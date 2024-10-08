const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Expresión regular para la cabecera del mensaje ISO 8583
const headerPattern = /ISO\d{9}\d{4}[0-9A-Fa-f]{16}/;

// Definición de campos ISO 8583
let defs = new Map();

// Clase para definir cada campo
class FieldDef {
  constructor(defLine) {
    const fields = defLine.split(',');
    if (fields.length < 6 || fields.length > 7) {
      throw new Error("Formato incorrecto. Se esperan 6 o 7 campos.");
    }

    this.id = parseInt(fields[0].trim());
    this.name = fields[1].trim();
    this.regex = fields[2].trim();
    this.len = parseInt(fields[3].trim());
    this.variable = fields[4].trim() === '1';
    this.numeric = fields[5].trim() === '1';
    this.label = fields[6] ? fields[6].trim() : this.name;

    if (this.regex) {
      this.pattern = new RegExp(this.regex);
    }

    // Determina el número de dígitos para la longitud del campo
    this.lenOfLen = Math.ceil(Math.log10(this.len + 1));
  }
}

// Función para leer la definición de campos desde un archivo CSV
function readDefinitions(fileName) {
  const data = fs.readFileSync(fileName, 'utf8');
  const lines = data.split('\n');

  for (let line of lines) {
    if (line.startsWith('#') || line.trim() === '') {
      continue; // Ignorar comentarios y líneas vacías
    }

    const field = new FieldDef(line);
    defs.set(field.id, field);
  }
}

// Función para analizar una línea de entrada
function parseInputLine(inputLine) {
  if (inputLine.length < 32) {
    throw new Error("Mensaje muy corto");
  }

  const header = inputLine.substring(0, 32);
  console.log(`FullHeader >${header}<`);

  const match = headerPattern.exec(header);
  if (!match) {
    throw new Error("Cabecera mal formada");
  }

  const base24Header = header.substring(3, 12);
  console.log(`Base24Header >${base24Header}<`);

  const messageType = header.substring(12, 16);
  console.log(`MessageType >${messageType}<`);

  const primaryBitmap = header.substring(16, 32);
  console.log(`PrimaryBitmap >${primaryBitmap}<`);

  let binaryPrimaryBitmap = hexa2bin(primaryBitmap);
  console.log(` >${binaryPrimaryBitmap}<`);

  let fullBitmap = binaryPrimaryBitmap;
  let currentPointer = 32;

  if (binaryPrimaryBitmap.charAt(0) === '1') {
    if (inputLine.length < 48) {
      throw new Error("Mensaje muy corto para contener el bitmap secundario");
    }
    const secondaryBitmap = inputLine.substring(32, 48);
    console.log(`SecondaryBitmap >${secondaryBitmap}<`);

    const binarySecondaryBitmap = hexa2bin(secondaryBitmap);
    fullBitmap += binarySecondaryBitmap;
    currentPointer = 48;
  }

  fullBitmap = '.' + fullBitmap; // Para que empiece desde 1

  let fieldsParsed = [];

  for (let i = 2; i < fullBitmap.length; i++) {
    if (fullBitmap.charAt(i) === '1') {
      currentPointer = parseField(i, inputLine, currentPointer, fieldsParsed);
    }
  }
  return fieldsParsed;
}

// Función para analizar un campo específico en la línea
function parseField(fieldNo, inputLine, currentPointer, fieldsParsed) {
  const field = defs.get(fieldNo);
  if (!field) {
    throw new Error(`Definición del campo ${fieldNo} no encontrada`);
  }

  let efLen;
  if (field.variable) {
    const lenStr = inputLine.substring(currentPointer, currentPointer + field.lenOfLen);
    efLen = parseInt(lenStr);
    currentPointer += field.lenOfLen;
  } else {
    efLen = field.len;
  }

  const value = inputLine.substring(currentPointer, currentPointer + efLen);
  currentPointer += efLen;

  fieldsParsed.push({
    fieldNo: fieldNo,
    label: field.label,
    length: efLen,
    value: value
  });

  if (field.pattern && !field.pattern.test(value)) {
    throw new Error(`El campo ${fieldNo} no coincide con el patrón`);
  }

  return currentPointer;
}

// Función para convertir hexadecimal a binario
function hexa2bin(hex) {
  return hex.split('').map(char => {
    return parseInt(char, 16).toString(2).padStart(4, '0');
  }).join('');
}

// Crear una instancia de Express
const app = express();
const PORT = process.env.PORT || 3001;

// Configuración de multer para manejar archivos subidos
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors()); // Habilita CORS para todas las rutas
app.use(express.json());


// Ruta para subir el archivo
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).send('No se ha subido ningún archivo');
  }

  const defsFileName = 'Formatos-B24-2.csv'; // Archivo con las definiciones de los campos
  const filePath = path.join(__dirname, file.path);

  // Leer el archivo de definiciones
  try {
    readDefinitions(defsFileName);
  } catch (error) {
    return res.status(500).json({ message: 'Error leyendo el archivo de definiciones', error: error.message });
  }

  // Leer y procesar el archivo subido
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    let parsedResults = [];

    lines.forEach((line, index) => {
      if (line.trim() !== '') {
        console.log(`InputLine >${index + 1}<`);
        const parsedLine = parseInputLine(line.trim());
        parsedResults.push({ line: index + 1, fields: parsedLine });
      }
    });

    // Elimina el archivo después de procesarlo
    fs.unlinkSync(filePath);

    // Devolver los resultados procesados
    res.json({ message: 'Archivo procesado correctamente', data: parsedResults });
  } catch (error) {
    fs.unlinkSync(filePath); // Asegurarse de eliminar el archivo en caso de error
    return res.status(500).json({ message: 'Error al procesar el archivo', error: error.message });
  }
});

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

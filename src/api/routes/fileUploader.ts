import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

// Create router
const router = express.Router();

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../../uploads');
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const fileExtension = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${fileExtension}`);
  }
});

// File filter to only accept Excel, CSV, and text files
const fileFilter = (req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedExtensions = ['.csv', '.xlsx', '.xls', '.txt'];
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(fileExtension)) {
    cb(null, true);
  } else {
    cb(new Error('Only Excel, CSV, and text files are allowed'));
  }
};

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter
});

// Interface for column metadata
interface ColumnMetadata {
  name: string;
  type: string;
  required: boolean;
  unique: boolean;
  primaryKey: boolean;
  foreignKey?: {
    table: string;
    column: string;
  };
}

// Interface for table metadata
interface TableMetadata {
  name: string;
  columns: ColumnMetadata[];
}

// Interface for mapping file columns to database columns
interface ColumnMapping {
  fileColumn: string;
  dbColumn: string;
  transform?: (value: any) => any;
}

// Interface for detected schema
interface DetectedSchema {
  tableName: string;
  columns: string[];
  data: any[];
  dataTypes: { [column: string]: string };
}

/**
 * File upload endpoint
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const file = req.file;
    const targetTable = req.body.tableName || '';
    const updateExisting = req.body.updateExisting === 'true';
    const skipErrors = req.body.skipErrors === 'true';
    
    console.log(`📤 File uploaded: ${file.originalname}, size: ${file.size} bytes`);
    console.log(`Target table: ${targetTable}, Update existing: ${updateExisting}, Skip errors: ${skipErrors}`);

    // Parse the file based on its extension
    const fileExtension = path.extname(file.originalname).toLowerCase();
    let parsedData: any[];

    if (fileExtension === '.csv') {
      parsedData = await parseCSVFile(file.path);
    } else if (['.xlsx', '.xls'].includes(fileExtension)) {
      parsedData = await parseExcelFile(file.path);
    } else if (fileExtension === '.txt') {
      parsedData = await parseTextFile(file.path);
    } else {
      // Clean up the file
      fs.unlinkSync(file.path);
      return res.status(400).json({
        success: false,
        message: 'Unsupported file format'
      });
    }

    if (!parsedData || parsedData.length === 0) {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        success: false,
        message: 'No data found in the file'
      });
    }

    // Detect schema from the parsed data
    const detectedSchema = detectSchema(parsedData, targetTable);

    // Get database metadata
    const dbSchema = await getDatabaseSchema();

    // Find the matching table in the database
    let matchingTable: TableMetadata | undefined;
    
    if (targetTable) {
      // Use specified table
      matchingTable = dbSchema.find(table => table.name.toLowerCase() === targetTable.toLowerCase());
      
      if (!matchingTable) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          message: `Specified table '${targetTable}' not found in the database`
        });
      }
    } else {
      // Auto-detect table based on column similarity
      matchingTable = findBestMatchingTable(detectedSchema, dbSchema);
      
      if (!matchingTable) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          message: 'Could not automatically match data to any existing database table',
          detectedColumns: detectedSchema.columns
        });
      }
    }

    // Create column mappings
    const columnMappings = createColumnMappings(detectedSchema.columns, matchingTable);
    
    // Validate the mappings
    const validationResults = validateColumnMappings(columnMappings, matchingTable);
    
    if (!validationResults.valid && !skipErrors) {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        success: false,
        message: 'Column validation failed',
        errors: validationResults.errors,
        table: matchingTable.name,
        columnMappings: columnMappings
      });
    }

    // Import the data
    const importResults = await importData(
      parsedData, 
      matchingTable.name, 
      columnMappings, 
      updateExisting,
      skipErrors
    );

    // Clean up the file after processing
    fs.unlinkSync(file.path);

    return res.status(200).json({
      success: true,
      message: 'File imported successfully',
      table: matchingTable.name,
      totalRows: parsedData.length,
      importedRows: importResults.importedRows,
      skippedRows: importResults.skippedRows,
      errors: importResults.errors,
      warnings: importResults.warnings,
      columnMappings: columnMappings
    });

  } catch (error: any) {
    console.error('❌ Error processing file upload:', error);
    
    // Clean up the file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    return res.status(500).json({
      success: false,
      message: 'Error processing file upload',
      error: error.message
    });
  }
});

/**
 * Get column mappings endpoint - allows users to customize column mappings
 */
router.post('/mappings', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const file = req.file;
    const targetTable = req.body.tableName || '';
    
    // Parse the file based on its extension
    const fileExtension = path.extname(file.originalname).toLowerCase();
    let parsedData: any[];

    if (fileExtension === '.csv') {
      parsedData = await parseCSVFile(file.path);
    } else if (['.xlsx', '.xls'].includes(fileExtension)) {
      parsedData = await parseExcelFile(file.path);
    } else if (fileExtension === '.txt') {
      parsedData = await parseTextFile(file.path);
    } else {
      // Clean up the file
      fs.unlinkSync(file.path);
      return res.status(400).json({
        success: false,
        message: 'Unsupported file format'
      });
    }

    // Detect schema from the parsed data
    const detectedSchema = detectSchema(parsedData, targetTable);

    // Get database metadata
    const dbSchema = await getDatabaseSchema();

    // Find matching tables based on column similarity
    const matchingTables = findPotentialMatchingTables(detectedSchema, dbSchema);
    
    // Clean up the file after analysis
    fs.unlinkSync(file.path);

    // Generate a unique ID for this mapping session
    const mappingSessionId = uuidv4();
    
    // Store the parsed data temporarily (would use Redis or similar in production)
    const tempDataFile = path.join(__dirname, '../../../uploads', `temp_data_${mappingSessionId}.json`);
    fs.writeFileSync(tempDataFile, JSON.stringify(parsedData));

    return res.status(200).json({
      success: true,
      message: 'File analyzed successfully',
      mappingSessionId: mappingSessionId,
      detectedSchema: {
        columns: detectedSchema.columns,
        dataTypes: detectedSchema.dataTypes,
        sampleData: parsedData.slice(0, 5)
      },
      potentialTables: matchingTables.map(table => ({
        name: table.table.name,
        matchScore: table.score,
        columns: table.table.columns.map(col => ({
          name: col.name,
          type: col.type,
          required: col.required
        }))
      }))
    });

  } catch (error: any) {
    console.error('❌ Error analyzing file:', error);
    
    // Clean up the file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    return res.status(500).json({
      success: false,
      message: 'Error analyzing file',
      error: error.message
    });
  }
});

/**
 * Complete import with custom mappings
 */
router.post('/import-with-mappings', express.json(), async (req, res) => {
  try {
    const { 
      mappingSessionId, 
      tableName, 
      columnMappings, 
      updateExisting = false,
      skipErrors = false 
    } = req.body;

    if (!mappingSessionId || !tableName || !columnMappings) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters'
      });
    }

    // Load the temporary data file
    const tempDataFile = path.join(__dirname, '../../../uploads', `temp_data_${mappingSessionId}.json`);
    
    if (!fs.existsSync(tempDataFile)) {
      return res.status(400).json({
        success: false,
        message: 'Mapping session expired or invalid'
      });
    }

    const parsedData = JSON.parse(fs.readFileSync(tempDataFile, 'utf8'));
    
    // Get database schema
    const dbSchema = await getDatabaseSchema();
    const matchingTable = dbSchema.find(table => table.name === tableName);
    
    if (!matchingTable) {
      return res.status(400).json({
        success: false,
        message: `Table '${tableName}' not found in the database`
      });
    }

    // Convert the mapping format from request to internal format
    const internalColumnMappings: ColumnMapping[] = columnMappings.map((mapping: any) => ({
      fileColumn: mapping.fileColumn,
      dbColumn: mapping.dbColumn,
      transform: createTransformFunction(mapping.transform)
    }));

    // Validate the mappings
    const validationResults = validateColumnMappings(internalColumnMappings, matchingTable);
    
    if (!validationResults.valid && !skipErrors) {
      return res.status(400).json({
        success: false,
        message: 'Column validation failed',
        errors: validationResults.errors
      });
    }

    // Import the data
    const importResults = await importData(
      parsedData, 
      tableName, 
      internalColumnMappings, 
      updateExisting,
      skipErrors
    );

    // Clean up the temporary file
    fs.unlinkSync(tempDataFile);

    return res.status(200).json({
      success: true,
      message: 'Data imported successfully',
      totalRows: parsedData.length,
      importedRows: importResults.importedRows,
      skippedRows: importResults.skippedRows,
      errors: importResults.errors,
      warnings: importResults.warnings
    });

  } catch (error: any) {
    console.error('❌ Error importing data with custom mappings:', error);
    return res.status(500).json({
      success: false,
      message: 'Error importing data',
      error: error.message
    });
  }
});

/**
 * Parse CSV file
 */
async function parseCSVFile(filePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    
    fs.createReadStream(filePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      }))
      .on('data', (data) => results.push(data))
      .on('error', (error) => reject(error))
      .on('end', () => resolve(results));
  });
}

/**
 * Parse Excel file
 */
function parseExcelFile(filePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    try {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet, { defval: null });
      resolve(data);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Parse text file (assumes tab or comma separated values with a header row)
 */
async function parseTextFile(filePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      
      try {
        const lines = data.split('\n').filter(line => line.trim().length > 0);
        
        if (lines.length === 0) {
          resolve([]);
          return;
        }
        
        // Detect delimiter (tab or comma)
        const firstLine = lines[0];
        const delimiter = firstLine.includes('\t') ? '\t' : ',';
        
        // Parse header
        const headers = firstLine.split(delimiter).map(h => h.trim());
        
        // Parse data rows
        const results = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const values = line.split(delimiter).map(v => v.trim());
          
          // Create object with header keys
          const obj: any = {};
          headers.forEach((header, index) => {
            obj[header] = index < values.length ? values[index] : null;
          });
          
          results.push(obj);
        }
        
        resolve(results);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Detect schema from parsed data
 */
function detectSchema(data: any[], suggestedTableName: string = ''): DetectedSchema {
  // Get all columns from the first row
  const columns = Object.keys(data[0] || {});
  
  // Determine data types for each column
  const dataTypes: { [column: string]: string } = {};
  
  columns.forEach(column => {
    const values = data.map(row => row[column]).filter(val => val !== null && val !== undefined);
    
    if (values.length === 0) {
      dataTypes[column] = 'VARCHAR(255)';
      return;
    }
    
    // Check if all values are numbers
    const allNumbers = values.every(val => !isNaN(Number(val)));
    if (allNumbers) {
      // Check if all values are integers
      const allIntegers = values.every(val => Number.isInteger(Number(val)));
      if (allIntegers) {
        dataTypes[column] = 'INT';
      } else {
        dataTypes[column] = 'DECIMAL(10,2)';
      }
      return;
    }
    
    // Check if all values are valid dates
    const allDates = values.every(val => !isNaN(Date.parse(String(val))));
    if (allDates) {
      dataTypes[column] = 'DATE';
      return;
    }
    
    // Default to VARCHAR
    const maxLength = Math.max(...values.map(val => String(val).length));
    dataTypes[column] = `VARCHAR(${Math.max(maxLength * 2, 255)})`;
  });
  
  // Guess table name if not provided
  let tableName = suggestedTableName;
  if (!tableName && columns.length > 0) {
    // Try to guess table name from column names
    const commonPrefixes = ['patient', 'doctor', 'medication', 'appointment', 'diagnosis', 'treatment'];
    for (const prefix of commonPrefixes) {
      const matchingColumns = columns.filter(col => 
        col.toLowerCase().includes(prefix) ||
        col.toLowerCase().includes(prefix + '_id')
      );
      
      if (matchingColumns.length > 0) {
        tableName = prefix + 's';
        break;
      }
    }
    
    // If still no table name, use generic name
    if (!tableName) {
      tableName = 'imported_data';
    }
  }
  
  return {
    tableName,
    columns,
    data,
    dataTypes
  };
}

/**
 * Get database schema
 */
async function getDatabaseSchema(): Promise<TableMetadata[]> {
  try {
    // Create a connection to the database
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST!,
      user: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      database: process.env.DB_NAME!
    });

    // Get all tables in the database
    const [tablesResult] = await connection.query(
      `SELECT TABLE_NAME 
       FROM INFORMATION_SCHEMA.TABLES 
       WHERE TABLE_SCHEMA = ?`,
      [process.env.DB_NAME]
    );
    
    const tables = (tablesResult as any[]).map(row => row.TABLE_NAME);
    
    // Get all columns for each table
    const schema: TableMetadata[] = [];
    
    for (const tableName of tables) {
      // Get column information
      const [columnsResult] = await connection.query(
        `SELECT 
          COLUMN_NAME, 
          DATA_TYPE, 
          IS_NULLABLE, 
          COLUMN_KEY,
          EXTRA
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [process.env.DB_NAME, tableName]
      );
      
      // Get foreign key constraints
      const [foreignKeysResult] = await connection.query(
        `SELECT
          COLUMN_NAME,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? 
         AND TABLE_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [process.env.DB_NAME, tableName]
      );
      
      const foreignKeys = (foreignKeysResult as any[]).reduce((acc: any, row: any) => {
        acc[row.COLUMN_NAME] = {
          table: row.REFERENCED_TABLE_NAME,
          column: row.REFERENCED_COLUMN_NAME
        };
        return acc;
      }, {});
      
      // Build columns array
      const columns = (columnsResult as any[]).map(col => {
        const columnMetadata: ColumnMetadata = {
          name: col.COLUMN_NAME,
          type: col.DATA_TYPE,
          required: col.IS_NULLABLE === 'NO',
          unique: col.COLUMN_KEY === 'UNI',
          primaryKey: col.COLUMN_KEY === 'PRI' || col.EXTRA === 'auto_increment'
        };
        
        if (foreignKeys[col.COLUMN_NAME]) {
          columnMetadata.foreignKey = foreignKeys[col.COLUMN_NAME];
        }
        
        return columnMetadata;
      });
      
      schema.push({
        name: tableName,
        columns: columns
      });
    }
    
    await connection.end();
    return schema;
    
  } catch (error) {
    console.error('Error fetching database schema:', error);
    throw new Error('Failed to retrieve database schema');
  }
}

/**
 * Find best matching table for the data
 */
function findBestMatchingTable(detectedSchema: DetectedSchema, dbSchema: TableMetadata[]): TableMetadata | undefined {
  const potentialTables = findPotentialMatchingTables(detectedSchema, dbSchema);
  
  if (potentialTables.length === 0) {
    return undefined;
  }
  
  // Return the table with the highest score
  return potentialTables[0].table;
}

/**
 * Find potential matching tables for the data
 */
function findPotentialMatchingTables(detectedSchema: DetectedSchema, dbSchema: TableMetadata[]): Array<{table: TableMetadata, score: number}> {
  const fileColumns = detectedSchema.columns.map(col => col.toLowerCase());
  
  const tableScores = dbSchema.map(table => {
    const dbColumns = table.columns.map(col => col.name.toLowerCase());
    
    // Calculate matching score (number of matching columns)
    let matchCount = 0;
    for (const fileCol of fileColumns) {
      if (dbColumns.includes(fileCol)) {
        matchCount++;
      } else {
        // Check for partial matches
        for (const dbCol of dbColumns) {
          if (fileCol.includes(dbCol) || dbCol.includes(fileCol)) {
            matchCount += 0.5;
            break;
          }
        }
      }
    }
    
    // Calculate score as percentage of file columns matched
    const score = matchCount / fileColumns.length;
    
    return {
      table: table,
      score: score
    };
  });
  
  // Sort tables by score in descending order
  return tableScores
    .filter(item => item.score > 0.3) // Only include tables with at least 30% match
    .sort((a, b) => b.score - a.score);
}

/**
 * Create column mappings
 */
function createColumnMappings(fileColumns: string[], dbTable: TableMetadata): ColumnMapping[] {
  const mappings: ColumnMapping[] = [];
  const dbColumns = dbTable.columns.map(col => col.name.toLowerCase());
  
  for (const fileCol of fileColumns) {
    const fileColLower = fileCol.toLowerCase();
    
    // Exact match
    if (dbColumns.includes(fileColLower)) {
      const dbCol = dbTable.columns.find(col => col.name.toLowerCase() === fileColLower);
      if (dbCol) {
        mappings.push({
          fileColumn: fileCol,
          dbColumn: dbCol.name,
          transform: createDefaultTransform(dbCol.type)
        });
      }
      continue;
    }
    
    // Try to find similar column names
    let bestMatch: { column: ColumnMetadata, score: number } | undefined;
    
    for (const dbCol of dbTable.columns) {
      const dbColLower = dbCol.name.toLowerCase();
      
      // Simple similarity check
      if (fileColLower.includes(dbColLower) || dbColLower.includes(fileColLower)) {
        const similarity = calculateStringSimilarity(fileColLower, dbColLower);
        
        if (!bestMatch || similarity > bestMatch.score) {
          bestMatch = {
            column: dbCol,
            score: similarity
          };
        }
      }
    }
    
    if (bestMatch && bestMatch.score > 0.6) {
      mappings.push({
        fileColumn: fileCol,
        dbColumn: bestMatch.column.name,
        transform: createDefaultTransform(bestMatch.column.type)
      });
    } else {
      // No match found for this column
      mappings.push({
        fileColumn: fileCol,
        dbColumn: '', // Empty string indicates no mapping
        transform: undefined
      });
    }
  }
  
  return mappings;
}

/**
 * Calculate string similarity (0-1)
 */
function calculateStringSimilarity(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  
  // If one string is empty, return 0
  if (len1 === 0 || len2 === 0) {
    return 0;
  }
  
  // If strings are identical, return 1
  if (str1 === str2) {
    return 1;
  }
  
  // Calculate Levenshtein distance
  const matrix: number[][] = [];
  
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  
  // Return similarity score (1 - normalized distance)
  return 1 - distance / maxLen;
}

/**
 * Create default transform function based on column type
 */
function createDefaultTransform(columnType: string): ((value: any) => any) | undefined {
  switch (columnType.toLowerCase()) {
    case 'int':
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'bigint':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const num = parseInt(value, 10);
        return isNaN(num) ? null : num;
      };
      
    case 'decimal':
    case 'float':
    case 'double':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const num = parseFloat(value);
        return isNaN(num) ? null : num;
      };
      
    case 'date':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
      };
      
    case 'datetime':
    case 'timestamp':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
      };
      
    case 'boolean':
    case 'tinyint(1)':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return value === 0 ? 0 : 1;
        if (typeof value === 'string') {
          const lowerVal = value.toLowerCase();
          if (['yes', 'y', 'true', 't', '1'].includes(lowerVal)) return 1;
          if (['no', 'n', 'false', 'f', '0'].includes(lowerVal)) return 0;
        }
        return null;
      };
      
    default:
      // Default string transformation
      return (value: any) => {
        if (value === null || value === undefined) return null;
        return String(value);
      };
  }
}

/**
 * Create transform function from string specification
 */
function createTransformFunction(transformSpec: string | undefined): ((value: any) => any) | undefined {
  if (!transformSpec) return undefined;
  
  // Simple transformation specifications
  switch (transformSpec) {
    case 'toInt':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const num = parseInt(value, 10);
        return isNaN(num) ? null : num;
      };
      
    case 'toFloat':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const num = parseFloat(value);
        return isNaN(num) ? null : num;
      };
      
    case 'toDate':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
      };
      
    case 'toDateTime':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
      };
      
    case 'toBoolean':
      return (value: any) => {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return value === 0 ? 0 : 1;
        if (typeof value === 'string') {
          const lowerVal = value.toLowerCase();
          if (['yes', 'y', 'true', 't', '1'].includes(lowerVal)) return 1;
          if (['no', 'n', 'false', 'f', '0'].includes(lowerVal)) return 0;
        }
        return null;
      };
      
    case 'toString':
      return (value: any) => {
        if (value === null || value === undefined) return null;
        return String(value);
      };
      
    default:
      return undefined;
  }
}

/**
 * Validate column mappings
 */
function validateColumnMappings(
  mappings: ColumnMapping[], 
  table: TableMetadata
): { valid: boolean, errors: string[] } {
  const errors: string[] = [];
  const mappedDbColumns = new Set(mappings.map(m => m.dbColumn).filter(c => c !== ''));
  
  // Check for required columns
  for (const column of table.columns) {
    if (column.required && !column.primaryKey && !mappedDbColumns.has(column.name)) {
      errors.push(`Required column '${column.name}' is not mapped`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors: errors
  };
}

/**
 * Import data into database
 */
async function importData(
  data: any[], 
  tableName: string, 
  columnMappings: ColumnMapping[],
  updateExisting: boolean,
  skipErrors: boolean
): Promise<{
  importedRows: number,
  skippedRows: number,
  errors: Array<{ row: number, error: string }>,
  warnings: Array<{ row: number, warning: string }>
}> {
  // Filter out mappings with empty dbColumn
  const validMappings = columnMappings.filter(mapping => mapping.dbColumn !== '');
  
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!
  });
  
  const importResults = {
    importedRows: 0,
    skippedRows: 0,
    errors: [] as Array<{ row: number, error: string }>,
    warnings: [] as Array<{ row: number, warning: string }>
  };
  
  try {
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowValues: { [column: string]: any } = {};
      
      try {
        // Transform values
        for (const mapping of validMappings) {
          const rawValue = row[mapping.fileColumn];
          
          // Apply transformation function if provided
          if (mapping.transform) {
            rowValues[mapping.dbColumn] = mapping.transform(rawValue);
          } else {
            rowValues[mapping.dbColumn] = rawValue;
          }
        }
        
        const columns = Object.keys(rowValues);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(col => rowValues[col]);
        
        if (updateExisting) {
          // Use INSERT ... ON DUPLICATE KEY UPDATE
          const updateClauses = columns.map(col => `${col} = VALUES(${col})`).join(', ');
          
          const query = `
            INSERT INTO ${tableName} (${columns.join(', ')})
            VALUES (${placeholders})
            ON DUPLICATE KEY UPDATE ${updateClauses}
          `;
          
          const [result] = await connection.execute(query, values);
          importResults.importedRows++;
          
        } else {
          // Simple INSERT
          const query = `
            INSERT INTO ${tableName} (${columns.join(', ')})
            VALUES (${placeholders})
          `;
          
          try {
            const [result] = await connection.execute(query, values);
            importResults.importedRows++;
          } catch (error: any) {
            if (error.code === 'ER_DUP_ENTRY') {
              importResults.warnings.push({
                row: i,
                warning: `Duplicate entry skipped: ${error.message}`
              });
              importResults.skippedRows++;
            } else {
              throw error;
            }
          }
        }
        
      } catch (error: any) {
        if (skipErrors) {
          importResults.errors.push({
            row: i,
            error: `Error processing row: ${error.message}`
          });
          importResults.skippedRows++;
        } else {
          throw new Error(`Error at row ${i + 1}: ${error.message}`);
        }
      }
    }
    
  } finally {
    await connection.end();
  }
  
  return importResults;
}

export default router;

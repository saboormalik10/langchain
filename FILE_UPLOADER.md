## File Uploader API

The File Uploader API allows for importing data from Excel, CSV, and text files into the medical database with intelligent schema detection and column mapping capabilities.

### Features

- Supports Excel (.xlsx, .xls), CSV, and text files
- Intelligent schema detection and database table matching
- Column name matching with fuzzy search for similar columns
- Data type validation and automatic conversion
- Error handling for common import issues
- Support for updating existing records

### Endpoints

#### `POST /api/files/upload`

Upload and import a file directly into a database table.

**Request:**
- Content-Type: `multipart/form-data`
- Form Fields:
  - `file`: The file to upload (required)
  - `tableName`: Target database table name (optional)
  - `updateExisting`: Whether to update existing records (optional, default: false)
  - `skipErrors`: Continue import even if errors occur (optional, default: false)

**Response:**
```json
{
  "success": true,
  "message": "File imported successfully",
  "table": "patients",
  "totalRows": 150,
  "importedRows": 142,
  "skippedRows": 8,
  "errors": [
    { "row": 24, "error": "Invalid date format" }
  ],
  "warnings": [
    { "row": 35, "warning": "Duplicate entry skipped" }
  ],
  "columnMappings": [
    { "fileColumn": "Patient Name", "dbColumn": "name" },
    { "fileColumn": "DOB", "dbColumn": "date_of_birth" }
  ]
}
```

#### `POST /api/files/mappings`

Analyze a file and generate suggested column mappings without importing.

**Request:**
- Content-Type: `multipart/form-data`
- Form Fields:
  - `file`: The file to analyze (required)
  - `tableName`: Preferred target table name (optional)

**Response:**
```json
{
  "success": true,
  "message": "File analyzed successfully",
  "mappingSessionId": "f7c3a9d0-1b2c-4d3e-8f9a-0b1c2d3e4f5a",
  "detectedSchema": {
    "columns": ["Patient Name", "DOB", "Blood Type"],
    "dataTypes": {
      "Patient Name": "VARCHAR(255)",
      "DOB": "DATE",
      "Blood Type": "VARCHAR(5)"
    },
    "sampleData": [
      { "Patient Name": "John Doe", "DOB": "1980-05-15", "Blood Type": "A+" }
    ]
  },
  "potentialTables": [
    {
      "name": "patients",
      "matchScore": 0.85,
      "columns": [
        { "name": "name", "type": "varchar", "required": true },
        { "name": "date_of_birth", "type": "date", "required": true },
        { "name": "blood_type", "type": "varchar", "required": false }
      ]
    }
  ]
}
```

#### `POST /api/files/import-with-mappings`

Import data using custom column mappings.

**Request:**
```json
{
  "mappingSessionId": "f7c3a9d0-1b2c-4d3e-8f9a-0b1c2d3e4f5a",
  "tableName": "patients",
  "columnMappings": [
    { "fileColumn": "Patient Name", "dbColumn": "name", "transform": "toString" },
    { "fileColumn": "DOB", "dbColumn": "date_of_birth", "transform": "toDate" },
    { "fileColumn": "Blood Type", "dbColumn": "blood_type" }
  ],
  "updateExisting": false,
  "skipErrors": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Data imported successfully",
  "totalRows": 150,
  "importedRows": 145,
  "skippedRows": 5,
  "errors": [
    { "row": 24, "error": "Invalid date format" }
  ],
  "warnings": [
    { "row": 35, "warning": "Duplicate entry skipped" }
  ]
}
```

### Data Type Transformations

The following transformation functions are available for column mappings:

- `toString`: Convert value to string
- `toInt`: Convert value to integer
- `toFloat`: Convert value to floating point number
- `toDate`: Convert value to date (YYYY-MM-DD)
- `toDateTime`: Convert value to datetime (YYYY-MM-DD HH:MM:SS)
- `toBoolean`: Convert value to boolean (0/1)

### Example Usage

#### Simple File Upload

```bash
curl -X POST http://localhost:3000/api/files/upload \
  -F "file=@patients.csv" \
  -F "tableName=patients" \
  -F "updateExisting=false" \
  -F "skipErrors=true"
```

#### Advanced Column Mapping

First, analyze the file:

```bash
curl -X POST http://localhost:3000/api/files/mappings \
  -F "file=@patients.csv"
```

Then, import with custom mappings:

```bash
curl -X POST http://localhost:3000/api/files/import-with-mappings \
  -H "Content-Type: application/json" \
  -d '{
    "mappingSessionId": "f7c3a9d0-1b2c-4d3e-8f9a-0b1c2d3e4f5a",
    "tableName": "patients",
    "columnMappings": [
      { "fileColumn": "Patient Name", "dbColumn": "name" },
      { "fileColumn": "Date of Birth", "dbColumn": "date_of_birth", "transform": "toDate" },
      { "fileColumn": "BloodType", "dbColumn": "blood_type" }
    ],
    "updateExisting": true,
    "skipErrors": false
  }'
```

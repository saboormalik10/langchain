# Testing the New Description Feature

## Overview

The `/api/medical/query-sql-manual` endpoint now includes intelligent descriptions that explain what your SQL queries do and what the results mean in simple, non-technical language.

## New Parameters

### `generateDescription` (optional, boolean, default: true)
- When `true`: Generates user-friendly descriptions of queries and results
- When `false`: Disables description generation for faster responses

## Example Usage

### Basic Request with Descriptions (Default)

```bash
curl -X POST "http://localhost:3000/api/medical/query-sql-manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "org-123",
    "query": "Show me patients with high blood pressure"
  }'
```

### Request with Descriptions Disabled

```bash
curl -X POST "http://localhost:3000/api/medical/query-sql-manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "org-123",
    "query": "Show me patients with high blood pressure",
    "generateDescription": false
  }'
```

## New Response Fields

### Success Response
```json
{
  "success": true,
  "query_processed": "Show me patients with high blood pressure",
  "sql_final": "SELECT * FROM patients WHERE condition = 'hypertension';",
  "sql_results": [...],
  "result_count": 25,
  
  // NEW: AI-generated descriptions
  "query_description": "This query searches the patient database for individuals diagnosed with high blood pressure (hypertension). It retrieves all available information for these patients from the patients table.",
  "result_explanation": "The search found 25 patients with high blood pressure in the database. The results show a mix of patients across different age groups, with most being over 50 years old. This represents approximately 15% of all patients in the system.",
  
  "processing_time": "1234.56ms",
  "timestamp": "2025-08-01T14:30:00.000Z"
}
```

### Error Response
```json
{
  "error": "SQL execution failed",
  "message": "Unknown column 'blood_pressure' in 'field list'",
  
  // NEW: User-friendly error explanation
  "error_description": "It looks like the system couldn't find a field called 'blood_pressure' in the patient data. Try asking about 'hypertension' or 'high blood pressure condition' instead, as the medical data might use different terminology.",
  
  "query_processed": "Show me patients with high blood pressure",
  "sql_final": "SELECT blood_pressure FROM patients;",
  "timestamp": "2025-08-01T14:30:00.000Z"
}
```

## Benefits

1. **User-Friendly**: Explains complex SQL operations in simple terms
2. **Educational**: Helps users understand what data is being retrieved
3. **Error Guidance**: Provides helpful suggestions when queries fail
4. **Flexible**: Can be disabled for applications that don't need descriptions
5. **Medical Context**: Tailored explanations for healthcare data

## Technical Details

- Uses Azure OpenAI to generate descriptions
- Analyzes both the SQL query and actual results
- Provides context-aware explanations for medical data
- Handles errors gracefully with fallback messages
- Optional feature that can be disabled for performance

## Use Cases

### For Non-Technical Users
- Understand what data queries retrieve
- Learn from AI explanations of database operations
- Get helpful guidance when queries fail

### For Technical Users  
- Validate that SQL queries match intended operations
- Get insights into data patterns and results
- Debug issues with clear error explanations

### For Applications
- Display user-friendly explanations in UIs
- Provide contextual help and guidance
- Enhance user experience with intelligent descriptions

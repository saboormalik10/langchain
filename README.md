# Medical LangChain API

This repository contains a sophisticated LangChain-powered API for medical database operations, featuring both SQL queries and conversational capabilities.

## Features

- **Natural Language Querying** - Query medical databases using natural language
- **Conversational Interface** - Maintain context across multiple interactions
- **SQL Query Generation** - LangChain-powered SQL generation with error recovery
- **MySQL Version Compatibility** - Automatically adapts queries to MySQL version
- **Database Intelligence** - Smart schema detection and query optimization

## API Endpoints

### Medical Database Queries

#### `POST /api/medical/query`

Single-shot query endpoint for medical database operations.

**Request:**
```json
{
  "query": "Find all patients with dosage over 250mg",
  "context": "Optional context to guide the query"
}
```

### Conversational SQL API

#### `POST /api/medical/query-sql-manual`

Provides SQL query capabilities with optional conversational context across multiple interactions.

**Request:**
```json
{
  "query": "Find patients with high blood pressure",
  "sessionId": "optional-session-id",
  "conversational": true,
  "context": "Optional additional context"
}
```

**Response:**
```json
{
  "success": true,
  "query_processed": "Find patients with high blood pressure",
  "sql_extracted": "SELECT * FROM patients WHERE condition = 'hypertension'",
  "sql_final": "SELECT * FROM patients WHERE condition = 'hypertension';",
  "sql_results": [...],
  "result_count": 5,
  "field_info": [...],
  "processing_time": "356.78ms",
  "agent_response": "...",
  "conversation": {
    "sessionId": "session-id-to-use-in-next-request",
    "historyLength": 2,
    "mode": "conversational"
  },
  "database_info": {
    "mysql_version": "8.0.33",
    "version_details": {...},
    "query_adapted_to_version": true
  },
  "timestamp": "2023-07-30T12:34:56.789Z"
}
```

#### `GET /api/medical/conversation/sessions`

List all active conversation sessions.

#### `DELETE /api/medical/conversation/sessions/:sessionId`

Delete a specific conversation session.

## Usage Examples

### Conversational SQL Query Example

First query:
```bash
curl -X POST http://localhost:3000/api/medical/query-sql-manual \
  -H "Content-Type: application/json" \
  -d '{"query": "Show me patients with high blood pressure", "conversational": true}'
```

Follow-up query (using returned session ID):
```bash
curl -X POST http://localhost:3000/api/medical/query-sql-manual \
  -H "Content-Type: application/json" \
  -d '{"query": "Which medications are they taking?", "sessionId": "returned-session-id", "conversational": true}'
```

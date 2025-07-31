# Multi-Tenant Medical Database API

This API now supports multi-tenant architecture where each organization can have its own database configuration.

## Setup

### 1. Database Configuration

The system uses PostgreSQL as the main database to store organization database configurations:

```env
# Database Configuration (PostgreSQL for tenant metadata)
DATABASE_URL=postgresql://postgres:password@localhost:5432/sqlgpt_platform

# Encryption Configuration
ENCRYPTION_KEY=vi0BJFHWT8yTlwokRILzAcwyp9gXBE0q
```

### 2. Database Schema

Create the following table in your PostgreSQL database:

```sql
CREATE TABLE database_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id VARCHAR(100) NOT NULL UNIQUE,
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL DEFAULT 3306,
    database VARCHAR(100) NOT NULL,
    username VARCHAR(100) NOT NULL,
    password TEXT NOT NULL, -- encrypted
    type VARCHAR(20) NOT NULL DEFAULT 'mysql',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

-- Index for fast lookups
CREATE INDEX idx_database_connections_org_id ON database_connections(organization_id);
CREATE INDEX idx_database_connections_active ON database_connections(organization_id, deleted_at) WHERE deleted_at IS NULL;
```

### 3. Adding Organization Database Configuration

To add a new organization's database configuration, encrypt the password and insert it:

```sql
-- Example: Add organization database config (password should be encrypted using AES with ENCRYPTION_KEY)
INSERT INTO database_connections (organization_id, host, port, database, username, password, type)
VALUES (
    'org-123',
    'sql12.freesqldatabase.com',
    3306,
    'sql12792726',
    'sql12792726',
    'encrypted_password_here', -- Use CryptoJS.AES.encrypt(password, ENCRYPTION_KEY).toString()
    'mysql'
);
```

## API Usage

### SQL Query Endpoint

**POST** `/api/medical/query-sql-manual`

**Required Body Parameters:**
- `organizationId` (string): The organization identifier
- `query` (string): Natural language query to convert to SQL

**Optional Body Parameters:**
- `conversational` (boolean): Enable conversational mode
- `sessionId` (string): Session ID for conversational mode
- `useChains` (boolean): Use LangChain chains for SQL generation
- `chainType` (string): Type of chain ('simple', 'sequential', 'router', 'multiprompt')

**Example Request:**
```json
{
    "organizationId": "org-123",
    "query": "Show me patients with high dosage medications",
    "conversational": false,
    "useChains": false
}
```

**Example Response:**
```json
{
    "success": true,
    "query_processed": "Show me patients with high dosage medications",
    "sql_final": "SELECT p.patient_id, p.gender, p.dob, p.city, p.state, m.medication_name, m.dosage FROM medication_histories m JOIN patients p ON m.record_id = p.patient_id WHERE CAST(SUBSTRING_INDEX(m.dosage, 'MG', 1) AS UNSIGNED) > 70 ORDER BY CAST(SUBSTRING_INDEX(m.dosage, 'MG', 1) AS UNSIGNED) DESC;",
    "sql_results": [
        {
            "patient_id": "WHP-6759370",
            "gender": "Male",
            "dob": "2018-05-30T19:00:00.000Z",
            "state": "1f9a2d1c-b13e-467f-8646-0f668e6acb3c",
            "city": "Schmidtside",
            "medication_name": "Refined Granite Hat",
            "dosage": "94MG"
        }
    ],
    "result_count": 4,
    "processing_time": "1234.56ms",
    "database_info": {
        "host": "sql12.freesqldatabase.com",
        "database": "sql12792726",
        "port": "3306",
        "mysql_version": "8.0.35"
    },
    "timestamp": "2025-07-31T14:30:00.000Z"
}
```

## Architecture

### Multi-Tenant Components

1. **DatabaseService** (`src/services/databaseService.ts`)
   - Manages PostgreSQL connections for organization metadata
   - Handles encryption/decryption of database passwords
   - Creates dynamic MySQL connections for each organization

2. **MultiTenantLangChainService** (`src/services/multiTenantLangChainService.ts`)
   - Manages LangChain app instances per organization
   - Caches LangChain apps for performance (30-minute cache)
   - Handles organization-specific SQL agents and chains

3. **Medical Routes** (`src/api/routes/medical.ts`)
   - Now requires `organizationId` in all requests
   - Dynamically creates database connections based on organization
   - Uses organization-specific LangChain instances

### Security Features

- **Password Encryption**: All database passwords are encrypted using AES
- **Connection Isolation**: Each organization uses separate database connections
- **Cache Management**: LangChain instances are cached but expire for security
- **Validation**: Comprehensive input validation for all parameters

### Performance Features

- **Connection Caching**: Database connections are reused when possible
- **LangChain Caching**: LangChain instances are cached per organization
- **Automatic Cleanup**: Expired connections and caches are automatically cleaned up

## Migration from Single-Tenant

To migrate from the previous single-tenant setup:

1. Remove the old environment variables:
   ```
   DB_HOST
   DB_PORT
   DB_USER
   DB_PASSWORD
   DB_NAME
   ```

2. Add the new environment variables:
   ```
   DATABASE_URL=postgresql://postgres:password@localhost:5432/sqlgpt_platform
   ENCRYPTION_KEY=vi0BJFHWT8yTlwokRILzAcwyp9gXBE0q
   ```

3. Create the PostgreSQL database and table schema
4. Insert your organization's database configuration
5. Update API calls to include `organizationId`

## Testing

Test the database connection for an organization:

```javascript
// Test organization database connection
const response = await fetch('/api/medical/query-sql-manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        organizationId: 'org-123',
        query: 'SELECT 1 as test'
    })
});
```

The system will automatically validate the organization's database connection before processing any queries.

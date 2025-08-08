# Structured Query Enhancement with Database Schema Context

## Overview
This enhancement addresses the issue where the structured query generation (Azure OpenAI restructuring) was generating wrong queries due to lack of database context. The solution provides comprehensive database schema information and version compatibility to both SQL Agent and structured query generation processes.

## Problem Statement
- **SQL Agent**: Was generating queries with non-existent column names (e.g., 'gs.test_name') despite having database context
- **Structured Query Generation**: Azure OpenAI was creating incorrect table/column references without proper schema validation
- **Missing Context**: Both processes lacked comprehensive database schema and version information

## Solution Components

### 1. Enhanced Query Service Extensions

#### New Methods Added:
- **`createStructuredEnhancedQuery()`**: Specialized method for structured query generation with full database schema context
- **`formatDatabaseSchema()`**: Helper method to format schema information for AI consumption
- **`createUniversalEnhancedQuery()`**: Comprehensive method supporting both SQL Agent and structured query needs

#### Key Features:
- **Complete Schema Context**: Provides all table and column information
- **Version Compatibility**: Ensures SQL features match database version capabilities
- **Schema Validation**: Mandatory verification of table and column names
- **Error Prevention**: Specific rules to prevent common column name assumptions

### 2. SQL Generation Service Updates

#### Enhanced Integration:
- **Schema-Aware Prompts**: Uses `EnhancedQueryService.createStructuredEnhancedQuery()`
- **Database Context**: Includes comprehensive table and column information
- **Version Compliance**: Enforces database-specific SQL syntax rules

#### Parameters Added:
- `databaseVersionInfo`: Complete version compatibility information
- `tableSchemas`: Detailed column information for each table
- `availableTables`: List of confirmed existing tables

### 3. Medical Routes Integration

#### Structured Query Generation:
- **Automatic Schema Discovery**: Collects table schemas using SQL Agent
- **Context-Rich Prompts**: Provides full database context to Azure OpenAI
- **Response Integration**: Includes structured query results in API response

#### Implementation Location:
- Added after SQL execution in `/query-sql-manual` endpoint
- Collects schemas for all available tables (limited to 10 for performance)
- Handles errors gracefully without breaking main functionality

## Technical Implementation

### EnhancedQueryService Extensions

```typescript
interface StructuredQueryParams extends EnhancedQueryParams {
    tableSchemas?: Record<string, any[]>;
    originalQuery?: string;
}

static createStructuredEnhancedQuery(params: StructuredQueryParams): string {
    // Creates comprehensive prompts with:
    // - Complete database schema
    // - Version compatibility rules
    // - Schema validation requirements
    // - Syntax error prevention
}
```

### SQL Generation Service Integration

```typescript
export async function generateRestructuredSQL(
    // ... existing parameters
    databaseVersionInfo?: any,
    tableSchemas?: Record<string, any[]>,
    availableTables?: string[]
): Promise<any> {
    // Uses EnhancedQueryService for schema-aware prompts
    const restructuringPrompt = EnhancedQueryService.createStructuredEnhancedQuery({
        query: userPrompt,
        organizationId,
        databaseType: dbType,
        databaseVersionString: dbVersion,
        databaseVersionInfo,
        availableTables,
        tableSchemas,
        originalQuery: originalSQL
    });
}
```

### Medical Routes Schema Collection

```typescript
// Collect table schemas for structured query context
const tableSchemas: Record<string, any[]> = {};

for (const tableName of debugInfo.availableTables.slice(0, 10)) {
    const schemaResponse = await sqlAgent.call({
        input: `sql_db_schema("${tableName}")`,
        chat_history: []
    });
    
    // Parse and store column information
    tableSchemas[tableName] = parsedColumns;
}
```

## Benefits

### 1. Schema Validation
- **Prevents Column Errors**: No more "Unknown column 'gs.test_name'" errors
- **Table Verification**: Confirms all tables exist before query generation
- **Exact Name Matching**: Uses precise table/column names from database

### 2. Version Compatibility
- **Database-Specific Features**: Only uses supported SQL syntax
- **MySQL/PostgreSQL Support**: Proper version-aware query generation
- **GROUP BY Compliance**: Handles MySQL `only_full_group_by` mode

### 3. Error Prevention
- **Schema Discovery**: Mandatory table/column discovery before query generation
- **Assumption Prevention**: Prohibits similar name substitutions
- **Validation Rules**: 12-point validation checklist for all queries

### 4. Enhanced Context
- **Complete Schema**: Provides all available tables and columns
- **Version Information**: Database version and feature support
- **Relationship Mapping**: Table relationships for proper JOINs

## Usage

### For SQL Agent Enhancement:
The existing `EnhancedQueryService.createEnhancedQuery()` method now includes enhanced schema validation and is used automatically in the medical routes.

### For Structured Query Generation:
The new integration automatically:
1. Collects database schemas after SQL execution
2. Provides comprehensive context to Azure OpenAI
3. Returns structured query results in the API response

### API Response Structure:
```json
{
  "success": true,
  "query": "user query",
  "sql": "generated SQL",
  "results": [...],
  "restructuredResults": {
    "restructured_sql": "optimized query",
    "explanation": "transformation explanation",
    "grouping_logic": "grouping strategy",
    "restructure_success": true
  }
}
```

## Configuration

### Required Environment Variables:
- `AZURE_OPENAI_DEPLOYMENT`: Azure OpenAI model deployment name
- Database connection parameters for schema discovery

### Performance Considerations:
- Schema collection limited to 10 tables maximum
- Cached schema information where possible
- Graceful error handling to maintain API performance

## Testing

### Validation Points:
1. **Schema Discovery**: Verify table and column names are correctly extracted
2. **Version Compatibility**: Test with different MySQL/PostgreSQL versions
3. **Error Handling**: Ensure graceful failure when schema unavailable
4. **Query Generation**: Validate that structured queries use correct schema

### Expected Improvements:
- Elimination of "Unknown column" errors
- Proper table name usage in all queries
- Version-appropriate SQL syntax
- Comprehensive schema validation

## Future Enhancements

### Potential Improvements:
- **Schema Caching**: Cache table schemas to reduce discovery overhead
- **Relationship Detection**: Automatic foreign key relationship discovery
- **Advanced Parsing**: Enhanced schema response parsing for complex structures
- **Performance Optimization**: Parallel schema discovery for large databases

This enhancement provides comprehensive database context to both SQL Agent and structured query generation, eliminating schema-related errors and ensuring accurate query generation.

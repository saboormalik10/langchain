# Medical LangChain API - Prompt System Summary

## Overview

The Medical LangChain API uses a comprehensive prompt engineering system with multiple specialized prompts for different stages of SQL query processing. This document provides a detailed summary of all the key prompts used in the system.

## Prompt Architecture

### 1. Main Query Generation Prompt (`generateEnhancedQueryPrompt`)

**Location:** `src/api/prompts/enhanceQueryPrompt.ts`

**Purpose:** Converts natural language queries into SQL queries using a step-by-step approach.

**Key Features:**
- **Database Version Awareness:** Adapts to MySQL version capabilities (JSON functions, window functions, CTEs, GROUP BY modes)
- **Strict Column Selection:** Prevents use of SELECT * and enforces selective column inclusion
- **Entity-Focused Approach:** Identifies primary entities and focuses on relevant tables
- **Condition-Based Table Selection:** Prioritizes tables containing filter columns over demographic tables

**Core Structure:**
```typescript
export function generateEnhancedQueryPrompt({
  databaseType,
  databaseVersionString,
  organizationId,
  versionSpecificInstructions,
  query,
  databaseVersionInfo,
  tableDescriptions,
  conversationalContext,
}: ComprehensiveQueryParams): string
```

**Mandatory Process Steps:**
1. **STEP 1:** Discover all tables using `sql_db_list_tables()`
2. **STEP 2:** Identify relevant tables with strict entity focus
3. **STEP 3:** Analyze table schemas using `sql_db_schema()`
4. **STEP 4:** Map query requirements to schema
5. **STEP 5:** Generate version-compatible SQL
6. **STEP 6:** Version-specific validation and compatibility check

**Critical Rules:**
- **No Asterisk Rule:** Absolutely prohibits `SELECT *` usage
- **Selective Column Rule:** Only include columns directly related to user query
- **Condition Column Rule:** Include columns used in WHERE/HAVING/JOIN conditions
- **Primary Entity Rule:** Focus on the main entity the user is asking about
- **Dependent Table Exclusion:** Avoid unnecessary columns from joined tables

### 2. SQL Restructuring Prompt (Multi-Sheet Excel Format)

**Location:** `src/api/routes/medical.ts` (lines 840-1150)

**Purpose:** Transforms flat SQL results into structured, hierarchical format for Excel export.

**Key Features:**
- **Multi-Sheet Organization:** Separates different entity types into logical sheets
- **JSON Aggregation:** Uses database-specific JSON functions to eliminate redundancy
- **Array Wrapper Format:** Returns results in `[{metadata: {...}, patients: [...], medications: [...]}]` structure
- **Sheet Type Classification:** Each record includes `sheet_type` field for organization

**Core Requirements:**
1. **Eliminate Redundancy:** Use GROUP BY to group related entities
2. **Create JSON Hierarchy:** Use JSON functions to create nested structures
3. **Maintain Data Integrity:** Don't lose information from original query
4. **Multi-Sheet Structure:** Organize by entity type (patients, medications, appointments)
5. **Mandatory Array Wrapper:** Always return results wrapped in array format
6. **Metadata Section:** Include main_entity, main_entity_count, main_entity_identifier

**Expected Output Structure:**
```json
[
  {
    "metadata": {
      "main_entity": "patients",
      "main_entity_count": 25,
      "main_entity_identifier": "patient_id"
    },
    "patients": [
      {
        "patient_id": "WHP-1584821",
        "sheet_type": "patient",
        "dob": "2019-07-23",
        "city": "Fort Salmaside",
        "gender": "Male"
      }
    ],
    "medications": [
      {
        "id": 1,
        "patient_id": "WHP-1584821",
        "sheet_type": "medication_summary",
        "medication_name": "Practical Bamboo Shirt",
        "medication_status": "Safe"
      }
    ]
  }
]
```

### 3. Error Correction Prompt (`generateCorrectionPrompt`)

**Location:** `src/api/prompts/queryPropmt.ts`

**Purpose:** Fixes SQL queries that have validation issues.

**Structure:**
```typescript
export function generateCorrectionPrompt(
  originalQuery: any,
  originalSQL: string,
  issues: string[]
)
```

**Key Requirements:**
1. Address ALL identified issues
2. Maintain original user query requirements
3. Use proper SQL syntax and structure
4. Include necessary JOINs, WHERE, GROUP BY, ORDER BY clauses
5. Generate ONLY the corrected SQL without explanations

### 4. Query Description Prompt (`generateQueryDescriptionPrompt`)

**Location:** `src/api/prompts/queryPropmt.ts`

**Purpose:** Provides user-friendly explanations of SQL queries.

**Features:**
- Medical database expertise focus
- Clear, professional explanations
- Business context understanding

### 5. Comprehensive Query Prompt (`generateComprehensiveQuery`)

**Location:** `src/api/prompts/queryPropmt.ts`

**Purpose:** Enhanced query generation with complete database knowledge.

**Key Components:**
- Database schema information integration
- MySQL version-specific compatibility checks
- Feature availability analysis (JSON functions, window functions, CTEs)
- Chain execution instructions

### 6. Database Version-Specific Rules

**JSON Functions by Database Type:**
- **MySQL 5.7+:** JSON_OBJECT, JSON_ARRAY, JSON_EXTRACT
- **MySQL 5.6 and below:** No JSON support
- **PostgreSQL:** json_build_object, json_agg
- **SQLite:** json_object, json_group_array

**GROUP BY Compliance:**
- **MySQL with only_full_group_by:** All non-aggregated SELECT columns must appear in GROUP BY
- **Standard MySQL:** Flexible GROUP BY rules
- **PostgreSQL/SQLite:** Standard GROUP BY requirements

## Organization-Based Caching System

The API implements a sophisticated caching system based on organization IDs:

**Cache Structure:**
```typescript
interface OrganizationCacheData {
  organizationId: string;
  timestamp: number;
  expirationTime: number;
  tableSchemas: { [tableName: string]: any };
  sampleData: { [tableName: string]: any[] };
  tableDescriptions: { [tableName: string]: string };
  databaseInfo: any;
}
```

**Cache Management:**
- **30-minute expiration** for cached data
- **JavaScript Map-based storage** for organization data
- **Cache-first approach** with fallback to database queries
- **Automatic invalidation** after expiration period

## Prompt Integration Flow

1. **User Query Reception:** Natural language query received via API
2. **Organization Cache Check:** Check if organization data is cached and valid
3. **Schema Discovery:** If not cached, discover tables and schemas
4. **Enhanced Query Generation:** Use `generateEnhancedQueryPrompt` with cached/discovered data
5. **SQL Execution:** Execute generated SQL against database
6. **Result Processing:** Apply restructuring if multi-sheet format requested
7. **Response Generation:** Return structured results with metadata

## Key Advantages

1. **Version Compatibility:** Adapts to specific database versions and capabilities
2. **Performance Optimization:** Organization-based caching reduces redundant operations
3. **Selective Column Selection:** Prevents information overload and improves query performance
4. **Multi-Format Support:** Supports both flat and hierarchical result structures
5. **Error Recovery:** Automatic retry with corrected prompts for failed queries
6. **Medical Domain Expertise:** Specialized for medical database queries and terminology

## Best Practices

1. **Always use explicit column names** - never SELECT *
2. **Focus on primary entities** when constructing queries
3. **Include condition columns** in SELECT clause for transparency
4. **Minimize dependent table columns** unless explicitly requested
5. **Leverage organization caching** for improved performance
6. **Validate database version compatibility** before using advanced features
7. **Structure queries logically** to represent user intent clearly

This prompt system enables the Medical LangChain API to generate accurate, efficient, and version-compatible SQL queries while maintaining high performance through intelligent caching and selective data retrieval.

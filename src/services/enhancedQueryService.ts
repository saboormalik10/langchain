/**
 * Enhanced Query Processing Service
 * 
 * This service handles the creation of enhanced queries for the SQL Agent,
 * including database version compatibility, table context, and conversation history.
 */

interface DatabaseVersionInfo {
    full: string;
    major: number;
    minor: number;
    patch: number;
    supportsJSON: boolean;
    supportsWindowFunctions: boolean;
    supportsCTE: boolean;
    supportsRegex: boolean;
    hasOnlyFullGroupBy?: boolean;
}

interface EnhancedQueryParams {
    query: string;
    organizationId: string;
    databaseType: string;
    databaseVersionString: string;
    databaseVersionInfo?: DatabaseVersionInfo | null;
    conversational?: boolean;
    chatHistory?: any[];
    availableTables?: string[];
}

interface StructuredQueryParams extends EnhancedQueryParams {
    tableSchemas?: Record<string, any[]>;
    originalQuery?: string;
}

export class EnhancedQueryService {
    /**
     * Creates an enhanced query with database version compatibility, 
     * table context, and conversation history
     */
    static createEnhancedQuery(params: EnhancedQueryParams): string {
        const {
            query,
            organizationId,
            databaseType,
            databaseVersionString,
            databaseVersionInfo,
            conversational = false,
            chatHistory = [],
            availableTables = []
        } = params;

        // Create version-specific instructions
        const versionSpecificInstructions = databaseVersionInfo ? `
**CRITICAL DATABASE VERSION COMPATIBILITY REQUIREMENTS:**
- Database: ${databaseType.toUpperCase()} ${databaseVersionInfo.full}
- JSON Support: ${databaseVersionInfo.supportsJSON ? 'AVAILABLE' : 'NOT AVAILABLE - DO NOT USE JSON functions'}
- Window Functions: ${databaseVersionInfo.supportsWindowFunctions ? 'AVAILABLE' : 'NOT AVAILABLE - DO NOT USE ROW_NUMBER(), RANK(), etc.'}
- CTEs (WITH clause): ${databaseVersionInfo.supportsCTE ? 'AVAILABLE' : 'NOT AVAILABLE - DO NOT USE WITH statements'}
- Regular Expressions: ${databaseVersionInfo.supportsRegex ? 'AVAILABLE' : 'LIMITED'}

${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo.hasOnlyFullGroupBy ? `
**MYSQL ONLY_FULL_GROUP_BY MODE ENABLED - CRITICAL COMPLIANCE REQUIRED:**

This MySQL server has sql_mode=only_full_group_by ENABLED. You MUST strictly follow these rules:

**MANDATORY GROUP BY RULES:**
1. If using ANY aggregation function (COUNT, SUM, AVG, MAX, MIN), ALL non-aggregated columns in SELECT must be in GROUP BY
2. If a column appears in SELECT but is not aggregated, it MUST appear in GROUP BY
3. If using HAVING clause, ensure proper aggregation

**CORRECT EXAMPLES:**
✅ SELECT gender, COUNT(*) FROM patients GROUP BY gender;
✅ SELECT patient_id, gender, AVG(age) FROM patients GROUP BY patient_id, gender;
✅ SELECT state, city, COUNT(*) FROM patients GROUP BY state, city HAVING COUNT(*) > 5;

**WRONG EXAMPLES:**
❌ SELECT patient_id, gender, COUNT(*) FROM patients GROUP BY patient_id; (gender not in GROUP BY)
❌ SELECT column1, column2, risk_score FROM table GROUP BY column1, column2, patient_id HAVING AVG(risk_score) > 2; (risk_score not aggregated but not in GROUP BY)

**FIX STRATEGY:**
- If using aggregation: Either aggregate ALL columns (COUNT, MAX, MIN, etc.) OR include them in GROUP BY
- If NOT using aggregation: Remove GROUP BY entirely
- Example fix: SELECT column1, column2, AVG(risk_score) FROM table GROUP BY column1, column2 HAVING AVG(risk_score) > 2;

**MYSQL sql_mode=only_full_group_by COMPLIANCE IS ABSOLUTELY MANDATORY**` : 
databaseType.toLowerCase() === 'mysql' ? '**MySQL GROUP BY COMPLIANCE**: Ensure proper GROUP BY usage for any aggregation queries' : ''}

CRITICAL: Use ONLY SQL features compatible with this ${databaseType.toUpperCase()} version. Avoid any syntax not supported by ${databaseVersionInfo.full}.
` : '';

        // Add conversation context if in conversational mode
        let conversationalContext = '';
        if (conversational && Array.isArray(chatHistory) && chatHistory.length > 0) {
            conversationalContext = '\n\nPrevious conversation:\n' + chatHistory
                .map((msg: any) => `${msg.type === 'human' ? 'User' : 'Assistant'}: ${msg.content}`)
                .join('\n') + '\n\n';
        }

        // Add available tables context if provided
        let availableTablesContext = '';
        if (Array.isArray(availableTables) && availableTables.length > 0) {
            availableTablesContext = `
=== AVAILABLE TABLES IN DATABASE ===
The following tables are confirmed to exist in this database:
${availableTables.map(table => `- ${table}`).join('\n')}

**CRITICAL CONSTRAINT: You can ONLY use tables from this exact list. Any table name not listed above does NOT exist and will cause an error.**
========================
`;
        }

        // Create the enhanced query with the exact structure from original medical.ts
        const enhancedQuery = `
🎯 You are an expert SQL database analyst. Your task is to generate a WORKING SQL query that answers the user's question.

**🚨 CRITICAL SCHEMA VALIDATION REQUIREMENTS:**
1. **MANDATORY TABLE DISCOVERY**: You MUST use sql_db_list_tables() first to see all available tables
2. **MANDATORY COLUMN DISCOVERY**: You MUST use sql_db_schema("table_name") for each relevant table to see all available columns
3. **ZERO TOLERANCE FOR ASSUMPTIONS**: NEVER use table or column names that you have not explicitly discovered
4. **EXACT NAME MATCHING**: Use table and column names exactly as discovered - no modifications, no assumptions, no guessing
5. **SCHEMA VALIDATION**: Every table and column in your final query MUST exist in the discovered schema
6. **COLUMN NAME VERIFICATION**: Before using ANY column name, verify it exists in the sql_db_schema() output
7. **NO SIMILAR NAME ASSUMPTIONS**: Do not assume similar column names exist (e.g., don't assume 'test_name' exists if you only see 'test_type')
8. **DOCUMENT ALL DISCOVERIES**: List every table and column you discover before writing the query

**CRITICAL VERSION REQUIREMENTS:**
1. You MUST strictly follow the database version compatibility rules provided below
2. Any SQL features not supported by the detected version MUST be avoided
3. Version-specific query patterns MUST be followed exactly, especially for GROUP BY clauses

**MANDATORY DATABASE VERSION ANALYSIS:**
- Type: ${databaseType.toUpperCase()}
- Version: ${databaseVersionString}
- Organization: ${organizationId}

${versionSpecificInstructions}

**USER QUERY:** "${query}"

**VERSION-AWARE STEP-BY-STEP PROCESS:**

**STEP 1: DISCOVER TABLES**
- Use sql_db_list_tables() to see all available tables
- Document what tables exist
${Array.isArray(availableTables) && availableTables.length > 0 ? `
- **KNOWN AVAILABLE TABLES**: ${availableTables.join(', ')}
- **CRITICAL**: Verify these tables exist using sql_db_list_tables() and ONLY use tables that appear in both lists` : ''}

**STEP 3: EXAMINE RELEVANT SCHEMAS** 
- Use sql_db_schema("table_name") for tables that might contain data for the user's query
- Focus on tables that match the user's question topic (patients, medications, lab results, etc.)
- **CRITICAL: Document EVERY column name you discover - do not assume any column exists**
- **CRITICAL: If you need a specific column (like 'test_name'), verify it exists in the schema output**
- **CRITICAL: Do not use column names that sound similar but are not exactly what you discovered**

**STEP 4: MANDATORY SCHEMA VALIDATION**
- **CRITICAL: ONLY use table names that were discovered in STEP 1 (sql_db_list_tables)**
- **CRITICAL: ONLY use column names that were discovered in STEP 3 (sql_db_schema)**
- **NEVER use hardcoded or assumed table/column names**
- **VERIFY EVERY TABLE AND COLUMN**: Before using any table or column in your query, confirm it exists in the discovered schema
- **CASE SENSITIVITY**: Use exact case matching for table and column names as discovered
- **NO ASSUMPTIONS**: Do not assume column names based on common patterns - use only what you discovered

**STEP 4: GENERATE VERSION-COMPATIBLE SQL**
- **CRITICAL SCHEMA VALIDATION**: Before writing any SQL, verify that ALL table and column names exist in the discovered schema
- Create a SQL query compatible with ${databaseType.toUpperCase()} ${databaseVersionString}
- **MANDATORY TABLE VALIDATION**: Every table in FROM and JOIN clauses must be from the sql_db_list_tables() results
- **MANDATORY COLUMN VALIDATION**: Every column in SELECT, WHERE, JOIN, GROUP BY, ORDER BY must be from sql_db_schema() results
- Use explicit column names (NO SELECT *)
- Include columns mentioned in user query + minimal context columns
- Include WHERE conditions if user specifies filters
- If using MySQL with only_full_group_by mode: Strictly ensure all non-aggregated columns in SELECT appear in GROUP BY
- Avoid any syntax features not supported by this database version

**VERSION-COMPATIBLE QUERY EXAMPLES:**
${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo && databaseVersionInfo.hasOnlyFullGroupBy ? `
- ✅ For "patients with count": SELECT patient_id, gender, COUNT(*) FROM patients GROUP BY patient_id, gender;
- ✅ For "average risk score by gender": SELECT gender, AVG(risk_score) FROM patients GROUP BY gender;
- ✅ For "high risk patients": SELECT patient_id, risk_category FROM risk_details WHERE risk_category = 'High';
- ❌ AVOID: SELECT patient_id, gender, COUNT(*) FROM patients GROUP BY patient_id; (missing gender in GROUP BY)
- ❌ AVOID: SELECT risk_score, patient_name FROM risk_details GROUP BY patient_id; (columns not in GROUP BY)
` : `
- For "show patients": SELECT gender, dob, state, city FROM patients LIMIT 10;
- For "medications": SELECT medications FROM patients WHERE medications IS NOT NULL LIMIT 10;
- For "high risk": SELECT risk_category, risk_score FROM risk_details WHERE risk_category LIKE '%High%' LIMIT 10;
`}

**⚠️ WARNING: These examples use hypothetical table/column names. You MUST discover the actual schema using sql_db_list_tables() and sql_db_schema() before writing any query.**

**CRITICAL VERSION-SPECIFIC COMPATIBILITY CHECKS:**
${databaseType.toLowerCase() === 'mysql' ? `
- JSON Functions: ${databaseVersionInfo && databaseVersionInfo.supportsJSON ? 'Available - OK to use' : 'NOT AVAILABLE - DO NOT USE JSON_EXTRACT or other JSON functions'}
- Window Functions: ${databaseVersionInfo && databaseVersionInfo.supportsWindowFunctions ? 'Available - OK to use ROW_NUMBER(), etc.' : 'NOT AVAILABLE - DO NOT USE any window functions like ROW_NUMBER()'}
- CTEs (WITH clause): ${databaseVersionInfo && databaseVersionInfo.supportsCTE ? 'Available - OK to use' : 'NOT AVAILABLE - DO NOT USE WITH clause or CTEs'}
- GROUP BY Mode: ${databaseVersionInfo && databaseVersionInfo.hasOnlyFullGroupBy ? 'STRICT - all non-aggregated SELECT columns MUST be in GROUP BY' : 'Standard - normal GROUP BY rules apply'}
` : ''}

**CRITICAL:** Generate ONE version-compatible SQL query that directly answers: "${query}"

Start with STEP 1 - list all tables now.

=== DATABASE CONTEXT ===
Database Type: ${databaseType.toUpperCase()}
Database Version: ${databaseVersionString}
Organization ID: ${organizationId}

${versionSpecificInstructions}

Available Features:
- Table Discovery: Use sql_db_list_tables() to explore all available tables
- Schema Analysis: Use sql_db_schema("table_name") to understand table structure
- Query Execution: Generate and execute SQL queries based on discovered schema

CRITICAL: Your queries will be executed against this specific database instance. Ensure compatibility with the version and features listed above.
========================

${availableTablesContext}${conversationalContext ? `=== CONVERSATION CONTEXT ===${conversationalContext}========================` : ''}

=== CRITICAL SELECT CLAUSE REQUIREMENTS ===

**ABSOLUTE PROHIBITION: NEVER USE ASTERISK (*) IN SELECT CLAUSES**

**MANDATORY SELECT CLAUSE RULES:**
1. **EXPLICITLY LIST ALL COLUMN NAMES** - Never use table.* or * in any SELECT statement
2. **BE SELECTIVE AND QUERY-FOCUSED** - Only include columns that are:
   - Directly mentioned in the user query
   - Used in WHERE, HAVING, JOIN conditions (to show filtering criteria)
   - Essential for understanding the query results
   - Provide context for WHY records were selected
3. **INCLUDE CONDITION COLUMNS** - Add any column referenced in WHERE, HAVING, JOIN conditions to SELECT
4. **INCLUDE CONTEXT COLUMNS** - Add minimal relevant columns that explain the business logic
5. **EXCLUDE UNNECESSARY COLUMNS** - Do NOT include all columns from primary table - be selective based on query intent
6. **CRITICAL: NO DEPENDENT TABLE COLUMNS UNLESS EXPLICITLY REQUESTED** - Do NOT include ANY columns from joined/dependent tables UNLESS they are:
   - Explicitly mentioned by name in the user query
   - Used in WHERE/HAVING conditions (filtering criteria only)
   - Absolutely essential to understand the primary entity's data
   - **NEVER include descriptive columns from dependent tables just for context**

**SELECT CLAUSE CONSTRUCTION PROCESS:**
1. **QUERY-SPECIFIC COLUMNS**: List ONLY columns directly related to the user's specific question FROM THE PRIMARY TABLE
2. **CONDITION COLUMNS**: Add ALL columns used in WHERE, HAVING, ON clauses (filtering criteria only)
3. **MINIMAL CONTEXT COLUMNS**: Add ONLY essential descriptive columns FROM THE PRIMARY TABLE that explain the results
4. **BUSINESS VALUE COLUMNS**: Add ONLY columns FROM THE PRIMARY TABLE that directly answer the user's question
5. **FILTER CRITERIA COLUMNS**: Add any column that explains WHY a record was selected
6. **CRITICAL: DEPENDENT TABLE EXCLUSION**: Do NOT add ANY columns from joined/dependent tables UNLESS:
   - The column is explicitly mentioned by name in the user query
   - The column is used in WHERE/HAVING conditions (show filtering criteria)
   - The user specifically asks for data from that dependent table

**EXAMPLES OF PROPER SELECTIVE COLUMN SELECTION:**

❌ WRONG (includes unnecessary dependent table columns): SELECT p.patient_name, p.age, p.gender, m.medication_name, m.dosage, m.frequency, m.safety_status FROM patients p JOIN medications m ON p.patient_id = m.patient_id WHERE m.dosage > 100

✅ CORRECT (query-focused, primary table focus): SELECT p.patient_name, p.age, m.dosage FROM patients p JOIN medications m ON p.patient_id = m.patient_id WHERE m.dosage > 100

❌ WRONG (includes all columns from both tables): SELECT lr.test_date, lr.test_type, lr.glucose_level, lr.cholesterol_level, p.patient_name, p.age, p.gender, p.diagnosis FROM lab_results lr JOIN patients p ON lr.patient_id = p.patient_id WHERE lr.glucose_level > 200

✅ CORRECT (focused on glucose query, excludes unnecessary dependent table columns): SELECT lr.test_date, lr.glucose_level FROM lab_results lr JOIN patients p ON lr.patient_id = p.patient_id WHERE lr.glucose_level > 200

❌ WRONG (includes unnecessary medication details): SELECT p.patient_name, p.age, p.diagnosis, m.medication_name, m.dosage, m.frequency, m.therapeutic_class FROM patients p JOIN medications m ON p.patient_id = m.patient_id WHERE p.diagnosis LIKE '%diabetes%'

✅ CORRECT (patient-focused query, minimal dependent table data): SELECT p.patient_name, p.age, p.diagnosis FROM patients p JOIN medications m ON p.patient_id = m.patient_id WHERE p.diagnosis LIKE '%diabetes%'

**CRITICAL: If you use a column in ANY part of the query (WHERE, JOIN, ORDER BY, GROUP BY, HAVING), you MUST include it in the SELECT clause unless it's an ID column.**

**SELECTIVITY PRINCIPLE: Only include columns that directly relate to answering the user's specific question. Avoid including all available columns.**

**STRUCTURED QUERY REQUIREMENT: Make the query in a structured way to represent the real meaning of user prompt.**
- Organize the query logic to clearly reflect the user's intent
- Use appropriate clause ordering (SELECT, FROM, JOIN, WHERE, GROUP BY, HAVING, ORDER BY)
- Structure JOINs logically based on data relationships
- Ensure GROUP BY and aggregations accurately represent what the user is asking for
- Make the query readable and self-documenting of the user's request
===============================

MANDATORY STEP-BY-STEP PROCESS (YOU MUST FOLLOW THESE EXACT STEPS IN ORDER):

STEP 1: LIST ALL TABLES
- Run sql_db_list_tables() to see ALL available tables
- Document the complete list of tables you find
- **CRITICAL: NEVER use any table name that is not in this list**
${Array.isArray(availableTables) && availableTables.length > 0 ? `- **REFERENCE**: Expected tables include: ${availableTables.join(', ')}
- **VALIDATION**: Confirm each expected table exists in sql_db_list_tables() results` : ''}
- This step is MANDATORY and must be performed FIRST

STEP 2: IDENTIFY RELEVANT TABLES WITH STRICT ENTITY FOCUS
- Based on the user query, identify which tables from the DISCOVERED LIST are likely to contain the requested information
- **CRITICAL: ONLY choose tables that exist in the sql_db_list_tables() results**
- **CRITICAL: Identify the PRIMARY ENTITY** that the user is asking about (e.g., patients, medications, diagnoses)
- **CRITICAL: The PRIMARY ENTITY table should return COMPLETE records (all non-ID columns)**
- **CRITICAL: Related tables should provide columns used in filtering/conditions AND relevant context**
- For each potentially relevant table, explicitly state why you believe it's needed
- Document your table selection decisions with clear reasoning
- **CRITICAL CONDITION-BASED TABLE SELECTION RULE:**
  * **If multiple tables have similar or overlapping meanings/purposes, ALWAYS choose the table that contains the CONDITION COLUMNS from the user query**
  * **PRIORITIZE tables where the user's WHERE/HAVING/filtering conditions can be applied**
  * **Only go to those tables where the user query condition lies - avoid tables that don't have the filtering criteria**
  * **Example: If user asks "patients with high glucose", choose the table that has glucose columns, not just patient demographics**
  * **Example: If user asks "medications with dosage > 100mg", choose the table that has dosage columns, not just medication names**
- EXPERT TABLE SELECTION RULES:
  * If multiple tables seem related to the same medical concept (e.g., multiple patient tables, test tables, etc.), analyze the query context carefully
  * Choose tables based on QUERY SPECIFICITY: More specific user requirements should guide you to more specialized tables
  * Consider RECENCY: If query mentions "recent" or "latest", prefer tables that likely contain current/active data
  * Consider COMPLETENESS: If query asks for comprehensive data, prefer main/primary tables over auxiliary ones
  * Consider DATA GRANULARITY: Match table granularity to query needs (patient-level vs visit-level vs test-level data)
  * When confused between similar tables, prioritize based on the PRIMARY ACTION in the user query (diagnosis → diagnostic tables, medication → drug tables, etc.)

STEP 3: EXPLORE SCHEMA OF EACH RELEVANT TABLE
- For EACH table identified in Step 2, run sql_db_schema("table_name")
- Document ALL columns, data types, and constraints for each table
- **CRITICAL: Create a comprehensive list of ALL column names for SELECT clause construction**
- **CRITICAL: NEVER use any column name that is not discovered in this step**
- **CRITICAL: Use exact column names and case as discovered - no modifications or assumptions**
- **CRITICAL: Create a "DISCOVERED COLUMNS" list for each table before writing any SQL**
- **CRITICAL: If user mentions a concept (like 'test name'), find the ACTUAL column name in the schema (might be 'test_type', 'name', etc.)**
- Look specifically for:
  * Primary keys and their naming patterns (to EXCLUDE from SELECT)
  * Foreign key relationships (to EXCLUDE from SELECT unless needed for context)
  * Columns related to the user's query intent (to INCLUDE in SELECT)
  * Date/time fields for temporal queries (to INCLUDE in SELECT)
  * Status/flag fields for condition checking (to INCLUDE in SELECT)
  * Descriptive fields that provide business context (to INCLUDE in SELECT)
- This step is MANDATORY for EVERY relevant table
- SMART TABLE COMPARISON: If you discover multiple tables with similar schemas, compare them and choose the one that:
  * **MOST IMPORTANT: Contains the CONDITION COLUMNS from the user query (e.g., glucose_level, dosage, risk_category)**
  * **Has the exact columns needed for WHERE/HAVING clauses in the user query**
  * Has more columns relevant to the user's specific query
  * Contains the exact data types mentioned in the query
  * Has better foreign key relationships for joining
  * Appears to be the primary/main table (usually has more comprehensive data)
- **CONDITION-COLUMN PRIORITY RULE:**
  * **If user asks about "high glucose patients", prioritize tables with glucose columns**
  * **If user asks about "expensive medications", prioritize tables with cost/price columns**
  * **If user asks about "recent lab results", prioritize tables with date columns and result data**
  * **Always choose the table that can fulfill the filtering conditions directly**

STEP 4: MAP QUERY REQUIREMENTS TO SCHEMA WITH SELECTIVE COLUMN APPROACH
- Create an explicit mapping between the user's requirements and the discovered schema
- **CRITICAL: Identify the PRIMARY ENTITY** the user is asking about
- **CRITICAL: For the PRIMARY ENTITY table, list ONLY relevant column names (NO asterisk, NO table.*)**
- **SELECTIVE APPROACH: Only include columns that:**
  * Are directly mentioned in the user query
  * Are used in WHERE conditions (MANDATORY - include in SELECT to show filtering criteria)
  * Are used in JOIN conditions (if they provide business context, not just IDs)
  * Are specifically requested by the user
  * Are essential for understanding the query results
  * Provide minimal necessary context about why records were selected
- **CRITICAL: Exclude ID columns unless they provide specific business value**
- **CRITICAL: Do NOT include all available columns - be selective based on query intent**
- For each element in the user query, list:
  * The table(s) containing relevant data
  * The specific column(s) actually needed to answer the question
  * Any join conditions required
  * Filtering or condition columns
  * Minimal context columns that explain the business logic
- This step ensures you include ONLY what's needed to answer the user's question
- RESOLVE TABLE CONFLICTS: If multiple tables could satisfy the same requirement, choose based on:
  * **PRIORITY 1: CONDITION COLUMNS - Choose the table that contains the columns needed for WHERE/HAVING clauses**
  * **PRIORITY 2: Data completeness (table with more comprehensive information)**
  * **PRIORITY 3: Query specificity (more specialized table for specific queries)**
  * **PRIORITY 4: Join efficiency (table that requires fewer complex joins)**
- **CONDITION-FIRST TABLE SELECTION:**
  * **Always prioritize the table that can directly satisfy the user's filtering conditions**
  * **If user mentions specific values/ranges/conditions, choose the table with those exact columns**
  * **Avoid unnecessary joins to tables that don't contain the condition columns**

STEP 5: VERSION-COMPATIBLE SQL QUERY CONSTRUCTION
🎯 **CRITICAL VERSION-AWARE SQL GENERATION RULES:**
- **GENERATE VERSION-COMPATIBLE SQL**: Create SQL that strictly follows the version constraints of ${databaseType.toUpperCase()} ${databaseVersionString}
- **CHECK VERSION FEATURES BEFORE USING**: For each SQL feature or function, verify it's supported in this specific version
- **HONOR VERSION LIMITATIONS**: Avoid ANY syntax not explicitly supported by this version
- **FOLLOW VERSION-SPECIFIC PATTERNS**: Especially for GROUP BY clauses based on database mode settings
- **VALIDATE SYNTAX**: Ensure the SQL is syntactically correct AND compatible with this specific version
- **USE DISCOVERED SCHEMA**: Only use table and column names that you discovered through schema exploration

🚨 **CRITICAL MySQL GROUP BY COMPLIANCE (sql_mode=only_full_group_by):**
${databaseType.toLowerCase() === 'mysql' ? `
**MANDATORY GROUP BY RULES FOR MySQL:**
1. **ALL non-aggregated columns in SELECT MUST be in GROUP BY clause**
2. **If using ANY aggregation function (COUNT, SUM, AVG, MAX, MIN), ALL other non-aggregated SELECT columns MUST be in GROUP BY**
3. **NEVER mix aggregated and non-aggregated columns without proper GROUP BY**
4. **Every column in SELECT that is not an aggregate function MUST appear in GROUP BY**

**CORRECT MySQL PATTERNS:**
✅ SELECT col1, col2, COUNT(*) FROM table GROUP BY col1, col2;
✅ SELECT col1, AVG(col2) FROM table GROUP BY col1;
✅ SELECT * FROM table WHERE condition; (no aggregation, no GROUP BY needed)
✅ SELECT COUNT(*) FROM table; (only aggregation, no GROUP BY needed)

**INCORRECT MySQL PATTERNS (WILL FAIL WITH sql_mode=only_full_group_by):**
❌ SELECT col1, col2, COUNT(*) FROM table GROUP BY col1; (col2 missing from GROUP BY)
❌ SELECT col1, AVG(col2) FROM table; (col1 not in GROUP BY when using aggregation)
❌ SELECT gender, dob, risk_score FROM table GROUP BY gender, dob, patient_id HAVING AVG(risk_score) > 2;
   (risk_score is not aggregated and not in GROUP BY - MUST be AVG(risk_score) in SELECT)

**MySQL GROUP BY FIX STRATEGIES:**
- **Strategy 1**: If using aggregation, either aggregate ALL columns OR include them in GROUP BY
- **Strategy 2**: If NOT using aggregation, remove GROUP BY entirely
- **Strategy 3**: Move non-aggregated columns to GROUP BY clause

**EXAMPLES OF FIXES:**
❌ BROKEN: SELECT patients.gender, patients.dob, current_risk_regimen.risk_score, medication_report.evidence 
          FROM current_risk_regimen 
          JOIN medication_report ON current_risk_regimen.patient_id = medication_report.record_id 
          JOIN patients ON current_risk_regimen.patient_id = patients.patient_id 
          GROUP BY patients.gender, patients.dob, current_risk_regimen.patient_id 
          HAVING AVG(current_risk_regimen.risk_score) > 2;

✅ FIXED: SELECT patients.gender, patients.dob, AVG(current_risk_regimen.risk_score) as avg_risk_score, medication_report.evidence
         FROM current_risk_regimen 
         JOIN medication_report ON current_risk_regimen.patient_id = medication_report.record_id 
         JOIN patients ON current_risk_regimen.patient_id = patients.patient_id 
         WHERE medication_report.evidence = 'Strong'
         GROUP BY patients.gender, patients.dob, medication_report.evidence
         HAVING AVG(current_risk_regimen.risk_score) > 2;

**CRITICAL: Every query with aggregation functions MUST comply with only_full_group_by mode**` : ''}

**🔧 MANDATORY COLUMN VALIDATION PROCESS:**
Before writing any SELECT, WHERE, JOIN, or other SQL clause:
1. **LIST ALL DISCOVERED COLUMNS**: Document every column from sql_db_schema() for each table
2. **MAP USER CONCEPTS TO ACTUAL COLUMNS**: If user asks for "test name", find the actual column (might be 'name', 'test_type', 'description', etc.)
3. **VERIFY EVERY COLUMN**: Before using any column name, confirm it exists in your documented list
4. **NO SUBSTITUTIONS**: Do not substitute similar column names - use only exact matches
5. **DOCUMENT MAPPING**: Show your column mapping (e.g., "User wants 'test name' → Actual column is 'test_type'")

**COMMON COLUMN NAME MISTAKES TO AVOID:**
❌ Assuming 'test_name' exists when schema only has 'test_type' or 'name'
❌ Assuming 'patient_name' exists when schema only has 'name' or 'full_name'
❌ Using descriptive names like 'medication_name' without verification
❌ Guessing column names based on table purpose instead of discovering them

**🔧 MANDATORY SYNTAX VALIDATION BEFORE QUERY GENERATION:**
- **COMPLETE SUBQUERIES**: Every EXISTS clause MUST have a complete subquery with proper SELECT statement
- **PARENTHESES MATCHING**: Every opening parenthesis ( must have a matching closing parenthesis )
- **COMPLETE CONDITIONS**: Every WHERE condition must be complete and syntactically valid
- **PROPER SEMICOLON**: Every query must end with exactly one semicolon (;)
- **NO ORPHANED KEYWORDS**: Keywords like EXISTS, IN, BETWEEN must be followed by complete expressions

**EXAMPLES OF CORRECT EXISTS SYNTAX:**
✅ WHERE EXISTS (SELECT 1 FROM table2 WHERE condition)
✅ WHERE column IN (SELECT column FROM table2 WHERE condition)
✅ WHERE EXISTS (SELECT * FROM related_table WHERE related_table.id = main_table.id AND condition)

**EXAMPLES OF INCORRECT SYNTAX TO AVOID:**
❌ WHERE EXISTS ( -- incomplete
❌ WHERE EXISTS () -- empty subquery
❌ WHERE EXISTS (SELECT -- incomplete subquery
❌ WHERE condition AND EXISTS ( -- incomplete

**SQL STRUCTURE REQUIREMENTS:**
- Start with a clear SELECT statement
- Use proper FROM clause with discovered table names
- Add appropriate JOIN clauses based on discovered relationships
- Include WHERE conditions using discovered column names
- **CRITICAL: Ensure GROUP BY compliance for MySQL (every non-aggregated SELECT column must be in GROUP BY)**
- End with semicolon
- **CRITICAL: Avoid complex nested queries, CTEs, or subqueries unless essential**

**SIMPLE SQL PATTERN:**
SELECT discovered_columns
FROM primary_table_from_schema
JOIN additional_tables ON discovered_relationships (if needed)
WHERE conditions_using_discovered_columns
GROUP BY discovered_columns (if needed)
ORDER BY discovered_columns (if needed)
LIMIT number (if needed);

**🚫 ABSOLUTE PROHIBITIONS - NEVER GENERATE THESE:**
- ❌ Complex nested subqueries with ") SELECT" patterns
- ❌ Malformed CTE structures
- ❌ Multiple disconnected SELECT statements
- ❌ SQL with syntax errors or orphaned parentheses
- ❌ Incomplete EXISTS clauses (e.g., "EXISTS (" without proper subquery)
- ❌ Incomplete subqueries or missing closing parentheses
- ❌ References to non-existent tables or columns
- ❌ Hardcoded table/column names without schema validation
- ❌ Using table or column names not discovered through sql_db_list_tables() and sql_db_schema()
- ❌ Assuming column names exist without verification
- ❌ Using similar/guessed table names instead of exact discovered names
- ❌ Using similar/guessed column names instead of exact discovered names (e.g., using 'test_name' when schema only has 'test_type')
- ❌ Assuming descriptive column names exist without verification (e.g., 'patient_name', 'test_name', 'medication_name')
- ❌ SQL features not supported by this specific database version ${databaseVersionString}
- ❌ Malformed WHERE clauses with incomplete conditions
- ❌ Orphaned opening or closing parentheses

**✅ ALWAYS GENERATE THESE:**
- ✅ Simple, clean SELECT statements
- ✅ Proper JOIN syntax using discovered schema relationships
- ✅ Valid WHERE clauses with discovered column names
- ✅ Complete, syntactically correct SQL with proper parentheses matching
- ✅ Well-formed EXISTS clauses with complete subqueries
- ✅ Syntactically correct, executable SQL
- ✅ Schema-validated table and column references
- ✅ Version-compatible syntax that works with ${databaseType.toUpperCase()} ${databaseVersionString}
- ✅ Properly closed parentheses for all subqueries and conditions

**CRITICAL SELECT CLAUSE CONSTRUCTION:**
  * **NEVER use asterisk (*) or table.* syntax**
  * **List only relevant column names explicitly**
  * **For PRIMARY ENTITY table: Include ONLY columns that directly relate to the user's question**
  * **For related tables: Include columns that are:**
    - Used in WHERE conditions (MANDATORY - users need to see WHY records were selected)
    - Used in HAVING conditions (MANDATORY)
    - Explicitly mentioned by name in the user query
    - **NEVER include descriptive/context columns from dependent tables unless explicitly requested**
    - **NEVER include all available columns from joined tables**
  * **Be selective**: Don't include every available column - focus on what answers the user's question
  * **Include contextual columns**: Add minimal relevant descriptive fields FROM THE PRIMARY TABLE ONLY
  * **Exclude pure ID columns**: Don't include columns that are just numeric IDs unless specifically needed
  * **CRITICAL DEPENDENT TABLE RULE**: Only include columns from joined/dependent tables if they are:
    - Explicitly mentioned in the user query by name
    - Used in filtering conditions (WHERE/HAVING)
    - Absolutely essential for understanding the primary entity (very rare)

**🔧 FINAL QUERY VALIDATION CHECKLIST:**
Before generating any SQL query, verify:
1. ✅ Every opening parenthesis ( has a matching closing parenthesis )
2. ✅ Every EXISTS clause has a complete SELECT subquery inside parentheses
3. ✅ Every IN clause has a complete subquery or value list inside parentheses
4. ✅ The query ends with exactly one semicolon (;)
5. ✅ No incomplete WHERE conditions or orphaned keywords
6. ✅ All table and column references use discovered schema names
7. ✅ The query is syntactically valid and executable
8. ✅ **SCHEMA VALIDATION**: Every table name was discovered in sql_db_list_tables()
9. ✅ **SCHEMA VALIDATION**: Every column name was discovered in sql_db_schema()
10. ✅ **NO ASSUMPTIONS**: No hardcoded or guessed table/column names used
11. ✅ **COLUMN NAME VERIFICATION**: Each column used in the query was verified to exist in the actual schema
12. ✅ **NO SIMILAR NAME SUBSTITUTION**: Did not use similar-sounding column names that don't actually exist

**CRITICAL: If any of these checks fail, rewrite the query to fix the syntax issues.**

Start with STEP 1 - list all tables now.
`;

        return enhancedQuery.trim();
    }

    /**
     * Creates a simple enhanced query for basic cases
     */
    static createSimpleEnhancedQuery(query: string, context?: string): string {
        return context ? `${context}\n\nUser Query: ${query}` : query;
    }

    /**
     * Creates an enhanced query specifically for structured query generation (Azure OpenAI restructuring)
     * with full database schema context
     */
    static createStructuredEnhancedQuery(params: StructuredQueryParams): string {
        const {
            query,
            organizationId,
            databaseType,
            databaseVersionString,
            databaseVersionInfo,
            availableTables = [],
            tableSchemas = {},
            originalQuery
        } = params;

        // Create database schema context
        let schemaContext = '';
        if (Object.keys(tableSchemas).length > 0) {
            schemaContext = `
=== COMPLETE DATABASE SCHEMA ===
Database: ${databaseType.toUpperCase()} ${databaseVersionString}
Organization: ${organizationId}

Available Tables and Their Columns:
${Object.entries(tableSchemas).map(([tableName, columns]) => `
**${tableName}:**
${columns.map(col => `  - ${col.column_name || col.name} (${col.data_type || col.type})`).join('\n')}
`).join('')}

**CRITICAL SCHEMA CONSTRAINTS:**
- ONLY use tables from the list above: ${Object.keys(tableSchemas).join(', ')}
- ONLY use column names exactly as listed above
- Verify every table and column reference against this schema
- Do NOT assume any column names not explicitly listed
========================
`;
        } else if (availableTables.length > 0) {
            schemaContext = `
=== AVAILABLE TABLES ===
Database: ${databaseType.toUpperCase()} ${databaseVersionString}
Available Tables: ${availableTables.join(', ')}

**WARNING: Full column schema not provided. You MUST discover columns using appropriate schema discovery methods.**
========================
`;
        }

        // Create version-specific instructions for structured queries
        const versionInstructions = databaseVersionInfo ? `
=== DATABASE VERSION COMPATIBILITY ===
Database: ${databaseType.toUpperCase()} ${databaseVersionInfo.full}
- JSON Support: ${databaseVersionInfo.supportsJSON ? 'AVAILABLE' : 'NOT AVAILABLE - Avoid JSON functions'}
- Window Functions: ${databaseVersionInfo.supportsWindowFunctions ? 'AVAILABLE' : 'NOT AVAILABLE'}
- CTEs (WITH clause): ${databaseVersionInfo.supportsCTE ? 'AVAILABLE' : 'NOT AVAILABLE'}
- GROUP BY Mode: ${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo.hasOnlyFullGroupBy ? 'STRICT only_full_group_by' : 'Standard'}

${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo.hasOnlyFullGroupBy ? `
**CRITICAL: MySQL only_full_group_by mode is ENABLED**
- ALL non-aggregated columns in SELECT must appear in GROUP BY
- When using aggregation functions, ensure GROUP BY compliance
` : ''}
========================
` : '';

        const structuredQuery = `
🎯 You are an expert SQL query restructuring specialist. Your task is to generate a WORKING, optimized SQL query with proper database schema validation.

${schemaContext}${versionInstructions}

**🚨 CRITICAL SCHEMA VALIDATION FOR STRUCTURED QUERIES:**
1. **MANDATORY SCHEMA ADHERENCE**: ONLY use tables and columns from the provided schema above
2. **EXACT NAME MATCHING**: Use table and column names exactly as listed in the schema
3. **NO ASSUMPTIONS**: Do not assume any column exists that is not explicitly listed
4. **VERSION COMPATIBILITY**: Ensure all SQL features are compatible with ${databaseType.toUpperCase()} ${databaseVersionString}
5. **SYNTAX VALIDATION**: Generate syntactically correct, executable SQL

**USER QUERY:** "${query}"
${originalQuery ? `**ORIGINAL QUERY CONTEXT:** "${originalQuery}"` : ''}

**STRUCTURED QUERY REQUIREMENTS:**
1. **Use Discovered Schema Only**: Reference only tables and columns from the schema provided above
2. **Optimize for Performance**: Structure the query efficiently with proper indexing considerations
3. **Maintain Data Accuracy**: Ensure the restructured query returns equivalent results
4. **Version Compatibility**: Use only SQL features supported by the database version
5. **Clear Logic Flow**: Organize query components (CTEs, subqueries, joins) logically

**CRITICAL COLUMN VALIDATION PROCESS:**
Before using ANY column in your restructured query:
1. Verify the table exists in the schema above
2. Verify the exact column name exists in that table's column list
3. Use the exact column name as listed (case-sensitive)
4. Do not substitute similar-sounding column names

**COMMON COLUMN NAME ERRORS TO AVOID:**
❌ Using 'test_name' when schema shows 'test_type' or 'name'
❌ Using 'patient_name' when schema shows 'name' or 'full_name'
❌ Assuming descriptive columns exist without verification
❌ Using camelCase when schema shows snake_case or vice versa

**SQL STRUCTURE GUIDELINES:**
- Start with simple, clear SELECT statements
- Use CTEs for complex logic organization (if supported by database version)
- Apply proper JOIN syntax based on discovered relationships
- Include appropriate WHERE clauses for data filtering
- Ensure GROUP BY compliance for aggregation queries
- End with proper semicolon termination

**FINAL VALIDATION CHECKLIST:**
✅ Every table name exists in the provided schema
✅ Every column name exists in its respective table schema
✅ SQL syntax is compatible with ${databaseType.toUpperCase()} ${databaseVersionString}
✅ Query logic accurately represents the user's intent
✅ All parentheses are properly matched
✅ Query ends with a single semicolon

Generate an optimized, schema-validated SQL query that answers: "${query}"
`;

        return structuredQuery.trim();
    }

    /**
     * Helper method to format database schema information for query generation
     */
    static formatDatabaseSchema(
        availableTables: string[], 
        tableSchemas: Record<string, any[]>, 
        databaseType: string, 
        version: string
    ): string {
        if (Object.keys(tableSchemas).length === 0) {
            return `
=== DATABASE STRUCTURE ===
Database: ${databaseType.toUpperCase()} ${version}
Available Tables: ${availableTables.join(', ')}

**WARNING: Column details not available. Schema discovery required.**
========================
`;
        }

        return `
=== COMPLETE DATABASE SCHEMA ===
Database: ${databaseType.toUpperCase()} ${version}

${Object.entries(tableSchemas).map(([tableName, columns]) => `
**TABLE: ${tableName}**
${columns.map(col => {
    const name = col.column_name || col.name || col.field;
    const type = col.data_type || col.type;
    const nullable = col.is_nullable ? ' (nullable)' : '';
    const key = col.column_key || col.key || '';
    const keyInfo = key === 'PRI' ? ' [PRIMARY KEY]' : key === 'MUL' ? ' [INDEX]' : '';
    return `  • ${name} (${type})${nullable}${keyInfo}`;
}).join('\n')}
`).join('')}

**SCHEMA VALIDATION RULES:**
✅ Use ONLY these tables: ${Object.keys(tableSchemas).join(', ')}
✅ Use ONLY the column names listed above (exact case matching)
❌ Do NOT assume any columns not explicitly listed
❌ Do NOT use similar-sounding column names without verification
========================
`;
    }

    /**
     * Creates a comprehensive query with both SQL Agent and structured query support
     */
    static createUniversalEnhancedQuery(params: StructuredQueryParams): string {
        const {
            query,
            organizationId,
            databaseType,
            databaseVersionString,
            databaseVersionInfo,
            availableTables = [],
            tableSchemas = {},
            originalQuery
        } = params;

        // Format schema information
        const schemaInfo = this.formatDatabaseSchema(availableTables, tableSchemas, databaseType, databaseVersionString);

        // Create version instructions
        const versionInstructions = databaseVersionInfo ? `
=== VERSION COMPATIBILITY ===
${databaseType.toUpperCase()} ${databaseVersionInfo.full}
- JSON Functions: ${databaseVersionInfo.supportsJSON ? '✅ Supported' : '❌ Not Available'}
- Window Functions: ${databaseVersionInfo.supportsWindowFunctions ? '✅ Supported' : '❌ Not Available'}
- CTEs (WITH): ${databaseVersionInfo.supportsCTE ? '✅ Supported' : '❌ Not Available'}
- GROUP BY Mode: ${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo.hasOnlyFullGroupBy ? '⚠️ Strict only_full_group_by' : '✅ Standard'}
========================
` : '';

        return `
🎯 **UNIVERSAL SQL QUERY GENERATOR**
You are an expert database analyst capable of generating accurate SQL queries with complete schema validation.

${schemaInfo}${versionInstructions}

**TARGET QUERY:** "${query}"
${originalQuery ? `**ORIGINAL CONTEXT:** "${originalQuery}"` : ''}

**🚨 ABSOLUTE REQUIREMENTS:**
1. **SCHEMA VALIDATION**: Use ONLY tables and columns from the schema above
2. **EXACT NAMING**: Use table/column names exactly as listed (case-sensitive)
3. **VERSION COMPLIANCE**: Use only features supported by ${databaseType.toUpperCase()} ${databaseVersionString}
4. **SYNTAX ACCURACY**: Generate syntactically perfect, executable SQL

**QUERY GENERATION PROCESS:**
1. **Identify Required Tables**: Choose tables that contain the data needed for the query
2. **Map User Intent**: Translate user requirements to specific table columns from the schema
3. **Construct Query**: Build SQL using discovered schema elements only
4. **Validate Syntax**: Ensure proper parentheses, semicolons, and SQL structure
5. **Version Check**: Confirm all features are supported by the database version

${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo?.hasOnlyFullGroupBy ? `
**🚨 CRITICAL: MySQL only_full_group_by Compliance**
- Every non-aggregated column in SELECT MUST be in GROUP BY
- Example: SELECT col1, col2, COUNT(*) FROM table GROUP BY col1, col2
- Invalid: SELECT col1, col2, COUNT(*) FROM table GROUP BY col1
` : ''}

**FINAL VALIDATION:**
✅ All table names exist in the provided schema
✅ All column names exist in their respective tables
✅ SQL syntax is valid and complete
✅ Features are compatible with database version
✅ Query logic matches user intent

Generate the SQL query now.
`.trim();
    }
}

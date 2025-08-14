import {
  ComprehensiveQueryParams,
  TableRelevancePromptParams,
  VersionSpecificInstructionsParams,
} from "../types/promptTypes";

export function generateTableRelevancePrompt({
  query,
  schemaDescription,
}: TableRelevancePromptParams): string {
  return `You are a database schema analyst helping an SQL agent choose the correct tables for a specific query. 

User Query: "${query}"

Database Tables: ${schemaDescription}

Based on the user's specific query "${query}", analyze each table name and provide targeted descriptions that help the SQL agent understand which tables are most relevant for this specific query. Focus on:
1. Which tables likely contain the data needed for this specific query
2. Which tables should be prioritized for this type of question
3. Which tables might be confused with each other and clarify the differences

Provide descriptions in this format:
**Table: table_name** - Relevance to query "${query}": [High/Medium/Low] - Brief description focusing on why this table is/isn't suitable for this specific query

Keep descriptions concise (1-2 sentences) and focus on helping the SQL agent choose the RIGHT tables for this specific user query.`;
}



export function generateVersionSpecificInstructions({
  databaseType,
  databaseVersionInfo
}: VersionSpecificInstructionsParams): string {
  if (!databaseVersionInfo) return "";

  return `
${databaseType.toUpperCase()} VERSION INFO: Your query will run on ${databaseType.toUpperCase()} ${
    databaseVersionInfo.full
  } (${databaseVersionInfo.major}.${databaseVersionInfo.minor}.${databaseVersionInfo.patch})

VERSION-SPECIFIC COMPATIBILITY:
- JSON Functions (e.g., JSON_EXTRACT): ${
    databaseVersionInfo.supportsJSON ? "AVAILABLE ✅" : "NOT AVAILABLE ❌"
  }
- Window Functions (e.g., ROW_NUMBER()): ${
    databaseVersionInfo.supportsWindowFunctions ? "AVAILABLE ✅" : "NOT AVAILABLE ❌"
  }
- Common Table Expressions (WITH): ${
    databaseVersionInfo.supportsCTE ? "AVAILABLE ✅" : "NOT AVAILABLE ❌"
  }
- Regular Expressions: AVAILABLE ✅
${
  databaseType.toLowerCase() === "mysql"
    ? `- MySQL only_full_group_by mode: ${
        databaseVersionInfo.hasOnlyFullGroupBy
          ? "ENABLED 🚨 (STRICT GROUP BY REQUIRED)"
          : "DISABLED ✅"
      }`
    : ""
}

🚨 CRITICAL MySQL GROUP BY COMPLIANCE (sql_mode=only_full_group_by):
${
  databaseType.toLowerCase() === "mysql" && databaseVersionInfo.hasOnlyFullGroupBy
    ? `
**🚨 ONLY_FULL_GROUP_BY MODE IS ENABLED - STRICT COMPLIANCE REQUIRED:**
1. **ALL non-aggregated columns in SELECT MUST be in GROUP BY clause**
2. **If using aggregation functions (COUNT, SUM, AVG, MAX, MIN), ALL other SELECT columns MUST be in GROUP BY**
3. **NEVER mix aggregated and non-aggregated columns without proper GROUP BY**

**CORRECT PATTERN:**
✅ SELECT column1, column2, COUNT(*) FROM table GROUP BY column1, column2;
✅ SELECT column1, AVG(column2) FROM table GROUP BY column1;
✅ SELECT * FROM table WHERE condition; (no aggregation)

**INCORRECT PATTERN (WILL FAIL):**
❌ SELECT column1, column2, COUNT(*) FROM table GROUP BY column1; (missing column2 in GROUP BY)
❌ SELECT column1, AVG(column2) FROM table; (missing GROUP BY when using aggregation)
❌ SELECT column1, column2, risk_score FROM table GROUP BY column1, column2, patient_id HAVING AVG(risk_score) > 2; (risk_score not aggregated but not in GROUP BY)

**FIX STRATEGY:**
- If using aggregation: Either aggregate ALL columns (COUNT, MAX, MIN, etc.) OR include them in GROUP BY
- If NOT using aggregation: Remove GROUP BY entirely
- Example fix: SELECT column1, column2, AVG(risk_score) FROM table GROUP BY column1, column2 HAVING AVG(risk_score) > 2;

**MYSQL sql_mode=only_full_group_by COMPLIANCE IS ABSOLUTELY MANDATORY**`
    : databaseType.toLowerCase() === "mysql"
    ? "**MySQL GROUP BY COMPLIANCE**: Ensure proper GROUP BY usage for any aggregation queries"
    : ""
}

CRITICAL: Use ONLY SQL features compatible with this ${databaseType.toUpperCase()} version. Avoid any syntax not supported by ${databaseVersionInfo.full}.
`;
}

export function generateEnhancedQueryPrompt({
  databaseType,
  databaseVersionString,
  organizationId,
  versionSpecificInstructions,
  query,
  databaseVersionInfo,
  tableDescriptions,
  conversationalContext,
}: ComprehensiveQueryParams): string {
  return `
🎯 You are an expert SQL database analyst. Your task is to generate a WORKING SQL query that answers the user's question.

**CRITICAL VERSION REQUIREMENTS:**
1. You MUST strictly follow the database version compatibility rules provided below
2. Any SQL features not supported by the detected version MUST be avoided
3. Version-specific query patterns MUST be followed exactly, especially for GROUP BY clauses

**MANDATORY DATABASE VERSION ANALYSIS:**
- Type: ${databaseType?.toUpperCase()}
- Version: ${databaseVersionString}
- Organization: ${organizationId}

${versionSpecificInstructions}

**USER QUERY:** "${query}"

**VERSION-AWARE STEP-BY-STEP PROCESS:**

**STEP 1: DISCOVER TABLES**
- Use sql_db_list_tables() to see all available tables
- Document what tables exist

**STEP 2: EXAMINE RELEVANT SCHEMAS** 
- Use sql_db_schema("table_name") for tables that might contain data for the user's query
- Focus on tables that match the user's question topic (patients, medications, lab results, etc.)

**STEP 3: GENERATE VERSION-COMPATIBLE SQL**
- Create a SQL query compatible with ${databaseType?.toUpperCase()} ${databaseVersionString}
- Use explicit column names (NO SELECT *)
- Include columns mentioned in user query + minimal context columns
- Include WHERE conditions if user specifies filters
- If using MySQL with only_full_group_by mode: Strictly ensure all non-aggregated columns in SELECT appear in GROUP BY
- Avoid any syntax features not supported by this database version

**VERSION-COMPATIBLE QUERY EXAMPLES:**
${
  databaseType?.toLowerCase() === "mysql" &&
  databaseVersionInfo &&
  databaseVersionInfo.hasOnlyFullGroupBy
    ? `
- ✅ For "patients with count": SELECT patient_id, gender, COUNT(*) FROM patients GROUP BY patient_id, gender;
- ✅ For "average risk score by gender": SELECT gender, AVG(risk_score) FROM patients GROUP BY gender;
- ✅ For "high risk patients": SELECT patient_id, risk_category FROM risk_details WHERE risk_category = 'High';
- ❌ AVOID: SELECT patient_id, gender, COUNT(*) FROM patients GROUP BY patient_id; (missing gender in GROUP BY)
- ❌ AVOID: SELECT risk_score, patient_name FROM risk_details GROUP BY patient_id; (columns not in GROUP BY)
`
    : `
- For "show patients": SELECT patient_id, gender, dob, state, city FROM patients LIMIT 10;
- For "medications": SELECT patient_id, medications FROM patients WHERE medications IS NOT NULL LIMIT 10;
- For "high risk": SELECT record_id, risk_category, risk_score FROM risk_details WHERE risk_category LIKE '%High%' LIMIT 10;
`
}

**CRITICAL VERSION-SPECIFIC COMPATIBILITY CHECKS:**
${
  databaseType?.toLowerCase() === "mysql"
    ? `
- JSON Functions: ${
        databaseVersionInfo && databaseVersionInfo.supportsJSON
          ? "Available - OK to use"
          : "NOT AVAILABLE - DO NOT USE JSON_EXTRACT or other JSON functions"
      }
- Window Functions: ${
        databaseVersionInfo && databaseVersionInfo.supportsWindowFunctions
          ? "Available - OK to use ROW_NUMBER(), etc."
          : "NOT AVAILABLE - DO NOT USE any window functions like ROW_NUMBER()"
      }
- CTEs (WITH clause): ${
        databaseVersionInfo && databaseVersionInfo.supportsCTE
          ? "Available - OK to use"
          : "NOT AVAILABLE - DO NOT USE WITH clause or CTEs"
      }
- GROUP BY Mode: ${
        databaseVersionInfo && databaseVersionInfo.hasOnlyFullGroupBy
          ? "STRICT - all non-aggregated SELECT columns MUST be in GROUP BY"
          : "Standard - normal GROUP BY rules apply"
      }
`
    : ""
}

**CRITICAL:** Generate ONE version-compatible SQL query that directly answers: "${query}"

Start with STEP 1 - list all tables now.

=== DATABASE CONTEXT ===
Database Type: ${databaseType?.toUpperCase()}
Database Version: ${databaseVersionString}
Organization ID: ${organizationId}

${versionSpecificInstructions}

Available Features:
- Table Discovery: Use sql_db_list_tables() to explore all available tables
- Schema Analysis: Use sql_db_schema("table_name") to understand table structure
- Query Execution: Generate and execute SQL queries based on discovered schema

CRITICAL: Your queries will be executed against this specific database instance. Ensure compatibility with the version and features listed above.
========================

${tableDescriptions}

${
  conversationalContext
    ? `=== CONVERSATION CONTEXT ===${conversationalContext}========================`
    : ""
}

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
5. **EXCLUDE ID COLUMNS** - Do NOT include any columns with names ending in '_id', 'id', or primary key columns unless specifically requested
6. **EXCLUDE UNNECESSARY COLUMNS** - Do NOT include all columns from primary table - be selective based on query intent
7. **CRITICAL: NO DEPENDENT TABLE COLUMNS UNLESS EXPLICITLY REQUESTED** - Do NOT include ANY columns from joined/dependent tables UNLESS they are:
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
- This step is MANDATORY and must be performed FIRST

STEP 2: IDENTIFY RELEVANT TABLES WITH STRICT ENTITY FOCUS
- Based on the user query, identify which tables are likely to contain the requested information
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
- **GENERATE VERSION-COMPATIBLE SQL**: Create SQL that strictly follows the version constraints of ${databaseType?.toUpperCase()} ${databaseVersionString}
- **CHECK VERSION FEATURES BEFORE USING**: For each SQL feature or function, verify it's supported in this specific version
- **HONOR VERSION LIMITATIONS**: Avoid ANY syntax not explicitly supported by this version
- **FOLLOW VERSION-SPECIFIC PATTERNS**: Especially for GROUP BY clauses based on database mode settings
- **VALIDATE SYNTAX**: Ensure the SQL is syntactically correct AND compatible with this specific version
- **USE DISCOVERED SCHEMA**: Only use table and column names that you discovered through schema exploration

🚨 **CRITICAL MySQL GROUP BY COMPLIANCE (sql_mode=only_full_group_by):**
${
  databaseType?.toLowerCase() === "mysql"
    ? `
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

**CRITICAL: Every query with aggregation functions MUST comply with only_full_group_by mode**`
    : ""
}

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
- ❌ References to non-existent tables or columns
- ❌ Hardcoded table/column names without schema validation
- ❌ SQL features not supported by this specific database version ${databaseVersionString}

**✅ ALWAYS GENERATE THESE:**
- ✅ Simple, clean SELECT statements
- ✅ Proper JOIN syntax using discovered schema relationships
- ✅ Valid WHERE clauses with discovered column names
- ✅ Syntactically correct, executable SQL
- ✅ Schema-validated table and column references
- ✅ Version-compatible syntax that works with ${databaseType?.toUpperCase()} ${databaseVersionString}

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
- **STRUCTURED QUERY CONSTRUCTION REQUIREMENTS:**
  * **Structure the query to represent the real meaning of the user prompt**
  * **Organize query logic to clearly reflect user intent**
  * **Use logical clause ordering**: SELECT → FROM → JOIN → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT
  * **Structure JOINs based on actual data relationships and user requirements**
  * **Ensure GROUP BY and aggregations accurately represent what the user is asking for**
  * **Make the query self-documenting of the user's request through clear structure**
- **FOCUSED COLUMN ENUMERATION PROCESS:**
  1. Start with columns directly mentioned in the user query FROM THE PRIMARY TABLE
  2. Add all columns used in WHERE clauses from any table (filtering criteria only)
  3. Add minimal essential context columns FROM THE PRIMARY TABLE ONLY
  4. Add columns that help explain why records were selected (condition columns)
  5. Verify no asterisk (*) symbols remain in the query
  6. **Double-check**: Remove any unnecessary columns that don't directly contribute to answering the user's question
  7. **CRITICAL**: Remove ANY columns from dependent/joined tables unless explicitly mentioned in user query or used in conditions
- Start with the core tables and gradually build the query
- Implement proper JOINs based on discovered key relationships
- Implement ALL conditions from the user query - don't skip any requirements
- Add appropriate GROUP BY, ORDER BY, and HAVING clauses based on the query intent
- **Structure the entire query to logically represent the user's request**
- Double-check that ALL aspects of the user's query are addressed

STEP 6: VERSION-SPECIFIC VALIDATION AND COMPATIBILITY CHECK
🎯 **MANDATORY VERSION VALIDATION CHECKLIST:**
- **VERSION COMPATIBILITY**: Verify the SQL uses ONLY features available in ${databaseType?.toUpperCase()} ${databaseVersionString}
- **VERSION-SPECIFIC CHECKS**: Confirm compatibility with all version-specific rules like GROUP BY requirements
- **FEATURE VALIDATION**: Double-check that all functions and clauses are supported in this exact version
- **SYNTAX CHECK**: Verify the SQL has proper structure for this database version
- **NO MALFORMED PATTERNS**: Ensure there are no ") SELECT" or similar syntax errors
- **SCHEMA VALIDATION**: Confirm all table and column names were discovered through schema exploration
- **EXECUTABILITY**: Ensure the SQL can be executed without syntax errors on this specific version
- **SIMPLICITY**: Verify the query is straightforward and not overly complex

**CRITICAL VERSION-SPECIFIC VALIDATION:**
${
  databaseType?.toLowerCase() === "mysql"
    ? `
  * **JSON Functions**: ${
    databaseVersionInfo && databaseVersionInfo.supportsJSON
      ? "OK to use JSON_EXTRACT, etc."
      : "REMOVE any JSON functions - not supported in this version"
  }
  * **Window Functions**: ${
    databaseVersionInfo && databaseVersionInfo.supportsWindowFunctions
      ? "OK to use ROW_NUMBER(), etc."
      : "REMOVE any window functions - not supported in this version"
  }
  * **CTEs**: ${
    databaseVersionInfo && databaseVersionInfo.supportsCTE
      ? "OK to use WITH clause"
      : "REMOVE any WITH clauses - not supported in this version"
  }
  * **GROUP BY**: ${
    databaseVersionInfo && databaseVersionInfo.hasOnlyFullGroupBy
      ? "STRICT VALIDATION - all non-aggregated SELECT columns MUST be in GROUP BY"
      : "Standard GROUP BY rules apply"
  }
`
    : ""
}

**CRITICAL SELECT CLAUSE VALIDATION:**
  * Verify NO asterisk (*) symbols exist in the SELECT clause
  * Verify ALL columns are listed explicitly by name
  * Verify ALL condition columns from WHERE/HAVING clauses are included in SELECT
  * Verify ONLY necessary business context columns FROM THE PRIMARY TABLE are included
  * Verify ID columns are excluded unless specifically needed
  * Verify the SELECT clause is focused and answers the user's specific question
  * **REMOVE any unnecessary columns that don't directly contribute to the query intent**
  * **CRITICAL: Verify NO columns from dependent/joined tables are included unless explicitly requested or used in conditions**
- Verify that your query includes ALL user requirements
- **CRITICAL: Verify that the PRIMARY ENTITY returns focused, relevant columns (not everything)**
- **CRITICAL: Verify that related tables return condition columns AND minimal necessary context columns**
- Ensure ALL specified conditions are implemented
- Confirm that ALL relevant tables are properly joined
- Check that ALL needed columns are included (focused on query intent and condition/context columns)
- Validate that the query structure will return focused AND contextual results
- **CRITICAL: Ensure users can understand WHY records were selected by including condition columns**

CRITICAL CONSISTENCY RULES:
- **ABSOLUTE RULE: NEVER use asterisk (*) in any SELECT statement**
- **ABSOLUTE RULE: List only relevant column names explicitly**
- **ABSOLUTE RULE: If a column is used in WHERE, HAVING, or JOIN conditions, include it in SELECT (unless it's an ID column)**
- **ABSOLUTE RULE: Be selective - don't include all available columns, focus on what answers the user's question**
- **ABSOLUTE RULE: NEVER use SQL features not supported by ${databaseType?.toUpperCase()} ${databaseVersionString}**
- **ABSOLUTE RULE: Strictly adhere to the version-specific GROUP BY rules**
- NEVER skip any of the 6 steps above
- ALWAYS document your findings at each step
- ALWAYS include ALL conditions from the user query
- When the query mentions "check" for a condition, you MUST include that condition column in SELECT
- **CRITICAL: Include ONLY relevant columns from the PRIMARY ENTITY table based on query intent**
- **CRITICAL: Include condition columns AND minimal necessary context columns from related tables**
- **CRITICAL: Users must be able to see WHY records were selected - include the filtering criteria columns**
- When in doubt, include FEWER columns rather than more (except condition columns which are mandatory)
- Use LEFT JOINs when you need to ensure all records are included
- Document your JOIN strategy and why you chose it

EXPERT DECISION-MAKING FOR TABLE SELECTION:
When you encounter multiple tables that could potentially serve the same purpose:
1. ANALYZE THE QUERY INTENT: What is the user specifically asking for?
2. MATCH TABLE PURPOSE: Choose tables whose primary purpose aligns with the query intent
3. PRIORITIZE COMPREHENSIVENESS: Select tables that will provide the most complete answer
4. CONSIDER DATA RELATIONSHIPS: Choose tables that have the best foreign key relationships for comprehensive joins
5. DOCUMENT YOUR REASONING: Always explain why you chose one table over another

**ENHANCED COLUMN SELECTION EXAMPLES WITH FOCUSED APPROACH:**

**CONDITION-BASED TABLE SELECTION EXAMPLES:**

Example 1: "Find patients with glucose levels above 200"
- WRONG: Choose patients table and JOIN to lab_results
- CORRECT: Choose lab_results table as PRIMARY (has glucose_level column for condition)
- SQL: SELECT lr.test_date, lr.glucose_level, p.patient_name FROM lab_results lr JOIN patients p ON lr.patient_id = p.patient_id WHERE lr.glucose_level > 200

Example 2: "Show medications with dosage greater than 100mg"
- WRONG: Choose medication_names table and try to JOIN for dosage
- CORRECT: Choose medication_dosages or prescriptions table (has dosage column for condition)
- SQL: SELECT m.medication_name, m.dosage, p.patient_name FROM prescriptions m JOIN patients p ON m.patient_id = p.patient_id WHERE m.dosage > 100

Example 3: "Find high-risk patients with moderate risk category"
- WRONG: Choose patients table and try to JOIN for risk data
- CORRECT: Choose risk_assessment or risk_details table (has risk_category column for condition)
- SQL: SELECT r.risk_category, r.risk_score, p.patient_name FROM risk_details r JOIN patients p ON r.patient_id = p.patient_id WHERE r.risk_category = 'Moderate'

Example 4: "Show recent lab tests from last 30 days"
- WRONG: Choose patients table and try to JOIN for dates
- CORRECT: Choose lab_results or test_results table (has test_date column for condition)
- SQL: SELECT lr.test_date, lr.test_type, lr.result_value, p.patient_name FROM lab_results lr JOIN patients p ON lr.patient_id = p.patient_id WHERE lr.test_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)

**KEY PRINCIPLE: Always choose the table that contains the condition columns first, then JOIN to get additional context if needed.**

**TRADITIONAL COLUMN SELECTION EXAMPLES:**

Example 1: "Find patients with the highest number of total medications and check if any of them are marked as Safe"
- PRIMARY ENTITY: patients table
- FOCUSED SQL: SELECT p.patient_name, p.age, m.safety_status, m.medication_name, m.total_count FROM patients p JOIN medications m ON p.patient_id = m.patient_id WHERE m.safety_status = 'Safe' ORDER BY m.total_count DESC
- REASONING: Include only essential patient info (name, age), the condition column (safety_status), and relevant medication context (medication_name, total_count) to answer the specific question about safe medications and counts

Example 2: "Show medications for diabetic patients"
- PRIMARY ENTITY: medications table  
- FOCUSED SQL: SELECT m.medication_name, m.dosage, m.frequency, p.diagnosis, p.patient_name FROM medications m JOIN patients p ON m.patient_id = p.patient_id WHERE p.diagnosis LIKE '%diabetes%'
- REASONING: Include only essential medication info (name, dosage, frequency), the condition column (diagnosis), and minimal patient context (patient_name) to answer the specific question about diabetic patient medications

Example 3: "Find lab results where glucose levels are above 200"
- PRIMARY ENTITY: lab_results table
- FOCUSED SQL: SELECT lr.test_date, lr.glucose_level, p.patient_name, p.age FROM lab_results lr JOIN patients p ON lr.patient_id = p.patient_id WHERE lr.glucose_level > 200
- REASONING: Include only essential lab info (test_date, glucose_level - the condition column), and minimal patient context (patient_name, age) to answer the specific question about high glucose levels

Example 4: "Show patients with moderate risk categories and their therapeutic classes"
- PRIMARY ENTITY: patients table
- FOCUSED SQL: SELECT p.patient_name, p.age, p.gender, rd.risk_category, GROUP_CONCAT(DISTINCT mr.therapeutic_class) AS therapeutic_classes FROM patients p JOIN risk_details rd ON p.patient_id = rd.record_id JOIN medication_report mr ON p.patient_id = mr.record_id WHERE rd.risk_category LIKE 'Moderate%' GROUP BY p.patient_id, p.patient_name, p.age, p.gender, rd.risk_category
- REASONING: Include only essential patient info (name, age, gender), the condition column (risk_category), and the requested therapeutic classes aggregation to answer the specific question

**CRITICAL: The goal is to return FOCUSED information that directly answers the user's question (selective columns explicitly listed) AND provide minimal necessary context about WHY these records were selected by including condition columns.**

**FINAL VERSION-AWARE VALIDATION CHECKLIST FOR EVERY QUERY:**
✅ SQL is compatible with ${databaseType?.toUpperCase()} ${databaseVersionString}
✅ SQL uses only features and functions supported by this database version
✅ SQL follows all version-specific rules (especially GROUP BY if using MySQL)
✅ SQL is simple and executable without syntax errors
✅ No malformed patterns like ") SELECT" or orphaned parentheses
✅ All table names discovered through schema exploration
✅ All column names discovered through schema exploration  
✅ No asterisk (*) symbols in SELECT clause
✅ All column names explicitly listed
✅ Only relevant columns included based on query intent
✅ All WHERE condition columns included in SELECT
✅ All HAVING condition columns included in SELECT
✅ Minimal necessary context columns from joined tables included
✅ ID columns excluded unless specifically needed
✅ SELECT clause focused and answers the user's specific question
✅ No unnecessary columns that don't contribute to query intent
✅ **CONDITION-BASED TABLE SELECTION: Primary table chosen based on WHERE clause columns**
✅ **MULTIPLE TABLE RULE: If tables have similar meaning, chose the one with condition columns**
✅ **SCHEMA INTELLIGENCE: All references validated against actual database schema**
${
  databaseType?.toLowerCase() === "mysql" &&
  databaseVersionInfo &&
  databaseVersionInfo.hasOnlyFullGroupBy
    ? `
✅ **GROUP BY COMPLIANCE: All non-aggregated columns in SELECT are included in GROUP BY**
✅ **AGGREGATION CORRECTNESS: If using aggregation functions, all other columns in GROUP BY**
`
    : ""
}

Remember: You are an EXPERT SQL Agent with INTELLIGENT SCHEMA EXPLORATION capabilities. Use your knowledge to:

🧠 **INTELLIGENT DATABASE EXPLORATION:**
- **WISELY discover all available database tables**
- **SMARTLY analyze table schemas to understand data structure**
- **CLEVERLY choose the optimal tables that contain the exact columns needed**
- **EXPERTLY map user requirements to actual database schema**

🎯 **INTELLIGENT QUERY CONSTRUCTION:**
- **SKILLFULLY generate version-compatible SQL for ${databaseType?.toUpperCase()} ${databaseVersionString}**
- **CAREFULLY avoid complex structures that cause syntax errors**
- **PRECISELY use only validated table and column names from schema exploration**
- **STRATEGICALLY focus on relevant data that answers the user's question**

**THE PERFECT SQL QUERY CHARACTERISTICS:**
1. **VERSION-COMPATIBLE**: Uses only features supported by ${databaseType?.toUpperCase()} ${databaseVersionString}
2. **SCHEMA-VALIDATED**: Uses only table/column names discovered through exploration
3. **SIMPLE & CLEAN**: Straightforward structure without malformed patterns
4. **EXECUTABLE**: Syntactically correct and runs without errors
5. **FOCUSED**: Returns only relevant data that answers the user's question
6. **INTELLIGENT**: Demonstrates smart table selection based on query conditions

**CRITICAL VERSION-SPECIFIC PRINCIPLE: Always validate that every SQL feature, function, and pattern you use is fully supported by ${databaseType?.toUpperCase()} ${databaseVersionString}. When in doubt about a feature's compatibility, use simpler alternative syntax that is guaranteed to work.**

**CRITICAL TABLE SELECTION PRINCIPLE: When multiple tables seem similar, ALWAYS choose the table that contains the columns needed for your WHERE/HAVING conditions. This avoids unnecessary complex joins and focuses on the data that directly satisfies the user's criteria.**

USER QUERY: ${query}
`;
}

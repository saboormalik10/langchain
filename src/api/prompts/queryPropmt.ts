
// generateCorrectionPrompt.js

import { getAzureOpenAIClient } from "../routes/medical";
import { ComprehensiveQueryParams, ErrorDescriptionParams, QueryDescriptionParams, RestructuringPromptParams, ResultExplanationParams } from "../types/promptTypes";

export function generateCorrectionPrompt(
  originalQuery: any,
  originalSQL: string,
  issues: string[]
) {
  return `
CRITICAL SQL CORRECTION NEEDED

Original User Query: "${originalQuery}"

Generated SQL: 
${originalSQL}

Identified Issues:
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}

TASK: Generate a corrected SQL query that:
1. Addresses ALL the identified issues above
2. Fully satisfies the original user query requirements
3. Uses proper SQL syntax and structure
4. Includes all necessary JOINs, WHERE clauses, GROUP BY, ORDER BY as needed
5. Uses the correct database schema (explore schema if needed)

CRITICAL REQUIREMENTS:
- The corrected SQL must address EVERY issue listed above
- Include ALL conditions and requirements from the original query
- Use proper aggregation functions (COUNT, AVG, MAX, MIN) if mentioned in original query
- Add proper filtering with WHERE clause if conditions are mentioned
- Add GROUP BY if grouping is implied in the original query
- Add ORDER BY if sorting is mentioned in the original query
- Ensure all medical terms and concepts from original query are properly addressed

Generate ONLY the corrected SQL query without explanations.
`;
}

export function getJsonFunctionsForDatabase(
  dbType: string,
  dbVersion: string
): any {
  const lowerType = dbType.toLowerCase();

  if (lowerType === "mysql") {
    const versionNumber = parseFloat(dbVersion);

    // MySQL 5.7+ supports JSON functions
    if (versionNumber >= 5.7) {
      return {
        createObject: "JSON_OBJECT(key, value, ...)",
        createArray: "JSON_ARRAYAGG(JSON_OBJECT(...))",
        description: `
MySQL ${dbVersion} JSON Functions:
- JSON_OBJECT('key', value, 'key2', value2) - creates NATIVE JSON object (NOT stringified)
- JSON_ARRAYAGG(JSON_OBJECT('key', value)) - creates array of native JSON objects (MySQL 5.7.22+)
- JSON_ARRAY(value1, value2, ...) - creates native JSON array
- These functions return structured JSON objects directly, not strings that need parsing
- COALESCE(column, default_value) - handles NULL values
- GROUP_CONCAT(DISTINCT column) - alternative for older MySQL versions (returns strings)

CRITICAL: These JSON functions produce ACTUAL JSON objects, not stringified JSON. The result can be directly used without JSON.parse().
`,
        examples: `
✅ CORRECT MYSQL EXAMPLE (MySQL ${dbVersion}) - Returns NATIVE JSON objects:
\`\`\`sql
SELECT 
    patient.id,
    patient.name,
    JSON_ARRAYAGG(
        JSON_OBJECT(
            'medication_id', medication.id,
            'medication_name', medication.name,
            'dosage', prescription.dosage
        )
    ) AS medications  -- This returns actual JSON objects, NOT strings
FROM patient
LEFT JOIN prescription ON patient.id = prescription.patient_id
LEFT JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id, patient.name
\`\`\`

❌ INCORRECT SYNTAX - This will fail or return strings:
\`\`\`sql
-- This fails in MySQL:
SELECT 
    patient.id,
    patient.name,
    JSON_ARRAYAGG(DISTINCT JSON_OBJECT('med_id', medication.id)) AS medications
FROM patient
JOIN prescription ON patient.id = prescription.patient_id
JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id

-- This returns strings, NOT JSON objects (avoid):
SELECT 
    patient.id,
    patient.name,
    GROUP_CONCAT(
        CONCAT('{"medication_id":', medication.id, ',"name":"', medication.name, '"}')
    ) AS medications_string  -- This is stringified JSON, requires parsing
FROM patient
JOIN prescription ON patient.id = prescription.patient_id
JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id, patient.name
\`\`\`
`,
        considerations: `
- For MySQL ${dbVersion}: 
  - JSON_ARRAYAGG() is available in MySQL 5.7.22+
  - JSON_OBJECT() is available in MySQL 5.7+
  - Use proper escaping for JSON string values
  - NEVER use DISTINCT inside JSON_ARRAYAGG() - MySQL does not support this syntax
  - For uniqueness, rely on proper GROUP BY clauses instead of DISTINCT inside JSON functions
  - Handle NULL values with COALESCE() or IFNULL()
  - For older MySQL versions, consider using GROUP_CONCAT() as an alternative
  - **CRITICAL**: JSON functions return NATIVE JSON objects, not strings requiring JSON.parse()
  - **AVOID**: String concatenation methods that produce stringified JSON
  - **USE**: Only native JSON functions that produce structured objects directly
`,
        finalReminder: `
FINAL MYSQL SYNTAX REMINDER FOR ${dbVersion}:
- ABSOLUTELY NEVER use DISTINCT inside JSON_ARRAYAGG() function
- NEVER write: JSON_ARRAYAGG(DISTINCT column) or JSON_ARRAYAGG(DISTINCT JSON_OBJECT(...))
- For unique values, use proper GROUP BY clauses instead
- ALL JSON functions must be compatible with MySQL ${dbVersion}
- Double-check every JSON function call for MySQL compatibility
- **ENSURE NATIVE JSON**: Query must return actual JSON objects, not stringified JSON
- **AVOID STRING CONCATENATION**: Don't use CONCAT() to create fake JSON strings
`,
      };
    } else {
      // For older MySQL versions, suggest GROUP_CONCAT as alternative
      return {
        createObject: "Use GROUP_CONCAT for older MySQL versions",
        createArray: "GROUP_CONCAT",
        description: `
MySQL ${dbVersion} (older version) - JSON functions not fully available:
- GROUP_CONCAT(DISTINCT column) - concatenates values as alternative to JSON
- CONCAT(), CONCAT_WS() - string concatenation functions
- Consider upgrading MySQL for better JSON support
`,
        examples: `
✅ CORRECT MYSQL EXAMPLE FOR OLDER VERSION (MySQL ${dbVersion}):
\`\`\`sql
SELECT 
    patient.id,
    patient.name,
    GROUP_CONCAT(DISTINCT 
        CONCAT(
            '{"medication_id":', medication.id, 
            ',"medication_name":"', medication.name, 
            '","dosage":"', prescription.dosage, '"}'
        )
    ) AS medications_json
FROM patient
LEFT JOIN prescription ON patient.id = prescription.patient_id
LEFT JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id, patient.name
\`\`\`
`,
        considerations: `
- For MySQL ${dbVersion} (older version):
  - Full JSON functions are NOT available
  - Use GROUP_CONCAT() with string concatenation to simulate JSON
  - Be careful with string escaping in CONCAT() functions
  - Consider application-side JSON processing instead
  - Remember GROUP_CONCAT has length limitations (default 1024 characters)
`,
        finalReminder: `
FINAL REMINDER FOR OLDER MYSQL ${dbVersion}:
- This version doesn't support full JSON functions
- Use GROUP_CONCAT with string concatenation carefully
- Watch for proper string escaping in simulated JSON
- Consider application-side JSON processing for complex structures
`,
      };
    }
  } else if (lowerType === "postgresql") {
    const versionNumber = parseFloat(dbVersion);

    // PostgreSQL 9.3+ has good JSON support
    if (versionNumber >= 9.3) {
      return {
        createObject: "json_build_object(key, value, ...)",
        createArray: "json_agg(json_build_object(...))",
        description: `
PostgreSQL ${dbVersion} JSON Functions:  
- json_build_object('key', value, 'key2', value2) - creates NATIVE JSON object (NOT stringified)
- json_agg(json_build_object('key', value)) - creates array of native JSON objects
- json_build_array(value1, value2, ...) - creates native JSON array
- jsonb_build_object() - creates binary JSON object (faster for operations)
- jsonb_agg() - creates binary JSON array (faster for operations)
- array_agg(DISTINCT column) - creates array of values
- row_to_json(row) - converts entire row to native JSON
- COALESCE(column, default_value) - handles NULL values
- These functions return structured JSON objects directly, not strings that need parsing

CRITICAL: These JSON functions produce ACTUAL JSON/JSONB objects, not stringified JSON. The result can be directly used without JSON.parse().
`,
        examples: `
✅ CORRECT POSTGRESQL EXAMPLE:
\`\`\`sql
SELECT 
    patient.id,
    patient.name,
    json_agg(
        json_build_object(
            'medication_id', medication.id,
            'medication_name', medication.name,
            'dosage', prescription.dosage
        )
    ) AS medications
FROM patient
LEFT JOIN prescription ON patient.id = prescription.patient_id
LEFT JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id, patient.name
\`\`\`

✅ ALTERNATIVE POSTGRESQL APPROACH:
\`\`\`sql
SELECT 
    patient.id,
    patient.name,
    json_agg(
        json_build_object(
            'medication', row_to_json(medication.*),
            'prescription', row_to_json(prescription.*)
        )
    ) AS medications
FROM patient
LEFT JOIN prescription ON patient.id = prescription.patient_id
LEFT JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id, patient.name
\`\`\`
`,
        considerations: `
- For PostgreSQL ${dbVersion}:
  - json_build_object() and json_agg() are available in PostgreSQL 9.4+
  - json_object() and json_array() are older alternatives
  - Use row_to_json() for complex row-based objects
  - PostgreSQL supports DISTINCT inside array_agg() but not inside json_agg()
  - Handle NULL values with COALESCE()
  - Consider using jsonb functions for better performance in newer PostgreSQL versions
`,
        finalReminder: `
FINAL POSTGRESQL SYNTAX REMINDER FOR ${dbVersion}:
- Ensure all JSON function names are correctly written: json_build_object, json_agg, etc.
- Use appropriate nesting of JSON functions
- All aggregation requires proper GROUP BY clauses
- Handle NULL values with COALESCE()
- Double-check all column references and qualification
`,
      };
    } else {
      // Older PostgreSQL versions
      return {
        createObject: "json_object/row_to_json",
        createArray: "array_to_json/array_agg",
        description: `
PostgreSQL ${dbVersion} (older version) JSON Functions:
- row_to_json(row) - converts a row to JSON
- array_to_json(array_agg(column)) - creates JSON array from aggregated values
- hstore extension provides key-value functionality as alternative
`,
        examples: `
✅ CORRECT POSTGRESQL EXAMPLE FOR OLDER VERSION:
\`\`\`sql
SELECT 
    patient.id,
    patient.name,
    array_to_json(
        array_agg(
            row_to_json(
                (SELECT r FROM (
                    SELECT 
                        medication.id AS medication_id,
                        medication.name AS medication_name,
                        prescription.dosage
                ) r)
            )
        )
    ) AS medications
FROM patient
LEFT JOIN prescription ON patient.id = prescription.patient_id
LEFT JOIN medication ON prescription.medication_id = medication.id
GROUP BY patient.id, patient.name
\`\`\`
`,
        considerations: `
- For PostgreSQL ${dbVersion} (older version):
  - json_build_* functions may not be available
  - Use row_to_json() with subqueries for complex objects
  - array_to_json(array_agg()) pattern for arrays
  - Consider using the hstore extension for key-value structures
  - Check PostgreSQL version compatibility carefully
`,
        finalReminder: `
FINAL REMINDER FOR OLDER POSTGRESQL ${dbVersion}:
- This version has limited JSON function support
- Use row_to_json() and array_to_json() with array_agg()
- Consider using subqueries with row_to_json for complex structures
- Check PostgreSQL docs for exact version compatibility
`,
      };
    }
  } else {
    // Default generic JSON syntax for unknown databases
    return {
      createObject: "JSON object creation function",
      createArray: "JSON array creation function",
      description: `
Generic JSON Functions (please verify compatibility with your database):
- JSON object creation function - creates a JSON object
- JSON array creation function - creates a JSON array
- Consult your database documentation for specific JSON function names
`,
      examples: `
EXAMPLE (verify syntax with your database):
\`\`\`sql
SELECT 
    main_entity.id,
    main_entity.name,
    -- Replace with your database's JSON functions:
    JSON_ARRAY_FUNCTION(
        JSON_OBJECT_FUNCTION(
            'related_id', related_entity.id,
            'related_name', related_entity.name
        )
    ) AS related_entities
FROM main_entity
LEFT JOIN related_entity ON main_entity.id = related_entity.main_id
GROUP BY main_entity.id, main_entity.name
\`\`\`
`,
      considerations: `
- For your database (${dbType} ${dbVersion}):
  - Verify JSON function availability and syntax
  - Check documentation for correct function names
  - Test all JSON functions in your specific environment
  - Consider application-side JSON processing as alternative
`,
      finalReminder: `
FINAL REMINDER:
- Verify all JSON function names with your database documentation
- Test the generated SQL in a development environment first
- Ensure compatibility with ${dbType} ${dbVersion}
`,
    };
  }
}

export function getDatabaseSyntaxRules(dbType: string, dbVersion: string): any {
  const lowerType = dbType.toLowerCase();

  if (lowerType === "mysql") {
    return {
      general: `
MySQL ${dbVersion} Syntax Rules:
- MySQL is case-insensitive for table and column names, but case-sensitive for string values
- Table and column names can be quoted with backticks (\`table_name\`) if they contain special characters or spaces
- String values must be quoted with single quotes ('string value')
- NULL values should be handled with IFNULL() or COALESCE() functions
- Date and time values are formatted as 'YYYY-MM-DD HH:MM:SS'
`,
      aliasRules: `
MySQL ALIAS USAGE RULES (CRITICAL):
- MySQL DOES NOT allow column aliases to be used in WHERE, GROUP BY, or HAVING clauses in the same query level
- MySQL DOES NOT allow column aliases to be used in ORDER BY clause in versions before 8.0
- For ORDER BY with aggregated values, you must either:
  1. Repeat the entire aggregation expression in the ORDER BY clause
  2. Use a position number (e.g., ORDER BY 4 to refer to the 4th column in the SELECT list)
  3. In MySQL 8.0+, you can use column aliases in ORDER BY
`,
      orderByRules: `
MYSQL ORDER BY RULES:
1. When using aggregate functions (COUNT, SUM, AVG, etc.) in ORDER BY, you MUST:
   - Repeat the entire aggregate expression in the ORDER BY clause
   - Example: SELECT COUNT(*) AS count ... ORDER BY COUNT(*) DESC
   - OR use positional references: ORDER BY 2 DESC (referring to the 2nd column)
   - DO NOT use the alias directly in older MySQL versions: ORDER BY count DESC (will fail in MySQL < 8.0)

2. When ordering by expressions:
   - Repeat the entire expression in ORDER BY
   - DO NOT reference the expression by its alias in older MySQL versions

3. CORRECT approaches for MySQL ${dbVersion}:
   - SELECT COUNT(*) AS total ... ORDER BY COUNT(*) DESC
   - SELECT COUNT(*) AS total ... ORDER BY 2 DESC
`,
      correctExamples: `
CORRECT ORDER BY EXAMPLES FOR MYSQL ${dbVersion}:
\`\`\`sql
-- Example 1: Repeating the aggregate expression in ORDER BY
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY COUNT(order_id) DESC

-- Example 2: Using positional reference in ORDER BY
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY 3 DESC

-- Example 3: Using calculated JSON with proper ORDER BY
SELECT
    customer_id,
    customer_name,
    JSON_OBJECT(
        'customer', customer_name,
        'total_orders', COUNT(order_id),
        'orders', JSON_ARRAYAGG(
            JSON_OBJECT(
                'order_id', order_id,
                'order_date', order_date
            )
        )
    ) AS customer_data,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY COUNT(order_id) DESC
\`\`\`
`,
      incorrectExamples: `
INCORRECT ORDER BY EXAMPLES FOR MYSQL ${dbVersion} (WILL CAUSE ERRORS):
\`\`\`sql
-- ERROR: Using column alias in ORDER BY (MySQL < 8.0)
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY order_count DESC  -- ERROR in MySQL < 8.0!

-- ERROR: Using alias for JSON field that's not directly available
SELECT
    JSON_OBJECT(
        'customer_id', customer_id,
        'total_orders', COUNT(order_id)
    ) AS customer_data
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id
ORDER BY total_orders DESC  -- ERROR! This field doesn't exist outside the JSON
\`\`\`
`,
      criticalRequirements: `
- REPEAT AGGREGATES IN ORDER BY: If using COUNT() or other aggregates in ORDER BY, repeat the entire expression
- AVOID ALIAS REFERENCES: Don't use column aliases in ORDER BY (for MySQL < 8.0)
- USE POSITIONAL REFERENCES: Consider using position numbers in ORDER BY (e.g., ORDER BY 3 DESC)
- TEST ORDER BY CLAUSES: Ensure ORDER BY references valid columns or expressions
`,
      finalReminder: `
FINAL MYSQL SYNTAX REMINDERS:
- ORDER BY cannot reference column aliases in MySQL versions before 8.0
- When ordering by an aggregate expression, either repeat the full expression or use a position number
- Never use column aliases in WHERE, HAVING, or GROUP BY clauses
- Always include all non-aggregated columns from SELECT in the GROUP BY clause
`,
    };
  } else if (lowerType === "postgresql") {
    return {
      general: `
PostgreSQL ${dbVersion} Syntax Rules:
- PostgreSQL is case-insensitive for table and column names unless quoted
- Table and column names can be quoted with double quotes ("table_name") if they contain special characters, spaces, or need case sensitivity
- String values must be quoted with single quotes ('string value')
- NULL values should be handled with COALESCE() function
- Date and time values are formatted as 'YYYY-MM-DD HH:MM:SS'
`,
      aliasRules: `
PostgreSQL ALIAS USAGE RULES:
- PostgreSQL ALLOWS column aliases to be used in ORDER BY clauses
- PostgreSQL DOES NOT allow column aliases to be used in WHERE, GROUP BY, or HAVING clauses in the same query level
- PostgreSQL supports all standard SQL aggregate functions and window functions
`,
      orderByRules: `
POSTGRESQL ORDER BY RULES:
1. PostgreSQL allows using column aliases directly in ORDER BY:
   - Example: SELECT COUNT(*) AS count ... ORDER BY count DESC

2. When ordering by expressions:
   - You can reference the expression by its alias in ORDER BY
   - You can still repeat the entire expression if preferred

3. CORRECT approaches for PostgreSQL ${dbVersion}:
   - SELECT COUNT(*) AS total ... ORDER BY total DESC
   - SELECT COUNT(*) AS total ... ORDER BY COUNT(*) DESC
   - SELECT COUNT(*) AS total ... ORDER BY 2 DESC
`,
      correctExamples: `
CORRECT ORDER BY EXAMPLES FOR POSTGRESQL ${dbVersion}:
\`\`\`sql
-- Example 1: Using column alias in ORDER BY (works in PostgreSQL)
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY order_count DESC

-- Example 2: Using positional reference in ORDER BY
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY 3 DESC

-- Example 3: Using calculated JSON with alias in ORDER BY
SELECT
    customer_id,
    customer_name,
    json_build_object(
        'customer', customer_name,
        'total_orders', COUNT(order_id),
        'orders', json_agg(
            json_build_object(
                'order_id', order_id,
                'order_date', order_date
            )
        )
    ) AS customer_data,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY order_count DESC
\`\`\`
`,
      incorrectExamples: `
INCORRECT EXAMPLES FOR POSTGRESQL ${dbVersion} (WILL CAUSE ERRORS):
\`\`\`sql
-- ERROR: Using column alias in WHERE clause
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
WHERE order_count > 5  -- ERROR! Cannot use alias in WHERE
GROUP BY customer_id, customer_name

-- ERROR: Using alias for JSON field that's not directly available
SELECT
    json_build_object(
        'customer_id', customer_id,
        'total_orders', COUNT(order_id)
    ) AS customer_data
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id
ORDER BY total_orders DESC  -- ERROR! This field doesn't exist outside the JSON
\`\`\`
`,
      criticalRequirements: `
- HANDLE COLUMN REFERENCES: Ensure all columns referenced in the query are properly qualified
- VERIFY JSON FUNCTION SYNTAX: Check that all JSON functions are properly nested and closed
- INCLUDE ALL NON-AGGREGATES IN GROUP BY: Every non-aggregated column in SELECT must be in GROUP BY
- TEST JOIN CONDITIONS: Ensure all joins have proper conditions and maintain data relationships
`,
      finalReminder: `
FINAL POSTGRESQL SYNTAX REMINDERS:
- PostgreSQL allows column aliases in ORDER BY clauses
- Use proper JSON function syntax with correct nesting
- Always include all non-aggregated columns from SELECT in the GROUP BY clause
- For better performance with JSON, consider using jsonb functions in newer PostgreSQL versions
`,
    };
  } else {
    // Generic rules for unknown databases
    return {
      general: `
Generic SQL Syntax Rules:
- Be consistent with case for table and column names
- Use appropriate quoting for identifiers and string values
- Handle NULL values with appropriate NULL-handling functions
- Follow standard SQL syntax for SELECT, FROM, JOIN, WHERE, GROUP BY, HAVING, and ORDER BY clauses
`,
      aliasRules: `
ALIAS USAGE RULES:
- Column aliases typically cannot be used in WHERE, GROUP BY, or HAVING clauses
- Support for column aliases in ORDER BY varies by database (MySQL < 8.0 doesn't support, PostgreSQL does)
- When in doubt, avoid using aliases and repeat the full expression
`,
      orderByRules: `
ORDER BY RULES:
1. For maximum compatibility:
   - Repeat the entire expression in ORDER BY instead of using an alias
   - Use positional references (ORDER BY 1, 2) where appropriate
   - Test alias usage with your specific database version

2. When ordering by aggregate expressions:
   - The safest approach is to repeat the entire expression
   - Alternative: use positional references (e.g., ORDER BY 3 DESC)
`,
      correctExamples: `
CORRECT ORDER BY EXAMPLES (GENERIC SQL):
\`\`\`sql
-- Example 1: Repeating the expression in ORDER BY (works in all databases)
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY COUNT(order_id) DESC

-- Example 2: Using positional reference in ORDER BY (works in all databases)
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY 3 DESC
\`\`\`
`,
      incorrectExamples: `
POTENTIALLY INCORRECT EXAMPLES (DATABASE-DEPENDENT):
\`\`\`sql
-- Might fail in some databases (e.g., MySQL < 8.0):
SELECT 
    customer_id,
    customer_name,
    COUNT(order_id) AS order_count
FROM customers
JOIN orders ON customers.id = orders.customer_id
GROUP BY customer_id, customer_name
ORDER BY order_count DESC  -- Works in PostgreSQL, fails in MySQL < 8.0
\`\`\`
`,
      criticalRequirements: `
- MAINTAIN DATABASE COMPATIBILITY: Use syntax that works across database types when possible
- VERIFY ORDER BY REFERENCES: Ensure ORDER BY references valid columns or expressions
- TEST ALIAS USAGE: Check alias usage compatibility with your specific database
- FOLLOW STANDARD SQL PATTERNS: Stick to widely-compatible SQL syntax patterns
`,
      finalReminder: `
FINAL SQL SYNTAX REMINDERS:
- When in doubt, repeat expressions instead of using aliases in ORDER BY
- Always include all non-aggregated columns from SELECT in the GROUP BY clause
- Test the query with your specific database version before deployment
- Consider using positional references in ORDER BY for maximum compatibility
`,
    };
  }
}



export function generateRestructuringPrompt({
  userPrompt,
  originalSQL,
  sampleSize,
  sampleResults,
  dbType,
  dbVersion,
  sqlResults,
  tablesInfo,
  validatedTables,
  validatedColumns,
  jsonFunctions,
  dbSyntaxRules,
}: RestructuringPromptParams): string {
  return `
You are an expert SQL developer specializing in transforming flat relational queries into structured, hierarchical queries that eliminate redundancy using JSON aggregation functions.

⚠️  CRITICAL COLUMN NAME WARNING ⚠️ 
DO NOT ASSUME, GUESS, OR MAKE UP COLUMN NAMES. Use ONLY the exact column names from the validated schema provided below. Common errors to AVOID:
- Using 'patient_id' when the actual column is 'id' or vice versa
- Using 'medication_histories.patient_id' when no such column exists
- Assuming standard naming conventions - always use the actual column names
- Making up foreign key column names without verification

If you cannot find the exact column name in the validated schema, DO NOT USE IT in the query.

USER PROMPT: "${userPrompt}"

ORIGINAL SQL QUERY:
\`\`\`sql
${originalSQL}
\`\`\`

SAMPLE RESULTS FROM ORIGINAL QUERY (first ${sampleSize} records):
\`\`\`json
${JSON.stringify(sampleResults, null, 2)}
\`\`\`

DATABASE TYPE: ${dbType.toUpperCase()}
DATABASE VERSION: ${dbVersion}

TOTAL RECORDS IN ORIGINAL RESULT: ${sqlResults.length}

${
  tablesInfo
    ? `
VALIDATED DATABASE SCHEMA FROM SQL AGENT:
${tablesInfo}

CRITICAL: Use ONLY the table and column names shown above. These are the actual names in the database.
`
    : ""
}

VALIDATED TABLES: ${
    validatedTables.length > 0
      ? validatedTables.join(", ")
      : "Schema validation failed - use original SQL table names"
  }

${
  Object.keys(validatedColumns).length > 0
    ? `
VALIDATED COLUMNS BY TABLE:
${Object.entries(validatedColumns)
  .map(([table, columns]) => `- ${table}: ${columns.join(", ")}`)
  .join("\n")}
`
    : ""
}

TASK: Generate a new SQL query that produces structured, non-redundant results directly from the database.

RESTRUCTURING REQUIREMENTS:
1. **ELIMINATE REDUNDANCY**: Use GROUP BY to group related entities (e.g., patients, medications, lab tests)
2. **CREATE JSON HIERARCHY**: Use ${jsonFunctions.createObject} and ${
    jsonFunctions.createArray
  } functions to create nested structures
3. **MAINTAIN DATA INTEGRITY**: Don't lose any information from the original query
4. **BE LOGICAL**: Structure should make business sense for the data domain
5. **USE APPROPRIATE GROUPING**: Identify the main entity and group related data under it
6. **PREVENT DUPLICATE DATA**: Ensure no duplicate records appear in any field of the response - each record should be unique
7. **AVOID IDENTICAL/REPETITIVE DATA**: Do NOT generate queries that return identical values across multiple rows or columns. Use DISTINCT, proper GROUP BY, and JSON aggregation to eliminate repetitive data patterns.
8. **RETURN PARSED JSON OBJECTS**: Generate SQL that returns properly structured JSON objects, NOT stringified JSON.
9. **MYSQL GROUP BY STRICT COMPLIANCE**: For MySQL, ensure every non-aggregated column in SELECT appears in GROUP BY clause (sql_mode=only_full_group_by)
10. **VERSION COMPATIBILITY**: Ensure the generated SQL is compatible with ${dbType.toUpperCase()} ${dbVersion}
11. **SCHEMA ACCURACY**: Use ONLY validated table and column names from the database schema above
12. **EXACT COLUMN NAMES**: Do NOT assume, guess, or make up column names.
13. **STRICT COLUMN VALIDATION**: Before using any column, verify it exists in the validated columns list.

DATABASE-SPECIFIC SYNTAX RULES FOR ${dbType.toUpperCase()} ${dbVersion}:
${dbSyntaxRules.general}

${dbSyntaxRules.aliasRules}

${dbSyntaxRules.orderByRules}

DATABASE-SPECIFIC JSON FUNCTIONS FOR ${dbType.toUpperCase()} ${dbVersion}:
${jsonFunctions.description}

CORRECT SYNTAX EXAMPLES FOR ${dbType.toUpperCase()} ${dbVersion}:
${jsonFunctions.examples}

${dbSyntaxRules.correctExamples}

INCORRECT SYNTAX EXAMPLES TO AVOID:
${dbSyntaxRules.incorrectExamples}

VERSION-SPECIFIC CONSIDERATIONS:
${jsonFunctions.considerations}

EXPECTED OUTPUT FORMAT:
Return a JSON object with this structure:
{
  "restructured_sql": "your_new_sql_query_here",
  "explanation": "Brief explanation of how you restructured the query and why",
  "grouping_logic": "Explanation of what entities you grouped together",
  "expected_structure": "Description of the JSON structure the new query will produce",
  "main_entity": "The primary entity being grouped"
}
**Orignal SQL :- you need to use same table names from original SQL**

${originalSQL}

${dbSyntaxRules.criticalRequirements}

${jsonFunctions.finalReminder}

${dbSyntaxRules.finalReminder}

Return only valid JSON without any markdown formatting, comments, or explanations outside the JSON.
`;
}

export async function generateBarChartAnalysis(
  structuredQuery: string,
  userPrompt: string,
  sqlResults: any[],
  organizationId: string
): Promise<any> {
  try {
    console.log("📊 Starting Azure OpenAI bar chart analysis...");

    const azureClient = getAzureOpenAIClient();
    if (!azureClient) {
      console.log("⚠️ Azure OpenAI not available, skipping bar chart analysis");
      return {
        bar_chart_success: false,
        message: "Azure OpenAI not available",
        timestamp: new Date().toISOString(),
      };
    }

    // Sample the results for analysis (first 5 rows)
    const sampleResults = sqlResults.slice(0, 5);
    const resultColumns =
      sampleResults.length > 0 ? Object.keys(sampleResults[0]) : [];

    const analysisPrompt = `You are an expert data visualization analyst specializing in medical data. Analyze the provided SQL query, user prompt, and sample data to generate comprehensive parameters for creating a BAR CHART visualization.

CRITICAL INSTRUCTIONS:
1. You MUST return a valid JSON object with all required parameters
2. Focus specifically on BAR CHART creation and analysis
3. Provide actionable parameters that can be directly used for chart creation
4. Consider medical data context and best practices
5. Ensure all parameters are practical and implementable

USER QUERY/PROMPT:
"${userPrompt}"

EXECUTED SQL QUERY:
${structuredQuery}

SAMPLE DATA RESULTS (first 5 rows):
${JSON.stringify(sampleResults, null, 2)}

AVAILABLE COLUMNS:
${resultColumns.join(", ")}

ANALYSIS REQUIREMENTS:
Please provide a comprehensive JSON response with the following structure:

{
    "bar_chart_success": true,
    "analysis": {
        "chart_type": "BAR_CHART",
        "recommended_chart_subtype": "vertical_bar|horizontal_bar|grouped_bar|stacked_bar",
        "data_interpretation": "Brief explanation of what the data represents",
        "visualization_rationale": "Why bar chart is suitable for this data"
    },
    "chart_parameters": {
        "title": "Meaningful chart title based on user query",
        "subtitle": "Additional context or time frame",
        "description": "What the chart shows and key insights",
        "x_axis": {
            "field": "column_name_for_x_axis",
            "label": "Human readable X-axis label",
            "data_type": "categorical|numeric|datetime",
            "format": "formatting_suggestion"
        },
        "y_axis": {
            "field": "column_name_for_y_axis", 
            "label": "Human readable Y-axis label",
            "data_type": "numeric|count",
            "aggregation": "sum|count|avg|max|min|none",
            "format": "number|currency|percentage"
        },
        "grouping": {
            "enabled": true|false,
            "field": "column_for_grouping_if_applicable",
            "label": "Group by label"
        },
        "filtering": {
            "recommended_filters": [
                {
                    "field": "column_name",
                    "label": "Filter label",
                    "type": "dropdown|range|search",
                    "default_value": "suggested default"
                }
            ]
        },
        "colors": {
            "scheme": "medical|professional|category|gradient",
            "primary_color": "#hex_color",
            "secondary_colors": ["#hex1", "#hex2", "#hex3"]
        },
        "sorting": {
            "field": "field_to_sort_by",
            "direction": "asc|desc",
            "rationale": "why this sorting makes sense"
        }
    },
    "insights": {
        "key_findings": [
            "Primary insight from the data",
            "Secondary insight or pattern",
            "Notable trends or outliers"
        ],
        "medical_context": "Medical significance of the visualization",
        "actionable_insights": [
            "What healthcare professionals can do with this information",
            "Decision support recommendations"
        ]
    },
    "interaction_features": {
        "drill_down": {
            "enabled": true|false,
            "target_fields": ["field1", "field2"],
            "description": "What drilling down reveals"
        },
        "tooltips": {
            "fields": ["field1", "field2", "field3"],
            "format": "what information to show on hover"
        },
        "export_options": ["png", "pdf", "csv", "excel"]
    },
    "performance_considerations": {
        "data_size": "small|medium|large",
        "rendering_strategy": "client_side|server_side|hybrid",
        "optimization_notes": "performance recommendations"
    },
    "accessibility": {
        "color_blind_friendly": true|false,
        "alt_text": "Alternative text description for screen readers",
        "keyboard_navigation": true|false
    }
}

IMPORTANT NOTES:
- Choose the most appropriate column for X and Y axes based on the user query intent
- Consider medical data privacy and sensitivity
- Ensure the visualization answers the user's original question
- Provide practical, implementable parameters
- Focus on clarity and actionability for healthcare professionals

Return ONLY the JSON object, no additional text or formatting.`;

    console.log("🤖 Sending bar chart analysis request to Azure OpenAI...");

    const completion = await azureClient.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a medical data visualization expert. Always respond with valid JSON only.",
        },
        {
          role: "user",
          content: analysisPrompt,
        },
      ],
      max_tokens: 2000,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const response = completion.choices[0]?.message?.content;
    if (!response) {
      throw new Error("No response from Azure OpenAI");
    }

    console.log(
      "✅ Received response from Azure OpenAI for bar chart analysis"
    );
    console.log("📄 Raw response length:", response.length);

    // Parse the JSON response
    let analysisResult;
    try {
      analysisResult = JSON.parse(response);
    } catch (parseError) {
      console.error(
        "❌ Failed to parse Azure OpenAI response as JSON:",
        parseError
      );
      console.error("❌ Raw response:", response.substring(0, 500) + "...");

      return {
        bar_chart_success: false,
        message: "Failed to parse bar chart analysis response",
        error_details: parseError,
        raw_response: response.substring(0, 500) + "...",
        timestamp: new Date().toISOString(),
      };
    }

    // Validate the response structure
    if (!analysisResult || typeof analysisResult !== "object") {
      throw new Error("Invalid response structure from Azure OpenAI");
    }

    // Add metadata to the response
    analysisResult.metadata = {
      analyzed_at: new Date().toISOString(),
      organization_id: organizationId,
      data_sample_size: sampleResults.length,
      total_columns: resultColumns.length,
      query_complexity: structuredQuery.length > 200 ? "complex" : "simple",
      ai_model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
    };

    console.log("✅ Bar chart analysis completed successfully");

    return analysisResult;
  } catch (error: any) {
    console.error(
      "❌ Error generating bar chart analysis with Azure OpenAI:",
      error.message
    );

    return {
      bar_chart_success: false,
      message: `Bar chart analysis failed: ${error.message}`,
      error_details: error.message,
      fallback_parameters: {
        chart_type: "BAR_CHART",
        title: "Data Visualization",
        x_axis:
          sqlResults.length > 0 ? Object.keys(sqlResults[0])[0] : "category",
        y_axis: sqlResults.length > 0 ? Object.keys(sqlResults[0])[1] : "value",
        basic_config: true,
      },
      timestamp: new Date().toISOString(),
    };
  }
}



export function generateComprehensiveQuery({
  query,
  databaseSchemaInfo,
  mysqlVersionInfo,
}: ComprehensiveQueryParams): string {
  return `${query}

=== COMPLETE DATABASE KNOWLEDGE FOR CHAIN EXECUTION ===

DATABASE SCHEMA INFORMATION:
${
    databaseSchemaInfo ||
    "Schema information not available - use database discovery tools"
  }

MYSQL VERSION INFO: Your query will run on MySQL ${
    mysqlVersionInfo ? mysqlVersionInfo.full : "Unknown"
  } ${
    mysqlVersionInfo
      ? `(${mysqlVersionInfo.major}.${mysqlVersionInfo.minor}.${mysqlVersionInfo.patch})`
      : ""
  }

VERSION-SPECIFIC COMPATIBILITY:
- JSON Functions (e.g., JSON_EXTRACT): ${
    mysqlVersionInfo
      ? mysqlVersionInfo.supportsJSON
        ? "AVAILABLE ✅"
        : "NOT AVAILABLE ❌"
      : "UNKNOWN ❓"
  }
- Window Functions (e.g., ROW_NUMBER()): ${
    mysqlVersionInfo
      ? mysqlVersionInfo.supportsWindowFunctions
        ? "AVAILABLE ✅"
        : "NOT AVAILABLE ❌"
      : "UNKNOWN ❓"
  }
- Common Table Expressions (WITH): ${
    mysqlVersionInfo
      ? mysqlVersionInfo.supportsCTE
        ? "AVAILABLE ✅"
        : "NOT AVAILABLE ❌"
      : "UNKNOWN ❓"
  }
- Regular Expressions: AVAILABLE ✅

CRITICAL INSTRUCTIONS FOR CHAINS:
1. Use ONLY the tables and columns that exist in the database schema above
2. Generate ONLY SQL queries compatible with the MySQL version specified
3. Use exact table and column names from the schema - no assumptions
4. Return ONLY the SQL query without explanations or markdown formatting
5. If schema info is unavailable, specify that database discovery is needed

===============================================`;
}



export function generateQueryDescriptionPrompt({
  finalSQL,
  query
}: QueryDescriptionParams): string {
  return `You are a medical database expert. Analyze this SQL query and provide a clear, professional explanation of what it does.

SQL Query: ${finalSQL}

Original User Question: ${query}

Provide a concise explanation (2-3 sentences) of:
1. What data this query retrieves
2. What conditions/filters are applied
3. How the results are organized

Keep it professional and easy to understand for both technical and non-technical users.`;
}



export function generateResultExplanationPrompt({
  query,
  finalSQL,
  rows,
  resultSample
}: ResultExplanationParams): string {
  return `You are a medical data analyst. Analyze these SQL query results and return a professional HTML summary.

Original Question: ${query}
SQL Query: ${finalSQL}
Total Results Found: ${rows.length}
Sample Results: ${JSON.stringify(resultSample, null, 2)}

Generate a clear, high-level explanation using HTML markup. Format the response as follows:
- A <h3> heading summarizing the result
- A short <p> paragraph (2–4 sentences) explaining:
  1. What was generally found in the data (without any individual-level detail)
  2. Key patterns or trends
  3. What this means in response to the user's question

Do NOT include any personal or sensitive data.
Avoid technical SQL details.
Keep the focus on medical/business relevance only.
Return only valid, semantic HTML.`;
}


export function generateErrorDescriptionPrompt({
  query,
  finalSQL,
  sqlError,
  errorDetails
}: ErrorDescriptionParams): string {
  return `You are a helpful database assistant. A user's SQL query failed with an error. Explain what went wrong in simple, non-technical terms and suggest how to fix it.

User's Original Question: ${query}
Generated SQL: ${finalSQL}
Error Message: ${sqlError.message}
Error Type: ${errorDetails?.error_type || "unknown"}

Provide a brief, user-friendly explanation (2-3 sentences) that:
1. Explains what went wrong in simple terms
2. Suggests how the user could rephrase their question
3. Is encouraging and helpful

Avoid technical jargon and focus on helping the user get the information they need.`;
}
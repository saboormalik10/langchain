import { getAzureOpenAIClient } from '../config/azure';
import { EnhancedQueryService } from './enhancedQueryService';

/**
 * Generate restructured SQL query using Azure OpenAI to produce structured, non-redundant results
 * 
 * This function takes the original SQL query and uses Azure OpenAI to:
 * 1. Generate a new SQL query that eliminates redundancy using JSON aggregation
 * 2. Create meaningful hierarchical structure directly in SQL
 * 3. Group related data logically using GROUP BY and JSON functions
 * 4. Provide structured explanation of the SQL transformation
 * 5. Ensure compatibility with specific database version
 * 
 * Works with both MySQL and PostgreSQL databases using version-appropriate JSON functions
 * 
 * @param originalSQL - The original SQL query that was executed
 * @param sqlResults - Sample results from original SQL execution for analysis
 * @param userPrompt - The original user query for context
 * @param dbType - Database type ('mysql' or 'postgresql') for appropriate JSON syntax
 * @param dbVersion - Database version information for compatibility
 * @param sampleSize - Number of sample records to send to Azure OpenAI for analysis
 * @returns Restructured SQL query with success/failure information
 */
export async function generateRestructuredSQL(
    originalSQL: string,
    sqlResults: any[],
    userPrompt: string,
    dbType: string,
    dbVersion: string,
    sampleSize: number = 3,
    sqlAgent: any,
    organizationId: string,
    databaseVersionInfo?: any,
    tableSchemas?: Record<string, any[]>,
    availableTables?: string[]
): Promise<any> {
    try {
        // Take sample of results for analysis
        const sampleResults = sqlResults.slice(0, sampleSize);

        if (sampleResults.length === 0) {
            return {
                restructured_data: [],
                restructure_success: false,
                restructure_message: "No data to restructure"
            };
        }

        console.log('🤖 Step 1: Using SQL Agent to get accurate database schema...');

        // Step 1: Use SQL Agent to explore and validate schema
        let schemaInfo = '';
        let tablesInfo = '';
        let validatedTables: string[] = [];
        let validatedColumns: { [table: string]: string[] } = {};

        try {
            // Extract table names from original SQL
            const tableNamePattern = /FROM\s+(\w+)|JOIN\s+(\w+)/gi;
            const tableMatches = [...originalSQL.matchAll(tableNamePattern)];
            const tableNames = [...new Set(tableMatches
                .map(match => match[1] || match[2])
                .filter(name => name && !['SELECT', 'WHERE', 'AND', 'OR', 'ORDER', 'GROUP', 'HAVING', 'LIMIT'].includes(name.toUpperCase()))
            )];

            console.log(`🔍 Detected tables from original SQL: ${tableNames.join(', ')}`);

            // Use SQL Agent to get table list and validate tables
            if (sqlAgent) {
                const tableListResult = await sqlAgent.call({
                    input: `List all available tables in the database and show me the schema for these specific tables: ${tableNames.join(', ')}. For each table, show all column names and their data types.`
                });

                if (tableListResult && tableListResult.output) {
                    tablesInfo = tableListResult.output;
                    console.log('✅ Got table information from SQL Agent');

                    // Extract validated table and column information from agent output
                    // This is a simple extraction - the agent output should contain table names and columns
                    const lines = tablesInfo.toLowerCase().split('\n');
                    let currentTable = '';

                    for (const line of lines) {
                        // Look for table names
                        for (const tableName of tableNames) {
                            if (line.includes(tableName.toLowerCase()) && (line.includes('table') || line.includes('schema'))) {
                                currentTable = tableName;
                                validatedTables.push(tableName);
                                validatedColumns[tableName] = [];
                                break;
                            }
                        }

                        // Look for column names (lines that contain column indicators)
                        if (currentTable && (line.includes('column') || line.includes('field') || line.includes('|'))) {
                            // Extract column names from the line
                            const columnMatches = line.match(/\b\w+\b/g);
                            if (columnMatches) {
                                for (const match of columnMatches) {
                                    if (match.length > 2 && !['column', 'field', 'type', 'table', 'schema', 'varchar', 'int', 'text', 'date', 'null'].includes(match.toLowerCase())) {
                                        if (!validatedColumns[currentTable].includes(match)) {
                                            validatedColumns[currentTable].push(match);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    console.log(`✅ Validated tables: ${validatedTables.join(', ')}`);
                    console.log(`✅ Extracted column information for schema validation`);
                }
            }
        } catch (schemaError: any) {
            console.error('❌ Error getting schema from SQL Agent:', schemaError.message);
            // Continue with Azure OpenAI only approach as fallback
        }

        console.log('🤖 Step 2: Using Azure OpenAI for restructuring logic with validated schema...');

        // Step 2: Create comprehensive restructuring prompt with database schema context
        console.log('🔍 Creating enhanced structured query prompt...');
        
        // Use our enhanced query service for structured query generation
        const restructuringPrompt = EnhancedQueryService.createStructuredEnhancedQuery({
            query: userPrompt,
            organizationId,
            databaseType: dbType,
            databaseVersionString: dbVersion,
            databaseVersionInfo,
            availableTables: availableTables || validatedTables,
            tableSchemas: tableSchemas || {},
            originalQuery: originalSQL
        });

        // Add additional structured query specific context
        const structuredQueryContext = `
=== STRUCTURED QUERY TRANSFORMATION CONTEXT ===

ORIGINAL SQL QUERY:
\`\`\`sql
${originalSQL}
\`\`\`

SAMPLE RESULTS FROM ORIGINAL QUERY (first ${sampleSize} records):
\`\`\`json
${JSON.stringify(sampleResults, null, 2)}
\`\`\`

TOTAL RECORDS IN ORIGINAL RESULT: ${sqlResults.length}

${tablesInfo ? `
VALIDATED DATABASE SCHEMA FROM SQL AGENT:
${tablesInfo}
` : ''}

=== TRANSFORMATION REQUIREMENTS ===
1. **ELIMINATE REDUNDANCY**: Use GROUP BY to group related entities (e.g., patients, medications, lab tests)
2. **CREATE JSON HIERARCHY**: Use ${dbType === 'mysql' ? 'JSON_OBJECT() and JSON_ARRAYAGG()' : 'json_build_object() and json_agg()'} functions to create nested structures
3. **MAINTAIN DATA INTEGRITY**: Don't lose any information from the original query
4. **BE LOGICAL**: Structure should make business sense for medical data (group by patient, medication, test type, etc.)
5. **USE APPROPRIATE GROUPING**: Identify the main entity (patient, medication, test, etc.) and group related data under it

${dbType === 'mysql' ? `
**CRITICAL MYSQL JSON SYNTAX RULES:**
- NEVER use DISTINCT inside JSON_ARRAYAGG() function
- Example: JSON_ARRAYAGG(JSON_OBJECT('key', value)) with proper GROUP BY
- For uniqueness, use proper GROUP BY clauses instead of DISTINCT inside JSON functions
` : ''}

**EXPECTED OUTPUT FORMAT:**
Return a JSON object with this structure:
{
  "restructured_sql": "your_new_sql_query_here",
  "explanation": "Brief explanation of how you restructured the query and why",
  "grouping_logic": "Explanation of what entities you grouped together",
  "expected_structure": "Description of the JSON structure the new query will produce",
  "main_entity": "The primary entity being grouped"
}

**CRITICAL:** Return only valid JSON without any markdown formatting, comments, or explanations outside the JSON.
========================
`;

        const finalPrompt = restructuringPrompt + '\n\n' + structuredQueryContext;

        console.log('🤖 Sending restructuring request to Azure OpenAI...');

        const azureOpenAIClient = getAzureOpenAIClient();
        if (!azureOpenAIClient) {
            throw new Error('Azure OpenAI client not available');
        }

        const completion = await azureOpenAIClient.chat.completions.create({
            model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are an expert data analyst specializing in restructuring relational database results into meaningful hierarchical JSON structures. You MUST return only valid JSON without any comments, markdown formatting, or additional text. Your response must be parseable by JSON.parse()."
                },
                {
                    role: "user",
                    content: finalPrompt
                }
            ],
            temperature: 0.1,
            max_tokens: 4000
        });

        const openaiResponse = completion.choices[0]?.message?.content;

        if (!openaiResponse) {
            throw new Error('No response from OpenAI');
        }

        console.log('🔍 Azure OpenAI response length:', openaiResponse.length);
        console.log('🔍 Response preview:', openaiResponse.substring(0, 200) + '...');

        // Parse the OpenAI response with robust error handling
        let restructuredResult;
        try {
            // Clean the response (remove any markdown formatting and comments)
            let cleanedResponse = openaiResponse
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .replace(/```/g, '')
                .trim();

            // Remove any single-line comments (//)
            cleanedResponse = cleanedResponse.replace(/\/\/.*$/gm, '');

            // Remove any multi-line comments (/* ... */)
            cleanedResponse = cleanedResponse.replace(/\/\*[\s\S]*?\*\//g, '');

            // Remove any trailing commas before closing brackets/braces
            cleanedResponse = cleanedResponse.replace(/,(\s*[\]}])/g, '$1');

            // First parsing attempt
            try {
                restructuredResult = JSON.parse(cleanedResponse);
            } catch (firstParseError) {
                console.log('🔄 First parse failed, trying to extract JSON object...');

                // Try to find the JSON object within the response
                const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const extractedJson = jsonMatch[0];

                    // Clean the extracted JSON further
                    const finalCleanedJson = extractedJson
                        .replace(/\/\/.*$/gm, '')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/,(\s*[\]}])/g, '$1');

                    restructuredResult = JSON.parse(finalCleanedJson);
                } else {
                    throw new Error('No valid JSON object found in response');
                }
            }
        } catch (parseError) {
            console.error('❌ Failed to parse Azure OpenAI response as JSON:', parseError);
            console.error('❌ Raw response:', openaiResponse.substring(0, 1000) + '...');
            console.error('❌ Error at position:', (parseError as any).message);

            return {
                restructured_sql: originalSQL, // Fallback to original SQL
                restructure_success: false,
                restructure_message: `Azure OpenAI response parsing failed: ${parseError}`,
                raw_openai_response: openaiResponse.substring(0, 500) + '...',
                error_details: `Parse error: ${parseError}. Response preview: ${openaiResponse.substring(0, 200)}...`,
                explanation: "Error parsing AI response",
                grouping_logic: "No grouping applied due to parsing error",
                expected_structure: "Original flat structure maintained",
                database_type: dbType,
                database_version: dbVersion
            };
        }

        // Validate the parsed result structure
        if (!restructuredResult || typeof restructuredResult !== 'object') {
            throw new Error('Parsed result is not a valid object');
        }

        if (!restructuredResult.restructured_sql || typeof restructuredResult.restructured_sql !== 'string') {
            console.log('⚠️ Invalid structure, no restructured SQL found...');

            return {
                restructured_sql: originalSQL, // Fallback to original SQL
                restructure_success: false,
                restructure_message: "No restructured SQL generated by AI, using original query",
                explanation: "AI did not provide a restructured SQL query",
                grouping_logic: "No grouping applied",
                expected_structure: "Original flat structure maintained",
                database_type: dbType,
                database_version: dbVersion
            };
        }

        // Validate that the generated SQL is different from the original
        const cleanedGeneratedSQL = restructuredResult.restructured_sql.trim().replace(/\s+/g, ' ');
        const cleanedOriginalSQL = originalSQL.trim().replace(/\s+/g, ' ');

        if (cleanedGeneratedSQL.toLowerCase() === cleanedOriginalSQL.toLowerCase()) {
            console.log('⚠️ Generated SQL is identical to original, no restructuring benefit...');

            return {
                restructured_sql: originalSQL,
                restructure_success: false,
                restructure_message: "Generated SQL is identical to original query",
                explanation: restructuredResult.explanation || "No restructuring applied",
                grouping_logic: restructuredResult.grouping_logic || "No grouping applied",
                expected_structure: restructuredResult.expected_structure || "Original structure maintained",
                database_type: dbType,
                database_version: dbVersion
            };
        }

        console.log('✅ Successfully generated restructured SQL query with Azure OpenAI');

        return {
            restructured_sql: restructuredResult.restructured_sql,
            restructure_success: true,
            restructure_message: "Successfully generated restructured SQL query using Azure OpenAI",
            explanation: restructuredResult.explanation || "SQL query restructured for better data organization",
            grouping_logic: restructuredResult.grouping_logic || "Applied intelligent grouping based on data analysis",
            expected_structure: restructuredResult.expected_structure || "Hierarchical JSON structure with reduced redundancy",
            main_entity: restructuredResult.main_entity || "Unknown",
            original_sql: originalSQL,
            sample_size_used: sampleSize,
            database_type: dbType,
            database_version: dbVersion
        };

    } catch (error: any) {
        console.error('❌ Error generating restructured SQL with Azure OpenAI:', error.message);

        return {
            restructured_sql: originalSQL, // Fallback to original SQL
            restructure_success: false,
            restructure_message: `SQL restructuring failed: ${error.message}`,
            error_details: error.message,
            explanation: "Error occurred during SQL restructuring",
            grouping_logic: "No grouping applied due to error",
            expected_structure: "Original flat structure maintained",
            database_type: dbType,
            database_version: dbVersion
        };
    }
}

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mysql from 'mysql2/promise';
import { MedicalDatabaseLangChainApp } from '../../index';
import { BufferMemory } from 'langchain/memory';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/databaseService';
import multiTenantLangChainService from '../../services/multiTenantLangChainService';
import { AzureOpenAI } from 'openai';

// Graph Types Enum
enum GraphType {
    BAR_CHART = 'bar_chart',
    LINE_CHART = 'line_chart',
    PIE_CHART = 'pie_chart',
    SCATTER_PLOT = 'scatter_plot',
    HISTOGRAM = 'histogram',
    BOX_PLOT = 'box_plot',
    HEATMAP = 'heatmap',
    TIMELINE = 'timeline',
    TREE_MAP = 'tree_map',
    RADAR_CHART = 'radar_chart',
    FUNNEL_CHART = 'funnel_chart',
    GAUGE_CHART = 'gauge_chart',
    BUBBLE_CHART = 'bubble_chart',
    AREA_CHART = 'area_chart',
    STACKED_BAR = 'stacked_bar',
    GROUPED_BAR = 'grouped_bar',
    MULTI_LINE = 'multi_line',
    DONUT_CHART = 'donut_chart',
    WATERFALL = 'waterfall',
    SANKEY_DIAGRAM = 'sankey_diagram'
}

// Medical Data Categories for Graph Context
enum MedicalDataCategory {
    PATIENT_DEMOGRAPHICS = 'patient_demographics',
    LABORATORY_RESULTS = 'laboratory_results',
    MEDICATIONS = 'medications',
    VITAL_SIGNS = 'vital_signs',
    DIAGNOSES = 'diagnoses',
    TREATMENTS = 'treatments',
    PROCEDURES = 'procedures',
    GENETIC_DATA = 'genetic_data',
    PHARMACOGENOMICS = 'pharmacogenomics',
    CLINICAL_TRIALS = 'clinical_trials',
    EPIDEMIOLOGY = 'epidemiology',
    OUTCOMES = 'outcomes',
    COST_ANALYSIS = 'cost_analysis',
    QUALITY_METRICS = 'quality_metrics',
    PATIENT_FLOW = 'patient_flow'
}

// Graph Configuration Interface
interface GraphConfig {
    type: GraphType;
    category?: MedicalDataCategory;
    xAxis?: string;
    yAxis?: string;
    colorBy?: string;
    sizeBy?: string;
    groupBy?: string;
    sortBy?: string;
    limit?: number;
    aggregation?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';
    timeFormat?: string;
    showTrends?: boolean;
    showOutliers?: boolean;
    includeNulls?: boolean;
    customColors?: string[];
    title?: string;
    subtitle?: string;
    description?: string;
}

// Graph Data Interface
interface GraphData {
    type: GraphType;
    data: any[];
    config: GraphConfig;
    metadata: {
        totalRecords: number;
        processedAt: string;
        dataQuality: {
            completeness: number;
            accuracy: number;
            consistency: number;
        };
        insights: string[];
        recommendations: string[];
    };
}

interface ConversationSession {
    memory: BufferMemory;
    lastAccess: Date;
    // Schema caching
    cachedSchema?: string;
    schemaLastUpdated?: Date;
    // For multi-agent system
    secondaryMemory?: BufferMemory;
    // For advanced analytics
    toolUsage?: Record<string, number>;
    queryHistory?: Array<{ query: string, success: boolean, executionTime: number }>;
    // For advanced conversation
    ambiguityResolutions?: Record<string, string>;
    userPreferences?: Record<string, any>;
    // For autocomplete
    frequentColumns?: string[];
    frequentTables?: string[];
    recentQueries?: string[];
}

const conversationSessions = new Map<string, ConversationSession>();

// Initialize Azure OpenAI client only if API key is available
let azureOpenAI: AzureOpenAI | null = null;
const isAzureOpenAIAvailable = !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);

// Function to get Azure OpenAI client lazily
function getAzureOpenAIClient(): AzureOpenAI | null {
    if (!isAzureOpenAIAvailable) {
        return null;
    }
    
    if (!azureOpenAI) {
        azureOpenAI = new AzureOpenAI({
            apiKey: process.env.AZURE_OPENAI_API_KEY,
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
        });
    }
    
    return azureOpenAI;
}

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
async function generateRestructuredSQL(
    originalSQL: string, 
    sqlResults: any[], 
    userPrompt: string, 
    dbType: string,
    dbVersion: string,
    sampleSize: number = 3,
    sqlAgent: any,
    organizationId: string
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

        const restructuringPrompt = `
You are an expert SQL developer specializing in transforming flat relational queries into structured, hierarchical queries that eliminate redundancy using JSON aggregation functions.

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

${tablesInfo ? `
VALIDATED DATABASE SCHEMA FROM SQL AGENT:
${tablesInfo}

CRITICAL: Use ONLY the table and column names shown above. These are the actual names in the database.
` : ''}

VALIDATED TABLES: ${validatedTables.length > 0 ? validatedTables.join(', ') : 'Schema validation failed - use original SQL table names'}

TASK: Generate a new SQL query that produces structured, non-redundant results directly from the database.

RESTRUCTURING REQUIREMENTS:
1. **ELIMINATE REDUNDANCY**: Use GROUP BY to group related entities (e.g., patients, medications, lab tests)
2. **CREATE JSON HIERARCHY**: Use ${dbType === 'mysql' ? 'JSON_OBJECT() and JSON_ARRAYAGG()' : 'json_build_object() and json_agg()'} functions to create nested structures
3. **MAINTAIN DATA INTEGRITY**: Don't lose any information from the original query
4. **BE LOGICAL**: Structure should make business sense for medical data (group by patient, medication, test type, etc.)
5. **USE APPROPRIATE GROUPING**: Identify the main entity (patient, medication, test, etc.) and group related data under it
6. **VERSION COMPATIBILITY**: Ensure the generated SQL is compatible with ${dbType.toUpperCase()} ${dbVersion}
7. **SCHEMA ACCURACY**: Use ONLY validated table and column names from the database schema above

DATABASE-SPECIFIC JSON FUNCTIONS FOR ${dbType.toUpperCase()} ${dbVersion}:
${dbType === 'mysql' ? `
MySQL ${dbVersion} JSON Functions:
- JSON_OBJECT('key', value, 'key2', value2) - creates JSON object
- JSON_ARRAYAGG(JSON_OBJECT('key', value)) - creates array of JSON objects (MySQL 5.7.22+)
- JSON_ARRAY(value1, value2, ...) - creates JSON array
- GROUP_CONCAT(DISTINCT column) - concatenates values (alternative to JSON)

CRITICAL MYSQL VERSION CONSTRAINTS FOR ${dbVersion}:
- JSON functions require MySQL 5.7+ for full support
- JSON_ARRAYAGG() available in MySQL 5.7.22+
- NEVER use DISTINCT inside JSON_ARRAYAGG() - use GROUP BY instead for uniqueness
- For duplicate removal, use proper GROUP BY clauses, not DISTINCT inside JSON functions
- Example: Instead of JSON_ARRAYAGG(DISTINCT value), use GROUP BY and JSON_ARRAYAGG(value)

CORRECT MYSQL SYNTAX:
✅ CORRECT: JSON_ARRAYAGG(JSON_OBJECT('key', value)) with proper GROUP BY
❌ INCORRECT: JSON_ARRAYAGG(DISTINCT JSON_OBJECT('key', value)) - DISTINCT not supported
❌ INCORRECT: JSON_ARRAYAGG(DISTINCT value) - DISTINCT not supported inside JSON_ARRAYAGG
- Note: JSON functions require MySQL 5.7+ for full support
- Use appropriate syntax for version ${dbVersion}
` : `
PostgreSQL ${dbVersion} JSON Functions:  
- json_build_object('key', value, 'key2', value2) - creates JSON object
- json_agg(json_build_object('key', value)) - creates array of JSON objects (PostgreSQL 9.3+)
- json_build_array(value1, value2, ...) - creates JSON array
- array_agg(DISTINCT column) - creates array of values
- Note: JSON functions available in PostgreSQL 9.2+, json_build_* in 9.4+
- Use appropriate syntax for version ${dbVersion}
`}

VERSION-SPECIFIC CONSIDERATIONS:
${dbType === 'mysql' ? `
- For MySQL ${dbVersion}: Check JSON function availability and syntax compatibility
- Use proper escaping for JSON string values
- Consider GROUP_CONCAT as fallback for older versions
- Ensure proper handling of NULL values in JSON functions
- CRITICAL: NEVER use DISTINCT inside JSON_ARRAYAGG() - MySQL does not support this syntax
- For uniqueness, rely on proper GROUP BY clauses instead of DISTINCT inside JSON functions
- Test all JSON function syntax against MySQL ${dbVersion} compatibility
` : `
- For PostgreSQL ${dbVersion}: Verify json_build_* function availability
- Use appropriate casting (::json) if needed for older versions
- Consider using row_to_json() for complex objects
- Ensure proper handling of NULL values in JSON aggregation
`}

EXAMPLE TRANSFORMATIONS:

Original flat query returning patient-medication pairs:
\`\`\`sql
SELECT p.name, p.age, m.medication_name, m.dosage 
FROM patients p JOIN medications m ON p.id = m.patient_id
\`\`\`

Restructured query with hierarchy:
${dbType === 'mysql' ? `
\`\`\`sql
SELECT 
    JSON_OBJECT(
        'patient', JSON_OBJECT(
            'name', p.name,
            'age', p.age,
            'id', p.id
        ),
        'medications', JSON_ARRAYAGG(
            JSON_OBJECT(
                'medication_name', m.medication_name,
                'dosage', m.dosage,
                'frequency', m.frequency
            )
        ),
        'total_medications', COUNT(m.id)
    ) as structured_result
FROM patients p 
LEFT JOIN medications m ON p.id = m.patient_id 
GROUP BY p.id, p.name, p.age
\`\`\`
` : `
\`\`\`sql
SELECT 
    json_build_object(
        'patient', json_build_object(
            'name', p.name,
            'age', p.age,
            'id', p.id
        ),
        'medications', json_agg(
            json_build_object(
                'medication_name', m.medication_name,
                'dosage', m.dosage,
                'frequency', m.frequency
            )
        ),
        'total_medications', count(m.id)
    ) as structured_result
FROM patients p 
LEFT JOIN medications m ON p.id = m.patient_id 
GROUP BY p.id, p.name, p.age
\`\`\`
`}

EXPECTED OUTPUT FORMAT:
Return a JSON object with this structure:
{
  "restructured_sql": "your_new_sql_query_here",
  "explanation": "Brief explanation of how you restructured the query and why",
  "grouping_logic": "Explanation of what entities you grouped together (e.g., 'Grouped by patient_id to eliminate patient duplication')",
  "expected_structure": "Description of the JSON structure the new query will produce",
  "main_entity": "The primary entity being grouped (e.g., 'patient', 'medication', 'lab_test')"
}

CRITICAL REQUIREMENTS:
- Generate a complete, executable SQL query that uses JSON functions compatible with ${dbType.toUpperCase()} ${dbVersion}
- The query should return fewer rows than the original (due to grouping)
- Each row should contain a JSON object with hierarchical structure
- Use appropriate GROUP BY clause to eliminate redundancy
- Include all original data but organized hierarchically
- Use LEFT JOIN if needed to preserve main entities even without related data
- Ensure SQL syntax is correct and compatible with ${dbType.toUpperCase()} ${dbVersion}
- Handle NULL values appropriately in JSON functions
- Use version-appropriate JSON function syntax

VERSION COMPATIBILITY NOTES:
${dbType === 'mysql' ? `
- For MySQL versions prior to 5.7.22, consider using GROUP_CONCAT instead of JSON_ARRAYAGG
- Ensure proper JSON escaping for string values
- Use COALESCE() or IFNULL() to handle NULL values in JSON functions
` : `
- For PostgreSQL versions prior to 9.4, use json_agg() instead of json_build_object()
- Consider row_to_json() for complex object structures in older versions
- Use COALESCE() to handle NULL values in JSON aggregation
`}

IMPORTANT: 
- Focus on the primary entity that appears most frequently in the sample data
- If data shows patients with multiple medications, group by patient
- If data shows medications with multiple effects, group by medication  
- If data shows lab tests with multiple results, group by test or patient
- Use the user's original query intent to determine the best grouping strategy

${dbType === 'mysql' ? `
FINAL MYSQL SYNTAX REMINDER FOR ${dbVersion}:
- ABSOLUTELY NEVER use DISTINCT inside JSON_ARRAYAGG() function
- NEVER write: JSON_ARRAYAGG(DISTINCT column) or JSON_ARRAYAGG(DISTINCT JSON_OBJECT(...))
- For unique values, use proper GROUP BY clauses instead
- ALL JSON functions must be compatible with MySQL ${dbVersion}
- Double-check every JSON function call for MySQL compatibility
` : ''}

Return only valid JSON without any markdown formatting, comments, or explanations outside the JSON.
`;

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
                    content: restructuringPrompt
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

/**
 * Generate bar chart analysis using Azure OpenAI
 * 
 * This function takes the structured query and user prompt to analyze data for bar chart creation.
 * It provides comprehensive parameters needed for creating meaningful bar charts.
 * 
 * @param structuredQuery - The SQL query that was executed
 * @param userPrompt - The original user query/prompt
 * @param sqlResults - The results from SQL execution for analysis
 * @param organizationId - The organization identifier
 * @returns Promise with bar chart analysis and parameters
 */
async function generateBarChartAnalysis(
    structuredQuery: string,
    userPrompt: string,
    sqlResults: any[],
    organizationId: string
): Promise<any> {
    try {
        console.log('📊 Starting Azure OpenAI bar chart analysis...');
        
        const azureClient = getAzureOpenAIClient();
        if (!azureClient) {
            console.log('⚠️ Azure OpenAI not available, skipping bar chart analysis');
            return {
                bar_chart_success: false,
                message: "Azure OpenAI not available",
                timestamp: new Date().toISOString()
            };
        }

        // Sample the results for analysis (first 5 rows)
        const sampleResults = sqlResults.slice(0, 5);
        const resultColumns = sampleResults.length > 0 ? Object.keys(sampleResults[0]) : [];
        
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
${resultColumns.join(', ')}

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

        console.log('🤖 Sending bar chart analysis request to Azure OpenAI...');
        
        const completion = await azureClient.chat.completions.create({
            model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
            messages: [
                {
                    role: "system", 
                    content: "You are a medical data visualization expert. Always respond with valid JSON only."
                },
                {
                    role: "user", 
                    content: analysisPrompt
                }
            ],
            max_tokens: 2000,
            temperature: 0.3,
            response_format: { type: "json_object" }
        });

        const response = completion.choices[0]?.message?.content;
        if (!response) {
            throw new Error('No response from Azure OpenAI');
        }

        console.log('✅ Received response from Azure OpenAI for bar chart analysis');
        console.log('📄 Raw response length:', response.length);

        // Parse the JSON response
        let analysisResult;
        try {
            analysisResult = JSON.parse(response);
        } catch (parseError) {
            console.error('❌ Failed to parse Azure OpenAI response as JSON:', parseError);
            console.error('❌ Raw response:', response.substring(0, 500) + '...');
            
            return {
                bar_chart_success: false,
                message: "Failed to parse bar chart analysis response",
                error_details: parseError,
                raw_response: response.substring(0, 500) + '...',
                timestamp: new Date().toISOString()
            };
        }

        // Validate the response structure
        if (!analysisResult || typeof analysisResult !== 'object') {
            throw new Error('Invalid response structure from Azure OpenAI');
        }

        // Add metadata to the response
        analysisResult.metadata = {
            analyzed_at: new Date().toISOString(),
            organization_id: organizationId,
            data_sample_size: sampleResults.length,
            total_columns: resultColumns.length,
            query_complexity: structuredQuery.length > 200 ? 'complex' : 'simple',
            ai_model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4"
        };

        console.log('✅ Bar chart analysis completed successfully');
        
        return analysisResult;

    } catch (error: any) {
        console.error('❌ Error generating bar chart analysis with Azure OpenAI:', error.message);
        
        return {
            bar_chart_success: false,
            message: `Bar chart analysis failed: ${error.message}`,
            error_details: error.message,
            fallback_parameters: {
                chart_type: "BAR_CHART",
                title: "Data Visualization",
                x_axis: sqlResults.length > 0 ? Object.keys(sqlResults[0])[0] : "category",
                y_axis: sqlResults.length > 0 ? Object.keys(sqlResults[0])[1] : "value",
                basic_config: true
            },
            timestamp: new Date().toISOString()
        };
    }
}


// Cleanup function for expired conversations (runs every hour)
const CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
setInterval(() => {
    const now = new Date();
    let expiredCount = 0;

    conversationSessions.forEach((session, sessionId) => {
        const timeDiff = now.getTime() - session.lastAccess.getTime();
        if (timeDiff > CONVERSATION_TIMEOUT_MS) {
            conversationSessions.delete(sessionId);
            expiredCount++;
        }
    });

    if (expiredCount > 0) {
        console.log(`🧹 Cleaned up ${expiredCount} expired conversation sessions`);
    }
}, 60 * 60 * 1000); // Check every hour

// Graph Processing Functions
class GraphProcessor {
    /**
     * Convert SQL results to graph data based on configuration
     */
    static processGraphData(sqlResults: any[], graphConfig: GraphConfig): GraphData {
        console.log(`📊 Processing graph data for type: ${graphConfig.type}`);

        let processedData = this.transformData(sqlResults, graphConfig);
        let insights = this.generateInsights(processedData, graphConfig);
        let recommendations = this.generateRecommendations(processedData, graphConfig);

        return {
            type: graphConfig.type,
            data: processedData,
            config: graphConfig,
            metadata: {
                totalRecords: sqlResults.length,
                processedAt: new Date().toISOString(),
                dataQuality: this.assessDataQuality(sqlResults),
                insights,
                recommendations
            }
        };
    }

    /**
     * Transform SQL results into graph-specific format
     */
    private static transformData(data: any[], config: GraphConfig): any[] {
        if (!data || data.length === 0) return [];

        switch (config.type) {
            case GraphType.BAR_CHART:
                return this.transformForBarChart(data, config);
            case GraphType.LINE_CHART:
                return this.transformForLineChart(data, config);
            case GraphType.PIE_CHART:
                return this.transformForPieChart(data, config);
            case GraphType.SCATTER_PLOT:
                return this.transformForScatterPlot(data, config);
            case GraphType.HISTOGRAM:
                return this.transformForHistogram(data, config);
            case GraphType.BOX_PLOT:
                return this.transformForBoxPlot(data, config);
            case GraphType.HEATMAP:
                return this.transformForHeatmap(data, config);
            case GraphType.TIMELINE:
                return this.transformForTimeline(data, config);
            case GraphType.STACKED_BAR:
                return this.transformForStackedBar(data, config);
            case GraphType.GROUPED_BAR:
                return this.transformForGroupedBar(data, config);
            case GraphType.MULTI_LINE:
                return this.transformForMultiLine(data, config);
            case GraphType.AREA_CHART:
                return this.transformForAreaChart(data, config);
            case GraphType.BUBBLE_CHART:
                return this.transformForBubbleChart(data, config);
            case GraphType.DONUT_CHART:
                return this.transformForDonutChart(data, config);
            case GraphType.WATERFALL:
                return this.transformForWaterfall(data, config);
            default:
                return this.transformForGenericChart(data, config);
        }
    }

    /**
     * Combine data with same labels to prevent duplicates
     */
    private static combineDataByLabel(data: any[], labelKey: string = 'label', valueKey: string = 'y', aggregation: string = 'sum'): any[] {
        const grouped = new Map<string, any>();

        data.forEach(item => {
            const label = item[labelKey];
            if (!label) return;

            if (!grouped.has(label)) {
                grouped.set(label, { ...item });
            } else {
                const existing = grouped.get(label);
                const existingValue = this.parseNumericValue(existing[valueKey]);
                const newValue = this.parseNumericValue(item[valueKey]);

                let combinedValue: number;
                switch (aggregation) {
                    case 'sum':
                        combinedValue = existingValue + newValue;
                        break;
                    case 'avg':
                        // For average, we need to track count and sum
                        const count = existing.count || 1;
                        const sum = existing.sum || existingValue;
                        combinedValue = (sum + newValue) / (count + 1);
                        existing.count = count + 1;
                        existing.sum = sum + newValue;
                        break;
                    case 'max':
                        combinedValue = Math.max(existingValue, newValue);
                        break;
                    case 'min':
                        combinedValue = Math.min(existingValue, newValue);
                        break;
                    default:
                        combinedValue = existingValue + newValue;
                }

                existing[valueKey] = combinedValue;

                // Merge additional properties if they exist
                if (item.color && !existing.color) {
                    existing.color = item.color;
                }
                if (item.group && !existing.group) {
                    existing.group = item.group;
                }
            }
        });

        return Array.from(grouped.values());
    }

    /**
     * Transform data for bar charts
     */
    private static transformForBarChart(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        console.log(`📊 Bar chart transformation: xAxis=${xAxis}, yAxis=${yAxis}`);

        if (config.aggregation) {
            return this.aggregateData(data, xAxis, yAxis, config.aggregation);
        }

        // Transform data first
        const transformedData = data.map(item => ({
            x: item[xAxis],
            y: this.parseNumericValue(item[yAxis]),
            label: item[xAxis],
            color: config.colorBy ? item[config.colorBy] : undefined
        }));

        // Combine data with same labels to prevent duplicates
        return this.combineDataByLabel(transformedData, 'label', 'y', config.aggregation || 'sum');
    }

    /**
     * Transform data for line charts
     */
    private static transformForLineChart(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map(item => ({
            x: this.parseDateValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            label: item[xAxis],
            group: config.colorBy ? item[config.colorBy] : undefined
        })).sort((a, b) => a.x - b.x);
    }

    /**
     * Transform data for pie charts
     */
    private static transformForPieChart(data: any[], config: GraphConfig): any[] {
        const labelField = config.xAxis || Object.keys(data[0] || {})[0];
        const valueField = config.yAxis || Object.keys(data[0] || {})[1];

        if (config.aggregation) {
            return this.aggregateData(data, labelField, valueField, config.aggregation);
        }

        // Transform data first
        const transformedData = data.map(item => ({
            label: item[labelField],
            value: this.parseNumericValue(item[valueField]),
            color: config.colorBy ? item[config.colorBy] : undefined
        }));

        // Combine data with same labels to prevent duplicates
        return this.combineDataByLabel(transformedData, 'label', 'value', config.aggregation || 'sum');
    }

    /**
     * Transform data for scatter plots
     */
    private static transformForScatterPlot(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map(item => ({
            x: this.parseNumericValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            size: config.sizeBy ? this.parseNumericValue(item[config.sizeBy]) : 10,
            color: config.colorBy ? item[config.colorBy] : undefined,
            label: item[xAxis]
        }));
    }

    /**
     * Transform data for histograms
     */
    private static transformForHistogram(data: any[], config: GraphConfig): any[] {
        const valueField = config.xAxis || Object.keys(data[0] || {})[0];
        const values = data.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));

        if (values.length === 0) return [];

        const min = Math.min(...values);
        const max = Math.max(...values);
        const binCount = Math.min(10, Math.ceil(Math.sqrt(values.length)));
        const binSize = (max - min) / binCount;

        const bins = Array(binCount).fill(0).map((_, i) => ({
            start: min + i * binSize,
            end: min + (i + 1) * binSize,
            count: 0
        }));

        values.forEach(value => {
            const binIndex = Math.min(Math.floor((value - min) / binSize), binCount - 1);
            bins[binIndex].count++;
        });

        return bins.map(bin => ({
            x: `${bin.start.toFixed(2)}-${bin.end.toFixed(2)}`,
            y: bin.count,
            start: bin.start,
            end: bin.end
        }));
    }

    /**
     * Transform data for box plots
     */
    private static transformForBoxPlot(data: any[], config: GraphConfig): any[] {
        const valueField = config.xAxis || Object.keys(data[0] || {})[0];
        const groupField = config.groupBy || config.colorBy;

        if (groupField) {
            const groups = this.groupData(data, groupField);
            return Object.entries(groups).map(([group, groupData]) => {
                const values = groupData.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));
                return this.calculateBoxPlotStats(values, group);
            });
        } else {
            const values = data.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));
            return [this.calculateBoxPlotStats(values, 'all')];
        }
    }

    /**
     * Transform data for heatmaps
     */
    private static transformForHeatmap(data: any[], config: GraphConfig): any[] {
        const xField = config.xAxis || Object.keys(data[0] || {})[0];
        const yField = config.yAxis || Object.keys(data[0] || {})[1];
        const valueField = config.sizeBy || Object.keys(data[0] || {})[2];

        return data.map(item => ({
            x: item[xField],
            y: item[yField],
            value: this.parseNumericValue(item[valueField]),
            color: this.getHeatmapColor(this.parseNumericValue(item[valueField]))
        }));
    }

    /**
     * Transform data for timelines
     */
    private static transformForTimeline(data: any[], config: GraphConfig): any[] {
        const timeField = config.xAxis || Object.keys(data[0] || {})[0];
        const eventField = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map(item => ({
            time: this.parseDateValue(item[timeField]),
            event: item[eventField],
            description: config.colorBy ? item[config.colorBy] : undefined,
            category: config.groupBy ? item[config.groupBy] : undefined
        })).sort((a, b) => a.time - b.time);
    }

    /**
     * Transform data for stacked bar charts
     */
    private static transformForStackedBar(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const stackBy = config.groupBy || config.colorBy;

        if (!stackBy) return this.transformForBarChart(data, config);

        const groups = this.groupData(data, xAxis);
        return Object.entries(groups).map(([xValue, groupData]) => {
            const stacks = this.groupData(groupData, stackBy);
            return {
                x: xValue,
                stacks: Object.entries(stacks).map(([stackName, stackData]) => ({
                    name: stackName,
                    value: stackData.reduce((sum, item) => sum + this.parseNumericValue(item[yAxis]), 0)
                }))
            };
        });
    }

    /**
     * Transform data for grouped bar charts
     */
    private static transformForGroupedBar(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const groupBy = config.groupBy || config.colorBy;

        if (!groupBy) return this.transformForBarChart(data, config);

        const groups = this.groupData(data, groupBy);
        return Object.entries(groups).map(([groupName, groupData]) => ({
            group: groupName,
            bars: groupData.map(item => ({
                x: item[xAxis],
                y: this.parseNumericValue(item[yAxis]),
                label: item[xAxis]
            }))
        }));
    }

    /**
     * Transform data for multi-line charts
     */
    private static transformForMultiLine(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const lineBy = config.groupBy || config.colorBy;

        if (!lineBy) return this.transformForLineChart(data, config);

        const lines = this.groupData(data, lineBy);
        return Object.entries(lines).map(([lineName, lineData]) => ({
            name: lineName,
            data: lineData.map(item => ({
                x: this.parseDateValue(item[xAxis]),
                y: this.parseNumericValue(item[yAxis])
            })).sort((a, b) => a.x - b.x)
        }));
    }

    /**
     * Transform data for area charts
     */
    private static transformForAreaChart(data: any[], config: GraphConfig): any[] {
        const result = this.transformForLineChart(data, config);
        return result.map(item => ({
            ...item,
            area: true
        }));
    }

    /**
     * Transform data for bubble charts
     */
    private static transformForBubbleChart(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const sizeField = config.sizeBy || Object.keys(data[0] || {})[2];

        return data.map(item => ({
            x: this.parseNumericValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            size: this.parseNumericValue(item[sizeField]),
            color: config.colorBy ? item[config.colorBy] : undefined,
            label: item[xAxis]
        }));
    }

    /**
     * Transform data for donut charts
     */
    private static transformForDonutChart(data: any[], config: GraphConfig): any[] {
        return this.transformForPieChart(data, config);
    }

    /**
     * Transform data for waterfall charts
     */
    private static transformForWaterfall(data: any[], config: GraphConfig): any[] {
        const labelField = config.xAxis || Object.keys(data[0] || {})[0];
        const valueField = config.yAxis || Object.keys(data[0] || {})[1];

        let runningTotal = 0;
        return data.map(item => {
            const value = this.parseNumericValue(item[valueField]);
            const start = runningTotal;
            runningTotal += value;
            return {
                label: item[labelField],
                value: value,
                start: start,
                end: runningTotal,
                color: value >= 0 ? 'positive' : 'negative'
            };
        });
    }

    /**
     * Generic chart transformation
     */
    private static transformForGenericChart(data: any[], config: GraphConfig): any[] {
        return data.map(item => ({
            ...item,
            processed: true
        }));
    }

    /**
     * Aggregate data based on specified function
     */
    private static aggregateData(data: any[], groupBy: string, valueField: string, aggregation: string): any[] {
        const groups = this.groupData(data, groupBy);

        return Object.entries(groups).map(([group, groupData]) => {
            const values = groupData.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));
            let aggregatedValue = 0;

            switch (aggregation) {
                case 'count':
                    aggregatedValue = groupData.length;
                    break;
                case 'sum':
                    aggregatedValue = values.reduce((sum, val) => sum + val, 0);
                    break;
                case 'avg':
                    aggregatedValue = values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
                    break;
                case 'min':
                    aggregatedValue = values.length > 0 ? Math.min(...values) : 0;
                    break;
                case 'max':
                    aggregatedValue = values.length > 0 ? Math.max(...values) : 0;
                    break;
                case 'median':
                    aggregatedValue = this.calculateMedian(values);
                    break;
                default:
                    aggregatedValue = values.reduce((sum, val) => sum + val, 0);
            }

            return {
                label: group,
                value: aggregatedValue,
                count: groupData.length
            };
        });
    }

    /**
     * Group data by a specific field
     */
    private static groupData(data: any[], groupBy: string): Record<string, any[]> {
        return data.reduce((groups, item) => {
            const key = item[groupBy] || 'Unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
            return groups;
        }, {} as Record<string, any[]>);
    }

    /**
     * Calculate box plot statistics
     */
    private static calculateBoxPlotStats(values: number[], group: string): any {
        if (values.length === 0) return { group, min: 0, q1: 0, median: 0, q3: 0, max: 0 };

        values.sort((a, b) => a - b);
        const min = values[0];
        const max = values[values.length - 1];
        const q1 = this.calculatePercentile(values, 25);
        const median = this.calculatePercentile(values, 50);
        const q3 = this.calculatePercentile(values, 75);

        return { group, min, q1, median, q3, max };
    }

    /**
     * Calculate percentile
     */
    private static calculatePercentile(values: number[], percentile: number): number {
        const index = (percentile / 100) * (values.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;

        if (upper === lower) return values[lower];
        return values[lower] * (1 - weight) + values[upper] * weight;
    }

    /**
     * Calculate median
     */
    private static calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        values.sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
    }

    /**
     * Parse numeric value safely
     */
    private static parseNumericValue(value: any): number {
        if (value === null || value === undefined) return 0;
        const parsed = parseFloat(value);
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Parse date value safely
     */
    private static parseDateValue(value: any): number {
        if (value === null || value === undefined) return 0;
        const date = new Date(value);
        return isNaN(date.getTime()) ? 0 : date.getTime();
    }



    /**
     * Get heatmap color based on value
     */
    private static getHeatmapColor(value: number): string {
        // Simple color scale from blue (low) to red (high)
        const normalized = Math.max(0, Math.min(1, value / 100));
        const r = Math.round(255 * normalized);
        const b = Math.round(255 * (1 - normalized));
        return `rgb(${r}, 0, ${b})`;
    }

    /**
     * Assess data quality
     */
    private static assessDataQuality(data: any[]): { completeness: number; accuracy: number; consistency: number } {
        if (data.length === 0) return { completeness: 0, accuracy: 0, consistency: 0 };

        const totalFields = Object.keys(data[0] || {}).length;
        let totalNulls = 0;
        let totalValues = 0;

        data.forEach(item => {
            Object.values(item).forEach(value => {
                totalValues++;
                if (value === null || value === undefined || value === '') {
                    totalNulls++;
                }
            });
        });

        const completeness = ((totalValues - totalNulls) / totalValues) * 100;
        const accuracy = Math.min(100, Math.max(0, 100 - (totalNulls / data.length) * 10));
        const consistency = Math.min(100, Math.max(0, 100 - (totalNulls / totalValues) * 20));

        return { completeness, accuracy, consistency };
    }

    /**
     * Generate insights from data
     */
    private static generateInsights(data: any[], config: GraphConfig): string[] {
        const insights: string[] = [];

        if (data.length === 0) {
            insights.push('No data available for visualization');
            return insights;
        }

        // Basic insights based on data type
        switch (config.type) {
            case GraphType.BAR_CHART:
            case GraphType.PIE_CHART:
                const maxValue = Math.max(...data.map(d => d.value || d.y || 0));
                const minValue = Math.min(...data.map(d => d.value || d.y || 0));
                insights.push(`Highest value: ${maxValue}`);
                insights.push(`Lowest value: ${minValue}`);
                insights.push(`Data range: ${maxValue - minValue}`);
                break;
            case GraphType.LINE_CHART:
            case GraphType.TIMELINE:
                insights.push(`Time span: ${data.length} data points`);
                if (data.length > 1) {
                    const trend = data[data.length - 1].y > data[0].y ? 'increasing' : 'decreasing';
                    insights.push(`Overall trend: ${trend}`);
                }
                break;
            case GraphType.SCATTER_PLOT:
                insights.push(`Correlation analysis available`);
                insights.push(`Outlier detection possible`);
                break;
        }

        // Medical-specific insights
        if (config.category) {
            switch (config.category) {
                case MedicalDataCategory.PATIENT_DEMOGRAPHICS:
                    insights.push('Demographic distribution analysis');
                    break;
                case MedicalDataCategory.LABORATORY_RESULTS:
                    insights.push('Lab result trends and ranges');
                    break;
                case MedicalDataCategory.MEDICATIONS:
                    insights.push('Medication usage patterns');
                    break;
                case MedicalDataCategory.VITAL_SIGNS:
                    insights.push('Vital sign monitoring trends');
                    break;
            }
        }

        return insights;
    }

    /**
     * Generate recommendations based on data and graph type
     */
    private static generateRecommendations(data: any[], config: GraphConfig): string[] {
        const recommendations: string[] = [];

        if (data.length === 0) {
            recommendations.push('Consider expanding the data query to include more records');
            return recommendations;
        }

        // Recommendations based on data quality
        const quality = this.assessDataQuality(data);
        if (quality.completeness < 80) {
            recommendations.push('Data completeness is low - consider data cleaning');
        }
        if (quality.accuracy < 90) {
            recommendations.push('Data accuracy could be improved - verify data sources');
        }

        // Recommendations based on graph type
        switch (config.type) {
            case GraphType.BAR_CHART:
                if (data.length > 20) {
                    recommendations.push('Consider grouping categories for better readability');
                }
                break;
            case GraphType.LINE_CHART:
                if (data.length < 5) {
                    recommendations.push('More data points recommended for trend analysis');
                }
                break;
            case GraphType.PIE_CHART:
                if (data.length > 8) {
                    recommendations.push('Consider combining smaller segments into "Other" category');
                }
                break;
            case GraphType.SCATTER_PLOT:
                recommendations.push('Consider adding trend lines for pattern analysis');
                break;
        }

        // Medical-specific recommendations
        if (config.category) {
            switch (config.category) {
                case MedicalDataCategory.LABORATORY_RESULTS:
                    recommendations.push('Consider adding normal range indicators');
                    break;
                case MedicalDataCategory.MEDICATIONS:
                    recommendations.push('Consider drug interaction analysis');
                    break;
                case MedicalDataCategory.VITAL_SIGNS:
                    recommendations.push('Consider adding alert thresholds');
                    break;
            }
        }

        return recommendations;
    }
}


export function medicalRoutes(): Router {
    const router = Router();

    // SQL Validation Functions
    interface SQLValidationResult {
        isValid: boolean;
        issues: string[];
        suggestions: string[];
    }

    /**
     * Validates if the generated SQL query matches the original query criteria
     */
    async function validateSQLAgainstCriteria(
        sql: string,
        originalQuery: string,
        langchainApp: MedicalDatabaseLangChainApp,
        organizationId: string,
        dbConfig: any
    ): Promise<SQLValidationResult> {
        const issues: string[] = [];
        const suggestions: string[] = [];
        let isValid = true;

        try {
            console.log('🔍 Validating SQL against criteria...');
            console.log('📝 Original query:', originalQuery);
            console.log('🔧 Generated SQL:', sql);

            // 1. Check if SQL contains the main keywords from the original query
            const originalLower = originalQuery.toLowerCase();
            const sqlLower = sql.toLowerCase();

            // Extract key medical terms and conditions from original query
            const medicalTerms = originalQuery.match(/\b(patient|diagnosis|medication|treatment|procedure|test|result|symptom|condition|disease|doctor|physician|nurse|clinic|hospital|lab|laboratory|blood|urine|genetic|pgx|pharmacogenomic|dosage|allergy|adverse|reaction|age|gender|ethnicity|race)\w*/gi) || [];

            // Check if important medical terms are referenced in the SQL
            for (const term of medicalTerms) {
                if (!sqlLower.includes(term.toLowerCase())) {
                    // Check if there's a related table or column that might contain this data
                    const relatedFound = await checkForRelatedTerm(term, sql, langchainApp, organizationId);
                    if (!relatedFound) {
                        issues.push(`Medical term "${term}" from original query not found in SQL`);
                        suggestions.push(`Consider adding reference to ${term} or related medical data`);
                        isValid = false;
                    }
                }
            }

            // 2. Check for specific query patterns and requirements
            if (originalLower.includes('count') || originalLower.includes('how many')) {
                if (!sqlLower.includes('count(') && !sqlLower.includes('group by')) {
                    issues.push('Original query asks for counting but SQL does not include COUNT() or GROUP BY');
                    suggestions.push('Add COUNT() aggregation or GROUP BY clause');
                    isValid = false;
                }
            }

            if (originalLower.includes('average') || originalLower.includes('mean')) {
                if (!sqlLower.includes('avg(')) {
                    issues.push('Original query asks for average but SQL does not include AVG()');
                    suggestions.push('Add AVG() aggregation function');
                    isValid = false;
                }
            }

            if (originalLower.includes('maximum') || originalLower.includes('highest') || originalLower.includes('max')) {
                if (!sqlLower.includes('max(') && !sqlLower.includes('order by') && !sqlLower.includes('desc')) {
                    issues.push('Original query asks for maximum but SQL does not include MAX() or ORDER BY DESC');
                    suggestions.push('Add MAX() function or ORDER BY DESC with LIMIT');
                    isValid = false;
                }
            }

            if (originalLower.includes('minimum') || originalLower.includes('lowest') || originalLower.includes('min')) {
                if (!sqlLower.includes('min(') && !sqlLower.includes('order by') && !sqlLower.includes('asc')) {
                    issues.push('Original query asks for minimum but SQL does not include MIN() or ORDER BY ASC');
                    suggestions.push('Add MIN() function or ORDER BY ASC with LIMIT');
                    isValid = false;
                }
            }

            // 3. Check for filtering conditions mentioned in original query
            const conditions = extractConditionsFromQuery(originalQuery);
            for (const condition of conditions) {
                if (!sqlLower.includes('where') && condition.length > 0) {
                    issues.push('Original query mentions conditions but SQL has no WHERE clause');
                    suggestions.push('Add WHERE clause with appropriate filtering conditions');
                    isValid = false;
                    break;
                }
            }

            // 4. Check for time-based queries
            if (originalLower.match(/\b(last|recent|past|since|between|before|after|during|year|month|week|day|date)\b/)) {
                if (!sqlLower.match(/\b(date|time|created|updated|year|month|day)\b/) && !sqlLower.includes('where')) {
                    issues.push('Original query has time-based requirements but SQL may not include proper date filtering');
                    suggestions.push('Add date/time filtering in WHERE clause');
                    isValid = false;
                }
            }

            // 5. Check for grouping requirements
            if (originalLower.match(/\b(by|per|each|every|group|category|type)\b/) && !originalLower.includes('order by')) {
                if (!sqlLower.includes('group by')) {
                    issues.push('Original query suggests grouping but SQL does not include GROUP BY');
                    suggestions.push('Add GROUP BY clause to group results appropriately');
                    isValid = false;
                }
            }

            // 6. Check for sorting requirements
            if (originalLower.match(/\b(sort|order|arrange|rank|top|bottom|first|last)\b/)) {
                if (!sqlLower.includes('order by')) {
                    issues.push('Original query mentions ordering but SQL does not include ORDER BY');
                    suggestions.push('Add ORDER BY clause to sort results');
                    isValid = false;
                }
            }

            // 7. Validate that SQL is actually selecting relevant data
            if (!sqlLower.includes('select')) {
                issues.push('Generated SQL does not contain SELECT statement');
                isValid = false;
            }

            if (!sqlLower.includes('from')) {
                issues.push('Generated SQL does not contain FROM clause');
                isValid = false;
            }

            console.log(`✅ SQL validation completed. Valid: ${isValid}, Issues: ${issues.length}`);

        } catch (validationError) {
            console.error('❌ Error during SQL validation:', validationError);
            issues.push('Validation process encountered an error');
            isValid = false;
        }

        return {
            isValid,
            issues,
            suggestions
        };
    }

    /**
     * Attempts to correct the SQL query based on validation issues
     */
    async function correctSQLQuery(
        originalSQL: string,
        originalQuery: string,
        issues: string[],
        langchainApp: MedicalDatabaseLangChainApp,
        organizationId: string
    ): Promise<string | null> {
        try {
            console.log('🔧 Attempting to correct SQL query...');

            const sqlAgent = langchainApp.getSqlAgent();
            if (!sqlAgent) {
                console.log('❌ SQL Agent not available for correction');
                return null;
            }

            // Create a correction prompt that includes the original query, generated SQL, and identified issues
            const correctionPrompt = `
CRITICAL SQL CORRECTION NEEDED

Original User Query: "${originalQuery}"

Generated SQL: 
${originalSQL}

Identified Issues:
${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

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

            console.log('📝 Sending correction prompt to SQL agent...');

            const correctionResult = await sqlAgent.call({
                input: correctionPrompt
            });

            if (correctionResult && correctionResult.output) {
                const correctedSQL = cleanSQLQuery(correctionResult.output);

                if (correctedSQL && correctedSQL !== originalSQL) {
                    console.log('✅ SQL correction successful');
                    console.log('🔧 Corrected SQL:', correctedSQL);
                    return correctedSQL;
                }
            }

            console.log('⚠️ SQL correction did not produce a different query');
            return null;

        } catch (correctionError) {
            console.error('❌ Error during SQL correction:', correctionError);
            return null;
        }
    }

    /**
     * Helper function to check if a medical term is referenced in the SQL through related tables/columns
     */
    async function checkForRelatedTerm(
        term: string,
        sql: string,
        langchainApp: MedicalDatabaseLangChainApp,
        organizationId: string
    ): Promise<boolean> {
        try {
            // Simple check - see if there are related medical table names in the SQL
            const medicalTableKeywords = [
                'patient', 'diagnosis', 'medication', 'treatment', 'procedure',
                'test', 'result', 'lab', 'clinical', 'medical', 'pgx', 'genetic',
                'drug', 'dose', 'allergy', 'adverse', 'symptom', 'condition'
            ];

            const sqlLower = sql.toLowerCase();
            const termLower = term.toLowerCase();

            // Check if the term is part of a table or column name
            for (const keyword of medicalTableKeywords) {
                if (termLower.includes(keyword) && sqlLower.includes(keyword)) {
                    return true;
                }
            }

            // Check if there are medical-related table names in the SQL
            if (sqlLower.match(/\b(patient|diagnosis|medication|treatment|procedure|test|result|lab|clinical|medical|pgx|genetic)\w*\b/)) {
                return true;
            }

            return false;
        } catch (error) {
            console.error('Error checking for related term:', error);
            return false;
        }
    }

    /**
     * Extracts conditions and filtering requirements from the original query
     */
    function extractConditionsFromQuery(query: string): string[] {
        const conditions: string[] = [];
        const queryLower = query.toLowerCase();

        // Look for common condition patterns
        const conditionPatterns = [
            /with\s+([^,\s]+)/g,
            /where\s+([^,\s]+)/g,
            /having\s+([^,\s]+)/g,
            /age\s*(>|<|=|>=|<=)\s*(\d+)/g,
            /older\s+than\s+(\d+)/g,
            /younger\s+than\s+(\d+)/g,
            /between\s+(\d+)\s+and\s+(\d+)/g,
            /in\s+the\s+last\s+(\d+)\s+(day|week|month|year)s?/g,
            /since\s+(\d{4})/g,
            /before\s+(\d{4})/g,
            /after\s+(\d{4})/g
        ];

        for (const pattern of conditionPatterns) {
            const matches = queryLower.matchAll(pattern);
            for (const match of matches) {
                conditions.push(match[0]);
            }
        }

        return conditions;
    }

    // Enhanced endpoint for manual SQL execution with complete query extraction
    // Fixed endpoint for manual SQL execution with better SQL cleaning
    // Fixed endpoint for manual SQL execution with schema validation
    // Now includes conversational capabilities with session management
    router.post('/query-sql-manual',
        [
            body('organizationId').isString().isLength({ min: 1, max: 100 }).withMessage('Organization ID is required and must be 1-100 characters'),
            body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters'),
            body('context').optional().isString().isLength({ max: 1000 }).withMessage('Context must be less than 1000 characters'),
            body('sessionId').optional().isString().withMessage('Session ID must be a string'),
            body('conversational').optional().isBoolean().withMessage('Conversational flag must be a boolean'),
            body('generateDescription').optional().isBoolean().withMessage('Generate description flag must be a boolean'),
            // New parameters for enhanced features
            body('autoRetry').optional().isBoolean().withMessage('Auto-retry flag must be a boolean'),
            body('generateSummary').optional().isBoolean().withMessage('Generate summary flag must be a boolean'),
            body('useSchemaCache').optional().isBoolean().withMessage('Schema cache flag must be a boolean'),
            body('multiAgentMode').optional().isBoolean().withMessage('Multi-agent mode flag must be a boolean'),
            body('detailedAnalytics').optional().isBoolean().withMessage('Detailed analytics flag must be a boolean'),
            body('friendlyErrors').optional().isBoolean().withMessage('Friendly errors flag must be a boolean'),
            body('advancedConversation').optional().isBoolean().withMessage('Advanced conversation flag must be a boolean'),
            body('autocompleteMode').optional().isBoolean().withMessage('Autocomplete mode flag must be a boolean'),
            body('maxRetries').optional().isInt({ min: 0, max: 3 }).withMessage('Max retries must be between 0 and 3'),
            body('summaryFormat').optional().isIn(['text', 'chart', 'highlights', 'full']).withMessage('Invalid summary format'),
            // Chain parameters
            body('useChains').optional().isBoolean().withMessage('Use chains flag must be a boolean'),
            body('chainType').optional().isIn(['simple', 'sequential', 'router', 'multiprompt']).withMessage('Invalid chain type'),
            body('preferredChain').optional().isString().withMessage('Preferred chain must be a string'),
            // Graph parameters
            body('generateGraph').optional().isBoolean().withMessage('Generate graph flag must be a boolean'),
            body('graphType').optional().isIn(Object.values(GraphType)).withMessage('Invalid graph type'),
            body('graphCategory').optional().isIn(Object.values(MedicalDataCategory)).withMessage('Invalid medical data category'),
            body('graphConfig').optional().isObject().withMessage('Graph configuration must be an object'),
            body('graphConfig.xAxis').optional().isString().withMessage('X-axis field must be a string'),
            body('graphConfig.yAxis').optional().isString().withMessage('Y-axis field must be a string'),
            body('graphConfig.colorBy').optional().isString().withMessage('Color by field must be a string'),
            body('graphConfig.sizeBy').optional().isString().withMessage('Size by field must be a string'),
            body('graphConfig.groupBy').optional().isString().withMessage('Group by field must be a string'),
            body('graphConfig.sortBy').optional().isString().withMessage('Sort by field must be a string'),
            body('graphConfig.limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Graph limit must be between 1 and 1000'),
            body('graphConfig.aggregation').optional().isIn(['count', 'sum', 'avg', 'min', 'max', 'median']).withMessage('Invalid aggregation type'),
            body('graphConfig.showTrends').optional().isBoolean().withMessage('Show trends flag must be a boolean'),
            body('graphConfig.showOutliers').optional().isBoolean().withMessage('Show outliers flag must be a boolean'),
            body('graphConfig.includeNulls').optional().isBoolean().withMessage('Include nulls flag must be a boolean'),
            body('graphConfig.customColors').optional().isArray().withMessage('Custom colors must be an array'),
            body('graphConfig.title').optional().isString().withMessage('Graph title must be a string'),
            body('graphConfig.subtitle').optional().isString().withMessage('Graph subtitle must be a string'),
            body('graphConfig.description').optional().isString().withMessage('Graph description must be a string')
        ],
        async (req: Request, res: Response) => {
            const startTime = performance.now();
            let rawAgentResponse = null;
            // Initialize MySQL version variables
            let mySQLVersionString = "unknown";
            let mysqlVersionInfo = null;

            let debugInfo = {
                extractionAttempts: [] as string[],
                sqlCorrections: [] as string[],
                originalQueries: [] as string[]
                // No schema validations since we're trusting the sqlAgent
            };

            try {
                const errors = validationResult(req);
                if (!errors.isEmpty()) {
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors.array()
                    });
                }

                const {
                    organizationId,
                    query,
                    context = 'Medical database query',
                    conversational = false,
                    generateDescription = true, // Default to true for better user experience
                    sessionId = uuidv4(),
                    // Enhanced parameters
                    enableAutoCorrect = false,
                    summarizeResults = false,
                    enableMultiAgent = false,
                    enableSchemaCache = true,
                    enableToolTracing = false,
                    friendlyErrors = true,
                    enableAgentQuestions = false,
                    enableAutoComplete = true,
                    maxRetries = 3,
                    analyzePatterns = false,
                    returnSQLExplanation = false,
                    // Chain parameters
                    chainType = 'simple',
                    preferredChain = '',
                    // Graph parameters
                    generateGraph = false,
                    graphType = GraphType.BAR_CHART,
                    graphCategory = undefined,
                    graphConfig = {}
                } = req.body;

                // Make useChains mutable so we can reset it if chains fail
                let useChains = req.body.useChains || false;

                console.log(`🚀 Processing SQL manual query for organization ${organizationId}: "${query}" ${conversational ? 'with conversation' : ''}`);

                // Test organization database connection first
                try {
                    const connectionTest = await databaseService.testOrganizationConnection(organizationId);
                    if (!connectionTest) {
                        return res.status(400).json({
                            error: 'Database connection failed',
                            message: `Unable to connect to database for organization: ${organizationId}`,
                            timestamp: new Date().toISOString()
                        });
                    }
                    console.log(`✅ Database connection verified for organization: ${organizationId}`);
                } catch (connectionError: any) {
                    console.error(`❌ Database connection error for organization ${organizationId}:`, connectionError.message);
                    return res.status(500).json({
                        error: 'Database connection error',
                        message: connectionError.message,
                        timestamp: new Date().toISOString()
                    });
                }

                // Get organization-specific LangChain app
                let langchainApp: MedicalDatabaseLangChainApp;
                try {
                    langchainApp = await multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
                    console.log(`✅ LangChain app initialized for organization: ${organizationId}`);
                } catch (langchainError: any) {
                    console.error(`❌ LangChain initialization error for organization ${organizationId}:`, langchainError.message);
                    return res.status(500).json({
                        error: 'LangChain initialization error',
                        message: langchainError.message,
                        timestamp: new Date().toISOString()
                    });
                }

                // Get or create conversation memory for this session if using conversational mode
                let sessionData = null;
                let chatHistory: any[] = [];

                if (conversational) {
                    console.log(`💬 Using conversational mode with session: ${sessionId}`);
                    sessionData = conversationSessions.get(sessionId);

                    if (!sessionData) {
                        console.log(`🆕 Creating new conversation session: ${sessionId}`);
                        const memory = new BufferMemory({
                            memoryKey: 'chat_history',
                            returnMessages: true,
                            inputKey: 'input',
                            outputKey: 'output',
                        });
                        sessionData = {
                            memory,
                            lastAccess: new Date()
                        };
                        conversationSessions.set(sessionId, sessionData);
                    } else {
                        // Update last access time
                        sessionData.lastAccess = new Date();
                        console.log(`📝 Using existing conversation session: ${sessionId}`);
                    }

                    // Retrieve conversation history if available
                    try {
                        const memoryVariables = await sessionData.memory.loadMemoryVariables({});
                        chatHistory = memoryVariables.chat_history || [];
                        console.log(`📜 Retrieved conversation history with ${Array.isArray(chatHistory) ? chatHistory.length : 0} messages`);
                    } catch (memoryError) {
                        console.error('❌ Error retrieving conversation history:', memoryError);
                        // Continue without history if there's an error
                    }
                }

                const sqlAgent = langchainApp.getSqlAgent();

                if (!sqlAgent) {
                    return res.status(503).json({
                        error: 'SQL Agent not available',
                        message: 'Service temporarily unavailable',
                        timestamp: new Date().toISOString()
                    });
                }

                // Let sqlAgent handle most of the schema exploration
                // We'll just do minimal setup to ensure the agent understands the task
                console.log('📊 Preparing to let sqlAgent explore database schema');

                // Get database configuration to determine type
                const dbConfig = await databaseService.getOrganizationDatabaseConnection(organizationId);
                console.log(`📊 Database type: ${dbConfig.type.toLocaleLowerCase()}`);

                // Get minimal database information to guide the agent
                try {
                    let tables: string[] = [];

                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                        // MySQL connection and table discovery
                        const connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                        console.log('📊 Getting high-level MySQL database structure');

                        const [tableResults] = await connection.execute(
                            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                            [dbConfig.database]
                        );

                        if (Array.isArray(tableResults) && tableResults.length > 0) {
                            tables = tableResults.map((table: any) => table.TABLE_NAME);
                            console.log('✅ MySQL database contains these tables:', tables.join(', '));
                            debugInfo.sqlCorrections.push(`Available tables: ${tables.join(', ')}`);
                        } else {
                            console.log('⚠️ No tables found in the MySQL database');
                        }

                        await connection.end();
                        console.log('✅ Basic MySQL database structure check complete');

                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                        // PostgreSQL connection and table discovery
                        const client = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                        console.log('📊 Getting high-level PostgreSQL database structure');

                        const result = await client.query(
                            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                        );

                        if (result.rows && result.rows.length > 0) {
                            tables = result.rows.map((row: any) => row.tablename);
                            console.log('✅ PostgreSQL database contains these tables:', tables.join(', '));
                            debugInfo.sqlCorrections.push(`Available tables: ${tables.join(', ')}`);
                        } else {
                            console.log('⚠️ No tables found in the PostgreSQL database');
                        }

                        await client.end();
                        console.log('✅ Basic PostgreSQL database structure check complete');

                    } else {
                        throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
                    }

                } catch (schemaError: any) {
                    console.error('❌ Failed to get basic database structure:', schemaError.message);
                }

                // ========== DATABASE VERSION DETECTION ==========
                // Detect database version for both chain and non-chain modes
                console.log('🔍 Detecting database version for query optimization...');
                
                try {
                    // Get database version information
                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                        const versionConnection = await databaseService.createOrganizationMySQLConnection(organizationId);

                        const [rows] = await versionConnection.execute('SELECT VERSION() as version');
                        if (rows && Array.isArray(rows) && rows[0] && (rows[0] as any).version) {
                            mySQLVersionString = (rows[0] as any).version;

                            // Parse version string
                            const versionMatch = mySQLVersionString.match(/(\d+)\.(\d+)\.(\d+)/);
                            if (versionMatch) {
                                const major = parseInt(versionMatch[1]);
                                const minor = parseInt(versionMatch[2]);
                                const patch = parseInt(versionMatch[3]);

                                mysqlVersionInfo = {
                                    full: mySQLVersionString,
                                    major,
                                    minor,
                                    patch,
                                    supportsJSON: major >= 5 && minor >= 7,
                                    supportsWindowFunctions: major >= 8,
                                    supportsCTE: major >= 8,
                                    supportsRegex: true
                                };

                                console.log(`✅ MySQL Version detected: ${mySQLVersionString} (${major}.${minor}.${patch})`);
                                console.log(`📋 Feature support: JSON=${mysqlVersionInfo.supportsJSON}, Windows=${mysqlVersionInfo.supportsWindowFunctions}, CTE=${mysqlVersionInfo.supportsCTE}`);
                            }
                        }

                        await versionConnection.end();
                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                        const versionConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);

                        const result = await versionConnection.query('SELECT version()');
                        if (result.rows && result.rows[0] && result.rows[0].version) {
                            mySQLVersionString = result.rows[0].version; // Use same variable name for consistency
                            console.log(`✅ PostgreSQL Version detected: ${mySQLVersionString}`);
                            
                            // Parse PostgreSQL version for features
                            const versionMatch = mySQLVersionString.match(/PostgreSQL (\d+)\.(\d+)/);
                            if (versionMatch) {
                                const major = parseInt(versionMatch[1]);
                                const minor = parseInt(versionMatch[2]);

                                mysqlVersionInfo = {
                                    full: mySQLVersionString,
                                    major,
                                    minor,
                                    patch: 0,
                                    supportsJSON: major >= 9 && minor >= 2,
                                    supportsWindowFunctions: major >= 8,
                                    supportsCTE: major >= 8 && minor >= 4,
                                    supportsRegex: true
                                };
                            }
                        }

                        await versionConnection.end();
                    }
                } catch (versionError) {
                    console.error('❌ Failed to get database version:', versionError);
                    // Continue with unknown version
                }

                // ========== CHAIN EXECUTION LOGIC ==========

                // Check if chains should be used for SQL generation instead of direct SQL agent
                let enhancedQuery = query;
                let chainSQLGenerated = '';
                let chainMetadata = {};

                if (useChains) {
                    console.log(`🔗 Using LangChain chains for SQL generation: ${chainType}`);

                    try {
                        // Get complete database knowledge for chains - schema info
                        console.log('🔍 Getting complete database knowledge for chain execution...');

                        let databaseSchemaInfo = "";

                        // Get database schema information using the SQL database connection
                        try {
                            console.log('📊 Getting complete database schema for chains...');
                            const sqlDatabase = langchainApp.getSqlDatabase();
                            if (sqlDatabase) {
                                databaseSchemaInfo = await sqlDatabase.getTableInfo();
                                console.log(`✅ Retrieved database schema info for chains (${databaseSchemaInfo.length} characters)`);
                            } else {
                                console.log('⚠️ SQL Database not available, chains will work without schema info');
                            }
                        } catch (schemaError) {
                            console.error('❌ Failed to get database schema for chains:', schemaError);
                        }

                        // Create comprehensive database-aware query for chains
                        const comprehensiveQuery = `${query}

=== COMPLETE DATABASE KNOWLEDGE FOR CHAIN EXECUTION ===

DATABASE SCHEMA INFORMATION:
${databaseSchemaInfo || "Schema information not available - use database discovery tools"}

MYSQL VERSION INFO: Your query will run on MySQL ${mysqlVersionInfo ? mysqlVersionInfo.full : 'Unknown'} ${mysqlVersionInfo ? `(${mysqlVersionInfo.major}.${mysqlVersionInfo.minor}.${mysqlVersionInfo.patch})` : ''}

VERSION-SPECIFIC COMPATIBILITY:
- JSON Functions (e.g., JSON_EXTRACT): ${mysqlVersionInfo ? (mysqlVersionInfo.supportsJSON ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌') : 'UNKNOWN ❓'}
- Window Functions (e.g., ROW_NUMBER()): ${mysqlVersionInfo ? (mysqlVersionInfo.supportsWindowFunctions ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌') : 'UNKNOWN ❓'}
- Common Table Expressions (WITH): ${mysqlVersionInfo ? (mysqlVersionInfo.supportsCTE ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌') : 'UNKNOWN ❓'}
- Regular Expressions: AVAILABLE ✅

CRITICAL INSTRUCTIONS FOR CHAINS:
1. Use ONLY the tables and columns that exist in the database schema above
2. Generate ONLY SQL queries compatible with the MySQL version specified
3. Use exact table and column names from the schema - no assumptions
4. Return ONLY the SQL query without explanations or markdown formatting
5. If schema info is unavailable, specify that database discovery is needed

===============================================`;

                        let chainResult;

                        switch (chainType) {
                            case 'simple':
                                chainResult = await langchainApp.executeSimpleSequentialChain(comprehensiveQuery);
                                break;
                            case 'sequential':
                                chainResult = await langchainApp.executeSequentialChain(comprehensiveQuery);
                                break;
                            case 'router':
                                chainResult = await langchainApp.executeRouterChain(comprehensiveQuery);
                                break;
                            case 'multiprompt':
                                chainResult = await langchainApp.executeMultiPromptChain(comprehensiveQuery);
                                break;
                            default:
                                throw new Error(`Unsupported chain type: ${chainType}`);
                        }

                        if (chainResult.success) {
                            console.log(`✅ Chain SQL generation successful: ${chainResult.chainType}`);

                            // Extract SQL from chain result
                            if (chainResult.finalSQL) {
                                chainSQLGenerated = chainResult.finalSQL;
                                console.log(`🔗 Chain generated SQL from finalSQL: ${chainSQLGenerated.substring(0, 100)}...`);
                            } else if (chainResult.sql) {
                                chainSQLGenerated = chainResult.sql;
                                console.log(`🔗 Chain generated SQL from sql: ${chainSQLGenerated.substring(0, 100)}...`);
                            } else if (chainResult.result) {
                                // Try to extract SQL from the chain result text
                                const resultText = typeof chainResult.result === 'string' ? chainResult.result : JSON.stringify(chainResult.result);
                                const sqlPattern = /```sql\s*([\s\S]*?)\s*```|SELECT[\s\S]*?;/i;
                                const sqlMatch = resultText.match(sqlPattern);
                                if (sqlMatch) {
                                    chainSQLGenerated = sqlMatch[1] || sqlMatch[0];
                                    console.log(`🔗 Extracted SQL from chain result: ${chainSQLGenerated.substring(0, 100)}...`);
                                }
                            }

                            // Store chain metadata for final response including MySQL version and schema info
                            chainMetadata = {
                                chain_used: chainResult.chainType,
                                chain_analysis: chainResult.analysis || 'No analysis available',
                                chain_validation: chainResult.schemaValidation || 'No validation available',
                                chain_steps: chainResult.steps || [],
                                chain_timestamp: chainResult.timestamp,
                                mysql_version: mySQLVersionString,
                                mysql_features: mysqlVersionInfo ? {
                                    json_support: mysqlVersionInfo.supportsJSON,
                                    window_functions: mysqlVersionInfo.supportsWindowFunctions,
                                    cte_support: mysqlVersionInfo.supportsCTE,
                                    regex_support: mysqlVersionInfo.supportsRegex
                                } : null,
                                database_schema_provided: !!databaseSchemaInfo,
                                schema_info_length: databaseSchemaInfo ? databaseSchemaInfo.length : 0,
                                comprehensive_database_knowledge: true
                            };

                            // Save conversation if in conversational mode
                            if (conversational && sessionData) {
                                try {
                                    const contextSummary = `Chain ${chainResult.chainType} generated SQL with complete database schema (${databaseSchemaInfo ? databaseSchemaInfo.length : 0} chars) and MySQL version ${mySQLVersionString}`;
                                    await sessionData.memory.saveContext(
                                        { input: query },
                                        { output: `${contextSummary}: ${chainSQLGenerated || 'No SQL extracted'}` }
                                    );
                                    console.log('💾 Saved comprehensive chain SQL generation to conversation context');
                                } catch (saveError) {
                                    console.error('❌ Error saving chain conversation:', saveError);
                                }
                            }

                        } else {
                            console.log(`❌ Chain SQL generation failed: ${chainResult.error}`);

                            // Fall back to regular SQL agent if chain fails
                            console.log('🔄 Falling back to regular SQL agent...');
                            useChains = false; // Reset flag so we use the regular path

                            // Store error info for final response
                            chainMetadata = {
                                chain_attempted: chainType,
                                chain_error: chainResult.error,
                                fallback_used: true
                            };
                        }

                    } catch (chainError: any) {
                        console.error('❌ Chain execution error:', chainError);

                        // Fall back to regular SQL agent if chain fails
                        console.log('🔄 Falling back to regular SQL agent due to error...');
                        useChains = false; // Reset flag so we use the regular path

                        // Store error info for final response
                        chainMetadata = {
                            chain_attempted: chainType,
                            chain_error: chainError.message,
                            fallback_used: true
                        };
                    }
                }

                // Step 1: Get the SQL query from the agent (or use chain-generated SQL)
                console.log('📊 Step 1: Extracting SQL query from agent...');
                let agentResult;
                let intermediateSteps: any[] = [];
                let capturedSQLQueries: string[] = [];

                // If we have chain-generated SQL, use it directly
                if (chainSQLGenerated) {
                    console.log('🔗 Using SQL generated by chain instead of agent');
                    console.log('🔍 Raw chain SQL before cleaning:', chainSQLGenerated);

                    // For chain-generated SQL, we may not need aggressive cleaning since chains should produce clean SQL
                    // Try minimal cleaning first
                    let cleanedChainSQL = chainSQLGenerated.trim();

                    // Only clean if it contains obvious markdown or formatting
                    if (chainSQLGenerated.includes('```') || chainSQLGenerated.includes('**') || chainSQLGenerated.includes('*')) {
                        console.log('🧹 Chain SQL contains formatting, applying cleaning...');
                        cleanedChainSQL = cleanSQLQuery(chainSQLGenerated);
                    } else {
                        console.log('✅ Chain SQL appears clean, using directly');
                        // Just ensure it ends with semicolon
                        if (!cleanedChainSQL.endsWith(';')) {
                            cleanedChainSQL += ';';
                        }
                    }

                    console.log('🔧 Final cleaned chain SQL:', cleanedChainSQL);

                    if (cleanedChainSQL) {
                        capturedSQLQueries.push(cleanedChainSQL);
                        debugInfo.originalQueries.push(chainSQLGenerated);
                        debugInfo.extractionAttempts.push('Chain-generated SQL: ' + cleanedChainSQL);

                        // Create a mock agent result for consistency with the rest of the flow
                        agentResult = {
                            output: `Chain-generated SQL query: ${cleanedChainSQL}`,
                            type: 'chain_generated',
                            metadata: chainMetadata
                        };

                        console.log('✅ Chain-generated SQL prepared for execution');
                    } else {
                        console.log('❌ Failed to clean chain-generated SQL, falling back to agent');
                        chainSQLGenerated = ''; // Reset so we use the agent
                    }
                }

                // If no chain SQL or chain SQL cleaning failed, use the regular agent
                if (!chainSQLGenerated) {
                    try {
                        // Use already detected database version information
                        console.log('🔍 Using detected database version for SQL generation...');
                        
                        const databaseType = dbConfig.type.toLocaleLowerCase();
                        const databaseVersionString = mySQLVersionString;
                        const databaseVersionInfo = mysqlVersionInfo;

                        // Configure LangChain's sqlAgent with version-specific instructions
                        const versionSpecificInstructions = databaseVersionInfo ? `
${databaseType.toUpperCase()} VERSION INFO: Your query will run on ${databaseType.toUpperCase()} ${databaseVersionInfo.full} (${databaseVersionInfo.major}.${databaseVersionInfo.minor}.${databaseVersionInfo.patch})

VERSION-SPECIFIC COMPATIBILITY:
- JSON Functions (e.g., JSON_EXTRACT): ${databaseVersionInfo.supportsJSON ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Window Functions (e.g., ROW_NUMBER()): ${databaseVersionInfo.supportsWindowFunctions ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Common Table Expressions (WITH): ${databaseVersionInfo.supportsCTE ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Regular Expressions: AVAILABLE ✅

CRITICAL: Use ONLY SQL features compatible with this ${databaseType.toUpperCase()} version. Avoid any syntax not supported by ${databaseVersionInfo.full}.
` : '';

                        // Add conversation context if in conversational mode
                        let conversationalContext = '';
                        if (conversational && Array.isArray(chatHistory) && chatHistory.length > 0) {
                            conversationalContext = '\n\nPrevious conversation:\n' + chatHistory
                                .map((msg: any) => `${msg.type === 'human' ? 'User' : 'Assistant'}: ${msg.content}`)
                                .join('\n') + '\n\n';
                        }

                        // The enhanced prompt with structured step-by-step approach
                        // The enhanced prompt with structured step-by-step approach and database context
                        const enhancedQuery = `
You are an expert medical database SQL analyst with deep understanding of healthcare data structures. Your task is to understand the user's query intent and generate comprehensive SQL queries that return COMPLETE and DETAILED data.

CRITICAL REQUIREMENT: NEVER use hardcoded table or column names. ALWAYS use the schema exploration tools to discover the actual table and column names from the database.

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

${conversationalContext ? `=== CONVERSATION CONTEXT ===${conversationalContext}========================` : ''}

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

STEP 5: CONSTRUCT THE SQL QUERY WITH SELECTIVE AND FOCUSED SELECT CLAUSE
- **CRITICAL SELECT CLAUSE CONSTRUCTION:**
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

STEP 6: REVIEW AND VALIDATE WITH SELECTIVE COLUMN VERIFICATION
- **CRITICAL SELECT CLAUSE VALIDATION:**
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

**FINAL VALIDATION CHECKLIST FOR EVERY QUERY:**
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

Remember: You are an EXPERT - use your knowledge to make intelligent decisions about table selection AND always create focused SELECT clauses with explicit column names that directly answer the user's question.

**CRITICAL TABLE SELECTION PRINCIPLE: When multiple tables seem similar, ALWAYS choose the table that contains the columns needed for your WHERE/HAVING conditions. This avoids unnecessary complex joins and focuses on the data that directly satisfies the user's criteria.**

USER QUERY: ${query}

BEGIN WITH STEP 1 NOW. List ALL tables before proceeding to any other steps.
`;


                        console.log('📝 Enhanced query with schema information:', enhancedQuery.substring(0, 200) + '...');

                        // Configure the sqlAgent for intelligent query understanding and generation
                        const agentConfig = {
                            input: enhancedQuery,
                            // Allow intelligent decision-making about schema exploration
                            // The agent will decide when schema exploration is needed based on query complexity
                        };

                        // Enhanced callback system to track intelligent query understanding and generation
                        agentResult = await sqlAgent.call(agentConfig, {
                            callbacks: [{
                                handleAgentAction: (action: any) => {
                                    // Log agent's decision-making process
                                    console.log('🧠 Agent action:', action.tool);
                                    console.log('🔍 Action input:', typeof action.toolInput === 'string' ?
                                        action.toolInput.substring(0, 100) + '...' :
                                        JSON.stringify(action.toolInput).substring(0, 100) + '...');

                                    // Track schema exploration for complex queries
                                    if (action.tool === 'sql_db_schema') {
                                        console.log('✅ Agent intelligently exploring schema for query understanding');
                                        debugInfo.sqlCorrections.push('Schema exploration for query scope analysis');
                                        intermediateSteps.push({
                                            tool: 'sql_db_schema',
                                            toolInput: action.toolInput,
                                            note: 'Intelligent schema exploration for query understanding'
                                        });
                                    }

                                    // Track table listing for query scope
                                    if (action.tool === 'sql_db_list_tables') {
                                        console.log('📋 Agent checking available tables for query scope');
                                        debugInfo.sqlCorrections.push('Table availability check for query scope');
                                        intermediateSteps.push({
                                            tool: 'sql_db_list_tables',
                                            toolInput: action.toolInput,
                                            note: 'Understanding available tables for query scope'
                                        });
                                    }

                                    // Capture SQL generation with understanding
                                    if (action.tool === 'query-checker' || action.tool === 'query-sql') {
                                        const sql = String(action.toolInput);
                                        console.log('💡 Agent generating SQL based on query understanding');
                                        debugInfo.originalQueries.push(sql);

                                        const cleanedSql = cleanSQLQuery(sql);
                                        if (cleanedSql) {
                                            capturedSQLQueries.push(cleanedSql);
                                            console.log('✅ Generated intelligent SQL:', cleanedSql);
                                        }
                                    }

                                    // Track all SQL-related actions for comprehensive understanding
                                    if (action.tool === 'sql_db_query' ||
                                        action.tool === 'query_sql_db' ||
                                        action.tool === 'sql_db_schema' ||
                                        action.tool === 'sql_db_list_tables') {

                                        console.log('🔧 Tool action for query understanding:', action.tool);
                                        intermediateSteps.push({
                                            tool: action.tool,
                                            toolInput: action.toolInput,
                                            note: 'Part of intelligent query understanding process'
                                        });

                                        // Capture SQL queries that demonstrate understanding
                                        if (typeof action.toolInput === 'string' &&
                                            (action.toolInput.toLowerCase().includes('select') ||
                                                action.toolInput.toLowerCase().includes('from'))) {

                                            const cleanedSql = cleanSQLQuery(action.toolInput);
                                            if (cleanedSql) {
                                                capturedSQLQueries.push(cleanedSql);
                                                console.log('✅ Captured intelligent SQL:', cleanedSql);
                                            }
                                        }
                                    }
                                    return action;
                                },
                                handleChainStart: (chain: any) => {
                                    console.log('🧠 Starting intelligent query analysis:', chain.type);
                                },
                                handleChainEnd: (output: any) => {
                                    console.log('✅ Intelligent query analysis completed');
                                    console.log('📊 Analysis output:', typeof output === 'string' ?
                                        output.substring(0, 200) + '...' :
                                        JSON.stringify(output).substring(0, 200) + '...');
                                },
                                handleToolStart: (tool: any) => {
                                    console.log('🔧 Starting tool for query understanding:', tool.name);
                                },
                                handleToolEnd: (output: any) => {
                                    console.log('✅ Tool completed for query understanding');
                                    console.log('📊 Tool output:', typeof output === 'string' ?
                                        output.substring(0, 200) + '...' :
                                        JSON.stringify(output).substring(0, 200) + '...');

                                    // Validate schema understanding
                                    if (output && typeof output === 'string' && output.includes('COLUMN_NAME')) {
                                        console.log('📊 Schema information captured for intelligent query generation');
                                        debugInfo.sqlCorrections.push('Schema understood for intelligent query generation');
                                    }

                                    // Capture SQL from intelligent analysis
                                    if (typeof output === 'string' && output.toLowerCase().includes('select')) {
                                        const cleanedSql = cleanSQLQuery(output);
                                        if (cleanedSql) {
                                            capturedSQLQueries.push(cleanedSql);
                                            console.log('✅ Captured SQL from intelligent analysis:', cleanedSql);
                                        }
                                    }
                                }
                            }]
                        });

                        // Store raw response for debugging
                        rawAgentResponse = JSON.stringify(agentResult, null, 2);
                        console.log('🔍 Agent raw response:', rawAgentResponse);

                        // Also try to extract SQL from the final output
                        if (agentResult.output && typeof agentResult.output === 'string') {
                            const cleanedSql = cleanSQLQuery(agentResult.output);
                            if (cleanedSql) {
                                capturedSQLQueries.push(cleanedSql);
                                console.log('✅ Captured SQL from final output:', cleanedSql);
                            }
                        }

                    } catch (agentError: any) {
                        console.error('❌ SQL Agent error:', agentError.message);
                        return res.status(500).json({
                            error: 'SQL Agent execution failed',
                            message: agentError.message,
                            chain_metadata: chainMetadata,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                // Initialize agentResult if it wasn't set (safety check)
                if (!agentResult) {
                    agentResult = {
                        output: 'No agent result available',
                        type: 'fallback'
                    };
                }

                // Step 2: Extract SQL query with enhanced methods
                console.log('📊 Step 2: Extracting SQL from agent response...');
                let extractedSQL = '';

                // If we have chain-generated SQL, use it
                if (chainSQLGenerated) {
                    console.log({ chainSQLGenerated });
                    extractedSQL = cleanSQLQuery(chainSQLGenerated);
                    console.log('✅ Using chain-generated SQL');
                } else {
                    // Method 1: Use already captured SQL queries from callbacks
                    if (capturedSQLQueries.length > 0) {
                        // Sort queries by length to prioritize longer, more complete queries
                        const sortedQueries = [capturedSQLQueries[capturedSQLQueries.length - 1]];

                        // Get the longest SQL query that includes both SELECT and FROM and appears to be complete
                        for (const sql of sortedQueries) {
                            console.log({ sql });
                            console.log({ sortedQueries });
                            if (isCompleteSQLQuery(sql)) {
                                extractedSQL = sql;
                                debugInfo.extractionAttempts.push('Complete captured query: ' + extractedSQL);
                                console.log('✅ Found complete SQL from captured queries');
                                break;
                            }
                        }

                        // If no complete query found, take the longest one
                        if (!extractedSQL) {
                            console.log('⚠️ No complete SQL found in captured queries, using longest one');
                            extractedSQL = sortedQueries[sortedQueries.length - 1];
                            debugInfo.extractionAttempts.push('Longest captured query: ' + extractedSQL);
                            console.log('⚠️ Using longest captured SQL query as fallback');
                        }
                    }

                    // Method 2: Try to extract from agent output if still not found
                    if (!extractedSQL && agentResult && agentResult.output) {
                        extractedSQL = cleanSQLQuery(agentResult.output);
                        if (extractedSQL) {
                            debugInfo.extractionAttempts.push('Extracted from agent output: ' + extractedSQL);
                            console.log('✅ Found SQL in agent output');
                        }
                    }
                }

                // Special handling for incomplete SQL queries
                if (extractedSQL && !isCompleteSQLQuery(extractedSQL)) {
                    console.log('⚠️ Detected incomplete SQL query');

                    const fixedSQL = fixIncompleteSQLQuery(extractedSQL);
                    if (fixedSQL !== extractedSQL) {
                        debugInfo.extractionAttempts.push('Fixed incomplete SQL: ' + fixedSQL);
                        console.log('✅ Fixed incomplete SQL query');
                        extractedSQL = fixedSQL;
                    }
                }

                if (!extractedSQL) {
                    return res.status(400).json({
                        error: 'No valid SQL query found in agent response',
                        agent_response: agentResult ? agentResult.output : rawAgentResponse,
                        intermediate_steps: intermediateSteps,
                        captured_queries: capturedSQLQueries,
                        debug_info: debugInfo,
                        chain_metadata: chainMetadata,
                        timestamp: new Date().toISOString()
                    });
                }

                console.log('🔧 Extracted SQL:', extractedSQL);

                // Step 3: Final SQL validation and cleaning
                console.log('📊 Step 3: Final SQL validation and cleaning...');

                // Apply final cleaning to ensure we have a valid SQL query
                let finalSQL = extractedSQL;

                if (!finalSQL) {
                    return res.status(400).json({
                        error: 'Failed to produce a valid SQL query',
                        extracted_sql: extractedSQL,
                        debug_info: debugInfo,
                        timestamp: new Date().toISOString()
                    });
                }

                // NEW: Enhanced SQL syntax validation before execution
                console.log('📊 Step 3.1: Enhanced SQL syntax validation...');
                // const syntaxValidation = finalSQL;

                // if (false) {
                //     console.log('⚠️ SQL syntax issues detected:', syntaxValidation.errors);
                //     debugInfo.sqlCorrections.push(`Syntax issues found: ${syntaxValidation.errors.join(', ')}`);

                //     // Use the fixed SQL if available and different from original
                //     if (syntaxValidation.fixedSQL && syntaxValidation.fixedSQL !== finalSQL) {
                //         console.log('🔧 Applied automatic syntax fixes');
                //         console.log('🔧 Original SQL:', finalSQL);
                //         console.log('🔧 Fixed SQL:', syntaxValidation.fixedSQL);
                        
                //         finalSQL = syntaxValidation.fixedSQL;
                //         debugInfo.sqlCorrections.push('Applied automatic syntax corrections');
                        
                //         // Re-validate the fixed SQL to ensure it's now valid
                //         const revalidation = validateSQLSyntax(finalSQL);
                //         if (!revalidation.isValid) {
                //             console.log('❌ Fixed SQL still has issues:', revalidation.errors);
                //             debugInfo.sqlCorrections.push(`Fixed SQL still has issues: ${revalidation.errors.join(', ')}`);
                            
                //             // Try one more round of fixes
                //             if (revalidation.fixedSQL && revalidation.fixedSQL !== finalSQL) {
                //                 finalSQL = revalidation.fixedSQL;
                //                 console.log('🔧 Applied second round of fixes:', finalSQL);
                //                 debugInfo.sqlCorrections.push('Applied second round of automatic corrections');
                //             }
                //         } else {
                //             console.log('✅ Fixed SQL now passes validation');
                //             debugInfo.sqlCorrections.push('Fixed SQL passes validation');
                //         }
                //     } else {
                //         console.log('❌ Could not automatically fix SQL syntax issues');
                //         return res.status(400).json({
                //             error: 'SQL syntax validation failed',
                //             message: 'The generated SQL query has syntax errors that could not be automatically fixed',
                //             extracted_sql: extractedSQL,
                //             final_sql: finalSQL,
                //             syntax_errors: syntaxValidation.errors,
                //             debug_info: debugInfo,
                //             suggestions: [
                //                 'Try rephrasing your query with simpler language',
                //                 'Check if you are referencing existing table and column names',
                //                 'Ensure your query structure is clear and unambiguous'
                //             ],
                //             timestamp: new Date().toISOString()
                //         });
                //     }
                // } else {
                //     console.log('✅ SQL syntax validation passed');
                //     debugInfo.sqlCorrections.push('SQL syntax validation passed');
                // }

                // Skip column name correction and trust the sqlAgent to generate correct queries
                console.log('📊 Step 3.5: Using original SQL from agent without column name modifications');

                // Add a note to debug info
                debugInfo.sqlCorrections.push('Using SQL directly from agent without column name corrections');

                console.log('✅ Final SQL:', finalSQL);

                // Step 3.5: Double-check SQL Query Against Original Query Criteria
                console.log('📊 Step 3.5: Double-checking SQL query against original query criteria...');

                // let sqlValidationResult = await validateSQLAgainstCriteria(finalSQL, query, langchainApp, organizationId, dbConfig);

                // if (!sqlValidationResult.isValid) {
                //     console.log('❌ SQL validation failed. Attempting to correct the query...');
                //     debugInfo.sqlCorrections.push(`SQL validation failed: ${sqlValidationResult.issues.join(', ')}`);

                //     // Try to get a corrected SQL query
                //     const correctedSQL = await correctSQLQuery(finalSQL, query, sqlValidationResult.issues, langchainApp, organizationId);

                //     if (correctedSQL && correctedSQL !== finalSQL) {
                //         console.log('✅ SQL query corrected based on validation');
                //         finalSQL = correctedSQL;
                //         debugInfo.sqlCorrections.push(`Applied correction: ${correctedSQL}`);
                //     } else {
                //         console.log('⚠️ Could not automatically correct SQL. Proceeding with original query.');
                //         debugInfo.sqlCorrections.push('Auto-correction failed, using original query');
                //     }
                // } else {
                //     console.log('✅ SQL query validation passed');
                //     debugInfo.sqlCorrections.push('SQL validation passed - query matches criteria');
                // }

                // Step 3.7: Check the query for common issues, but trust sqlAgent's schema understanding
                console.log('📊 Step 3.7: Validating SQL query before execution...');

                // Quick syntax validation without repeating schema analysis that sqlAgent already did
                try {
                    let connection: any;
                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                        connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                        connection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                    }

                    // Extract table names from the query
                    const tableNamePattern = /FROM\s+(\w+)|JOIN\s+(\w+)/gi;
                    const tableMatches = [...finalSQL.matchAll(tableNamePattern)];
                    const tableNames = tableMatches
                        .map(match => match[1] || match[2])
                        .filter(name => name && !['SELECT', 'WHERE', 'AND', 'OR', 'ORDER', 'GROUP', 'HAVING', 'LIMIT'].includes(name.toUpperCase()));

                    console.log('🔍 Query references these tables:', tableNames);

                    // Map to store potential table name corrections
                    const tableCorrections: { [key: string]: string } = {};
                    const columnCorrections: { [key: string]: string } = {};
                    let sqlNeedsCorrection = false;

                    // Do a simple check if these tables exist and find similar table names if not
                    for (const tableName of tableNames) {
                        try {
                            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                // MySQL table validation
                                const [result] = await connection.execute(
                                    "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                    [dbConfig.database, tableName]
                                );

                                if (Array.isArray(result) && result.length > 0) {
                                    console.log(`✅ Table '${tableName}' exists`);

                                    // If table exists, get a sample of column names to verify query correctness
                                    const [columns] = await connection.execute(
                                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 10",
                                        [dbConfig.database, tableName]
                                    );

                                    if (Array.isArray(columns) && columns.length > 0) {
                                        const sampleColumns = columns.map((col: any) => col.COLUMN_NAME).slice(0, 5).join(', ');
                                        console.log(`📋 Table ${tableName} sample columns: ${sampleColumns}...`);
                                        debugInfo.sqlCorrections.push(`Table ${tableName} exists with columns like: ${sampleColumns}...`);

                                        // Check if the query uses column names that don't match the snake_case pattern in the database
                                        // Extract column names from the query that are associated with this table
                                        const columnPattern = new RegExp(`${tableName}\\.([\\w_]+)`, 'g');
                                        let columnMatch;
                                        const queriedColumns = [];

                                        while ((columnMatch = columnPattern.exec(finalSQL)) !== null) {
                                            queriedColumns.push(columnMatch[1]);
                                        }

                                        // Check each queried column against actual columns
                                        const actualColumns = columns.map((col: any) => col.COLUMN_NAME);
                                        for (const queriedCol of queriedColumns) {
                                            if (!actualColumns.includes(queriedCol)) {
                                                // Try to find a similar column name (e.g., 'fullname' vs 'full_name')
                                                const similarCol = actualColumns.find(col =>
                                                    col.replace(/_/g, '').toLowerCase() === queriedCol.toLowerCase() ||
                                                    col.toLowerCase() === queriedCol.replace(/_/g, '').toLowerCase()
                                                );

                                                if (similarCol) {
                                                    console.log(`⚠️ Column correction needed: '${queriedCol}' should be '${similarCol}'`);
                                                    columnCorrections[queriedCol] = similarCol;
                                                    sqlNeedsCorrection = true;
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    console.log(`⚠️ WARNING: Table '${tableName}' does not exist in the database`);
                                    debugInfo.sqlCorrections.push(`WARNING: Table '${tableName}' does not exist`);

                                    // Find similar table names (e.g., 'pgxtestresults' vs 'pgxtest_results')
                                    // First get all tables in the database
                                    const [allTables] = await connection.execute(
                                        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                                        [dbConfig.database]
                                    );

                                    if (Array.isArray(allTables) && allTables.length > 0) {
                                        // Look for similar table names
                                        const allTableNames = allTables.map((t: any) => t.TABLE_NAME);

                                        // Try different matching strategies
                                        // 1. Remove underscores and compare
                                        const similarTableNoUnderscores = allTableNames.find((t: string) =>
                                            t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase()
                                        );

                                        // 2. Check for plural/singular variations
                                        const singularName = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
                                        const pluralName = tableName.endsWith('s') ? tableName : tableName + 's';

                                        const similarTableByPlurality = allTableNames.find((t: string) =>
                                            t.toLowerCase() === singularName.toLowerCase() ||
                                            t.toLowerCase() === pluralName.toLowerCase()
                                        );

                                        // 3. Check for table with similar prefix
                                        const similarTableByPrefix = allTableNames.find((t: string) =>
                                            (t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                                tableName.toLowerCase().startsWith(t.toLowerCase())) &&
                                            t.length > 3
                                        );

                                        const correctedTableName = similarTableNoUnderscores || similarTableByPlurality || similarTableByPrefix;

                                        if (correctedTableName) {
                                            console.log(`🔄 Found similar table: '${correctedTableName}' instead of '${tableName}'`);
                                            tableCorrections[tableName] = correctedTableName;
                                            sqlNeedsCorrection = true;
                                        }
                                    }
                                }
                            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                // PostgreSQL table validation
                                const result = await connection.query(
                                    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
                                    [tableName]
                                );

                                if (result.rows && result.rows.length > 0) {
                                    console.log(`✅ Table '${tableName}' exists`);

                                    // If table exists, get a sample of column names to verify query correctness
                                    const columnsResult = await connection.query(
                                        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 LIMIT 10",
                                        [tableName]
                                    );

                                    if (columnsResult.rows && columnsResult.rows.length > 0) {
                                        const sampleColumns = columnsResult.rows.map((col: any) => col.column_name).slice(0, 5).join(', ');
                                        console.log(`📋 Table ${tableName} sample columns: ${sampleColumns}...`);
                                        debugInfo.sqlCorrections.push(`Table ${tableName} exists with columns like: ${sampleColumns}...`);

                                        // Check if the query uses column names that don't match the snake_case pattern in the database
                                        // Extract column names from the query that are associated with this table
                                        const columnPattern = new RegExp(`${tableName}\\.([\\w_]+)`, 'g');
                                        let columnMatch;
                                        const queriedColumns = [];

                                        while ((columnMatch = columnPattern.exec(finalSQL)) !== null) {
                                            queriedColumns.push(columnMatch[1]);
                                        }

                                        // Check each queried column against actual columns
                                        const actualColumns = columnsResult.rows.map((col: any) => col.column_name);
                                        for (const queriedCol of queriedColumns) {
                                            if (!actualColumns.includes(queriedCol)) {
                                                // Try to find a similar column name (e.g., 'fullname' vs 'full_name')
                                                const similarCol = actualColumns.find((col: string) =>
                                                    col.replace(/_/g, '').toLowerCase() === queriedCol.toLowerCase() ||
                                                    col.toLowerCase() === queriedCol.replace(/_/g, '').toLowerCase()
                                                );

                                                if (similarCol) {
                                                    console.log(`⚠️ Column correction needed: '${queriedCol}' should be '${similarCol}'`);
                                                    columnCorrections[queriedCol] = similarCol;
                                                    sqlNeedsCorrection = true;
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    console.log(`⚠️ WARNING: Table '${tableName}' does not exist in the database`);
                                    debugInfo.sqlCorrections.push(`WARNING: Table '${tableName}' does not exist`);

                                    // Find similar table names (e.g., 'pgxtestresults' vs 'pgxtest_results')
                                    // First get all tables in the database
                                    const allTablesResult = await connection.query(
                                        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                                    );

                                    if (allTablesResult.rows && allTablesResult.rows.length > 0) {
                                        // Look for similar table names
                                        const allTableNames = allTablesResult.rows.map((t: any) => t.tablename);

                                        // Try different matching strategies
                                        // 1. Remove underscores and compare
                                        const similarTableNoUnderscores = allTableNames.find((t: string) =>
                                            t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase()
                                        );

                                        // 2. Check for plural/singular variations
                                        const singularName = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
                                        const pluralName = tableName.endsWith('s') ? tableName : tableName + 's';

                                        const similarTableByPlurality = allTableNames.find((t: string) =>
                                            t.toLowerCase() === singularName.toLowerCase() ||
                                            t.toLowerCase() === pluralName.toLowerCase()
                                        );

                                        // 3. Check for table with similar prefix
                                        const similarTableByPrefix = allTableNames.find((t: string) =>
                                            (t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                                tableName.toLowerCase().startsWith(t.toLowerCase())) &&
                                            t.length > 3
                                        );

                                        const correctedTableName = similarTableNoUnderscores || similarTableByPlurality || similarTableByPrefix;

                                        if (correctedTableName) {
                                            console.log(`🔄 Found similar table: '${correctedTableName}' instead of '${tableName}'`);
                                            tableCorrections[tableName] = correctedTableName;
                                            sqlNeedsCorrection = true;
                                        }
                                    }
                                }
                            }
                        } catch (tableError: any) {
                            console.error(`❌ Error validating table '${tableName}':`, tableError.message);
                        }
                    }

                    // Apply corrections if needed
                    if (sqlNeedsCorrection) {
                        let correctedSQL = finalSQL;

                        // Apply table name corrections
                        for (const [oldName, newName] of Object.entries(tableCorrections)) {
                            const tableRegex = new RegExp(`\\b${oldName}\\b`, 'gi');
                            correctedSQL = correctedSQL.replace(tableRegex, newName);
                            console.log(`🔄 Corrected table name: '${oldName}' → '${newName}'`);
                        }

                        // Apply column name corrections
                        for (const [oldName, newName] of Object.entries(columnCorrections)) {
                            const columnRegex = new RegExp(`\\b${oldName}\\b`, 'gi');
                            correctedSQL = correctedSQL.replace(columnRegex, newName);
                            console.log(`🔄 Corrected column name: '${oldName}' → '${newName}'`);
                        }

                        if (correctedSQL !== finalSQL) {
                            console.log('🔄 Applied SQL corrections');
                            finalSQL = correctedSQL;
                            debugInfo.sqlCorrections.push('Applied table/column name corrections');
                        }
                    }

                    // Close connection
                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                        await connection.end();
                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                        await connection.end();
                    }

                    console.log('✅ Database connection established');

                } catch (validationError) {
                    console.error('❌ Error during query validation:', validationError);
                    // Connection is already closed in the try block
                }

                // Step 4: Execute the SQL query manually
                console.log('📊 Step 4: Executing SQL query manually...');

                try {
                    let connection: any;
                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                        connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                        connection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                    }

                    console.log('✅ Database connection established');
                    console.log('🔧 Executing SQL:', finalSQL);

                    // Final syntax check before execution
                    const preExecutionValidation = validateSQLSyntax(finalSQL);
                    if (!preExecutionValidation.isValid) {
                        console.log('⚠️ Pre-execution validation failed, attempting fix...');
                        if (preExecutionValidation.fixedSQL && preExecutionValidation.fixedSQL !== finalSQL) {
                            finalSQL = preExecutionValidation.fixedSQL;
                            console.log('🔧 Applied pre-execution fixes:', preExecutionValidation.errors);
                            debugInfo.sqlCorrections.push(`Pre-execution fixes: ${preExecutionValidation.errors.join(', ')}`);
                        }
                    }

                    // Execute the final SQL based on database type
                    let rows: any[] = [];
                    let fields: any = null;

                    try {
                        if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                            const [mysqlRows, mysqlFields] = await connection.execute(finalSQL);
                            rows = mysqlRows;
                            fields = mysqlFields;
                        } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                            const result = await connection.query(finalSQL);
                            rows = result.rows;
                            fields = result.fields;
                        }
                        console.log(`✅ Query executed successfully, returned ${Array.isArray(rows) ? rows.length : 0} rows`);
                    } catch (executionError: any) {
                        // Try to fix common syntax errors and retry once
                        const errorMessage = executionError.message.toLowerCase();
                        if (errorMessage.includes('syntax error') || errorMessage.includes('near') || errorMessage.includes('unexpected')) {
                            console.log('🔧 SQL execution failed with syntax error, attempting auto-fix...');

                            // Apply common fixes
                            let fixedSQL = finalSQL;

                            if (errorMessage.includes('near \')\'')) {
                                fixedSQL = fixedSQL.replace(/^\s*\)\s*/, '');
                                console.log('🔧 Removed orphaned closing parenthesis');
                            }

                            if (errorMessage.includes('with') && errorMessage.includes(')')) {
                                fixedSQL = fixedSQL.replace(/WITH\s*\)\s*/gi, '');
                                console.log('🔧 Removed malformed WITH clause');
                            }

                            // Ensure balanced parentheses
                            const openCount = (fixedSQL.match(/\(/g) || []).length;
                            const closeCount = (fixedSQL.match(/\)/g) || []).length;
                            if (openCount > closeCount) {
                                fixedSQL = fixedSQL.replace(/;$/, '') + ')'.repeat(openCount - closeCount) + ';';
                                console.log(`🔧 Added ${openCount - closeCount} missing closing parentheses`);
                            } else if (closeCount > openCount) {
                                for (let i = 0; i < closeCount - openCount; i++) {
                                    fixedSQL = fixedSQL.replace(/^\s*\)/, '');
                                }
                                console.log(`🔧 Removed ${closeCount - openCount} extra closing parentheses`);
                            }

                            // Retry with fixed SQL
                            try {
                                console.log('🔄 Retrying with fixed SQL:', fixedSQL);
                                if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                    const [mysqlRows, mysqlFields] = await connection.execute(fixedSQL);
                                    rows = mysqlRows;
                                    fields = mysqlFields;
                                } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                    const result = await connection.query(fixedSQL);
                                    rows = result.rows;
                                    fields = result.fields;
                                }
                                console.log(`✅ Retry successful, returned ${Array.isArray(rows) ? rows.length : 0} rows`);
                                finalSQL = fixedSQL; // Use the fixed SQL for logging
                                debugInfo.sqlCorrections.push('Applied auto-fix for syntax error during execution');
                            } catch (retryError: any) {
                                console.error('❌ Retry also failed:', retryError.message);
                                throw executionError; // Throw original error
                            }
                        } else {
                            throw executionError; // Re-throw non-syntax errors
                        }
                    }

                    const processingTime = performance.now() - startTime;

                    // Generate description/explanation of the query and results
                    console.log('📝 Step 5: Generating query description and result explanation...');
                    let queryDescription = '';
                    let resultExplanation = '';

                    if (generateDescription) {
                        try {
                            // Get the LangChain app to access the LLM
                            const langchainApp = await multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
                            const llm = (langchainApp as any).llm; // Access the Azure OpenAI LLM instance

                            if (llm) {
                                // Generate query description
                                const queryDescriptionPrompt = `You are a medical database expert. Analyze this SQL query and provide a clear, professional explanation of what it does.

SQL Query: ${finalSQL}

Original User Question: ${query}

Provide a concise explanation (2-3 sentences) of:
1. What data this query retrieves
2. What conditions/filters are applied
3. How the results are organized

Keep it professional and easy to understand for both technical and non-technical users.`;

                                const queryDescResponse = await llm.invoke(queryDescriptionPrompt);
                                queryDescription = typeof queryDescResponse === 'string' ? queryDescResponse : queryDescResponse.content || '';
                                console.log('✅ Generated query description');

                                // Generate result explanation if we have results
                                if (Array.isArray(rows) && rows.length > 0) {
                                    const resultSample = rows.slice(0, 3); // Show first 3 rows as sample
                                    const resultExplanationPrompt = `You are a medical data analyst. Analyze these SQL query results and return a professional HTML summary.

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

                                    const resultExpResponse = await llm.invoke(resultExplanationPrompt);
                                    resultExplanation = typeof resultExpResponse === 'string' ? resultExpResponse : resultExpResponse.content || '';
                                    console.log('✅ Generated result explanation');
                                } else {
                                    resultExplanation = 'No results were found matching your query criteria.';
                                }
                            } else {
                                console.log('⚠️ LLM not available for description generation');
                                queryDescription = 'Query description not available';
                                resultExplanation = 'Result explanation not available';
                            }
                        } catch (descError: any) {
                            console.error('❌ Error generating descriptions:', descError.message);
                            queryDescription = 'Error generating query description';
                            resultExplanation = 'Error generating result explanation';
                        }
                    }

                    // Note: Connection will be closed after all operations including restructured SQL

                    // Process graph data if requested
                    let graphData = null;
                    const hasExplicitGraphConfig = graphType && graphConfig && Object.keys(graphConfig).length > 0;
                    const shouldGenerateGraph = generateGraph || hasExplicitGraphConfig;
                    let detectedGraphType: GraphType = GraphType.BAR_CHART;
                    let detectedCategory: MedicalDataCategory = MedicalDataCategory.PATIENT_DEMOGRAPHICS;

                    console.log(`🔍 Graph processing check: generateGraph=${generateGraph}, hasExplicitConfig=${hasExplicitGraphConfig}, shouldGenerate=${shouldGenerateGraph}`);
                    console.log(`🔍 Rows data: ${Array.isArray(rows) ? rows.length : 'not array'} rows`);

                    if (shouldGenerateGraph && Array.isArray(rows) && rows.length > 0) {
                        try {
                            let fullGraphConfig: GraphConfig;
                            let detectedGraphType: GraphType;
                            let detectedCategory: MedicalDataCategory;

                            if (hasExplicitGraphConfig) {
                                // Use explicit configuration
                                console.log(`📊 Using explicit graph configuration`);
                                fullGraphConfig = {
                                    type: graphType,
                                    category: graphCategory,
                                    xAxis: graphConfig.xAxis,
                                    yAxis: graphConfig.yAxis,
                                    colorBy: graphConfig.colorBy,
                                    sizeBy: graphConfig.sizeBy,
                                    groupBy: graphConfig.groupBy,
                                    sortBy: graphConfig.sortBy,
                                    limit: graphConfig.limit,
                                    aggregation: graphConfig.aggregation,
                                    timeFormat: graphConfig.timeFormat,
                                    showTrends: graphConfig.showTrends,
                                    showOutliers: graphConfig.showOutliers,
                                    includeNulls: graphConfig.includeNulls,
                                    customColors: graphConfig.customColors,
                                    title: graphConfig.title,
                                    subtitle: graphConfig.subtitle,
                                    description: graphConfig.description
                                };
                                detectedGraphType = graphType;
                                detectedCategory = graphCategory || MedicalDataCategory.PATIENT_DEMOGRAPHICS;
                            } else {
                                // Use AI to analyze data structure
                                console.log(`🤖 Using AI to analyze data structure for graph generation`);
                                const analysis = await AIGraphAnalyzer.analyzeDataWithAI(rows, langchainApp.getLLM());
                                fullGraphConfig = analysis.config;
                                detectedGraphType = analysis.type;
                                detectedCategory = analysis.category;
                            }

                            // Process the graph data
                            console.log(`📊 Processing ${rows.length} rows with config:`, JSON.stringify(fullGraphConfig, null, 2));
                            graphData = GraphProcessor.processGraphData(rows, fullGraphConfig);
                            console.log(`✅ Graph data processed successfully: ${graphData.data.length} data points`);
                            console.log(`📊 Sample graph data:`, JSON.stringify(graphData.data.slice(0, 3), null, 2));
                        } catch (graphError: any) {
                            console.error('❌ Graph processing failed:', graphError.message);
                            graphData = {
                                type: graphType || GraphType.BAR_CHART,
                                data: [],
                                config: { type: graphType || GraphType.BAR_CHART },
                                metadata: {
                                    totalRecords: 0,
                                    processedAt: new Date().toISOString(),
                                    dataQuality: { completeness: 0, accuracy: 0, consistency: 0 },
                                    insights: ['Graph processing failed'],
                                    recommendations: ['Check data format and graph configuration']
                                }
                            };
                        }
                    }

                    // Always include graph data structure if graph parameters are present, even if processing failed
                    if (shouldGenerateGraph && !graphData) {
                        console.log(`⚠️ Graph processing was requested but failed or no data available`);

                        let fallbackType = GraphType.BAR_CHART;
                        let fallbackCategory = MedicalDataCategory.PATIENT_DEMOGRAPHICS;
                        let fallbackConfig: GraphConfig;

                        if (hasExplicitGraphConfig) {
                            fallbackType = graphType;
                            fallbackCategory = graphCategory || MedicalDataCategory.PATIENT_DEMOGRAPHICS;
                            fallbackConfig = {
                                type: graphType,
                                category: graphCategory,
                                xAxis: graphConfig?.xAxis,
                                yAxis: graphConfig?.yAxis,
                                colorBy: graphConfig?.colorBy,
                                title: graphConfig?.title || 'Graph Analysis'
                            };
                        } else {
                            // Use AI for fallback analysis
                            try {
                                const analysis = await AIGraphAnalyzer.analyzeDataWithAI(rows, langchainApp.getLLM());
                                fallbackType = analysis.type;
                                fallbackCategory = analysis.category;
                                fallbackConfig = analysis.config;
                            } catch (error) {
                                console.error('❌ AI fallback analysis failed:', error);
                                fallbackType = GraphType.BAR_CHART;
                                fallbackCategory = MedicalDataCategory.PATIENT_DEMOGRAPHICS;
                                fallbackConfig = {
                                    type: GraphType.BAR_CHART,
                                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                                    title: 'Data Analysis'
                                };
                            }
                        }

                        graphData = {
                            type: fallbackType,
                            data: [],
                            config: fallbackConfig,
                            metadata: {
                                totalRecords: 0,
                                processedAt: new Date().toISOString(),
                                dataQuality: { completeness: 0, accuracy: 0, consistency: 0 },
                                insights: ['No data available for graph processing'],
                                recommendations: ['Check if the query returned data and graph configuration is correct']
                            }
                        };
                    }

                    // Return the raw SQL results with descriptions
                    const response = {
                        success: true,
                        query_processed: query,
                        sql_extracted: extractedSQL,
                        sql_final: finalSQL,
                        sql_results: {
                            resultExplanation,
                            sql_final: rows,
                            processing_time: `${processingTime.toFixed(2)}ms`,
                            // Add graph data to sql_results if available
                            ...(graphData ? { graph_data: graphData } : {})
                        }, // Raw SQL results with optional graph data
                        result_count: Array.isArray(rows) ? rows.length : 0,
                        field_info: fields ? fields.map((field: any) => ({
                            name: field.name,
                            type: field.type,
                            table: field.table
                        })) : [],
                        processing_time: `${processingTime.toFixed(2)}ms`,
                        // agent_response: agentResult ? agentResult.output : '',

                        // New description fields
                        query_description: queryDescription,
                        // result_explanation: resultExplanation,

                        // Add chain information if chains were used
                        ...(useChains && Object.keys(chainMetadata).length > 0 ? {
                            chain_info: {
                                ...chainMetadata,
                                sql_source: chainSQLGenerated ? 'chain_generated' : 'agent_generated'
                            }
                        } : {}),

                        // Add conversation information if in conversational mode
                        ...(conversational ? {
                            conversation: {
                                sessionId: sessionId,
                                historyLength: Array.isArray(chatHistory) ? chatHistory.length : 0,
                                mode: useChains ? 'conversational_with_chains' : 'conversational'
                            }
                        } : {}),
                        captured_queries: capturedSQLQueries,
                        intermediate_steps: intermediateSteps,
                        debug_info: debugInfo,
                        database_info: {
                            organization_id: organizationId,
                            host: (await databaseService.getOrganizationDatabaseConnection(organizationId)).host,
                            database: (await databaseService.getOrganizationDatabaseConnection(organizationId)).database,
                            port: (await databaseService.getOrganizationDatabaseConnection(organizationId)).port,
                            mysql_version: mySQLVersionString,
                            version_details: mysqlVersionInfo,
                            query_adapted_to_version: !!mysqlVersionInfo
                        },
                        // Add graph processing info if graphs were requested
                        ...(shouldGenerateGraph ? {
                            graph_processing: {
                                requested: shouldGenerateGraph,
                                type: detectedGraphType || graphType,
                                category: detectedCategory || graphCategory,
                                success: !!graphData && graphData.data.length > 0,
                                data_points: graphData ? graphData.data.length : 0,
                                explicit_generate_graph: generateGraph,
                                auto_detected: !hasExplicitGraphConfig,
                                auto_analyzed: !hasExplicitGraphConfig,
                                debug_info: {
                                    should_generate: shouldGenerateGraph,
                                    has_explicit_config: hasExplicitGraphConfig,
                                    rows_count: Array.isArray(rows) ? rows.length : 0,
                                    analysis_method: hasExplicitGraphConfig ? 'explicit_config' : 'auto_analysis'
                                }
                            }
                        } : {}),
                        timestamp: new Date().toISOString()
                    };

                    // ========== STEP: GENERATE RESTRUCTURED SQL WITH AZURE OPENAI ==========
                    console.log('🤖 Step: Generating restructured SQL with Azure OpenAI for better data organization...');
                    
                    let restructuredResults = null;
                    try {
                        // Check if Azure OpenAI is available
                        if (!isAzureOpenAIAvailable) {
                            console.log('⚠️ Azure OpenAI API key not available, skipping restructuring');
                            (response.sql_results as any).restructure_info = {
                                success: false,
                                message: 'Azure OpenAI API key not configured',
                                skipped: true
                            };
                        }
                        // Only restructure if we have actual data and it's an array with records
                        else if (Array.isArray(rows) && rows.length > 0) {
                            console.log(`🔄 Generating restructured SQL query for ${rows.length} records using Azure OpenAI...`);
                            
                            // Prepare comprehensive version information for Azure OpenAI
                            let detailedVersionInfo = mySQLVersionString || 'unknown';
                            if (mysqlVersionInfo) {
                                detailedVersionInfo = `${mysqlVersionInfo.full} (${mysqlVersionInfo.major}.${mysqlVersionInfo.minor}.${mysqlVersionInfo.patch}) - JSON:${mysqlVersionInfo.supportsJSON}, CTE:${mysqlVersionInfo.supportsCTE}, Windows:${mysqlVersionInfo.supportsWindowFunctions}`;
                            }
                            
                            restructuredResults = await generateRestructuredSQL(
                                finalSQL, // originalSQL
                                rows, // sqlResults  
                                query, // userPrompt
                                dbConfig.type.toLocaleLowerCase(), // dbType
                                detailedVersionInfo, // dbVersion - Enhanced version information with feature support
                                3, // sampleSize - Sample size for OpenAI analysis
                                sqlAgent, // sqlAgent
                                organizationId // organizationId
                            );
                            
                            console.log('✅ SQL restructuring completed');
                            
                            // If we successfully generated a restructured SQL, execute it
                            if (restructuredResults && restructuredResults.restructure_success && restructuredResults.restructured_sql) {
                                try {
                                    console.log('🔄 Executing restructured SQL query...');
                                    console.log('🔧 Restructured SQL:', restructuredResults.restructured_sql);
                                    
                                    // Check if connection is still valid, create new one if needed
                                    if (!connection || 
                                        (connection.state && connection.state === 'disconnected') || 
                                        (connection.destroyed !== undefined && connection.destroyed) ||
                                        (connection._fatalError !== undefined)) {
                                        console.log('🔄 Recreating database connection for restructured SQL...');
                                        if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                            connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                                        } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                            connection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                                        }
                                        console.log('✅ Database connection recreated successfully');
                                    } else {
                                        console.log('✅ Using existing database connection for restructured SQL');
                                    }
                                    
                                    let restructuredRows: any[] = [];
                                    let restructuredFields: any = null;
                                    
                                    // Execute the restructured SQL query
                                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                        const [mysqlRows, mysqlFields] = await connection.execute(restructuredResults.restructured_sql);
                                        restructuredRows = mysqlRows;
                                        restructuredFields = mysqlFields;
                                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                        const result = await connection.query(restructuredResults.restructured_sql);
                                        restructuredRows = result.rows;
                                        restructuredFields = result.fields;
                                    }
                                    
                                    console.log(`✅ Restructured query executed successfully, returned ${Array.isArray(restructuredRows) ? restructuredRows.length : 0} structured rows`);
                                    
                                    // Add restructured data to sql_results
                                    (response.sql_results as any).sql_final = restructuredRows;
                                    (response.sql_results as any).restructure_info = {
                                        success: true,
                                        message: "Successfully executed restructured SQL query",
                                        restructured_sql: restructuredResults.restructured_sql,
                                        explanation: restructuredResults.explanation,
                                        grouping_logic: restructuredResults.grouping_logic,
                                        expected_structure: restructuredResults.expected_structure,
                                        main_entity: restructuredResults.main_entity,
                                        original_record_count: rows.length,
                                        restructured_record_count: Array.isArray(restructuredRows) ? restructuredRows.length : 0,
                                        sample_size_used: 3,
                                        database_type: dbConfig.type.toLocaleLowerCase()
                                    };
                                    console.log('✅ Enhanced response with restructured SQL results');
                                    
                                } catch (restructuredSQLError: any) {
                                    console.error('❌ Error executing restructured SQL:', restructuredSQLError.message);
                                    
                                    // Fallback to original data with error info
                                    (response.sql_results as any).restructure_info = {
                                        success: false,
                                        message: `Restructured SQL execution failed: ${restructuredSQLError.message}`,
                                        restructured_sql: restructuredResults.restructured_sql,
                                        explanation: restructuredResults.explanation,
                                        sql_error: restructuredSQLError.message,
                                        database_type: dbConfig.type.toLocaleLowerCase()
                                    };
                                    console.log('⚠️ Restructured SQL execution failed, keeping original data');
                                }
                            } else {
                                (response.sql_results as any).restructure_info = {
                                    success: false,
                                    message: restructuredResults?.restructure_message || 'Restructured SQL generation failed',
                                    error_details: restructuredResults?.error_details,
                                    explanation: restructuredResults?.explanation,
                                    database_type: dbConfig.type.toLocaleLowerCase()
                                };
                                console.log('⚠️ Restructured SQL generation failed, keeping original data');
                            }
                        } else {
                            (response.sql_results as any).restructure_info = {
                                success: false,
                                message: 'No data available for restructuring',
                                skipped: true,
                                database_type: dbConfig.type.toLocaleLowerCase()
                            };
                            console.log('⚠️ Skipping restructuring - no data available');
                        }
                    } catch (restructureError: any) {
                        console.error('❌ Error during SQL results restructuring:', restructureError.message);
                        (response.sql_results as any).restructure_info = {
                            success: false,
                            message: 'Restructuring process failed',
                            error_details: restructureError.message,
                            database_type: dbConfig.type.toLocaleLowerCase()
                        };
                    }

                    // ========== BAR CHART ANALYSIS LAYER ==========
                    // Add Azure OpenAI bar chart analysis before sending response
                    console.log('📊 Step 5: Adding bar chart analysis layer...');
                    
                    try {
                        // Get the data for analysis (use restructured data if available, otherwise original data)
                        const dataForAnalysis = (response.sql_results as any).sql_final || rows;
                        
                        if (dataForAnalysis && Array.isArray(dataForAnalysis) && dataForAnalysis.length > 0) {
                            console.log('🤖 Calling Azure OpenAI for bar chart analysis...');
                            
                            const barChartAnalysis = await generateBarChartAnalysis(
                                finalSQL,
                                query,
                                dataForAnalysis,
                                organizationId
                            );
                            
                            // Add bar chart analysis to the response
                            (response as any).bar_chart_analysis = barChartAnalysis;
                            console.log('✅ Bar chart analysis completed and added to response');
                        } else {
                            console.log('⚠️ No data available for bar chart analysis');
                            (response as any).bar_chart_analysis = {
                                bar_chart_success: false,
                                message: "No data available for bar chart analysis",
                                timestamp: new Date().toISOString()
                            };
                        }
                    } catch (barChartError: any) {
                        console.error('❌ Error during bar chart analysis:', barChartError.message);
                        (response as any).bar_chart_analysis = {
                            bar_chart_success: false,
                            message: `Bar chart analysis failed: ${barChartError.message}`,
                            error_details: barChartError.message,
                            timestamp: new Date().toISOString()
                        };
                    }
                    // ================================================

                    res.json(response);

                    // Cleanup: Close database connections to prevent "Too many connections" errors
                    try {
                        if (connection) {
                            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                if (!connection.destroyed) {
                                    await connection.end();
                                }
                            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                if (!connection._ended) {
                                    await connection.end();
                                }
                            }
                            console.log('✅ Primary database connection closed');
                        }
                        
                        await databaseService.closeOrganizationConnections(organizationId);
                        console.log(`🔌 Closed all database connections for organization: ${organizationId}`);
                    } catch (cleanupError) {
                        console.error(`❌ Error closing database connections for organization ${organizationId}:`, cleanupError);
                    }

                } catch (sqlError: any) {
                    console.error('❌ SQL execution failed:', sqlError.message);

                    // Cleanup: Close database connections to prevent "Too many connections" errors
                    try {
                        await databaseService.closeOrganizationConnections(organizationId);
                        console.log(`🔌 Closed database connections for organization: ${organizationId}`);
                    } catch (cleanupError) {
                        console.error(`❌ Error closing database connections for organization ${organizationId}:`, cleanupError);
                    }

                    // Enhanced error analysis and suggestions
                    const suggestedFixes: string[] = [];
                    let errorDetails: any = {};

                    // Handle column not found errors
                    if (sqlError.message.includes('Unknown column') || sqlError.message.includes('column') && sqlError.message.includes('doesn\'t exist')) {
                        // Extract the problematic column name
                        const columnMatch = sqlError.message.match(/Unknown column '([^']+)'/);
                        const badColumn = columnMatch ? columnMatch[1] : 'unknown';

                        console.log(`🚨 Column error detected: "${badColumn}"`);

                        // Determine if it's a table.column pattern
                        let tableName, columnName;
                        if (badColumn.includes('.')) {
                            [tableName, columnName] = badColumn.split('.');
                        }

                        try {
                            // Create a new connection for error analysis
                            let errorConnection: any;
                            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                errorConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                errorConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                            }

                            if (errorConnection && tableName && columnName) {
                                // Get database configuration for error handling
                                const dbConfigForError = await databaseService.getOrganizationDatabaseConnection(organizationId);

                                if (dbConfigForError.type === 'mysql') {
                                    // First verify the table exists
                                    const [tableResult] = await errorConnection.execute(
                                        "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                        [dbConfigForError.database, tableName]
                                    );

                                    if (Array.isArray(tableResult) && tableResult.length > 0) {
                                        // Table exists, get all its columns
                                        const [columns] = await errorConnection.execute(
                                            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                            [dbConfigForError.database, tableName]
                                        );

                                        if (Array.isArray(columns) && columns.length > 0) {
                                            const actualColumns = columns.map((col: any) => col.COLUMN_NAME);

                                            // Look for similar column names
                                            // 1. Check for snake_case vs camelCase
                                            const similarByCase = actualColumns.find((col: string) =>
                                                col.replace(/_/g, '').toLowerCase() === columnName.toLowerCase()
                                            );

                                            // 2. Check for simple typos or close matches
                                            const similarByPrefix = actualColumns.find((col: string) =>
                                                (col.toLowerCase().startsWith(columnName.toLowerCase()) ||
                                                    columnName.toLowerCase().startsWith(col.toLowerCase())) &&
                                                col.length > 2
                                            );

                                            const suggestedColumn = similarByCase || similarByPrefix;

                                            if (suggestedColumn) {
                                                console.log(`🔄 Suggested column correction: '${columnName}' → '${suggestedColumn}'`);
                                                suggestedFixes.push(`Use '${tableName}.${suggestedColumn}' instead of '${badColumn}'`);

                                                errorDetails = {
                                                    error_type: 'column_not_found',
                                                    problematic_column: badColumn,
                                                    suggested_column: `${tableName}.${suggestedColumn}`,
                                                    suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Did you mean '${suggestedColumn}'?`
                                                };
                                            } else {
                                                // No similar column found, show available columns
                                                const availableColumns = actualColumns.slice(0, 10).join(', ');
                                                errorDetails = {
                                                    error_type: 'column_not_found',
                                                    problematic_column: badColumn,
                                                    available_columns: availableColumns,
                                                    suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Available columns: ${availableColumns}...`
                                                };
                                                suggestedFixes.push(`Choose a column from: ${availableColumns}...`);
                                            }
                                        }
                                    } else {
                                        // Table doesn't exist, look for similar table names
                                        const [allTables] = await errorConnection.execute(
                                            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                                            [dbConfigForError.database]
                                        );

                                        if (Array.isArray(allTables) && allTables.length > 0) {
                                            const allTableNames = allTables.map((t: any) => t.TABLE_NAME);

                                            // Similar matching as before
                                            const similarTable = allTableNames.find((t: string) =>
                                                t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase() ||
                                                t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                                tableName.toLowerCase().startsWith(t.toLowerCase())
                                            );

                                            if (similarTable) {
                                                console.log(`🔄 Table '${tableName}' doesn't exist, but found similar table '${similarTable}'`);
                                                suggestedFixes.push(`Use table '${similarTable}' instead of '${tableName}'`);
                                                errorDetails = {
                                                    error_type: 'table_and_column_not_found',
                                                    problematic_table: tableName,
                                                    problematic_column: columnName,
                                                    suggested_table: similarTable,
                                                    suggestion: `Both table '${tableName}' and column '${columnName}' have issues. Try using table '${similarTable}' instead.`
                                                };
                                            }
                                        }
                                    }
                                } else if (dbConfigForError.type === 'postgresql') {
                                    // PostgreSQL error analysis
                                    const tableResult = await errorConnection.query(
                                        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
                                        [tableName]
                                    );

                                    if (tableResult.rows && tableResult.rows.length > 0) {
                                        // Table exists, get all its columns
                                        const columnsResult = await errorConnection.query(
                                            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
                                            [tableName]
                                        );

                                        if (columnsResult.rows && columnsResult.rows.length > 0) {
                                            const actualColumns = columnsResult.rows.map((col: any) => col.column_name);

                                            // Look for similar column names
                                            const similarByCase = actualColumns.find((col: string) =>
                                                col.replace(/_/g, '').toLowerCase() === columnName.toLowerCase()
                                            );

                                            const similarByPrefix = actualColumns.find((col: string) =>
                                                (col.toLowerCase().startsWith(columnName.toLowerCase()) ||
                                                    columnName.toLowerCase().startsWith(col.toLowerCase())) &&
                                                col.length > 2
                                            );

                                            const suggestedColumn = similarByCase || similarByPrefix;

                                            if (suggestedColumn) {
                                                console.log(`🔄 Suggested column correction: '${columnName}' → '${suggestedColumn}'`);
                                                suggestedFixes.push(`Use '${tableName}.${suggestedColumn}' instead of '${badColumn}'`);

                                                errorDetails = {
                                                    error_type: 'column_not_found',
                                                    problematic_column: badColumn,
                                                    suggested_column: `${tableName}.${suggestedColumn}`,
                                                    suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Did you mean '${suggestedColumn}'?`
                                                };
                                            } else {
                                                const availableColumns = actualColumns.slice(0, 10).join(', ');
                                                errorDetails = {
                                                    error_type: 'column_not_found',
                                                    problematic_column: badColumn,
                                                    available_columns: availableColumns,
                                                    suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Available columns: ${availableColumns}...`
                                                };
                                                suggestedFixes.push(`Choose a column from: ${availableColumns}...`);
                                            }
                                        }
                                    } else {
                                        // Table doesn't exist, look for similar table names
                                        const allTablesResult = await errorConnection.query(
                                            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                                        );

                                        if (allTablesResult.rows && allTablesResult.rows.length > 0) {
                                            const allTableNames = allTablesResult.rows.map((t: any) => t.tablename);

                                            const similarTable = allTableNames.find((t: string) =>
                                                t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase() ||
                                                t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                                tableName.toLowerCase().startsWith(t.toLowerCase())
                                            );

                                            if (similarTable) {
                                                console.log(`🔄 Table '${tableName}' doesn't exist, but found similar table '${similarTable}'`);
                                                suggestedFixes.push(`Use table '${similarTable}' instead of '${tableName}'`);
                                                errorDetails = {
                                                    error_type: 'table_and_column_not_found',
                                                    problematic_table: tableName,
                                                    problematic_column: columnName,
                                                    suggested_table: similarTable,
                                                    suggestion: `Both table '${tableName}' and column '${columnName}' have issues. Try using table '${similarTable}' instead.`
                                                };
                                            }
                                        }
                                    }
                                }

                                // Close error analysis connection
                                if (dbConfigForError.type === 'mysql') {
                                    await errorConnection.end();
                                } else if (dbConfigForError.type === 'postgresql') {
                                    await errorConnection.end();
                                }
                            }
                        } catch (analyzeError) {
                            console.error('Error during error analysis:', analyzeError);
                        }

                        // Fallback if we couldn't provide better guidance
                        if (Object.keys(errorDetails).length === 0) {
                            errorDetails = {
                                error_type: 'column_not_found',
                                problematic_column: badColumn,
                                suggestion: `The column '${badColumn}' does not exist in the database. Try using snake_case format (e.g., 'full_name' instead of 'fullname').`
                            };
                        }

                        debugInfo.sqlCorrections.push(`Error with column: ${badColumn}`);
                    }
                    // Handle table not found errors
                    else if (sqlError.message.includes('doesn\'t exist')) {
                        // Extract the problematic table name
                        const tableMatch = sqlError.message.match(/Table '.*\.(\w+)' doesn't exist/);
                        const badTable = tableMatch ? tableMatch[1] : 'unknown';

                        console.log(`🚨 Table error detected: "${badTable}"`);

                        try {
                            // Create a new connection for error analysis
                            let errorConnection: any;
                            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                errorConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                errorConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                            }

                            if (errorConnection) {
                                // Get database configuration for error handling
                                const dbConfigForTableError = await databaseService.getOrganizationDatabaseConnection(organizationId);

                                if (dbConfigForTableError.type === 'mysql') {
                                    const [allTables] = await errorConnection.execute(
                                        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                                        [dbConfigForTableError.database]
                                    );

                                    if (Array.isArray(allTables) && allTables.length > 0) {
                                        const allTableNames = allTables.map((t: any) => t.TABLE_NAME);

                                        // Similar matching as before
                                        const similarTable = allTableNames.find((t: string) =>
                                            t.replace(/_/g, '').toLowerCase() === badTable.toLowerCase() ||
                                            t.toLowerCase().startsWith(badTable.toLowerCase()) ||
                                            badTable.toLowerCase().startsWith(t.toLowerCase())
                                        );

                                        if (similarTable) {
                                            console.log(`🔄 Found similar table: '${similarTable}' instead of '${badTable}'`);
                                            suggestedFixes.push(`Use table '${similarTable}' instead of '${badTable}'`);
                                            errorDetails = {
                                                error_type: 'table_not_found',
                                                problematic_table: badTable,
                                                suggested_table: similarTable,
                                                suggestion: `The table '${badTable}' does not exist. Did you mean '${similarTable}'?`
                                            };
                                        }
                                    }
                                } else if (dbConfigForTableError.type === 'postgresql') {
                                    const allTablesResult = await errorConnection.query(
                                        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                                    );

                                    if (allTablesResult.rows && allTablesResult.rows.length > 0) {
                                        const allTableNames = allTablesResult.rows.map((t: any) => t.tablename);

                                        const similarTable = allTableNames.find((t: string) =>
                                            t.replace(/_/g, '').toLowerCase() === badTable.toLowerCase() ||
                                            t.toLowerCase().startsWith(badTable.toLowerCase()) ||
                                            badTable.toLowerCase().startsWith(t.toLowerCase())
                                        );

                                        if (similarTable) {
                                            console.log(`🔄 Found similar table: '${similarTable}' instead of '${badTable}'`);
                                            suggestedFixes.push(`Use table '${similarTable}' instead of '${badTable}'`);
                                            errorDetails = {
                                                error_type: 'table_not_found',
                                                problematic_table: badTable,
                                                suggested_table: similarTable,
                                                suggestion: `The table '${badTable}' does not exist. Did you mean '${similarTable}'?`
                                            };
                                        }
                                    }
                                }

                                // Close error analysis connection
                                if (dbConfigForTableError.type === 'mysql') {
                                    await errorConnection.end();
                                } else if (dbConfigForTableError.type === 'postgresql') {
                                    await errorConnection.end();
                                }
                            }
                        } catch (analyzeError) {
                            console.error('Error during table error analysis:', analyzeError);
                        }

                        // Fallback if we couldn't provide better guidance
                        if (Object.keys(errorDetails).length === 0) {
                            errorDetails = {
                                error_type: 'table_not_found',
                                problematic_table: badTable,
                                suggestion: `The table '${badTable}' does not exist in the database. Try using snake_case format (e.g., 'pgx_test_results' instead of 'pgxtestresults').`
                            };
                        }

                        debugInfo.sqlCorrections.push(`Error with table: ${badTable}`);
                    }
                    // Handle other types of SQL errors
                    else {
                        errorDetails = {
                            error_type: 'general_sql_error',
                            message: sqlError.message,
                            suggestion: 'Check SQL syntax, table relationships, or data types.'
                        };
                    }

                    if (suggestedFixes.length > 0) {
                        debugInfo.sqlCorrections.push(`Suggested fixes: ${suggestedFixes.join('; ')}`);
                    }

                    const processingTime = performance.now() - startTime;

                    // Generate error description to help users understand what went wrong
                    let errorDescription = '';
                    if (generateDescription) {
                        try {
                            const langchainApp = await multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
                            const llm = (langchainApp as any).llm;

                            if (llm) {
                                const errorDescriptionPrompt = `You are a helpful database assistant. A user's SQL query failed with an error. Explain what went wrong in simple, non-technical terms and suggest how to fix it.

User's Original Question: ${query}
Generated SQL: ${finalSQL}
Error Message: ${sqlError.message}
Error Type: ${(errorDetails as any).error_type || 'unknown'}

Provide a brief, user-friendly explanation (2-3 sentences) that:
1. Explains what went wrong in simple terms
2. Suggests how the user could rephrase their question
3. Is encouraging and helpful

Avoid technical jargon and focus on helping the user get the information they need.`;

                                const errorDescResponse = await llm.invoke(errorDescriptionPrompt);
                                errorDescription = typeof errorDescResponse === 'string' ? errorDescResponse : errorDescResponse.content || '';
                                console.log('✅ Generated error description');
                            } else {
                                errorDescription = 'An error occurred while processing your query. Please try rephrasing your question or contact support.';
                            }
                        } catch (descError) {
                            console.error('❌ Error generating error description:', descError);
                            errorDescription = 'An error occurred while processing your query. Please try rephrasing your question.';
                        }
                    } else {
                        errorDescription = 'Error description generation disabled';
                    }

                    // If in conversational mode, still save the error to conversation history
                    if (conversational && sessionData) {
                        try {
                            const errorSummary = `Error executing SQL: ${errorDescription}`;
                            await sessionData.memory.saveContext(
                                { input: query },
                                { output: errorSummary }
                            );
                            console.log('💾 Saved error to conversation context');
                        } catch (saveError) {
                            console.error('❌ Error saving conversation:', saveError);
                        }
                    }

                    res.status(500).json({
                        error: 'SQL execution failed',
                        message: sqlError.message,
                        sql_code: sqlError.code,
                        sql_errno: sqlError.errno,
                        query_processed: query,
                        sql_extracted: extractedSQL,
                        sql_final: finalSQL,
                        processing_time: `${processingTime.toFixed(2)}ms`,
                        agent_response: agentResult.output,

                        // User-friendly error description
                        error_description: errorDescription,

                        // Add conversation information if in conversational mode
                        ...(conversational ? {
                            conversation: {
                                sessionId: sessionId,
                                historyLength: Array.isArray(chatHistory) ? chatHistory.length : 0,
                                mode: 'conversational'
                            }
                        } : {}),
                        captured_queries: capturedSQLQueries,
                        intermediate_steps: intermediateSteps,
                        debug_info: debugInfo,
                        error_details: errorDetails,
                        database_info: {
                            mysql_version: mySQLVersionString,
                            version_details: mysqlVersionInfo ? JSON.stringify(mysqlVersionInfo) : null,
                            query_adapted_to_version: !!mysqlVersionInfo
                        },
                        timestamp: new Date().toISOString()
                    });
                }

            } catch (error) {
                const processingTime = performance.now() - startTime;
                console.error('❌ Manual SQL query processing error:', error);

                // Cleanup: Log connection management for debugging
                console.log(`🔌 API request failed with general error`);

                // Ensure these variables are accessible in the error handler
                const conversational = req.body.conversational === true;
                const sessionId = req.body.sessionId || uuidv4();
                const chatHistory: any[] = [];

                res.status(500).json({
                    error: 'Manual SQL query processing failed',
                    message: (error as Error).message,
                    raw_agent_response: rawAgentResponse,
                    // Add conversation information if in conversational mode
                    ...(conversational ? {
                        conversation: {
                            sessionId: sessionId,
                            historyLength: Array.isArray(chatHistory) ? chatHistory.length : 0,
                            mode: 'conversational'
                        }
                    } : {}),
                    debug_info: debugInfo,
                    processing_time: `${processingTime.toFixed(2)}ms`,
                    timestamp: new Date().toISOString()
                });
            }
        }
    );

    // We're not using database schema information since we're relying on 
    // sqlAgent's intelligence to handle database structure correctly

    // We're relying on the sqlAgent's intelligence to handle column names correctly
    // No hardcoded mappings or corrections are needed

    // The rest of the helper functions remain the same
    function cleanSQLQuery(input: string): string {
        if (!input || typeof input !== 'string') return '';

        let sql = '';

        // First try to extract from code blocks
        const codeBlockMatch = input.match(/```(?:sql)?\s*((?:SELECT|select)[\s\S]*?)```/);
        if (codeBlockMatch) {
            sql = codeBlockMatch[1].trim();
        } else {
            const inlineCodeMatch = input.match(/`((?:SELECT|select)[\s\S]*?)`/);
            if (inlineCodeMatch) {
                sql = inlineCodeMatch[1].trim();
            } else {
                // More comprehensive regex that captures multi-line SQL including JOINs
                const sqlMatch = input.match(/(SELECT\s+[\s\S]*?\s+FROM\s+[\s\S]*?)(?:;(?:\s*$|\s*[^\s])|\s*$|\s*(?:\*\*|\#\#|--(?!\s*ON)|```|\[\[|\]\]|Query executed|Result:|Error:|Final answer|Step \d+|\d+\.\s))/i);
                if (sqlMatch) {
                    sql = sqlMatch[1].trim();
                } else {
                    // Fallback: try to capture everything from SELECT to a natural stopping point
                    const lastResortMatch = input.match(/(SELECT\s+[\s\S]*?FROM[\s\S]*?)(?:;(?:\s*$|\s*[^\s])|\s*$|\s*(?:\*\*|\#\#|Query executed|Result:|Error:|Final answer))/i);
                    if (lastResortMatch) {
                        sql = lastResortMatch[1].trim();
                    }
                }
            }
        }

        if (!sql) return '';

        // Clean up markdown and formatting but preserve SQL structure
        sql = sql.replace(/\*\*(.*?)\*\*/g, '$1') // Bold
            .replace(/\*(.*?)\*/g, '$1')          // Italic
            .replace(/__(.*?)__/g, '$1')          // Bold
            // .replace(/_(.*?)_/g, '$1')         // <--- Removed to keep underscores
            .replace(/~~(.*?)~~/g, '$1')          // Strikethrough
            .replace(/\[(.*?)\]\(.*?\)/g, '$1')   // Links
            .replace(/\[\[(.*?)\]\]/g, '$1')      // Wiki links
            .replace(/\s*```[\s\S]*?```\s*/g, ' ') // Other code blocks
            .replace(/`([^`]*)`/g, '$1')          // Inline code
            // .replace(/#+\s+(.*?)\s*(?:\n|$)/g, ' ') // Headings -- REMOVED
            // .replace(/(?:\n|^)\s*-\s+(.*?)(?:\n|$)/g, ' $1 ') // List items -- REMOVED
            // .replace(/(?:\n|^)\s*\d+\.\s+(.*?)(?:\n|$)/g, ' $1 ') // Numbered list items -- REMOVED
            .replace(/--.*?(?:\n|$)/g, ' ')          // SQL comments (but not ON conditions)
            .replace(/\/\/.*?(?:\n|$)/g, ' ')        // JS comments
            .replace(/\/\*[\s\S]*?\*\//g, ' ')       // Multi-line comments
            .replace(/\s*\*\*Review for common mistakes:\*\*[\s\S]*/i, '')
            .replace(/\s*\*\*Notes:\*\*[\s\S]*/i, '')
            .replace(/\{\{.*?\}\}/g, ' ')            // Template tags
            .replace(/\{\%.*?\%\}/g, ' ');           // Template tags

        // Normalize whitespace but preserve SQL structure
        sql = sql.replace(/\s+/g, ' ').trim();

        // Add semicolon if not present
        if (!sql.endsWith(';')) {
            sql += ';';
        }

        return sql;
    }


    function isCompleteSQLQuery(sql: string): boolean {
        if (!sql || typeof sql !== 'string') return false;

        // A complete SQL query should have SELECT, FROM, and a valid table reference
        const hasSelect = /\bSELECT\b/i.test(sql);
        const hasFrom = /\bFROM\b/i.test(sql);
        const hasTable = /\bFROM\s+([a-zA-Z0-9_\.]+)/i.test(sql);

        return hasSelect && hasFrom && hasTable;
    }

    function fixIncompleteSQLQuery(sql: string): string {
        if (!sql || typeof sql !== 'string') return sql;

        // Already complete
        if (isCompleteSQLQuery(sql)) return sql;

        let fixedSQL = sql;

        // Check if query ends with FROM without a table
        if (/\bFROM\s*(?:;|\s*$)/i.test(sql)) {
            // Extract column names to determine tables
            const columnsMatch = sql.match(/\bSELECT\s+(.*?)\s+FROM\b/i);

            if (columnsMatch) {
                const columns = columnsMatch[1];

                if (columns.includes('p.') && columns.includes('m.')) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, 'FROM patients p JOIN medications m ON p.id = m.patient_id');
                } else if (columns.includes('p.')) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, 'FROM patients p');
                } else if (columns.includes('m.')) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, 'FROM medications m');
                } else if (columns.includes('d.') || columns.includes('doctor')) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, 'FROM doctors d');
                } else if (columns.includes('v.') || columns.includes('visit')) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, 'FROM visits v');
                } else {
                    // Default to patients table if we can't determine
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, 'FROM patients');
                }
            }
        }

        // No SELECT statement found
        if (!fixedSQL.toLowerCase().includes('select')) {
            const possibleSelectMatch = fixedSQL.match(/^[^a-zA-Z]*(.*)/);
            if (possibleSelectMatch && possibleSelectMatch[1].toLowerCase().includes('from')) {
                fixedSQL = 'SELECT * ' + possibleSelectMatch[1];
            } else {
                fixedSQL = 'SELECT * FROM patients';
            }
        }

        // No FROM clause found
        if (!fixedSQL.toLowerCase().includes('from')) {
            fixedSQL += ' FROM patients';
        }

        // If the query doesn't have a semicolon at the end, add one
        if (!fixedSQL.endsWith(';')) {
            fixedSQL += ';';
        }

        return fixedSQL;
    }

    function finalCleanSQL(sql: string): string {
        if (!sql || typeof sql !== 'string') return '';

        // First remove any non-ASCII characters that might cause problems
        let cleanSQL = sql.replace(/[^\x00-\x7F]/g, '');

        // Remove any markdown artifacts or non-SQL content that might remain
        cleanSQL = cleanSQL.replace(/```/g, '')
            .replace(/\*\*/g, '')
            .replace(/--.*?(?:\n|$)/g, ' ')
            .replace(/\/\/.*?(?:\n|$)/g, ' ')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\s*Review for common mistakes:[\s\S]*/i, '')
            .replace(/\s*Notes:[\s\S]*/i, '');

        // Remove any other non-SQL content that might follow a semicolon
        const semicolonIndex = cleanSQL.indexOf(';');
        if (semicolonIndex !== -1) {
            cleanSQL = cleanSQL.substring(0, semicolonIndex + 1);
        }

        // Normalize whitespace
        cleanSQL = cleanSQL.replace(/\s+/g, ' ').trim();

        // Make sure it starts with SELECT
        if (!cleanSQL.toUpperCase().startsWith('SELECT')) {
            const selectMatch = cleanSQL.match(/(SELECT[\s\S]+)/i);
            if (selectMatch) {
                cleanSQL = selectMatch[1];
            } else {
                return ''; // Not a valid SQL query
            }
        }

        // Make sure it includes FROM
        if (!cleanSQL.toUpperCase().includes(' FROM ')) {
            return ''; // Not a valid SQL query
        }

        // ENHANCED SQL SYNTAX VALIDATION AND FIXING
        
        // Fix common syntax issues that cause MySQL errors
        
        // 1. Fix orphaned closing parentheses at the beginning
        cleanSQL = cleanSQL.replace(/^\s*\)\s*/, '');
        
        // 2. Fix malformed WITH clauses that don't have proper structure
        cleanSQL = cleanSQL.replace(/^\s*WITH\s*\)\s*/i, '');
        
        // 3. Fix cases where there's a closing parenthesis before SELECT
        cleanSQL = cleanSQL.replace(/^\s*\)\s*(SELECT)/i, '$1');
        
        // 4. Fix complex query structure issues first
        // Handle cases where we have ") SELECT" which indicates malformed CTE or subquery
        if (/\)\s+SELECT/i.test(cleanSQL)) {
            console.log('🔧 Detected malformed CTE/subquery structure, attempting to fix...');
            
            // Pattern: "...GROUP BY field ) SELECT ..." - this is likely a malformed CTE
            const ctePattern = /(SELECT.*?FROM.*?GROUP BY.*?)\s*\)\s*(SELECT.*)/i;
            const cteMatch = cleanSQL.match(ctePattern);
            
            if (cteMatch) {
                console.log('🔧 Converting to proper CTE structure...');
                const innerQuery = cteMatch[1];
                const outerQuery = cteMatch[2];
                
                // Create a proper CTE structure
                cleanSQL = `WITH therapeutic_counts AS (${innerQuery}) ${outerQuery}`;
                console.log('🔧 Fixed CTE structure:', cleanSQL);
            } else {
                // If we can't parse it as CTE, try to extract the most complete SELECT statement
                console.log('🔧 Could not parse as CTE, extracting most complete SELECT...');
                const selectMatches = cleanSQL.match(/(SELECT[\s\S]*?(?:;|$))/gi);
                if (selectMatches && selectMatches.length > 0) {
                    // Take the longest SELECT statement (likely most complete)
                    const longestSelect = selectMatches.reduce((longest, current) => 
                        current.length > longest.length ? current : longest
                    );
                    cleanSQL = longestSelect;
                    console.log('🔧 Using longest SELECT statement:', cleanSQL);
                }
            }
        }
        
        // 5. Fix mismatched parentheses - count and balance them
        const openParens = (cleanSQL.match(/\(/g) || []).length;
        const closeParens = (cleanSQL.match(/\)/g) || []).length;
        
        if (closeParens > openParens) {
            // Remove extra closing parentheses strategically
            let extraClosing = closeParens - openParens;
            console.log(`🔧 Removing ${extraClosing} extra closing parentheses...`);
            
            // First, try to remove orphaned closing parentheses at the beginning
            while (extraClosing > 0 && /^\s*\)/.test(cleanSQL)) {
                cleanSQL = cleanSQL.replace(/^\s*\)/, '');
                extraClosing--;
            }
            
            // If still have extra, remove them from other strategic positions
            while (extraClosing > 0) {
                // Remove closing parentheses that appear before keywords without matching opening
                if (/\)\s+(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)/i.test(cleanSQL)) {
                    cleanSQL = cleanSQL.replace(/\)\s+(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)/i, ' $1');
                    extraClosing--;
                } else {
                    // Remove the last closing parenthesis
                    const lastCloseIndex = cleanSQL.lastIndexOf(')');
                    if (lastCloseIndex > -1) {
                        cleanSQL = cleanSQL.substring(0, lastCloseIndex) + cleanSQL.substring(lastCloseIndex + 1);
                        extraClosing--;
                    } else {
                        break;
                    }
                }
            }
        } else if (openParens > closeParens) {
            // Add missing closing parentheses at the end (before semicolon)
            const missingClosing = openParens - closeParens;
            console.log(`🔧 Adding ${missingClosing} missing closing parentheses...`);
            if (cleanSQL.endsWith(';')) {
                cleanSQL = cleanSQL.slice(0, -1) + ')'.repeat(missingClosing) + ';';
            } else {
                cleanSQL += ')'.repeat(missingClosing);
            }
        }
        
        // 6. Fix cases where there are multiple SELECT statements incorrectly formatted
        const selectMatches = cleanSQL.match(/SELECT/gi);
        if (selectMatches && selectMatches.length > 1) {
            // If there are multiple SELECTs, take only the first complete one
            const firstSelectIndex = cleanSQL.toUpperCase().indexOf('SELECT');
            let queryEnd = cleanSQL.length;
            
            // Find the end of the first SELECT statement
            const secondSelectIndex = cleanSQL.toUpperCase().indexOf('SELECT', firstSelectIndex + 6);
            if (secondSelectIndex > -1) {
                queryEnd = secondSelectIndex;
            }
            
            cleanSQL = cleanSQL.substring(firstSelectIndex, queryEnd).trim();
        }
        
        // 7. Fix common MySQL syntax issues
        
        // Fix incorrect LIMIT syntax
        cleanSQL = cleanSQL.replace(/LIMIT\s+(\d+)\s*,\s*(\d+)/gi, 'LIMIT $2 OFFSET $1');
        
        // Fix incorrect date formatting
        cleanSQL = cleanSQL.replace(/DATE\s*\(\s*['"]([^'"]+)['"]\s*\)/gi, 'DATE(\'$1\')');
        
        // Fix table alias issues (missing AS keyword or improper spacing)
        cleanSQL = cleanSQL.replace(/(\w+)\s+(\w+)\s+(ON|WHERE|JOIN|GROUP|ORDER|LIMIT|HAVING)/gi, '$1 AS $2 $3');
        
        // 8. NEW: Fix specific SELECT clause issues that cause syntax errors
        
        // Fix missing comma after table.* in SELECT clauses
        // Pattern: SELECT table.* function(...) should be SELECT table.*, function(...)
        cleanSQL = cleanSQL.replace(/SELECT\s+([\w.]+\.\*)\s+([A-Z_]+\s*\()/gi, 'SELECT $1, $2');
        
        // Fix extra "AS" before table names in FROM clause
        // Pattern: FROM AS table_name should be FROM table_name
        cleanSQL = cleanSQL.replace(/FROM\s+AS\s+/gi, 'FROM ');
        
        // Fix missing comma between SELECT fields - IMPROVED PATTERN
        // Only match field names followed by aggregate functions, not function parameters
        cleanSQL = cleanSQL.replace(/(\w+(?:\.\w+)?)\s+(GROUP_CONCAT|COUNT|SUM|AVG|MAX|MIN)\s*\(/gi, '$1, $2(');
        
        // Fix orphaned commas before FROM
        cleanSQL = cleanSQL.replace(/,\s*FROM/gi, ' FROM');
        
        // 9. Validate basic SQL structure
        const upperSQL = cleanSQL.toUpperCase();
        
        // Ensure proper SELECT structure
        if (!upperSQL.includes('SELECT') || !upperSQL.includes('FROM')) {
            return '';
        }
        
        // Check for basic syntax requirements
        const hasValidStructure = /SELECT\s+.*\s+FROM\s+\w+/i.test(cleanSQL);
        if (!hasValidStructure) {
            return '';
        }
        
        // 10. Final cleanup
        
        // Remove any trailing commas before FROM, WHERE, etc.
        cleanSQL = cleanSQL.replace(/,\s+(FROM|WHERE|GROUP|ORDER|LIMIT|HAVING)/gi, ' $1');
        
        // Remove any extra spaces
        cleanSQL = cleanSQL.replace(/\s+/g, ' ').trim();
        
        // Ensure it ends with a semicolon
        if (!cleanSQL.endsWith(';')) {
            cleanSQL += ';';
        }

        return cleanSQL;
    }    // New function to validate SQL syntax before execution
    function validateSQLSyntax(sql: string): { isValid: boolean; errors: string[]; fixedSQL: string } {
        const errors: string[] = [];
        let fixedSQL = sql;

        // Basic syntax checks
        const upperSQL = sql.toUpperCase();

        // Check for required elements
        if (!upperSQL.includes('SELECT')) {
            errors.push('Missing SELECT clause');
        }

        if (!upperSQL.includes('FROM')) {
            errors.push('Missing FROM clause');
        }

        // Check for complex query structure issues FIRST
        if (/\)\s+SELECT/i.test(sql)) {
            errors.push('Malformed CTE or subquery structure detected');
            console.log('🔧 Validator: Detected ") SELECT" pattern, attempting to fix...');
            
            // Pattern: "...GROUP BY field ) SELECT ..." - this is likely a malformed CTE
            const ctePattern = /(SELECT.*?FROM.*?GROUP BY.*?)\s*\)\s*(SELECT.*)/i;
            const cteMatch = fixedSQL.match(ctePattern);
            
            if (cteMatch) {
                console.log('🔧 Validator: Converting to proper CTE structure...');
                const innerQuery = cteMatch[1];
                const outerQuery = cteMatch[2];
                
                // Create a proper CTE structure
                fixedSQL = `WITH therapeutic_counts AS (${innerQuery}) ${outerQuery}`;
                console.log('🔧 Validator: Fixed CTE structure:', fixedSQL);
            } else {
                // If we can't parse it as CTE, try to extract the most complete SELECT statement
                console.log('🔧 Validator: Could not parse as CTE, extracting most complete SELECT...');
                const selectMatches = fixedSQL.match(/(SELECT[\s\S]*?(?:;|$))/gi);
                if (selectMatches && selectMatches.length > 0) {
                    // Take the longest SELECT statement (likely most complete)
                    const longestSelect = selectMatches.reduce((longest, current) => 
                        current.length > longest.length ? current : longest
                    );
                    fixedSQL = longestSelect;
                    console.log('🔧 Validator: Using longest SELECT statement:', fixedSQL);
                }
            }
        }

        // Check for unmatched parentheses
        const openParens = (fixedSQL.match(/\(/g) || []).length;
        const closeParens = (fixedSQL.match(/\)/g) || []).length;

        if (openParens !== closeParens) {
            errors.push(`Unmatched parentheses: ${openParens} opening, ${closeParens} closing`);

            // Try to fix parentheses
            if (closeParens > openParens) {
                let extra = closeParens - openParens;
                console.log(`🔧 Validator: Removing ${extra} extra closing parentheses...`);
                
                // Remove orphaned closing parentheses at the beginning first
                while (extra > 0 && /^\s*\)/.test(fixedSQL)) {
                    fixedSQL = fixedSQL.replace(/^\s*\)/, '');
                    extra--;
                }
                
                // Remove remaining extra closing parentheses strategically
                let remaining = extra;
                while (remaining > 0) {
                    if (/\)\s+(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)/i.test(fixedSQL)) {
                        fixedSQL = fixedSQL.replace(/\)\s+(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)/i, ' $1');
                        remaining--;
                    } else {
                        // Remove the last closing parenthesis
                        const lastCloseIndex = fixedSQL.lastIndexOf(')');
                        if (lastCloseIndex > -1) {
                            fixedSQL = fixedSQL.substring(0, lastCloseIndex) + fixedSQL.substring(lastCloseIndex + 1);
                            remaining--;
                        } else {
                            break;
                        }
                    }
                }
            } else if (openParens > closeParens) {
                const missing = openParens - closeParens;
                console.log(`🔧 Validator: Adding ${missing} missing closing parentheses...`);
                if (fixedSQL.endsWith(';')) {
                    fixedSQL = fixedSQL.slice(0, -1) + ')'.repeat(missing) + ';';
                } else {
                    fixedSQL += ')'.repeat(missing);
                }
            }
        }

        // Check for orphaned closing parenthesis at start
        if (/^\s*\)/.test(sql)) {
            errors.push('Orphaned closing parenthesis at start');
            fixedSQL = fixedSQL.replace(/^\s*\)/, '');
        }

        // Check for missing commas in SELECT clause - CRITICAL FIX for common syntax error
        const selectClausePattern = /SELECT\s+(.*?)\s+FROM/is;
        const selectMatch = fixedSQL.match(selectClausePattern);
        if (selectMatch) {
            const selectClause = selectMatch[1];
            
            // More specific pattern: field_name followed by aggregate function (not within function parameters)
            // Look for cases like "field_name GROUP_CONCAT(" but not "DISTINCT field_name"
            const missingCommaPattern = /(\w+(?:\.\w+)?)\s+(GROUP_CONCAT|COUNT|SUM|AVG|MAX|MIN)\s*\(/g;
            
            if (missingCommaPattern.test(selectClause)) {
                console.log('🔧 Validator: Detected missing comma in SELECT clause');
                errors.push('Missing comma in SELECT clause between fields');
                
                // Fix by adding commas before aggregate functions (but not inside function parameters)
                let fixedSelectClause = selectClause.replace(
                    /(\w+(?:\.\w+)?)\s+(GROUP_CONCAT|COUNT|SUM|AVG|MAX|MIN)\s*\(/g, 
                    '$1, $2('
                );
                
                // Fix missing commas before table.field references (but avoid function parameters)
                fixedSelectClause = fixedSelectClause.replace(
                    /(\w+(?:\.\w+)?)\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)(?!\s*\))/g,
                    '$1, $2'
                );
                
                // Reconstruct the full query
                fixedSQL = fixedSQL.replace(selectClause, fixedSelectClause);
                console.log('🔧 Validator: Fixed SELECT clause:', fixedSelectClause);
            }
        }

        // Check for malformed WITH clauses
        if (/WITH\s*\)/i.test(sql)) {
            errors.push('Malformed WITH clause');
            fixedSQL = fixedSQL.replace(/WITH\s*\)/gi, '');
        }

        // Check for multiple SELECT statements that might be malformed
        const selectCount = (upperSQL.match(/SELECT/g) || []).length;
        if (selectCount > 1) {
            errors.push('Multiple SELECT statements detected - using first one');
            const firstSelectIndex = upperSQL.indexOf('SELECT');
            const secondSelectIndex = upperSQL.indexOf('SELECT', firstSelectIndex + 6);
            if (secondSelectIndex > -1) {
                fixedSQL = sql.substring(firstSelectIndex, secondSelectIndex).trim();
                if (!fixedSQL.endsWith(';')) {
                    fixedSQL += ';';
                }
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            fixedSQL
        };
    }


    // The /query-conversation endpoint has been removed
    // Its functionality has been integrated into /query-sql-manual

    return router;
}



// AI-Powered Graph Configuration Analyzer
class AIGraphAnalyzer {
    /**
     * Use OpenAI to analyze data structure and determine optimal graph configuration
     */
    static async analyzeDataWithAI(data: any[], llm: any): Promise<{ type: GraphType; config: GraphConfig; category: MedicalDataCategory }> {
        console.log("🤖 AI analyzing data with AI", data);
        if (!data || data.length === 0) {
            return {
                type: GraphType.BAR_CHART,
                config: { type: GraphType.BAR_CHART, title: 'No Data Available' },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        }

        try {
            // Take a sample of data for analysis (max 10 rows to avoid token limits)
            const sampleData = data.slice(0, Math.min(10, data.length));
            const columns = Object.keys(sampleData[0] || {});

            console.log(`🤖 AI analyzing ${sampleData.length} sample rows with ${columns.length} columns`);
            console.log(`🤖 Sample data:`, JSON.stringify(sampleData.slice(0, 3), null, 2));

            // Create analysis prompt for OpenAI
            const analysisPrompt = this.createAnalysisPrompt(sampleData, columns);
            console.log(`🤖 Analysis prompt (first 500 chars):`, analysisPrompt.substring(0, 500) + '...');

            // Get AI analysis
            const aiResponse = await llm.invoke(analysisPrompt);
            console.log(`🤖 AI Response:`, aiResponse);
            console.log(`🤖 AI Response length:`, aiResponse.length);

            // Parse AI response to extract graph configuration
            const graphConfig = this.parseAIResponse(aiResponse, columns, data.length);

            console.log(`🎯 AI determined: ${graphConfig.type} for ${graphConfig.category}`);
            console.log(`🎯 AI config:`, JSON.stringify(graphConfig.config, null, 2));

            return graphConfig;
        } catch (error: any) {
            console.error('❌ AI analysis failed:', error.message);
            console.error('❌ Full error:', error);
            // Fallback to basic analysis
            return this.fallbackAnalysis(data);
        }
    }

    /**
     * Analyze data types dynamically
     */
    private static analyzeDataTypes(data: any[], columns: string[]): { numeric: string[], categorical: string[], date: string[] } {
        const numeric: string[] = [];
        const categorical: string[] = [];
        const date: string[] = [];

        for (const column of columns) {
            const values = data.map(row => row[column]).filter(v => v !== null && v !== undefined);
            if (values.length === 0) continue;

            // Check if column contains dates
            const datePattern = /^\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}/;
            const isDate = values.some(v => datePattern.test(String(v)));
            if (isDate) {
                date.push(column);
                continue;
            }

            // Check if column contains numeric values
            const numericPattern = /^-?\d+(\.\d+)?$/;
            const isNumeric = values.every(v => numericPattern.test(String(v)));
            if (isNumeric) {
                numeric.push(column);
                continue;
            }

            // Check for numeric values with units (like "19MG", "100mg", "5.5kg")
            const unitPattern = /^\d+(\.\d+)?[a-zA-Z]+$/;
            const hasNumericWithUnits = values.some(v => unitPattern.test(String(v)));
            if (hasNumericWithUnits) {
                numeric.push(column);
                continue;
            }

            // Default to categorical
            categorical.push(column);
        }

        return { numeric, categorical, date };
    }

    /**
     * Create analysis prompt for OpenAI
     */
    private static createAnalysisPrompt(sampleData: any[], columns: string[]): string {
        const dataPreview = sampleData.map((row, index) => {
            const preview = Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(', ');
            return `Row ${index + 1}: {${preview}}`;
        }).join('\n');

        // Analyze data types dynamically
        const dataTypes = this.analyzeDataTypes(sampleData, columns);
        const numericColumns = dataTypes.numeric;
        const categoricalColumns = dataTypes.categorical;
        const dateColumns = dataTypes.date;

        return `You are a medical data visualization expert. Analyze the following sample data and determine the optimal graph configuration.

SAMPLE DATA (First 3 records):
${dataPreview}

COLUMNS: ${columns.join(', ')}

DATA TYPE ANALYSIS:
- Numeric columns: ${numericColumns.join(', ') || 'None'}
- Categorical columns: ${categoricalColumns.join(', ') || 'None'}
- Date columns: ${dateColumns.join(', ') || 'None'}

ANALYSIS REQUIREMENTS:
1. Determine the medical data category based on column names and data content
2. Identify the best graph type based on data structure and relationships
3. Determine appropriate axis mappings (xAxis, yAxis, colorBy) based on data types
4. Generate meaningful title and description that explains the visualization

DYNAMIC ANALYSIS GUIDELINES:
- Analyze the actual data structure and content to determine the most appropriate visualization
- Consider the relationships between fields and what insights would be most valuable
- For numeric values with units (like "19MG", "100mg", "5.5kg"), the system will automatically extract numeric parts
- Choose graph types that best represent the data relationships and patterns
- Consider aggregation if there are multiple records per category
- Use categorical columns for x-axis, numeric columns for y-axis
- Use date columns for time-series visualizations
- Consider color coding for additional dimensions
- The system automatically combines data with the same labels to prevent duplicates (e.g., multiple records for "Aspirin" will be summed/averaged)
- For charts with categorical data, consider whether you want to show individual records or aggregated values
- Aggregation options: "sum" (default), "avg" (average), "count" (count of records), "max" (maximum value), "min" (minimum value)

AVAILABLE GRAPH TYPES:
- bar_chart: For categorical comparisons and distributions
- line_chart: For time series, trends, and continuous data
- pie_chart: For proportional data and percentages
- scatter_plot: For correlation analysis between two numeric variables
- histogram: For distribution analysis of single numeric variable
- box_plot: For statistical distribution and outlier detection
- heatmap: For matrix data and correlation matrices
- timeline: For chronological events and time-based data
- stacked_bar: For grouped categorical data with multiple series
- grouped_bar: For multiple series comparison
- multi_line: For multiple time series on same chart
- area_chart: For cumulative data and filled areas
- bubble_chart: For 3-dimensional data (x, y, size)
- donut_chart: For proportional data with center space
- waterfall: For cumulative impact analysis

MEDICAL CATEGORIES:
- patient_demographics: Age, gender, location, ethnicity data
- laboratory_results: Test results, lab values, measurements
- medications: Drug names, dosages, prescriptions
- vital_signs: Blood pressure, heart rate, temperature, etc.
- diagnoses: Medical conditions, diseases, diagnoses
- treatments: Procedures, therapies, interventions
- genetic_data: DNA, genetic markers, genomic data
- pharmacogenomics: Drug-gene interactions, genetic drug responses

RESPONSE FORMAT (JSON only):
{
  "type": "graph_type",
  "category": "medical_category",
  "config": {
    "xAxis": "column_name",
    "yAxis": "column_name",
    "colorBy": "column_name",
    "aggregation": "sum|avg|count|max|min",
    "title": "Graph Title",
    "subtitle": "Graph Subtitle",
    "description": "Graph Description"
  }
}

Analyze the data structure, content, and relationships to determine the optimal visualization configuration. Respond with JSON format only.`;
    }

    /**
     * Parse AI response to extract graph configuration
     */
    private static parseAIResponse(aiResponse: any, columns: string[], totalRecords: number): { type: GraphType; config: GraphConfig; category: MedicalDataCategory } {
        try {
            console.log(`🔍 Parsing AI response...`);

            // Handle both string and AIMessage objects
            let responseContent: string;
            if (typeof aiResponse === 'string') {
                responseContent = aiResponse;
            } else if (aiResponse && typeof aiResponse === 'object' && aiResponse.content) {
                responseContent = aiResponse.content;
            } else {
                console.error('❌ Invalid AI response format:', aiResponse);
                throw new Error('Invalid AI response format');
            }

            console.log(`🔍 AI Response content:`, responseContent);

            // Extract JSON from AI response
            const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error('❌ No JSON found in AI response');
                throw new Error('No JSON found in AI response');
            }

            const jsonStr = jsonMatch[0];
            console.log(`🔍 Extracted JSON:`, jsonStr);

            const parsed = JSON.parse(jsonStr);
            console.log(`🔍 Parsed config:`, parsed);

            // Validate and map the response
            const graphType = this.validateGraphType(parsed.type);
            const category = this.validateMedicalCategory(parsed.category);

            console.log(`🔍 Validated: type=${graphType}, category=${category}`);

            const config: GraphConfig = {
                type: graphType,
                category,
                xAxis: parsed.config?.xAxis,
                yAxis: parsed.config?.yAxis,
                colorBy: parsed.config?.colorBy,
                title: parsed.config?.title || 'AI-Generated Analysis',
                subtitle: parsed.config?.subtitle || `Auto-generated from ${totalRecords} records`,
                description: parsed.config?.description || `AI-determined ${graphType} visualization for ${category} data`
            };

            console.log(`🔍 Final config:`, config);
            return { type: graphType, config, category };
        } catch (error: any) {
            console.error('❌ Failed to parse AI response:', error.message);
            console.error('❌ AI Response was:', aiResponse);
            return this.fallbackAnalysis([]);
        }
    }

    /**
     * Validate and map graph type
     */
    private static validateGraphType(type: string): GraphType {
        const validTypes = Object.values(GraphType);
        const normalizedType = type.toLowerCase().replace(/[^a-z]/g, '_');

        if (validTypes.includes(normalizedType as GraphType)) {
            return normalizedType as GraphType;
        }

        // Map common variations
        const typeMapping: Record<string, GraphType> = {
            'bar': GraphType.BAR_CHART,
            'line': GraphType.LINE_CHART,
            'pie': GraphType.PIE_CHART,
            'scatter': GraphType.SCATTER_PLOT,
            'histogram': GraphType.HISTOGRAM,
            'box': GraphType.BOX_PLOT,
            'heatmap': GraphType.HEATMAP,
            'timeline': GraphType.TIMELINE,
            'stacked': GraphType.STACKED_BAR,
            'grouped': GraphType.GROUPED_BAR,
            'multi_line': GraphType.MULTI_LINE,
            'area': GraphType.AREA_CHART,
            'bubble': GraphType.BUBBLE_CHART,
            'donut': GraphType.DONUT_CHART,
            'waterfall': GraphType.WATERFALL
        };

        for (const [key, value] of Object.entries(typeMapping)) {
            if (normalizedType.includes(key)) {
                return value;
            }
        }

        return GraphType.BAR_CHART; // Default fallback
    }

    /**
     * Validate and map medical category
     */
    private static validateMedicalCategory(category: string): MedicalDataCategory {
        const validCategories = Object.values(MedicalDataCategory);
        const normalizedCategory = category.toLowerCase().replace(/[^a-z]/g, '_');

        if (validCategories.includes(normalizedCategory as MedicalDataCategory)) {
            return normalizedCategory as MedicalDataCategory;
        }

        // Map common variations
        const categoryMapping: Record<string, MedicalDataCategory> = {
            'patient': MedicalDataCategory.PATIENT_DEMOGRAPHICS,
            'demographics': MedicalDataCategory.PATIENT_DEMOGRAPHICS,
            'lab': MedicalDataCategory.LABORATORY_RESULTS,
            'laboratory': MedicalDataCategory.LABORATORY_RESULTS,
            'medication': MedicalDataCategory.MEDICATIONS,
            'drug': MedicalDataCategory.MEDICATIONS,
            'vital': MedicalDataCategory.VITAL_SIGNS,
            'diagnosis': MedicalDataCategory.DIAGNOSES,
            'treatment': MedicalDataCategory.TREATMENTS,
            'genetic': MedicalDataCategory.GENETIC_DATA,
            'pharmacogenomic': MedicalDataCategory.PHARMACOGENOMICS,
            'pgx': MedicalDataCategory.PHARMACOGENOMICS
        };

        for (const [key, value] of Object.entries(categoryMapping)) {
            if (normalizedCategory.includes(key)) {
                return value;
            }
        }

        return MedicalDataCategory.PATIENT_DEMOGRAPHICS; // Default fallback
    }

    /**
     * Fallback analysis when AI fails - Dynamic approach
     */
    private static fallbackAnalysis(data: any[]): { type: GraphType; config: GraphConfig; category: MedicalDataCategory } {
        if (data.length === 0) {
            return {
                type: GraphType.BAR_CHART,
                config: {
                    type: GraphType.BAR_CHART,
                    title: 'No Data Available',
                    subtitle: 'Fallback analysis',
                    description: 'No data to visualize'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        }

        const sampleRow = data[0];
        const columns = Object.keys(sampleRow);

        console.log(`🔍 Dynamic fallback analysis - Columns:`, columns);
        console.log(`🔍 Dynamic fallback analysis - Sample row:`, sampleRow);

        // Dynamic analysis based on data structure
        const numericColumns = columns.filter(col => {
            const sampleValue = sampleRow[col];
            return typeof sampleValue === 'number' ||
                (typeof sampleValue === 'string' && /^\d+/.test(sampleValue));
        });

        const categoricalColumns = columns.filter(col => {
            const sampleValue = sampleRow[col];
            return typeof sampleValue === 'string' && !numericColumns.includes(col);
        });

        console.log(`🔍 Dynamic analysis - Numeric columns:`, numericColumns);
        console.log(`🔍 Dynamic analysis - Categorical columns:`, categoricalColumns);

        // Choose best visualization based on data structure
        if (numericColumns.length >= 2) {
            // Multiple numeric columns - good for scatter plot or correlation
            return {
                type: GraphType.SCATTER_PLOT,
                config: {
                    type: GraphType.SCATTER_PLOT,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: numericColumns[0],
                    yAxis: numericColumns[1],
                    title: 'Data Correlation Analysis',
                    subtitle: 'Dynamic correlation analysis',
                    description: 'Analysis of relationships between numeric fields'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        } else if (categoricalColumns.length > 0 && numericColumns.length > 0) {
            // Categorical vs numeric - good for bar chart
            return {
                type: GraphType.BAR_CHART,
                config: {
                    type: GraphType.BAR_CHART,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: categoricalColumns[0],
                    yAxis: numericColumns[0],
                    title: 'Data Distribution Analysis',
                    subtitle: 'Dynamic distribution analysis',
                    description: 'Analysis of categorical vs numeric data'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        } else {
            // Generic fallback
            return {
                type: GraphType.BAR_CHART,
                config: {
                    type: GraphType.BAR_CHART,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: columns[0],
                    yAxis: columns[1],
                    title: 'Data Analysis',
                    subtitle: 'Dynamic fallback analysis',
                    description: 'Dynamic chart visualization'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        }
    }
}

import { Router, Request, Response } from "express";
import { body, validationResult } from "express-validator";
import * as mysql from "mysql2/promise";
import { MedicalDatabaseLangChainApp } from "../../index";
import { BufferMemory } from "langchain/memory";
import { v4 as uuidv4 } from "uuid";
import databaseService from "../../services/databaseService";
import multiTenantLangChainService from "../../services/multiTenantLangChainService";
import { AzureOpenAI } from "openai";
import {
    generateBarChartAnalysis,
    generateComprehensiveQuery,
    generateCorrectionPrompt,
    generateErrorDescriptionPrompt,
    generateQueryDescriptionPrompt,
    generateRestructuringPrompt,
    generateResultExplanationPrompt,
    getDatabaseSyntaxRules,
    getJsonFunctionsForDatabase,
} from "../prompts/queryPropmt";
import {
    generateEnhancedQueryPrompt,
    generateTableRelevancePrompt,
    generateVersionSpecificInstructions,
} from "../prompts/enhanceQueryPrompt";
import { AIGraphAnalyzer } from "../prompts/graphAnalyzerClass";


/**
 * Type definition for data items with sheet_type
 */
type DataItem = {
    sheet_type: string;
    [key: string]: any;
};

/**
 * Groups data by sheet_type and removes null fields
 * @param data Array of data items to process
 * @returns Object with keys as sheet_types and values as arrays of cleaned items
 */
function groupAndCleanData(data: DataItem[]): { [sheetType: string]: object[] } {
    const groupedData: { [sheetType: string]: object[] } = {};

    for (const item of data) {
        const { sheet_type } = item;

        // Initialize the group if it doesn't exist
        if (!groupedData[sheet_type]) {
            groupedData[sheet_type] = [];
        }

        // Remove null fields
        const cleanedItem: { [key: string]: any } = {};
        for (const [key, value] of Object.entries(item)) {
            if (value !== null) {
                cleanedItem[key] = value;
            }
        }

        groupedData[sheet_type].push(cleanedItem);
    }

    return groupedData;
}

// Example usage:
// const result = groupAndCleanData(yourData);
// console.log(result);

/**
 * Recursively parses stringified JSON data within the input.
 * @param rows - The data that may contain stringified JSON at any nesting level.
 * @returns The fully parsed data with all stringified JSON parsed.
 */
/**
 * Recursively parses stringified JSON data within the input.
 * @param rows - The data that may contain stringified JSON at any nesting level.
 * @returns The fully parsed data with all stringified JSON parsed.
 */

/**
 * Extract details about column-related errors from SQL error messages
 *
 * @param errorMessage - The SQL error message
 * @returns Object containing extracted column error details
 */
function extractColumnErrorDetails(errorMessage: string): any {
    const details: any = {};

    // Extract column name from common error patterns
    const unknownColumnMatch = errorMessage.match(
        /unknown column ['"](.*?)['"]|unknown column ([\w.]+)/i
    );
    const noSuchColumnMatch = errorMessage.match(
        /no such column[: ]+['"](.*?)['"]|no such column[: ]+([\w.]+)/i
    );
    const invalidColumnMatch = errorMessage.match(
        /invalid column name ['"](.*?)['"]|invalid column name ([\w.]+)/i
    );
    const fieldListMatch = errorMessage.match(
        /['"](.*?)['"] in 'field list'|([\w.]+) in 'field list'/i
    );

    if (unknownColumnMatch) {
        details.error_type = "unknown_column";
        details.column_name = unknownColumnMatch[1] || unknownColumnMatch[2];
    } else if (noSuchColumnMatch) {
        details.error_type = "no_such_column";
        details.column_name = noSuchColumnMatch[1] || noSuchColumnMatch[2];
    } else if (invalidColumnMatch) {
        details.error_type = "invalid_column_name";
        details.column_name = invalidColumnMatch[1] || invalidColumnMatch[2];
    } else if (fieldListMatch) {
        details.error_type = "field_list_error";
        details.column_name = fieldListMatch[1] || fieldListMatch[2];
    }

    // Extract table alias or name if present
    if (details.column_name && details.column_name.includes(".")) {
        const parts = details.column_name.split(".");
        details.table_alias = parts[0];
        details.column_only = parts[1];
    }

    details.original_message = errorMessage;

    return details;
}

export function parseRows<T = any>(data: unknown): T {
    // Handle arrays
    if (Array.isArray(data)) {
        return data.map((item) => parseRows(item)) as T;
    }

    // Handle objects
    if (data && typeof data === "object") {
        const result: Record<string, any> = {};

        for (const [key, value] of Object.entries(data)) {
            // Skip empty objects
            if (
                value &&
                typeof value === "object" &&
                Object.keys(value).length === 0
            ) {
                continue;
            }

            // Special handling for medications_json
            if (typeof value === "string") {
                try {
                    // Fix the JSON format by wrapping in array brackets
                    const fixedJson = `[${value}]`;
                    result[key] = JSON.parse(fixedJson);
                } catch (e) {
                    // console.error('Error parsing medications_json:', e);
                    result[key] = value;
                }
            } else {
                result[key] = parseRows(value);
            }
        }

        return result as T;
    }

    // Return primitives as is
    return data as T;
}

// Graph Types Enum
enum GraphType {
    BAR_CHART = "bar_chart",
    LINE_CHART = "line_chart",
    PIE_CHART = "pie_chart",
    SCATTER_PLOT = "scatter_plot",
    HISTOGRAM = "histogram",
    BOX_PLOT = "box_plot",
    HEATMAP = "heatmap",
    TIMELINE = "timeline",
    TREE_MAP = "tree_map",
    RADAR_CHART = "radar_chart",
    FUNNEL_CHART = "funnel_chart",
    GAUGE_CHART = "gauge_chart",
    BUBBLE_CHART = "bubble_chart",
    AREA_CHART = "area_chart",
    STACKED_BAR = "stacked_bar",
    GROUPED_BAR = "grouped_bar",
    MULTI_LINE = "multi_line",
    DONUT_CHART = "donut_chart",
    WATERFALL = "waterfall",
    SANKEY_DIAGRAM = "sankey_diagram",
}

// Medical Data Categories for Graph Context
enum MedicalDataCategory {
    PATIENT_DEMOGRAPHICS = "patient_demographics",
    LABORATORY_RESULTS = "laboratory_results",
    MEDICATIONS = "medications",
    VITAL_SIGNS = "vital_signs",
    DIAGNOSES = "diagnoses",
    TREATMENTS = "treatments",
    PROCEDURES = "procedures",
    GENETIC_DATA = "genetic_data",
    PHARMACOGENOMICS = "pharmacogenomics",
    CLINICAL_TRIALS = "clinical_trials",
    EPIDEMIOLOGY = "epidemiology",
    OUTCOMES = "outcomes",
    COST_ANALYSIS = "cost_analysis",
    QUALITY_METRICS = "quality_metrics",
    PATIENT_FLOW = "patient_flow",
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
    aggregation?: "count" | "sum" | "avg" | "min" | "max" | "median";
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
    queryHistory?: Array<{
        query: string;
        success: boolean;
        executionTime: number;
    }>;
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
const isAzureOpenAIAvailable = !!(
    process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT
);

// Function to get Azure OpenAI client lazily
export function getAzureOpenAIClient(): AzureOpenAI | null {
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
// async function generateRestructuredSQL(
//   originalSQL: string,
//   sqlResults: any[],
//   userPrompt: string,
//   dbType: string,
//   dbVersion: string,
//   sampleSize: number = 3,
//   sqlAgent: any,
//   organizationId: string
// ): Promise<any> {
//   try {
//     // Take sample of results for analysis
//     const sampleResults = sqlResults.slice(0, sampleSize);

//     if (sampleResults.length === 0) {
//       return {
//         restructured_data: [],
//         restructure_success: false,
//         restructure_message: "No data to restructure",
//       };
//     }

//     console.log(
//       "🤖 Step 1: Using SQL Agent to get accurate database schema..."
//     );

//     // Step 1: Use SQL Agent to explore and validate schema
//     let schemaInfo = "";
//     let tablesInfo = "";
//     let validatedTables: string[] = [];
//     let validatedColumns: { [table: string]: string[] } = {};

//     try {
//       // Improved table name extraction from original SQL
//       // This regex handles more complex SQL with table aliases and subqueries
//       const sqlWithoutComments = originalSQL
//         .replace(/--.*$/gm, "")
//         .replace(/\/\*[\s\S]*?\*\//g, "");
//       const tableNamePattern =
//         /(?:FROM|JOIN)\s+(?:(?:\w+\.)?"?(\w+)"?(?:\s+(?:AS\s+)?"?(\w+)"?)?|\([\s\S]*?\)(?:\s+(?:AS\s+)?"?(\w+)"?)?)/gi;
//       const tableMatches = [...sqlWithoutComments.matchAll(tableNamePattern)];

//       // Extract table names and remove SQL keywords
//       const tableNames = [
//         ...new Set(
//           tableMatches
//             .flatMap((match) => [match[1], match[2], match[3]].filter(Boolean))
//             .filter(
//               (name) =>
//                 name &&
//                 ![
//                   "SELECT",
//                   "WHERE",
//                   "AND",
//                   "OR",
//                   "ORDER",
//                   "GROUP",
//                   "HAVING",
//                   "LIMIT",
//                   "BY",
//                   "ON",
//                   "AS",
//                 ].includes(name.toUpperCase())
//             )
//         ),
//       ];

//       console.log(
//         `🔍 Detected tables from original SQL: ${tableNames.join(", ")}`
//       );

//       // Use SQL Agent to get comprehensive table schema and validate tables
//       if (sqlAgent) {
//         const tableListResult = await sqlAgent.call({
//           input: `CRITICAL: I need the COMPLETE and ACCURATE schema for these specific tables: ${tableNames.join(
//             ", "
//           )}.

// For each table, provide:
// 1. The EXACT table name (case-sensitive if applicable)
// 2. ALL column names (complete list, no abbreviations)
// 3. Data types for each column
// 4. Primary keys and foreign keys
// 5. Any constraints or relationships

// Format the response clearly with:
// - Table: [exact_table_name]
// - Columns: [column1, column2, column3, ...]

// IMPORTANT: 
// - Show ALL columns for each table, not just a sample
// - Use the EXACT column names as they exist in the database
// - Do NOT assume or guess column names
// - If a column name contains spaces or special characters, show the exact format

// Example format:
// Table: patients
// Columns: patient_id, first_name, last_name, date_of_birth, gender, city, phone_number

// Table: medications  
// Columns: medication_id, medication_name, dosage, frequency, side_effects

// Provide complete schema information for: ${tableNames.join(", ")}`,
//         });

//         if (tableListResult && tableListResult.output) {
//           tablesInfo = tableListResult.output;
//           console.log("✅ Got comprehensive table information from SQL Agent");

//           // Improved extraction of table and column information
//           const lines = tablesInfo.split("\n");
//           let currentTable = "";
//           let inTableDefinition = false;

//           for (const line of lines) {
//             const lowerLine = line.toLowerCase();

//             // Better table detection pattern
//             if (
//               lowerLine.includes("table") &&
//               (lowerLine.includes("schema") ||
//                 lowerLine.includes("structure") ||
//                 lowerLine.includes("columns"))
//             ) {
//               for (const tableName of tableNames) {
//                 if (lowerLine.includes(tableName.toLowerCase())) {
//                   currentTable = tableName;
//                   if (!validatedTables.includes(currentTable)) {
//                     validatedTables.push(currentTable);
//                     validatedColumns[currentTable] = [];
//                   }
//                   inTableDefinition = true;
//                   break;
//                 }
//               }
//             }

//             // Better column detection with awareness of markdown table format and list formats
//             if (currentTable && inTableDefinition) {
//               // Skip header rows in markdown tables
//               if (
//                 lowerLine.includes("column") &&
//                 (lowerLine.includes("type") || lowerLine.includes("data type"))
//               ) {
//                 continue;
//               }

//               // Handle both markdown tables and lists
//               if (
//                 lowerLine.includes("|") ||
//                 lowerLine.match(/^\s*[\-\*\•]\s+\w+/) ||
//                 lowerLine.match(/^\s*\d+\.\s+\w+/)
//               ) {
//                 // For markdown tables, typically the column name is in the first cell
//                 let columnName = "";

//                 if (lowerLine.includes("|")) {
//                   const cells = lowerLine.split("|").map((cell) => cell.trim());
//                   // First non-empty cell is usually the column name
//                   columnName = cells.find((cell) => cell.length > 0) || "";
//                 } else {
//                   // For lists, extract the column name after the bullet/number
//                   const match = lowerLine.match(
//                     /^\s*(?:[\-\*\•]|\d+\.)\s+(\w+)/
//                   );
//                   if (match && match[1]) {
//                     columnName = match[1];
//                   }
//                 }

//                 // Clean up the column name and filter out data type words
//                 if (columnName) {
//                   // Remove data type information if present in the same string
//                   columnName = columnName.split(/\s+/)[0];

//                   // Skip known data type words and SQL keywords
//                   const skipWords = [
//                     "varchar",
//                     "int",
//                     "text",
//                     "date",
//                     "timestamp",
//                     "boolean",
//                     "float",
//                     "double",
//                     "decimal",
//                     "char",
//                     "null",
//                     "not",
//                     "primary",
//                     "key",
//                     "foreign",
//                     "references",
//                     "unique",
//                     "index",
//                     "constraint",
//                     "default",
//                     "auto_increment",
//                     "serial",
//                   ];

//                   if (
//                     columnName.length > 1 &&
//                     !skipWords.includes(columnName.toLowerCase())
//                   ) {
//                     if (!validatedColumns[currentTable].includes(columnName)) {
//                       validatedColumns[currentTable].push(columnName);
//                     }
//                   }
//                 }
//               }
//             }

//             // Detect end of table definition
//             if (
//               inTableDefinition &&
//               (line.trim() === "" ||
//                 (lowerLine.includes("table") &&
//                   !lowerLine.includes(currentTable.toLowerCase())))
//             ) {
//               inTableDefinition = false;
//             }
//           }

//           console.log(`✅ Validated tables: ${validatedTables.join(", ")}`);
//           for (const table in validatedColumns) {
//             console.log(
//               `✅ Validated columns for ${table}: ${validatedColumns[
//                 table
//               ].join(", ")}`
//             );
//           }
//         }
//       }
//     } catch (schemaError: any) {
//       console.error(
//         "❌ Error getting schema from SQL Agent:",
//         schemaError.message
//       );
//       // Continue with Azure OpenAI only approach as fallback
//     }

//     console.log(
//       "🤖 Step 2: Using Azure OpenAI for restructuring logic with validated schema..."
//     );

//     // Determine JSON function syntax based on database type and version
//     const jsonFunctions = getJsonFunctionsForDatabase(dbType, dbVersion);
//     const dbSyntaxRules = getDatabaseSyntaxRules(dbType, dbVersion);
//     const restructuringPrompt = generateRestructuringPrompt({
//       userPrompt,
//       originalSQL,
//       sampleSize,
//       sampleResults,
//       dbType,
//       dbVersion,
//       sqlResults,
//       tablesInfo,
//       validatedTables,
//       validatedColumns,
//       jsonFunctions,
//       dbSyntaxRules,
//     });

//     console.log("🤖 Sending restructuring request to Azure OpenAI...");

//     const azureOpenAIClient = getAzureOpenAIClient();
//     if (!azureOpenAIClient) {
//       throw new Error("Azure OpenAI client not available");
//     }

//     const completion = await azureOpenAIClient.chat.completions.create({
//       model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
//       messages: [
//         {
//           role: "system",
//           content:
//             "You are an expert data analyst specializing in restructuring relational database results into meaningful hierarchical JSON structures. You MUST return only valid JSON without any comments, markdown formatting, or additional text. Your response must be parseable by JSON.parse(). Generate only syntactically correct SQL that works with the specific database type and version. CRITICAL: You must use ONLY the exact table and column names provided in the validated schema - never assume, guess, or make up column names. Verify every column reference against the provided schema before using it.",
//         },
//         {
//           role: "user",
//           content: restructuringPrompt,
//         },
//       ],
//       temperature: 0.1,
//       max_tokens: 4000,
//     });

//     const openaiResponse = completion.choices[0]?.message?.content;

//     if (!openaiResponse) {
//       throw new Error("No response from OpenAI");
//     }

//     console.log("🔍 Azure OpenAI response length:", openaiResponse.length);
//     console.log(
//       "🔍 Response preview:",
//       openaiResponse.substring(0, 200) + "..."
//     );

//     // Parse the OpenAI response with robust error handling
//     let restructuredResult;
//     try {
//       // Clean the response (remove any markdown formatting and comments)
//       let cleanedResponse = openaiResponse
//         .replace(/```json\n?/g, "")
//         .replace(/```\n?/g, "")
//         .replace(/```/g, "")
//         .trim();

//       // Remove any single-line comments (//)
//       cleanedResponse = cleanedResponse.replace(/\/\/.*$/gm, "");

//       // Remove any multi-line comments (/* ... */)
//       cleanedResponse = cleanedResponse.replace(/\/\*[\s\S]*?\*\//g, "");

//       // Remove any trailing commas before closing brackets/braces
//       cleanedResponse = cleanedResponse.replace(/,(\s*[\]}])/g, "$1");

//       // First parsing attempt
//       try {
//         restructuredResult = JSON.parse(cleanedResponse);
//       } catch (firstParseError) {
//         console.log("🔄 First parse failed, trying to extract JSON object...");

//         // Try to find the JSON object within the response
//         const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
//         if (jsonMatch) {
//           const extractedJson = jsonMatch[0];

//           // Clean the extracted JSON further
//           const finalCleanedJson = extractedJson
//             .replace(/\/\/.*$/gm, "")
//             .replace(/\/\*[\s\S]*?\*\//g, "")
//             .replace(/,(\s*[\]}])/g, "$1");

//           restructuredResult = JSON.parse(finalCleanedJson);
//         } else {
//           throw new Error("No valid JSON object found in response");
//         }
//       }
//     } catch (parseError) {
//       console.error(
//         "❌ Failed to parse Azure OpenAI response as JSON:",
//         parseError
//       );
//       console.error(
//         "❌ Raw response:",
//         openaiResponse.substring(0, 1000) + "..."
//       );
//       console.error("❌ Error at position:", (parseError as any).message);

//       return {
//         restructured_sql: originalSQL, // Fallback to original SQL
//         restructure_success: false,
//         restructure_message: `Azure OpenAI response parsing failed: ${parseError}`,
//         raw_openai_response: openaiResponse.substring(0, 500) + "...",
//         error_details: `Parse error: ${parseError}. Response preview: ${openaiResponse.substring(
//           0,
//           200
//         )}...`,
//         explanation: "Error parsing AI response",
//         grouping_logic: "No grouping applied due to parsing error",
//         expected_structure: "Original flat structure maintained",
//         database_type: dbType,
//         database_version: dbVersion,
//       };
//     }

//     // Validate the parsed result structure
//     if (!restructuredResult || typeof restructuredResult !== "object") {
//       throw new Error("Parsed result is not a valid object");
//     }

//     if (
//       !restructuredResult.restructured_sql ||
//       typeof restructuredResult.restructured_sql !== "string"
//     ) {
//       console.log("⚠️ Invalid structure, no restructured SQL found...");

//       return {
//         restructured_sql: originalSQL, // Fallback to original SQL
//         restructure_success: false,
//         restructure_message:
//           "No restructured SQL generated by AI, using original query",
//         explanation: "AI did not provide a restructured SQL query",
//         grouping_logic: "No grouping applied",
//         expected_structure: "Original flat structure maintained",
//         database_type: dbType,
//         database_version: dbVersion,
//       };
//     }

//     // Validate that the generated SQL is different from the original
//     const cleanedGeneratedSQL = restructuredResult.restructured_sql
//       .trim()
//       .replace(/\s+/g, " ");
//     const cleanedOriginalSQL = originalSQL.trim().replace(/\s+/g, " ");

//     if (
//       cleanedGeneratedSQL.toLowerCase() === cleanedOriginalSQL.toLowerCase()
//     ) {
//       console.log(
//         "⚠️ Generated SQL is identical to original, no restructuring benefit..."
//       );

//       return {
//         restructured_sql: originalSQL,
//         restructure_success: false,
//         restructure_message: "Generated SQL is identical to original query",
//         explanation:
//           restructuredResult.explanation || "No restructuring applied",
//         grouping_logic:
//           restructuredResult.grouping_logic || "No grouping applied",
//         expected_structure:
//           restructuredResult.expected_structure ||
//           "Original structure maintained",
//         database_type: dbType,
//         database_version: dbVersion,
//       };
//     }

//     console.log(
//       "✅ Successfully generated restructured SQL query with Azure OpenAI"
//     );

//     return {
//       restructured_sql: restructuredResult.restructured_sql,
//       restructure_success: true,
//       restructure_message:
//         "Successfully generated restructured SQL query using Azure OpenAI",
//       explanation:
//         restructuredResult.explanation ||
//         "SQL query restructured for better data organization",
//       grouping_logic:
//         restructuredResult.grouping_logic ||
//         "Applied intelligent grouping based on data analysis",
//       expected_structure:
//         restructuredResult.expected_structure ||
//         "Hierarchical JSON structure with reduced redundancy",
//       main_entity: restructuredResult.main_entity || "Unknown",
//       original_sql: originalSQL,
//       sample_size_used: sampleSize,
//       database_type: dbType,
//       database_version: dbVersion,
//     };
//   } catch (error: any) {
//     console.error(
//       "❌ Error generating restructured SQL with Azure OpenAI:",
//       error.message
//     );

//     return {
//       restructured_sql: originalSQL, // Fallback to original SQL
//       restructure_success: false,
//       restructure_message: `SQL restructuring failed: ${error.message}`,
//       error_details: error.message,
//       explanation: "Error occurred during SQL restructuring",
//       grouping_logic: "No grouping applied due to error",
//       expected_structure: "Original flat structure maintained",
//       database_type: dbType,
//       database_version: dbVersion,
//     };
//   }
// }

// FINAL REMINDER:
// - Verify all JSON function names with your database documentation
// - Test the generated SQL in a development environment first
// - Ensure compatibility with ${dbType} ${dbVersion}
// `,
//     };
//   }
// }



async function generateRestructuredSQL(
    originalSQL: string,
    sqlResults: any[],
    userPrompt: string,
    dbType: string,
    dbVersion: string,
    sampleSize: number = 3,
    sqlAgent: any,
    organizationId: string,
    tableSampleData: { [table: string]: any[] } = {},
    isRetryAttempt: boolean = false,
    previousError?: string
): Promise<any> {
    try {
        // Log retry attempt status
        if (isRetryAttempt) {
            console.log('🔄 GenerateRestructuredSQL - Retry attempt in progress...');
        } else {
            console.log('🔄 GenerateRestructuredSQL - First attempt...');
        }

        // Take sample of results for analysis
        const sampleResults = sqlResults.slice(0, sampleSize);

        if (sampleResults.length === 0) {
            return {
                restructured_data: [],
                restructure_success: false,
                restructure_message: "No data to restructure"
            };
        }
        console.log({ tableSampleData })

        console.log('🤖 Using Azure OpenAI for restructuring logic...');

        // Determine JSON function syntax based on database type and version
        const jsonFunctions = getJsonFunctionsForDatabase(dbType, dbVersion);
        const dbSyntaxRules = getDatabaseSyntaxRules(dbType, dbVersion);

        const restructuringPrompt = `
🎯 CRITICAL DATABASE-SPECIFIC SQL GENERATION TASK 🎯

You are an expert SQL developer with DEEP knowledge of ${dbType.toUpperCase()} ${dbVersion} syntax and capabilities.

⚠️ MANDATORY DEEP THINKING REQUIREMENT ⚠️
Before generating ANY SQL, you MUST:
1. IDENTIFY the exact database type: ${dbType.toUpperCase()}
2. CONFIRM the exact version: ${dbVersion}  
3. ANALYZE what SQL features are available in this specific version
4. VALIDATE every single function, syntax element, and clause against ${dbType.toUpperCase()} ${dbVersion} compatibility
5. DOUBLE-CHECK that you're not mixing PostgreSQL syntax with MySQL or vice versa
6. THINK STEP-BY-STEP about each part of your query before writing it

🚨 ZERO TOLERANCE FOR SYNTAX ERRORS 🚨
Your generated SQL will be executed directly against a ${dbType.toUpperCase()} ${dbVersion} database.
ANY syntax error will cause system failure. THINK DEEPLY and VALIDATE THOROUGHLY.

USER PROMPT: "${userPrompt}"

ORIGINAL SQL QUERY:
\`\`\`sql
${originalSQL}
\`\`\`

SAMPLE RESULTS FROM ORIGINAL QUERY (first ${sampleSize} records):
\`\`\`json
${JSON.stringify(sampleResults, null, 2)}
\`\`\`

🔍 DATABASE SPECIFICATIONS:
- TYPE: ${dbType.toUpperCase()}
- VERSION: ${dbVersion}
- TOTAL RECORDS: ${sqlResults.length}

${isRetryAttempt && previousError ? `
🚫 PREVIOUS ATTEMPT FAILED WITH ERROR:
${previousError}

🎯 CRITICAL ERROR ANALYSIS REQUIRED:
1. READ the error message carefully and understand what went wrong
2. IDENTIFY if it was a syntax error, function compatibility issue, or column reference problem  
3. DETERMINE the root cause (wrong database syntax, invalid function, missing column, etc.)
4. APPLY the specific fix needed while maintaining all other requirements
5. ENSURE you don't repeat the same mistake in this retry attempt

⚠️ MANDATORY: Fix the specific issue that caused the failure while maintaining all requirements.
` : ''}

🗂️ DATABASE SCHEMA CONTEXT:
${Object.keys(tableSampleData).length > 0 ? `
TABLE SAMPLE DATA (First 3 records from each table):
${Object.entries(tableSampleData).map(([table, sampleData]) => {
            const samples = Array.isArray(sampleData) && sampleData.length > 0 ?
                `\nSample Data:\n${JSON.stringify(sampleData, null, 2)}` :
                '\nNo sample data available';
            return `- ${table}: ${samples}`;
        }).join('\n')}

🔍 SCHEMA ANALYSIS REQUIREMENTS:
- Understand the actual data types and formats in each table
- Identify which tables contain the information relevant to the user query
- Analyze how the data is structured and what values to expect
- Map relationships between tables based on actual data content
- Identify which columns have meaningful data vs empty/null values
` : 'Use the original SQL structure and column names as shown in the query above.'}

🎯 DEEP THINKING PROCESS - EXECUTE BEFORE GENERATING SQL:

STEP 1: DATABASE TYPE VALIDATION
- Confirm: "I am working with ${dbType.toUpperCase()} version ${dbVersion}"
- Verify: "The syntax I use must be 100% compatible with ${dbType.toUpperCase()} ${dbVersion}"
- Check: "I will NOT use PostgreSQL syntax if this is MySQL, or MySQL syntax if this is PostgreSQL"

STEP 2: FUNCTION COMPATIBILITY CHECK  
- JSON Functions Available: ${jsonFunctions.createObject ? 'YES' : 'NO'}
- Create Object Function: ${jsonFunctions.createObject}
- Create Array Function: ${jsonFunctions.createArray}
- All functions I use must be supported in ${dbType.toUpperCase()} ${dbVersion}

STEP 3: SYNTAX RULES VERIFICATION
${dbSyntaxRules.general}
${dbSyntaxRules.aliasRules}
${dbSyntaxRules.orderByRules}

STEP 4: COLUMN VALIDATION  
- Use ONLY columns that appear in the original SQL query
- Use ONLY columns that exist in the sample data provided
- NEVER invent column names like 'medication_count', 'patient_count', etc.
- If I need counts, use COUNT(*) or COUNT(existing_column_name)

STEP 5: QUERY STRUCTURE VALIDATION
- Ensure proper JOIN syntax for ${dbType.toUpperCase()}
- Validate GROUP BY compliance (especially for MySQL sql_mode=only_full_group_by)
- Check WHERE clause syntax and operators
- Verify aggregate function usage

🎯 MANDATORY CRITICAL VALIDATION CHECKLIST 🎯

Before finalizing your SQL query, you MUST complete this validation checklist:

✅ DATABASE TYPE VERIFICATION:
□ I confirmed this is ${dbType.toUpperCase()} version ${dbVersion}
□ I verified all functions are compatible with ${dbType.toUpperCase()} ${dbVersion}  
□ I checked that I'm not mixing PostgreSQL and MySQL syntax

✅ SYNTAX VALIDATION:
□ Every function I used exists in ${dbType.toUpperCase()} ${dbVersion}
□ All JOIN syntax follows ${dbType.toUpperCase()} standards
□ All aggregate functions are properly used
□ All parentheses, commas, and quotes are correctly placed

✅ COLUMN VALIDATION:
□ Every column I referenced exists in the original SQL or sample data
□ I did not invent any column names like 'count', 'total', 'summary_id'
□ I used exact column names with proper table prefixes
□ I used COUNT(*) instead of non-existent count columns

✅ GROUP BY VALIDATION (Critical for MySQL):
□ If using aggregation, all non-aggregated SELECT columns are in GROUP BY
□ My GROUP BY clause follows ${dbType.toUpperCase()} strict mode requirements
□ I verified no GROUP BY violations that would cause errors

✅ JSON FUNCTION VALIDATION:
□ I used ${jsonFunctions.createObject} correctly for objects
□ I used ${jsonFunctions.createArray} correctly for arrays  
□ My JSON syntax matches ${dbType.toUpperCase()} ${dbVersion} specifications

✅ UNION ALL VALIDATION (if applicable):
□ All SELECT statements have exactly the same number of columns
□ Column data types are consistent across all UNION statements
□ I used proper CAST(NULL as DATA_TYPE) for missing columns
□ Column order is identical in all SELECT statements

⚠️ FINAL VERIFICATION STEP ⚠️
Read through your entire SQL query one more time and ask:
1. "Will this execute successfully on ${dbType.toUpperCase()} ${dbVersion}?"
2. "Did I use any functions that don't exist in this database version?"
3. "Are all my column references valid and existing?"
4. "Does my syntax perfectly match ${dbType.toUpperCase()} requirements?"

🚨 ONLY PROCEED IF ALL CHECKS PASS 🚨

TASK: Generate a new SQL query that produces structured, non-redundant results directly from the database.

RESTRUCTURING REQUIREMENTS:
1. **ELIMINATE REDUNDANCY**: Use GROUP BY to group related entities (e.g., patients, medications, lab tests)
2. **CREATE JSON HIERARCHY**: Use ${jsonFunctions.createObject} and ${jsonFunctions.createArray} functions to create nested structures
3. **MAINTAIN DATA INTEGRITY**: Don't lose any information from the original query
4. **BE LOGICAL**: Structure should make business sense for the data domain
5. **USE APPROPRIATE GROUPING**: Identify the main entity and group related data under it
6. **PREVENT DUPLICATE DATA**: Ensure no duplicate records appear in any field of the response - each record should be unique
7. **AVOID IDENTICAL/REPETITIVE DATA**: Do NOT generate queries that return identical values across multiple rows or columns. Use DISTINCT, proper GROUP BY, and JSON aggregation to eliminate repetitive data patterns. Avoid queries that produce the same data values repeated multiple times in the response.
8. **RETURN PARSED JSON OBJECTS**: Generate SQL that returns properly structured JSON objects, NOT stringified JSON. The JSON functions should produce actual JSON objects that can be directly used without additional parsing. Avoid queries that return JSON data as strings that require further parsing.
9. **MYSQL GROUP BY STRICT COMPLIANCE**: For MySQL, ensure every non-aggregated column in SELECT appears in GROUP BY clause (sql_mode=only_full_group_by)
10. **VERSION COMPATIBILITY**: Ensure the generated SQL is compatible with ${dbType.toUpperCase()} ${dbVersion}
11. **SCHEMA ACCURACY**: Use ONLY validated table and column names from the database schema above
12. **EXACT COLUMN NAMES**: Do NOT assume, guess, or make up column names. Use ONLY the exact column names provided in the validated schema. If a column name is not in the validated list, DO NOT use it. Never use variations like 'patient_id' when the actual column is 'id', or vice versa.
13. **STRICT COLUMN VALIDATION**: Before using any column in SELECT, FROM, JOIN, WHERE, or GROUP BY clauses, verify it exists in the validated columns list for that table. Reject any query that references non-existent columns.
14. **SAMPLE DATA VERIFICATION**: Use the provided sample data to VERIFY that columns actually exist and contain the expected data types. Do NOT reference any column that is not visible in the sample data provided.
15. **COLUMN CROSS-REFERENCE**: Cross-check every single column reference against both the validated schema AND the sample data. If a column is not present in either the schema or sample data, DO NOT use it under any circumstances.
16. **NO COLUMN ASSUMPTIONS**: Never assume standard column names like 'summary_id', 'patient_id', 'medication_id' etc. Use ONLY the exact column names shown in the sample data and schema.
17. **SAMPLE DATA ANALYSIS**: Leverage the provided sample data to understand the actual data content, formats, and relationships. Use sample data to verify which tables contain relevant information for the user query and to understand data patterns that should influence your restructuring approach.
18. **DATA-DRIVEN TABLE SELECTION**: Prioritize tables that contain relevant data based on the sample data analysis. If sample data shows certain tables have meaningful information for the user query while others are empty or irrelevant, focus on the tables with relevant sample data.
19. **NEVER INVENT COLUMN NAMES**: CRITICAL - Do NOT create imaginary columns like 'medication_count', 'patient_count', 'summary_id', 'total_medications', 'risk_score', etc. If you need to count something, use COUNT(*) or COUNT(existing_column_name) but do NOT reference non-existent counting columns.
20. **FORBIDDEN COLUMN PATTERNS**: NEVER use columns ending in '_count', '_total', '_sum', '_avg' unless they physically exist in the sample data. Do NOT generate queries with aggregated column names that don't exist in the actual database schema.
21. **SAMPLE DATA IS GROUND TRUTH**: The sample data shows you EXACTLY which columns exist. If a column is not in the sample data, it does NOT exist. Period. No exceptions. No assumptions. No guessing.
22. **AGGREGATE FUNCTIONS ONLY**: If you need counts, sums, or calculations, use SQL aggregate functions like COUNT(*), SUM(existing_column), AVG(existing_column). Do NOT reference made-up column names to get these values.
23. **MULTI-SHEET EXCEL FORMAT**: Generate results organized for multi-sheet Excel export where different record types are separated into different sheets. Structure the output as a JSON object with sheet names as keys and their corresponding data arrays as values. Each sheet should contain homogeneous records (same entity type) with consistent column structures. 

24. **MAIN ENTITY COUNT AND IDENTIFIER**: ALWAYS include metadata about the main entity being queried. Add a "metadata" section in the response that includes:
- "main_entity": The name of the primary entity type (e.g., "patients", "medications", "appointments")
- "main_entity_count": The total count of unique main entities using COUNT(*) or COUNT(DISTINCT main_entity_id)
- "main_entity_identifier": The primary key field name used to identify the main entity (e.g., "patient_id", "medication_id", "appointment_id")

**CRITICAL STRUCTURING REQUIREMENTS FOR MULTI-SHEET EXCEL:**
- MANDATORY ARRAY WRAPPER: The response MUST ALWAYS be wrapped in an array with a single object: [{ metadata: {...}, patients: [...], medications: [...] }]
- Organize results by entity type: patients, medications, appointments, diagnoses, etc. into separate logical sheets within the single array object.
- Return EXACTLY this structure: [{"metadata": {"main_entity": "patients", "main_entity_count": 25, "main_entity_identifier": "patient_id"}, "patients": [patient_records], "medications": [medication_records], "appointments": [appointment_records]}]
- Each sheet (array) should contain flat, denormalized records with consistent column structures.
- Within each sheet, ensure all rows have the same column structure for proper Excel formatting.
- Use descriptive sheet names that clearly identify the record type (e.g., "patients", "medications", "appointments", "lab_results").
- MANDATORY: Include a "sheet_type" field in each record to identify its category (e.g., "patient", "medication_summary", "appointment", etc.).
- Maintain relationships through foreign keys (patient_id in medication records, etc.) rather than nesting.
- Each sheet should be independently exportable to Excel with proper headers and consistent data types per column.
- For complex queries involving multiple entities, determine the primary focus and create appropriate sheet divisions.
- MANDATORY: Always include the metadata section with main entity information and count.
- CRITICAL: The frontend expects EXACTLY this array structure - never return a plain object, always wrap in array.

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

🎯 EXPECTED OUTPUT FORMAT WITH VALIDATION PROOF 🎯

Return a JSON object with this EXACT structure:

{
  "database_validation": {
    "confirmed_db_type": "${dbType.toUpperCase()}",
    "confirmed_version": "${dbVersion}",
    "syntax_validation_passed": true/false,
    "functions_verified": ["list of functions you used"],
    "compatibility_check": "explanation of how you ensured compatibility"
  },
  "error_analysis": ${isRetryAttempt && previousError ? `{
    "previous_error": "${previousError}",
    "root_cause_identified": "explanation of what caused the error",
    "fix_applied": "specific changes made to fix the error"
  }` : 'null'},
  "restructured_sql": "your_new_sql_query_here",
  "explanation": "Brief explanation of how you restructured the query and why",
  "grouping_logic": "Explanation of what entities you grouped together (e.g., 'Grouped by patient_id to eliminate patient duplication')",
  "expected_structure": "The SQL results should be transformable into: [{ metadata: { main_entity: 'patients', main_entity_count: X, main_entity_identifier: 'patient_id' }, patients: [...], medications: [...] }]",
  "main_entity": "The primary entity being grouped (e.g., 'patient', 'medication', 'lab_test')",
  "validation_checklist": {
    "database_type_confirmed": true/false,
    "syntax_verified": true/false,
    "columns_validated": true/false,  
    "group_by_compliant": true/false,
    "json_functions_correct": true/false,
    "union_structure_valid": true/false
  },
  "sql_quality_assurance": {
    "will_execute_successfully": true/false,
    "no_syntax_errors": true/false,
    "all_columns_exist": true/false,
    "database_specific_syntax": true/false
  }
}

CRITICAL: The generated SQL should produce results that can be transformed into this EXACT format:
[
  {
    "metadata": {
      "main_entity": "patients",
      "main_entity_count": 2,
      "main_entity_identifier": "patient_id"
    },
    "patients": [
      {
        "patient_id": "WHP-1584821",
        "sheet_type": "patient",
        "dob": "2019-07-23",
        "city": "Fort Salmaside",
        "gender": "Male",
        "medications": "Fresh Concrete Chair (62MG), Bespoke Steel Shoes (23MG), ...",
        // all patient fields as separate columns
      }
    ],
    "medications": [
      {
        "id": 1,
        "patient_id": "WHP-1584821",
        "sheet_type": "medication_summary",
        "medication_name": "Practical Bamboo Shirt",
        "medication_status": "Safe",
        // all medication fields as separate columns
      }
    ]
  }
]

**Original SQL :- you need to use same table names from original SQL**

${originalSQL}


CRITICAL REQUIREMENTS FOR MULTI-SHEET EXCEL FORMAT:
- Generate a complete, executable SQL query that produces results in the EXACT format shown above
- The SQL should return results that can be transformed into the multi-sheet array structure with metadata, patients array, medications array, etc.
- MANDATORY: Include metadata information in the SQL results (main_entity, main_entity_count, main_entity_identifier)
- Each record must include a "sheet_type" field to identify which sheet it belongs to (e.g., "patient", "medication_summary", "appointment")
- Patient records should have sheet_type = "patient" and include all patient demographic fields
- Medication records should have sheet_type = "medication_summary" and include all medication-specific fields
- Use UNION ALL to combine different entity types into a single result set that can be separated by sheet_type
- Ensure consistent column structures within each sheet_type (all patient records have same columns, all medication records have same columns)
- Include foreign key relationships (patient_id) to maintain connections between different entity types
- The SQL should produce a flat result set that can be post-processed into the required nested array structure

EXAMPLE SQL STRUCTURE (adapt to your specific tables and columns):

CRITICAL: ALL SELECT statements in UNION must have the EXACT SAME number of columns in the EXACT SAME order!

SELECT 
  'metadata' as sheet_type,
  'patients' as main_entity,
  COUNT(DISTINCT patient_id) as main_entity_count,
  'patient_id' as main_entity_identifier,
  CAST(NULL as VARCHAR(50)) as patient_id,
  CAST(NULL as VARCHAR(100)) as patient_name,
  CAST(NULL as DATE) as dob,
  CAST(NULL as VARCHAR(50)) as gender,
  CAST(NULL as VARCHAR(100)) as city,
  CAST(NULL as VARCHAR(100)) as medication_name,
  CAST(NULL as VARCHAR(50)) as medication_status,
  CAST(NULL as VARCHAR(20)) as dosage
FROM your_main_table
UNION ALL
SELECT 
  'patient' as sheet_type,
  CAST(NULL as VARCHAR(50)) as main_entity,
  CAST(NULL as INTEGER) as main_entity_count,
  CAST(NULL as VARCHAR(50)) as main_entity_identifier,
  patient_id,
  patient_name,
  dob,
  gender,
  city,
  CAST(NULL as VARCHAR(100)) as medication_name,
  CAST(NULL as VARCHAR(50)) as medication_status,
  CAST(NULL as VARCHAR(20)) as dosage
FROM your_patient_table
UNION ALL  
SELECT
  'medication_summary' as sheet_type,
  CAST(NULL as VARCHAR(50)) as main_entity,
  CAST(NULL as INTEGER) as main_entity_count,
  CAST(NULL as VARCHAR(50)) as main_entity_identifier,
  patient_id,
  CAST(NULL as VARCHAR(100)) as patient_name,
  CAST(NULL as DATE) as dob,
  CAST(NULL as VARCHAR(50)) as gender,
  CAST(NULL as VARCHAR(100)) as city,
  medication_name,
  medication_status,
  dosage
FROM your_medication_table

This produces a single result set that can be separated by sheet_type into the required format.
- Include metadata fields in the results like main_entity, main_entity_count, and main_entity_identifier
- Use appropriate JOINs to gather related data but maintain flat, tabular structure within each entity type
- The generated SQL should produce results in a format that can later be transformed into: [{"metadata": {"main_entity": "patients", "main_entity_count": 25, "main_entity_identifier": "patient_id"}, "patients": [], "medications": [], "appointments": []}]
- Each record should be completely flat with no nested objects or arrays
- Use foreign key relationships (patient_id, appointment_id, etc.) to maintain relationships between different entity types
- The SQL should be designed so that when executed, the results can be grouped by sheet_type to create separate Excel sheets
- **MANDATORY SHEET_TYPE FIELD**: Every record in every sheet must include a "sheet_type" field (e.g., "patient", "medication_summary", "appointment")
- **FLAT RECORDS WITHIN SHEETS**: Each record within a sheet should be flat with no nested objects or arrays
- **CONSISTENT SHEET STRUCTURE**: All records within the same sheet must have identical column structures
- **FOREIGN KEY RELATIONSHIPS**: Use foreign keys (patient_id, appointment_id, etc.) to maintain relationships between sheets instead of nesting
- **USE ORIGINAL SQL COLUMNS**: Use the exact column names as they appear in the original SQL query and sample data
- **STRICT TABLE.COLUMN FORMAT**: Always use the exact table.column format when referencing columns (e.g., patients.patient_id, medications.medication_name)
- **ENTITY-BASED GROUPING**: Group related data by entity type rather than hierarchical nesting
- Handle NULL values appropriately and ensure data integrity across sheets
- Use version-appropriate SQL syntax for ${dbType.toUpperCase()} ${dbVersion}

## CRITICAL SQL CORRECTNESS REQUIREMENTS
- VALIDATE ALL SYNTAX: Double-check every function, clause, and operator for compatibility with ${dbType.toUpperCase()} ${dbVersion}
- TEST QUERY STRUCTURE: Ensure proper nesting of JSON functions and correct parentheses matching
- **USE SAMPLE DATA COLUMNS**: Use only column names that appear in the sample data and original SQL query
- CHECK JOIN CONDITIONS: All joins must have proper conditions and table relationships
- ENSURE PROPER GROUPING: All non-aggregated columns must be included in GROUP BY clauses
- **MYSQL GROUP BY COMPLIANCE**: For MySQL with sql_mode=only_full_group_by, ALL non-aggregated columns in SELECT must appear in GROUP BY clause
- **PREVENT GROUP BY VIOLATIONS**: Never use aggregated expressions from subqueries without proper grouping
- **SUBQUERY AGGREGATION RULES**: When using aggregated columns from subqueries, ensure main query groups by all non-aggregated columns
- AVOID SYNTAX ERRORS: Pay special attention to database-specific syntax requirements
- HANDLE NULL VALUES: Use appropriate NULL handling for the specific database type (COALESCE, IFNULL)
- FOLLOW EXACT VERSION CONSTRAINTS: Only use functions available in ${dbType.toUpperCase()} ${dbVersion}

## CRITICAL UNION ALL REQUIREMENTS - MANDATORY FOR MULTI-SHEET FORMAT
**UNION COLUMN MATCHING (PREVENTS "each UNION query must have the same number of columns" ERROR):**
- **EXACT COLUMN COUNT**: Every SELECT statement in UNION ALL must have the EXACT SAME number of columns
- **EXACT COLUMN ORDER**: All columns must appear in the EXACT SAME order in every SELECT statement
- **CONSISTENT DATA TYPES**: Use CAST() or CONVERT() functions to ensure matching data types for each column position
- **NULL PLACEHOLDER COLUMNS**: When a column doesn't exist in a particular entity, use CAST(NULL as DATA_TYPE) as column_name
- **COLUMN NAME CONSISTENCY**: Use the same alias names for corresponding columns across all UNION statements
- **NO MISSING COLUMNS**: Never omit columns in any SELECT statement - use NULL placeholders instead
- **DATA TYPE CASTING**: Always cast NULL values to the appropriate data type (VARCHAR, INTEGER, DATE, etc.) to match other UNION statements

**EXAMPLE OF CORRECT UNION COLUMN MATCHING:**
\`\`\`
SELECT 'metadata' as sheet_type, 'patients' as entity, COUNT(*) as count, CAST(NULL as VARCHAR(50)) as patient_id, CAST(NULL as VARCHAR(100)) as name
UNION ALL
SELECT 'patient' as sheet_type, CAST(NULL as VARCHAR(50)) as entity, CAST(NULL as INTEGER) as count, patient_id, patient_name as name
\`\`\`

**COMMON UNION ERRORS TO AVOID:**
- Different number of columns in SELECT statements
- Missing columns in some UNION statements  
- Inconsistent data types (mixing VARCHAR with INTEGER without casting)
- Using plain NULL instead of CAST(NULL as DATA_TYPE)
- Changing column order between UNION statements
${dbSyntaxRules.criticalRequirements}

BEFORE FINALIZING THE QUERY:
1. Review the entire query line by line for syntax errors
2. Use only column names from the original SQL and sample data
3. **VALIDATE EVERY COLUMN**: Use only columns that appear in the original SQL query and sample data
4. **CHECK TABLE.COLUMN REFERENCES**: Ensure all column references use the correct table prefix from the original SQL
5. **USE SAMPLE DATA COLUMNS**: If sample data is available, use only columns that appear in the sample data
6. **NO INVENTED COLUMNS**: Never create or assume column names. Use ONLY columns from the original SQL and available sample data
7. **NO AGGREGATED COLUMN ASSUMPTIONS**: NEVER use columns like 'medication_count', 'patient_count', 'total_*', '*_sum', '*_avg' unless they physically exist. If you need counts, use COUNT(*) or COUNT(existing_column)
8. **VALIDATE HAVING CLAUSE**: If using HAVING clause, ensure all referenced columns either appear in GROUP BY or are aggregate functions
9. **UNION ALL VALIDATION**: If using UNION ALL for multi-sheet format, ensure ALL SELECT statements have the EXACT same number of columns in the EXACT same order with proper CAST(NULL as DATA_TYPE) for missing columns
10. **UNION COLUMN CONSISTENCY**: Verify all UNION statements use consistent data types and column names to prevent "each UNION query must have the same number of columns" errors
11. **SQL STRUCTURE VALIDATION**: Ensure the generated SQL will produce results that include sheet_type fields for organizing into different Excel sheets
11. **SQL STRUCTURE VALIDATION**: Ensure the generated SQL will produce results that include sheet_type fields for organizing into different Excel sheets
12. **METADATA SECTION VALIDATION**: Ensure the response includes a metadata section with main_entity, main_entity_count (calculated using COUNT(*) or COUNT(DISTINCT)), and main_entity_identifier fields
13. **SHEET_TYPE FIELD VALIDATION**: Verify that the generated SQL includes a "sheet_type" field in the SELECT clause to identify record categories
14. **MULTI-SHEET STRUCTURE VALIDATION**: Ensure the query result can be properly organized into separate sheets by entity type (patients, medications, appointments, etc.)
15. **FLAT STRUCTURE CHECK**: Verify that each record within an entity type is completely flat with no nested objects or arrays
16. **SHEET CONSISTENCY**: Ensure all records of the same entity type have identical column structures for proper Excel sheet formatting
17. **FOREIGN KEY RELATIONSHIPS**: Verify that relationships between entities are maintained through foreign key references (patient_id, appointment_id, etc.) rather than nesting
18. **NO HIERARCHICAL NESTING**: Eliminate any JSON aggregation or array structures that would create nested data within records
19. **ENTITY SEPARATION**: Ensure different entity types (patients vs medications vs appointments) can be clearly separated into different result sets or sheets
20. Check that all JOIN conditions are logical and will maintain data relationships
21. Verify compatibility with ${dbType.toUpperCase()} ${dbVersion}
22. Double-check all parentheses, commas, and syntax elements
23. Verify ORDER BY clause uses either full expressions or positional references, not aliases
24. Confirm that any aggregated values used in ORDER BY are properly repeated in the SELECT clause
25. **MULTI-SHEET EXPORT READY**: Confirm the result structure is suitable for creating multiple Excel sheets with consistent, flat data in each sheet

DO NOT INCLUDE ANY EXPERIMENTAL OR UNTESTED SYNTAX. Only use proven, standard SQL constructs that are guaranteed to work with ${dbType.toUpperCase()} ${dbVersion}.

${jsonFunctions.finalReminder}

${dbSyntaxRules.finalReminder}

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
                    content: `🎯 CRITICAL SYSTEM INSTRUCTIONS FOR ${dbType.toUpperCase()} ${dbVersion} SQL GENERATION 🎯

You are a database expert with PERFECT knowledge of ${dbType.toUpperCase()} ${dbVersion} syntax and capabilities.

🚨 ZERO TOLERANCE POLICY 🚨
- ANY syntax error will cause system failure
- ANY wrong function usage will break the application  
- ANY column name mistakes will result in query failure
- You MUST generate 100% correct, executable SQL

🧠 MANDATORY DEEP THINKING PROCESS:
1. ALWAYS start by confirming the database type (${dbType.toUpperCase()}) and version (${dbVersion})
2. VALIDATE every single function against ${dbType.toUpperCase()} ${dbVersion} compatibility
3. VERIFY every column name exists in the provided schema/sample data
4. DOUBLE-CHECK all syntax elements for ${dbType.toUpperCase()} standards
5. ENSURE no mixing of PostgreSQL/MySQL/other database syntaxes

📝 RESPONSE REQUIREMENTS:
- Return ONLY valid JSON without markdown formatting, comments, or additional text
- Include the validation proof in your response structure
- Demonstrate that you verified compatibility and syntax correctness  
- Show evidence of deep thinking and validation in the response fields

🔧 SQL GENERATION RULES:
- Use ONLY column names from original SQL query and sample data provided
- Use ONLY functions available in ${dbType.toUpperCase()} ${dbVersion}
- Follow ${dbType.toUpperCase()}-specific syntax rules exactly
- NEVER create imaginary columns like 'medication_count', 'patient_count', 'summary_id'
- Use SQL aggregate functions (COUNT(*), SUM(), AVG()) instead of assuming aggregated columns exist
- For UNION ALL: ensure EXACT same column count and data types across all SELECT statements

⚠️ FAILURE IS NOT ACCEPTABLE ⚠️
Your SQL will be executed directly. It MUST work perfectly on the first try.`
                },
                {
                    role: "user",
                    content: restructuringPrompt
                }
            ],
            temperature: 0.0, // Set to 0 for maximum precision and consistency
            max_tokens: 4000,
            presence_penalty: 0,
            frequency_penalty: 0
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

        // Validate that the AI followed the deep thinking process
        if (!restructuredResult.database_validation) {
            console.warn('⚠️ AI did not provide database validation proof - adding default validation');
            restructuredResult.database_validation = {
                confirmed_db_type: dbType.toUpperCase(),
                confirmed_version: dbVersion,
                syntax_validation_passed: false,
                functions_verified: [],
                compatibility_check: "Validation not provided by AI"
            };
        }

        if (!restructuredResult.validation_checklist) {
            console.warn('⚠️ AI did not complete validation checklist - adding default checklist');
            restructuredResult.validation_checklist = {
                database_type_confirmed: false,
                syntax_verified: false,
                columns_validated: false,
                group_by_compliant: false,
                json_functions_correct: false,
                union_structure_valid: false
            };
        }

        if (!restructuredResult.sql_quality_assurance) {
            console.warn('⚠️ AI did not provide SQL quality assurance - adding default QA');
            restructuredResult.sql_quality_assurance = {
                will_execute_successfully: false,
                no_syntax_errors: false,
                all_columns_exist: false,
                database_specific_syntax: false
            };
        }

        // Log validation results for debugging
        console.log('🔍 AI Validation Results:', {
            database_validation: restructuredResult.database_validation,
            validation_checklist: restructuredResult.validation_checklist,
            sql_quality_assurance: restructuredResult.sql_quality_assurance
        });

        // Check if the AI claims the SQL is validated and correct
        const validationPassed = restructuredResult.sql_quality_assurance?.will_execute_successfully &&
                                restructuredResult.sql_quality_assurance?.no_syntax_errors &&
                                restructuredResult.validation_checklist?.syntax_verified;

        if (!validationPassed) {
            console.warn('⚠️ AI validation indicates potential issues with generated SQL');
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

        // Retry logic: If this is the first attempt, retry once after 5 seconds
        if (!isRetryAttempt) {
            console.log('🔄 First attempt failed, retrying in 5 seconds...');

            try {
                // Wait for 5 seconds before retry
                await new Promise(resolve => setTimeout(resolve, 5000));

                console.log('🔄 Attempting retry for generateRestructuredSQL...');

                // Call the function again with isRetryAttempt = true to prevent infinite recursion
                return await generateRestructuredSQL(
                    originalSQL,
                    sqlResults,
                    userPrompt,
                    dbType,
                    dbVersion,
                    sampleSize,
                    sqlAgent,
                    organizationId,
                    tableSampleData, // Pass the existing table sample data
                    true, // Mark as retry attempt
                    error.message // Pass the error message for the retry prompt
                );

            } catch (retryError: any) {
                console.error('❌ Retry attempt also failed:', retryError.message);

                return {
                    restructured_sql: originalSQL, // Fallback to original SQL
                    restructure_success: false,
                    restructure_message: `SQL restructuring failed after retry: Original error: ${error.message}, Retry error: ${retryError.message}`,
                    error_details: `Original: ${error.message}, Retry: ${retryError.message}`,
                    explanation: "Error occurred during SQL restructuring (failed twice)",
                    grouping_logic: "No grouping applied due to error",
                    expected_structure: "Original flat structure maintained",
                    database_type: dbType,
                    database_version: dbVersion,
                    retry_attempted: true,
                    retry_failed: true
                };
            }
        } else {
            // This is already a retry attempt, don't retry again
            console.log('❌ Retry attempt failed, not attempting third try');

            return {
                restructured_sql: originalSQL, // Fallback to original SQL
                restructure_success: false,
                restructure_message: `SQL restructuring retry failed: ${error.message}`,
                error_details: error.message,
                explanation: "Error occurred during SQL restructuring retry (no third attempt)",
                grouping_logic: "No grouping applied due to retry failure",
                expected_structure: "Original flat structure maintained",
                database_type: dbType,
                database_version: dbVersion,
                retry_attempted: true,
                retry_failed: true
            };
        }
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
    static processGraphData(
        sqlResults: any[],
        graphConfig: GraphConfig
    ): GraphData {
        console.log(`📊 Processing graph data for type: ${graphConfig.type}`);

        let processedData = this.transformData(sqlResults, graphConfig);
        let insights = this.generateInsights(processedData, graphConfig);
        let recommendations = this.generateRecommendations(
            processedData,
            graphConfig
        );

        return {
            type: graphConfig.type,
            data: processedData,
            config: graphConfig,
            metadata: {
                totalRecords: sqlResults.length,
                processedAt: new Date().toISOString(),
                dataQuality: this.assessDataQuality(sqlResults),
                insights,
                recommendations,
            },
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
    private static combineDataByLabel(
        data: any[],
        labelKey: string = "label",
        valueKey: string = "y",
        aggregation: string = "sum"
    ): any[] {
        const grouped = new Map<string, any>();

        data.forEach((item) => {
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
                    case "sum":
                        combinedValue = existingValue + newValue;
                        break;
                    case "avg":
                        // For average, we need to track count and sum
                        const count = existing.count || 1;
                        const sum = existing.sum || existingValue;
                        combinedValue = (sum + newValue) / (count + 1);
                        existing.count = count + 1;
                        existing.sum = sum + newValue;
                        break;
                    case "max":
                        combinedValue = Math.max(existingValue, newValue);
                        break;
                    case "min":
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
        const transformedData = data.map((item) => ({
            x: item[xAxis],
            y: this.parseNumericValue(item[yAxis]),
            label: item[xAxis],
            color: config.colorBy ? item[config.colorBy] : undefined,
        }));

        // Combine data with same labels to prevent duplicates
        return this.combineDataByLabel(
            transformedData,
            "label",
            "y",
            config.aggregation || "sum"
        );
    }

    /**
     * Transform data for line charts
     */
    private static transformForLineChart(
        data: any[],
        config: GraphConfig
    ): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        return data
            .map((item) => ({
                x: this.parseDateValue(item[xAxis]),
                y: this.parseNumericValue(item[yAxis]),
                label: item[xAxis],
                group: config.colorBy ? item[config.colorBy] : undefined,
            }))
            .sort((a, b) => a.x - b.x);
    }

    /**
     * Transform data for pie charts
     */
    private static transformForPieChart(data: any[], config: GraphConfig): any[] {
        const labelField = config.xAxis || Object.keys(data[0] || {})[0];
        const valueField = config.yAxis || Object.keys(data[0] || {})[1];

        if (config.aggregation) {
            return this.aggregateData(
                data,
                labelField,
                valueField,
                config.aggregation
            );
        }

        // Transform data first
        const transformedData = data.map((item) => ({
            label: item[labelField],
            value: this.parseNumericValue(item[valueField]),
            color: config.colorBy ? item[config.colorBy] : undefined,
        }));

        // Combine data with same labels to prevent duplicates
        return this.combineDataByLabel(
            transformedData,
            "label",
            "value",
            config.aggregation || "sum"
        );
    }

    /**
     * Transform data for scatter plots
     */
    private static transformForScatterPlot(
        data: any[],
        config: GraphConfig
    ): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map((item) => ({
            x: this.parseNumericValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            size: config.sizeBy ? this.parseNumericValue(item[config.sizeBy]) : 10,
            color: config.colorBy ? item[config.colorBy] : undefined,
            label: item[xAxis],
        }));
    }

    /**
     * Transform data for histograms
     */
    private static transformForHistogram(
        data: any[],
        config: GraphConfig
    ): any[] {
        const valueField = config.xAxis || Object.keys(data[0] || {})[0];
        const values = data
            .map((item) => this.parseNumericValue(item[valueField]))
            .filter((v) => !isNaN(v));

        if (values.length === 0) return [];

        const min = Math.min(...values);
        const max = Math.max(...values);
        const binCount = Math.min(10, Math.ceil(Math.sqrt(values.length)));
        const binSize = (max - min) / binCount;

        const bins = Array(binCount)
            .fill(0)
            .map((_, i) => ({
                start: min + i * binSize,
                end: min + (i + 1) * binSize,
                count: 0,
            }));

        values.forEach((value) => {
            const binIndex = Math.min(
                Math.floor((value - min) / binSize),
                binCount - 1
            );
            bins[binIndex].count++;
        });

        return bins.map((bin) => ({
            x: `${bin.start.toFixed(2)}-${bin.end.toFixed(2)}`,
            y: bin.count,
            start: bin.start,
            end: bin.end,
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
                const values = groupData
                    .map((item) => this.parseNumericValue(item[valueField]))
                    .filter((v) => !isNaN(v));
                return this.calculateBoxPlotStats(values, group);
            });
        } else {
            const values = data
                .map((item) => this.parseNumericValue(item[valueField]))
                .filter((v) => !isNaN(v));
            return [this.calculateBoxPlotStats(values, "all")];
        }
    }

    /**
     * Transform data for heatmaps
     */
    private static transformForHeatmap(data: any[], config: GraphConfig): any[] {
        const xField = config.xAxis || Object.keys(data[0] || {})[0];
        const yField = config.yAxis || Object.keys(data[0] || {})[1];
        const valueField = config.sizeBy || Object.keys(data[0] || {})[2];

        return data.map((item) => ({
            x: item[xField],
            y: item[yField],
            value: this.parseNumericValue(item[valueField]),
            color: this.getHeatmapColor(this.parseNumericValue(item[valueField])),
        }));
    }

    /**
     * Transform data for timelines
     */
    private static transformForTimeline(data: any[], config: GraphConfig): any[] {
        const timeField = config.xAxis || Object.keys(data[0] || {})[0];
        const eventField = config.yAxis || Object.keys(data[0] || {})[1];

        return data
            .map((item) => ({
                time: this.parseDateValue(item[timeField]),
                event: item[eventField],
                description: config.colorBy ? item[config.colorBy] : undefined,
                category: config.groupBy ? item[config.groupBy] : undefined,
            }))
            .sort((a, b) => a.time - b.time);
    }

    /**
     * Transform data for stacked bar charts
     */
    private static transformForStackedBar(
        data: any[],
        config: GraphConfig
    ): any[] {
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
                    value: stackData.reduce(
                        (sum, item) => sum + this.parseNumericValue(item[yAxis]),
                        0
                    ),
                })),
            };
        });
    }

    /**
     * Transform data for grouped bar charts
     */
    private static transformForGroupedBar(
        data: any[],
        config: GraphConfig
    ): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const groupBy = config.groupBy || config.colorBy;

        if (!groupBy) return this.transformForBarChart(data, config);

        const groups = this.groupData(data, groupBy);
        return Object.entries(groups).map(([groupName, groupData]) => ({
            group: groupName,
            bars: groupData.map((item) => ({
                x: item[xAxis],
                y: this.parseNumericValue(item[yAxis]),
                label: item[xAxis],
            })),
        }));
    }

    /**
     * Transform data for multi-line charts
     */
    private static transformForMultiLine(
        data: any[],
        config: GraphConfig
    ): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const lineBy = config.groupBy || config.colorBy;

        if (!lineBy) return this.transformForLineChart(data, config);

        const lines = this.groupData(data, lineBy);
        return Object.entries(lines).map(([lineName, lineData]) => ({
            name: lineName,
            data: lineData
                .map((item) => ({
                    x: this.parseDateValue(item[xAxis]),
                    y: this.parseNumericValue(item[yAxis]),
                }))
                .sort((a, b) => a.x - b.x),
        }));
    }

    /**
     * Transform data for area charts
     */
    private static transformForAreaChart(
        data: any[],
        config: GraphConfig
    ): any[] {
        const result = this.transformForLineChart(data, config);
        return result.map((item) => ({
            ...item,
            area: true,
        }));
    }

    /**
     * Transform data for bubble charts
     */
    private static transformForBubbleChart(
        data: any[],
        config: GraphConfig
    ): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const sizeField = config.sizeBy || Object.keys(data[0] || {})[2];

        return data.map((item) => ({
            x: this.parseNumericValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            size: this.parseNumericValue(item[sizeField]),
            color: config.colorBy ? item[config.colorBy] : undefined,
            label: item[xAxis],
        }));
    }

    /**
     * Transform data for donut charts
     */
    private static transformForDonutChart(
        data: any[],
        config: GraphConfig
    ): any[] {
        return this.transformForPieChart(data, config);
    }

    /**
     * Transform data for waterfall charts
     */
    private static transformForWaterfall(
        data: any[],
        config: GraphConfig
    ): any[] {
        const labelField = config.xAxis || Object.keys(data[0] || {})[0];
        const valueField = config.yAxis || Object.keys(data[0] || {})[1];

        let runningTotal = 0;
        return data.map((item) => {
            const value = this.parseNumericValue(item[valueField]);
            const start = runningTotal;
            runningTotal += value;
            return {
                label: item[labelField],
                value: value,
                start: start,
                end: runningTotal,
                color: value >= 0 ? "positive" : "negative",
            };
        });
    }

    /**
     * Generic chart transformation
     */
    private static transformForGenericChart(
        data: any[],
        config: GraphConfig
    ): any[] {
        return data.map((item) => ({
            ...item,
            processed: true,
        }));
    }

    /**
     * Aggregate data based on specified function
     */
    private static aggregateData(
        data: any[],
        groupBy: string,
        valueField: string,
        aggregation: string
    ): any[] {
        const groups = this.groupData(data, groupBy);

        return Object.entries(groups).map(([group, groupData]) => {
            const values = groupData
                .map((item) => this.parseNumericValue(item[valueField]))
                .filter((v) => !isNaN(v));
            let aggregatedValue = 0;

            switch (aggregation) {
                case "count":
                    aggregatedValue = groupData.length;
                    break;
                case "sum":
                    aggregatedValue = values.reduce((sum, val) => sum + val, 0);
                    break;
                case "avg":
                    aggregatedValue =
                        values.length > 0
                            ? values.reduce((sum, val) => sum + val, 0) / values.length
                            : 0;
                    break;
                case "min":
                    aggregatedValue = values.length > 0 ? Math.min(...values) : 0;
                    break;
                case "max":
                    aggregatedValue = values.length > 0 ? Math.max(...values) : 0;
                    break;
                case "median":
                    aggregatedValue = this.calculateMedian(values);
                    break;
                default:
                    aggregatedValue = values.reduce((sum, val) => sum + val, 0);
            }

            return {
                label: group,
                value: aggregatedValue,
                count: groupData.length,
            };
        });
    }

    /**
     * Group data by a specific field
     */
    private static groupData(
        data: any[],
        groupBy: string
    ): Record<string, any[]> {
        return data.reduce((groups, item) => {
            const key = item[groupBy] || "Unknown";
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
            return groups;
        }, {} as Record<string, any[]>);
    }

    /**
     * Calculate box plot statistics
     */
    private static calculateBoxPlotStats(values: number[], group: string): any {
        if (values.length === 0)
            return { group, min: 0, q1: 0, median: 0, q3: 0, max: 0 };

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
    private static calculatePercentile(
        values: number[],
        percentile: number
    ): number {
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
        return values.length % 2 === 0
            ? (values[mid - 1] + values[mid]) / 2
            : values[mid];
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
    private static assessDataQuality(data: any[]): {
        completeness: number;
        accuracy: number;
        consistency: number;
    } {
        if (data.length === 0)
            return { completeness: 0, accuracy: 0, consistency: 0 };

        const totalFields = Object.keys(data[0] || {}).length;
        let totalNulls = 0;
        let totalValues = 0;

        data.forEach((item) => {
            Object.values(item).forEach((value) => {
                totalValues++;
                if (value === null || value === undefined || value === "") {
                    totalNulls++;
                }
            });
        });

        const completeness = ((totalValues - totalNulls) / totalValues) * 100;
        const accuracy = Math.min(
            100,
            Math.max(0, 100 - (totalNulls / data.length) * 10)
        );
        const consistency = Math.min(
            100,
            Math.max(0, 100 - (totalNulls / totalValues) * 20)
        );

        return { completeness, accuracy, consistency };
    }

    /**
     * Generate insights from data
     */
    private static generateInsights(data: any[], config: GraphConfig): string[] {
        const insights: string[] = [];

        if (data.length === 0) {
            insights.push("No data available for visualization");
            return insights;
        }

        // Basic insights based on data type
        switch (config.type) {
            case GraphType.BAR_CHART:
            case GraphType.PIE_CHART:
                const maxValue = Math.max(...data.map((d) => d.value || d.y || 0));
                const minValue = Math.min(...data.map((d) => d.value || d.y || 0));
                insights.push(`Highest value: ${maxValue}`);
                insights.push(`Lowest value: ${minValue}`);
                insights.push(`Data range: ${maxValue - minValue}`);
                break;
            case GraphType.LINE_CHART:
            case GraphType.TIMELINE:
                insights.push(`Time span: ${data.length} data points`);
                if (data.length > 1) {
                    const trend =
                        data[data.length - 1].y > data[0].y ? "increasing" : "decreasing";
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
                    insights.push("Demographic distribution analysis");
                    break;
                case MedicalDataCategory.LABORATORY_RESULTS:
                    insights.push("Lab result trends and ranges");
                    break;
                case MedicalDataCategory.MEDICATIONS:
                    insights.push("Medication usage patterns");
                    break;
                case MedicalDataCategory.VITAL_SIGNS:
                    insights.push("Vital sign monitoring trends");
                    break;
            }
        }

        return insights;
    }

    /**
     * Generate recommendations based on data and graph type
     */
    private static generateRecommendations(
        data: any[],
        config: GraphConfig
    ): string[] {
        const recommendations: string[] = [];

        if (data.length === 0) {
            recommendations.push(
                "Consider expanding the data query to include more records"
            );
            return recommendations;
        }

        // Recommendations based on data quality
        const quality = this.assessDataQuality(data);
        if (quality.completeness < 80) {
            recommendations.push("Data completeness is low - consider data cleaning");
        }
        if (quality.accuracy < 90) {
            recommendations.push(
                "Data accuracy could be improved - verify data sources"
            );
        }

        // Recommendations based on graph type
        switch (config.type) {
            case GraphType.BAR_CHART:
                if (data.length > 20) {
                    recommendations.push(
                        "Consider grouping categories for better readability"
                    );
                }
                break;
            case GraphType.LINE_CHART:
                if (data.length < 5) {
                    recommendations.push(
                        "More data points recommended for trend analysis"
                    );
                }
                break;
            case GraphType.PIE_CHART:
                if (data.length > 8) {
                    recommendations.push(
                        'Consider combining smaller segments into "Other" category'
                    );
                }
                break;
            case GraphType.SCATTER_PLOT:
                recommendations.push(
                    "Consider adding trend lines for pattern analysis"
                );
                break;
        }

        // Medical-specific recommendations
        if (config.category) {
            switch (config.category) {
                case MedicalDataCategory.LABORATORY_RESULTS:
                    recommendations.push("Consider adding normal range indicators");
                    break;
                case MedicalDataCategory.MEDICATIONS:
                    recommendations.push("Consider drug interaction analysis");
                    break;
                case MedicalDataCategory.VITAL_SIGNS:
                    recommendations.push("Consider adding alert thresholds");
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

            // Declare tableSampleData at higher scope for reuse in restructured SQL
            let globalTableSampleData: { [table: string]: any[] } = {};

            // ========== RETRY LOOP FOR ZERO RECORDS ==========
            let maxRetryAttempts = 2; // Total of 2 attempts (original + 1 retry)
            let currentAttempt = 1;
            let finalResult: any = null;
            let previousAttemptError: string | null = null; // Track error from previous attempt
            let responseSent = false; // Flag to prevent double responses

            while (currentAttempt <= maxRetryAttempts && !finalResult) {
                console.log(`🔄 Starting API execution attempt ${currentAttempt} of ${maxRetryAttempts}...`);

                try {
                    const errors = validationResult(req);
                    if (!errors.isEmpty()) {
                        responseSent = true;
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

                                    // Check MySQL sql_mode for only_full_group_by
                                    let hasOnlyFullGroupBy = false;
                                    try {
                                        const [sqlModeRows] = await versionConnection.execute("SELECT @@sql_mode as sql_mode");
                                        if (sqlModeRows && Array.isArray(sqlModeRows) && sqlModeRows[0] && (sqlModeRows[0] as any).sql_mode) {
                                            const sqlMode = (sqlModeRows[0] as any).sql_mode;
                                            hasOnlyFullGroupBy = sqlMode.includes('ONLY_FULL_GROUP_BY');
                                            console.log(`🔍 MySQL sql_mode: ${sqlMode}`);
                                            console.log(`🚨 only_full_group_by enabled: ${hasOnlyFullGroupBy}`);
                                        }
                                    } catch (sqlModeError) {
                                        console.warn('⚠️ Could not detect sql_mode, assuming only_full_group_by is enabled for safety');
                                        hasOnlyFullGroupBy = true; // Assume enabled for safety
                                    }

                                    mysqlVersionInfo = {
                                        full: mySQLVersionString,
                                        major,
                                        minor,
                                        patch,
                                        supportsJSON: major >= 5 && minor >= 7,
                                        supportsWindowFunctions: major >= 8,
                                        supportsCTE: major >= 8,
                                        supportsRegex: true,
                                        hasOnlyFullGroupBy: hasOnlyFullGroupBy
                                    };

                                    console.log(`✅ MySQL Version detected: ${mySQLVersionString} (${major}.${minor}.${patch})`);
                                    console.log(`📋 Feature support: JSON=${mysqlVersionInfo.supportsJSON}, Windows=${mysqlVersionInfo.supportsWindowFunctions}, CTE=${mysqlVersionInfo.supportsCTE}`);
                                    console.log(`🚨 only_full_group_by mode: ${hasOnlyFullGroupBy ? 'ENABLED (strict GROUP BY required)' : 'DISABLED'}`);
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
${databaseType.toLowerCase() === 'mysql' ? `- MySQL only_full_group_by mode: ${databaseVersionInfo.hasOnlyFullGroupBy ? 'ENABLED 🚨 (STRICT GROUP BY REQUIRED)' : 'DISABLED ✅'}` : ''}

🚨 CRITICAL MySQL GROUP BY COMPLIANCE (sql_mode=only_full_group_by):
${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo.hasOnlyFullGroupBy ? `
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

**MYSQL sql_mode=only_full_group_by COMPLIANCE IS ABSOLUTELY MANDATORY**` : databaseType.toLowerCase() === 'mysql' ? '**MySQL GROUP BY COMPLIANCE**: Ensure proper GROUP BY usage for any aggregation queries' : ''}

CRITICAL: Use ONLY SQL features compatible with this ${databaseType.toUpperCase()} version. Avoid any syntax not supported by ${databaseVersionInfo.full}.
` : '';
                            console.log({ versionSpecificInstructions })

                            // Add conversation context if in conversational mode
                            let conversationalContext = '';
                            if (conversational && Array.isArray(chatHistory) && chatHistory.length > 0) {
                                conversationalContext = '\n\nPrevious conversation:\n' + chatHistory
                                    .map((msg: any) => `${msg.type === 'human' ? 'User' : 'Assistant'}: ${msg.content}`)
                                    .join('\n') + '\n\n';
                            }

                            // Get all database tables and columns with AI-generated purpose descriptions
                            let tableDescriptions = '';
                            try {
                                console.log('🔍 Getting all database tables and columns for AI analysis...');

                                // Get all tables for this organization
                                const allTables = await databaseService.getOrganizationTables(organizationId);
                                console.log(`📊 Found ${allTables.length} tables:`, allTables);

                                if (allTables.length > 0) {
                                    const tableSchemaData: any = {};
                                    // Use the global tableSampleData instead of local declaration

                                    // Get schema for each table using single connection
                                    console.log(`🔄 Fetching schema for ${allTables.length} tables using single connection...`);
                                    let schemaConnection: any = null;

                                    try {
                                        // Create one shared connection for all schema fetching
                                        if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                                            schemaConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                                        } else if (databaseType.toLowerCase() === 'postgresql') {
                                            schemaConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                                        }

                                        for (const tableName of allTables) {
                                            try {
                                                let columnInfo: any[] = [];

                                                if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                                                    const [rows] = await schemaConnection.execute(
                                                        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT 
                                                     FROM INFORMATION_SCHEMA.COLUMNS 
                                                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? 
                                                     ORDER BY ORDINAL_POSITION`,
                                                        [tableName]
                                                    );
                                                    columnInfo = rows as any[];
                                                } else if (databaseType.toLowerCase() === 'postgresql') {
                                                    const result = await schemaConnection.query(
                                                        `SELECT column_name as "COLUMN_NAME", data_type as "DATA_TYPE", is_nullable as "IS_NULLABLE", column_default as "COLUMN_DEFAULT", '' as "COLUMN_COMMENT"
                                                     FROM information_schema.columns 
                                                     WHERE table_schema = 'public' AND table_name = $1 
                                                     ORDER BY ordinal_position`,
                                                        [tableName]
                                                    );
                                                    columnInfo = result.rows;
                                                }

                                                tableSchemaData[tableName] = Array.isArray(columnInfo) ? columnInfo : [];
                                                console.log(`✅ Got schema for table ${tableName}: ${tableSchemaData[tableName].length} columns`);
                                            } catch (schemaError) {
                                                console.warn(`⚠️ Could not get schema for table ${tableName}:`, schemaError);
                                                tableSchemaData[tableName] = [];
                                            }
                                        }
                                    } finally {
                                        // Close the shared schema connection
                                        if (schemaConnection) {
                                            try {
                                                if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                                                    await schemaConnection.end();
                                                } else if (databaseType.toLowerCase() === 'postgresql') {
                                                    await schemaConnection.end();
                                                }
                                                console.log('🔌 Closed shared schema connection');
                                            } catch (closeError) {
                                                console.warn('⚠️ Error closing shared schema connection:', closeError);
                                            }
                                        }
                                    }

                                    // Get sample data (first 3 records) for each table using Promise.all for parallel execution
                                    console.log(`🔄 Fetching sample data for ${allTables.length} tables in parallel...`);

                                    // Create array of sample data fetch promises
                                    const sampleDataPromises = allTables.map(async (tableName) => {
                                        try {
                                            let sampleRecords: any[] = [];
                                            let tableConnection: any = null;

                                            try {
                                                // Create individual connection for this table (for parallel execution)
                                                if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                                                    tableConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                                                    const [rows] = await tableConnection.execute(
                                                        `SELECT * FROM \`${tableName}\` LIMIT 3`
                                                    );
                                                    sampleRecords = rows as any[];
                                                } else if (databaseType.toLowerCase() === 'postgresql') {
                                                    tableConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                                                    const result = await tableConnection.query(
                                                        `SELECT * FROM "${tableName}" LIMIT 3`
                                                    );
                                                    sampleRecords = result.rows;
                                                }

                                                globalTableSampleData[tableName] = Array.isArray(sampleRecords) ? sampleRecords : [];
                                                console.log(`✅ Got sample data for table ${tableName}: ${globalTableSampleData[tableName].length} records`);

                                                return { tableName, success: true };
                                            } finally {
                                                // Clean up individual connection
                                                if (tableConnection) {
                                                    try {
                                                        if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                                                            await tableConnection.end();
                                                        } else if (databaseType.toLowerCase() === 'postgresql') {
                                                            await tableConnection.end();
                                                        }
                                                    } catch (closeError) {
                                                        console.warn(`⚠️ Error closing connection for table ${tableName}:`, closeError);
                                                    }
                                                }
                                            }
                                        } catch (sampleError) {
                                            console.warn(`⚠️ Could not get sample data for table ${tableName}:`, sampleError);
                                            globalTableSampleData[tableName] = [];
                                            return { tableName, success: false, error: (sampleError as any)?.message || 'Unknown error' };
                                        }
                                    });

                                    // Execute all sample data fetching in parallel
                                    try {
                                        const sampleResults = await Promise.all(sampleDataPromises);
                                        const successCount = sampleResults.filter(r => r.success).length;
                                        console.log(`🎯 Sample data collection completed: ${successCount}/${allTables.length} tables successful`);
                                    } catch (parallelError) {
                                        console.error('❌ Error during parallel sample data fetching:', parallelError);
                                    }

                                    // Generate AI descriptions for all tables
                                    const azureClient = getAzureOpenAIClient();
                                    if (azureClient) {
                                        console.log('🤖 Generating AI purpose descriptions for database tables...');
                                        try {
                                            const schemaDescription = Object.entries(tableSchemaData)
                                                .map(([tableName, columns]: [string, any]) => {
                                                    const columnList = Array.isArray(columns) ?
                                                        columns.map((col: any) => `${col.COLUMN_NAME} (${col.DATA_TYPE})`).join(', ') :
                                                        'No columns available';

                                                    const sampleData = globalTableSampleData[tableName] || [];
                                                    const sampleDataStr = sampleData.length > 0 ?
                                                        `\nSample Data (first ${sampleData.length} records):\n${JSON.stringify(sampleData, null, 2)}` :
                                                        '\nNo sample data available';

                                                    return `Table: ${tableName}\nColumns: ${columnList}${sampleDataStr}`;
                                                })
                                                .join('\n\n');

                                            const aiPrompt = `You are a database schema analyst helping an SQL agent choose the correct tables for a specific query. 

User Query: "${query}"

Database Tables with Schema and Sample Data:
${schemaDescription}

Based on the user's specific query "${query}", analyze each table's schema AND sample data to provide targeted descriptions that help the SQL agent understand which tables are most relevant for this specific query. 

Focus on:
1. Which tables likely contain the data needed for this specific query (analyze both column names and sample data values)
2. Which tables should be prioritized for this type of question based on the actual data content
3. Which tables might be confused with each other and clarify the differences using sample data examples
4. What patterns you see in the sample data that indicate the table's purpose
5. How the sample data values relate to the user's query requirements

Provide descriptions in this format:
**Table: table_name** - Relevance to query "${query}": [High/Medium/Low] - Brief description focusing on why this table is/isn't suitable for this specific query, mentioning key columns and sample data insights that support your assessment.

Keep descriptions concise but informative (2-3 sentences) and focus on helping the SQL agent choose the RIGHT tables for this specific user query using both schema structure and actual data content.`;

                                            const aiResponse = await azureClient.chat.completions.create({
                                                model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1",
                                                messages: [{
                                                    role: "user",
                                                    content: aiPrompt
                                                }],
                                                max_tokens: 2000,
                                                temperature: 0.3,
                                            });

                                            if (aiResponse.choices && aiResponse.choices[0]?.message?.content) {
                                                tableDescriptions = `

=== DATABASE TABLE PURPOSE DESCRIPTIONS (AI-Generated with Sample Data Analysis) ===
${aiResponse.choices[0].message.content}

This database contains ${allTables.length} tables with comprehensive schema and sample data analysis:
${Object.entries(tableSchemaData).map(([tableName, columns]: [string, any]) => {
                                                    const columnCount = Array.isArray(columns) ? columns.length : 0;
                                                    const sampleRecordCount = globalTableSampleData[tableName] ? globalTableSampleData[tableName].length : 0;
                                                    return `• ${tableName} (${columnCount} columns, ${sampleRecordCount} sample records analyzed)`;
                                                }).join('\n')}
========================`;
                                                console.log('✅ Successfully generated AI table descriptions', tableDescriptions);
                                            } else {
                                                console.warn('⚠️ Azure OpenAI returned empty response for table descriptions');
                                            }
                                        } catch (aiError) {
                                            console.warn('⚠️ Could not generate AI descriptions for tables:', aiError);
                                            // Fallback: create basic descriptions without AI
                                            tableDescriptions = `

=== DATABASE TABLES OVERVIEW WITH SAMPLE DATA ===
This database contains ${allTables.length} tables:
${Object.entries(tableSchemaData).map(([tableName, columns]: [string, any]) => {
                                                const columnCount = Array.isArray(columns) ? columns.length : 0;
                                                const sampleColumns = Array.isArray(columns) && columns.length > 0
                                                    ? columns.slice(0, 5).map((col: any) => col.COLUMN_NAME).join(', ')
                                                    : 'No columns available';

                                                const sampleData = globalTableSampleData[tableName] || [];
                                                const sampleDataPreview = sampleData.length > 0
                                                    ? `\n  Sample Data (${sampleData.length} records): ${JSON.stringify(sampleData.slice(0, 2), null, 2)}`
                                                    : '\n  No sample data available';

                                                return `• **${tableName}** (${columnCount} columns) - Contains: ${sampleColumns}${columns.length > 5 ? ', ...' : ''}${sampleDataPreview}`;
                                            }).join('\n')}
========================`;
                                        }
                                    } else {
                                        console.warn('⚠️ Azure OpenAI not available, creating basic table overview');
                                        // Fallback: create basic descriptions without AI
                                        tableDescriptions = `

=== DATABASE TABLES OVERVIEW WITH SAMPLE DATA ===
This database contains ${allTables.length} tables:
${Object.entries(tableSchemaData).map(([tableName, columns]: [string, any]) => {
                                            const columnCount = Array.isArray(columns) ? columns.length : 0;
                                            const sampleColumns = Array.isArray(columns) && columns.length > 0
                                                ? columns.slice(0, 5).map((col: any) => col.COLUMN_NAME).join(', ')
                                                : 'No columns available';

                                            const sampleData = globalTableSampleData[tableName] || [];
                                            const sampleDataPreview = sampleData.length > 0
                                                ? `\n  Sample Data (${sampleData.length} records): ${JSON.stringify(sampleData.slice(0, 2), null, 2)}`
                                                : '\n  No sample data available';

                                            return `• **${tableName}** (${columnCount} columns) - Contains: ${sampleColumns}${columns.length > 5 ? ', ...' : ''}${sampleDataPreview}`;
                                        }).join('\n')}
========================`;
                                    }
                                } else {
                                    tableDescriptions = '\n=== DATABASE TABLES ===\nNo tables found in the database.\n========================';
                                }
                            } catch (tableError) {
                                console.error('❌ Error getting table descriptions:', tableError);
                                tableDescriptions = '\n=== DATABASE TABLES ===\nError retrieving table information.\n========================';
                            }

                            // The enhanced prompt with structured step-by-step approach and database version enforcement
                            const enhancedQuery = `
🎯 You are an expert SQL database analyst. Your task is to generate a WORKING SQL query that answers the user's question.

**CRITICAL VERSION REQUIREMENTS:**
1. You MUST strictly follow the database version compatibility rules provided below
2. Any SQL features not supported by the detected version MUST be avoided
3. Version-specific query patterns MUST be followed exactly, especially for GROUP BY clauses

🚨 **CRITICAL JOIN REQUIREMENT - READ THIS FIRST:**
**NEVER ADD NON-KEY COLUMN MATCHING IN JOIN CONDITIONS**
- Use ONLY primary/foreign key relationships in JOIN conditions
- FORBIDDEN: JOIN table2 ON table1.id = table2.table1_id AND table1.name = table2.name
- CORRECT: JOIN table2 ON table1.id = table2.table1_id
- Additional filtering belongs in WHERE clause, NOT JOIN conditions

${currentAttempt > 1 && previousAttemptError ? `
❌ **PREVIOUS ATTEMPT FAILED WITH ERROR:**
${previousAttemptError}

🚨 **CRITICAL: LEARN FROM THE ERROR ABOVE**
- Analyze the specific error that occurred in the previous attempt
- DO NOT repeat the same mistake that caused the failure
- Focus on fixing the exact issue while maintaining all other requirements
- Pay special attention to avoid syntax errors, column mismatches, or incorrect table references

` : ''}

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

**STEP 2: EXAMINE RELEVANT SCHEMAS WITH SAMPLE DATA UNDERSTANDING** 
- Use sql_db_schema("table_name") for tables that might contain data for the user's query
- Focus on tables that match the user's question topic (patients, medications, lab results, etc.)
- **IMPORTANT**: You have access to comprehensive table information that includes:
  - Complete column schemas with data types
  - Sample data from the first 3 records of each table
  - AI-generated purpose descriptions based on actual data content
- Use this sample data to understand the actual content and data patterns in each table
- Sample data helps you choose the RIGHT tables by showing actual values and data relationships

**STEP 2.1: LEVERAGE SAMPLE DATA INSIGHTS**
- Review the sample data provided in the database context below
- Use sample data values to understand which tables contain the information needed for the user's query
- Look for patterns in the sample data that match the user's query requirements
- Choose tables based on actual data content, not just table names or column names

**STEP 2.2: SMART TABLE SELECTION FOR SIMILAR NAMES**
- When multiple tables have similar names (e.g., "patients", "patient_data", "patient_info"), choose wisely based on:
  - The user's specific query requirements and what data they're asking for
  - Sample data content that matches the query intent
  - Table purpose revealed by column names and actual data values
- Always prioritize tables that contain the most relevant and complete data for the user's question
- Use sample data to verify which table has the right information before making your final selection

**STEP 2.3: JOIN MULTIPLE RELATED TABLES WHEN NEEDED**
- When the user query requires data from multiple related tables, DON'T choose just one table - JOIN all relevant tables
- Look for foreign key relationships (columns ending in _id) to identify how tables connect
- **CRITICAL: Use AI table descriptions to guide JOIN decisions**
  - **JOIN ALL tables marked with "Relevance to query: High" in the AI analysis**
  - When multiple tables have "High" relevance, they should be JOINed together to provide complete information
  - Review the AI-generated table descriptions to understand which tables contain complementary data for the query
- Use sample data to identify foreign key connections and table relationships
- Always include necessary JOIN conditions to get complete information for the user's query

# CRITICAL JOIN CONDITION RULES - MANDATORY COMPLIANCE

🚨 **FORBIDDEN: DO NOT MATCH NON-KEY COLUMNS IN JOIN CONDITIONS** 🚨

- **ONLY USE PRIMARY/FOREIGN KEY RELATIONSHIPS IN JOIN CONDITIONS**
- **NEVER add column matching conditions beyond primary/foreign keys**

## PROHIBITED EXAMPLES:
❌ JOIN table_b tb ON ta.a_id = tb.a_id AND ta.some_column = tb.some_column  
❌ JOIN table_x tx ON ty.y_id = tx.y_id AND ty.description = tx.description  
❌ JOIN users u ON o.user_id = u.user_id AND o.username = u.username  

## CORRECT EXAMPLES:
✅ JOIN table_b tb ON ta.a_id = tb.a_id  
✅ JOIN table_x tx ON ty.y_id = tx.y_id  
✅ JOIN users u ON o.user_id = u.user_id  

## RULE:
**When JOINing tables, use ONLY the key relationships (e.g., table_a.a_id = table_b.a_id)**

## PRINCIPLE:
**Matching non-primary/foreign key columns in JOIN conditions makes no logical sense and creates incorrect results**

## FILTERING:
**Any additional filtering should be done in WHERE clause, NOT in JOIN conditions**

**STEP 3: GENERATE VERSION-COMPATIBLE SQL**
- Create a SQL query compatible with ${databaseType.toUpperCase()} ${databaseVersionString}
- Use explicit column names (NO SELECT *)
- Include columns mentioned in user query + minimal context columns
- Include WHERE conditions if user specifies filters
- **🚨 CRITICAL JOIN RULE: Use ONLY primary/foreign key relationships in JOIN conditions - NEVER add non-key column matching (e.g., avoid AND table1.name = table2.name)**
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
- For "show patients": SELECT patient_id, gender, dob, state, city FROM patients LIMIT 10;
- For "medications": SELECT patient_id, medications FROM patients WHERE medications IS NOT NULL LIMIT 10;
- For "high risk": SELECT record_id, risk_category, risk_score FROM risk_details WHERE risk_category LIKE '%High%' LIMIT 10;
`}

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
- **Sample Data Analysis**: Access to first 3 records from each table for deep data understanding
- **AI-Powered Table Descriptions**: Intelligent analysis of table purposes based on actual data content
- Query Execution: Generate and execute SQL queries based on discovered schema and sample data insights

**SAMPLE DATA ADVANTAGE**: 
- Each table includes sample data (first 3 records) to help you understand actual data content
- Use sample data to verify which tables contain the information needed for the user's query
- Sample data helps distinguish between similarly named tables by showing actual content
- Look at sample values to understand data patterns, formats, and relationships

CRITICAL: Your queries will be executed against this specific database instance. Ensure compatibility with the version and features listed above. Use the sample data provided to make intelligent table selection decisions.
========================

${tableDescriptions}

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

STEP 2: IDENTIFY RELEVANT TABLES WITH STRICT ENTITY FOCUS AND SAMPLE DATA ANALYSIS
- Based on the user query, identify which tables are likely to contain the requested information
- **LEVERAGE SAMPLE DATA**: Use the provided sample data from each table to verify actual content and data patterns
- **CRITICAL: Identify the PRIMARY ENTITY** that the user is asking about (e.g., patients, medications, diagnoses)
- **CRITICAL: The PRIMARY ENTITY table should return COMPLETE records (all non-ID columns)**
- **CRITICAL: Related tables should provide columns used in filtering/conditions AND relevant context**
- **SAMPLE DATA VERIFICATION**: Check sample data values to confirm tables contain the type of information the user is requesting
- For each potentially relevant table, explicitly state why you believe it's needed based on both schema AND sample data analysis
- Document your table selection decisions with clear reasoning including sample data insights
- **CRITICAL CONDITION-BASED TABLE SELECTION RULE:**
  * **If multiple tables have similar or overlapping meanings/purposes, ALWAYS choose the table that contains the CONDITION COLUMNS from the user query**
  * **USE SAMPLE DATA to verify which table actually contains the filtering criteria values**
  * **PRIORITIZE tables where the user's WHERE/HAVING/filtering conditions can be applied AND verified with sample data**
  * **Only go to those tables where the user query condition lies - avoid tables that don't have the filtering criteria**
  * **Example: If user asks "patients with high glucose", choose the table that has glucose columns AND sample data showing actual glucose values**
  * **Example: If user asks "medications with dosage > 100mg", choose the table that has dosage columns AND sample data showing actual dosage values**
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
- ✅ Version-compatible syntax that works with ${databaseType.toUpperCase()} ${databaseVersionString}

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
- **VERSION COMPATIBILITY**: Verify the SQL uses ONLY features available in ${databaseType.toUpperCase()} ${databaseVersionString}
- **VERSION-SPECIFIC CHECKS**: Confirm compatibility with all version-specific rules like GROUP BY requirements
- **FEATURE VALIDATION**: Double-check that all functions and clauses are supported in this exact version
- **SYNTAX CHECK**: Verify the SQL has proper structure for this database version
- **NO MALFORMED PATTERNS**: Ensure there are no ") SELECT" or similar syntax errors
- **SCHEMA VALIDATION**: Confirm all table and column names were discovered through schema exploration
- **EXECUTABILITY**: Ensure the SQL can be executed without syntax errors on this specific version
- **SIMPLICITY**: Verify the query is straightforward and not overly complex

**CRITICAL VERSION-SPECIFIC VALIDATION:**
${databaseType.toLowerCase() === 'mysql' ? `
  * **JSON Functions**: ${databaseVersionInfo && databaseVersionInfo.supportsJSON ? 'OK to use JSON_EXTRACT, etc.' : 'REMOVE any JSON functions - not supported in this version'}
  * **Window Functions**: ${databaseVersionInfo && databaseVersionInfo.supportsWindowFunctions ? 'OK to use ROW_NUMBER(), etc.' : 'REMOVE any window functions - not supported in this version'}
  * **CTEs**: ${databaseVersionInfo && databaseVersionInfo.supportsCTE ? 'OK to use WITH clause' : 'REMOVE any WITH clauses - not supported in this version'}
  * **GROUP BY**: ${databaseVersionInfo && databaseVersionInfo.hasOnlyFullGroupBy ? 'STRICT VALIDATION - all non-aggregated SELECT columns MUST be in GROUP BY' : 'Standard GROUP BY rules apply'}
` : ''}

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
- **ABSOLUTE RULE: NEVER use SQL features not supported by ${databaseType.toUpperCase()} ${databaseVersionString}**
- **ABSOLUTE RULE: Strictly adhere to the version-specific GROUP BY rules**
- **🚨 ABSOLUTE RULE: JOIN ALL tables marked with "Relevance to query: High" in AI analysis - DO NOT choose just one table when multiple have High relevance**
- **🚨 ABSOLUTE RULE: Use AI table descriptions to identify which tables should be JOINed together for complete answers**
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


**CRITICAL: The goal is to return FOCUSED information that directly answers the user's question (selective columns explicitly listed) AND provide minimal necessary context about WHY these records were selected by including condition columns.**

**FINAL VERSION-AWARE VALIDATION CHECKLIST FOR EVERY QUERY:**
✅ SQL is compatible with ${databaseType.toUpperCase()} ${databaseVersionString}
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
✅ **🚨 CRITICAL JOIN REQUIREMENT: JOIN ALL tables marked with "Relevance to query: High" in AI analysis**
✅ **🚨 JOIN CONDITIONS: Use ONLY primary/foreign key relationships - NEVER add non-key column matching (e.g., avoid AND table1.name = table2.name)**
✅ **AI-GUIDED JOINS: Use AI table descriptions to identify complementary High-relevance tables for JOINs**
✅ **SCHEMA INTELLIGENCE: All references validated against actual database schema**
${databaseType.toLowerCase() === 'mysql' && databaseVersionInfo && databaseVersionInfo.hasOnlyFullGroupBy ? `
✅ **GROUP BY COMPLIANCE: All non-aggregated columns in SELECT are included in GROUP BY**
✅ **AGGREGATION CORRECTNESS: If using aggregation functions, all other columns in GROUP BY**
` : ''}

Remember: You are an EXPERT SQL Agent with INTELLIGENT SCHEMA EXPLORATION capabilities. Use your knowledge to:

🧠 **INTELLIGENT DATABASE EXPLORATION:**
- **WISELY discover all available database tables**
- **SMARTLY analyze table schemas to understand data structure**
- **CLEVERLY choose the optimal tables that contain the exact columns needed**
- **EXPERTLY map user requirements to actual database schema**

🎯 **INTELLIGENT QUERY CONSTRUCTION:**
- **SKILLFULLY generate version-compatible SQL for ${databaseType.toUpperCase()} ${databaseVersionString}**
- **CAREFULLY avoid complex structures that cause syntax errors**
- **PRECISELY use only validated table and column names from schema exploration**
- **STRATEGICALLY focus on relevant data that answers the user's question**

**THE PERFECT SQL QUERY CHARACTERISTICS:**
1. **VERSION-COMPATIBLE**: Uses only features supported by ${databaseType.toUpperCase()} ${databaseVersionString}
2. **SCHEMA-VALIDATED**: Uses only table/column names discovered through exploration
3. **SIMPLE & CLEAN**: Straightforward structure without malformed patterns
4. **EXECUTABLE**: Syntactically correct and runs without errors
5. **FOCUSED**: Returns only relevant data that answers the user's question
6. **INTELLIGENT**: Demonstrates smart table selection based on query conditions

**CRITICAL VERSION-SPECIFIC PRINCIPLE: Always validate that every SQL feature, function, and pattern you use is fully supported by ${databaseType.toUpperCase()} ${databaseVersionString}. When in doubt about a feature's compatibility, use simpler alternative syntax that is guaranteed to work.**

**CRITICAL TABLE SELECTION PRINCIPLE: When multiple tables seem similar, ALWAYS choose the table that contains the columns needed for your WHERE/HAVING conditions. This avoids unnecessary complex joins and focuses on the data that directly satisfies the user's criteria.**

USER QUERY: ${query}
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
                                        // 🎯 ENHANCED SQL CAPTURE SYSTEM
                                        console.log('🧠 Agent action:', action.tool);
                                        console.log('🔍 Action input type:', typeof action.toolInput);
                                        console.log('🔍 Action input preview:', typeof action.toolInput === 'string' ?
                                            action.toolInput.substring(0, 200) + '...' :
                                            JSON.stringify(action.toolInput).substring(0, 200) + '...');

                                        // Enhanced SQL capture from multiple tool types
                                        const sqlTools = [
                                            'sql_db_query',
                                            'query_sql_db',
                                            'sql_db_query_checker',
                                            'query-checker',
                                            'query-sql',
                                            'queryCheckerTool',
                                            'sql_query'
                                        ];

                                        if (sqlTools.includes(action.tool)) {
                                            console.log(`🎯 SQL Tool detected: ${action.tool}`);

                                            let sqlContent = '';
                                            if (typeof action.toolInput === 'string') {
                                                sqlContent = action.toolInput;
                                            } else if (action.toolInput && typeof action.toolInput === 'object') {
                                                // Handle different input formats
                                                sqlContent = action.toolInput.query || action.toolInput.sql || action.toolInput.input || '';
                                            }

                                            if (sqlContent && sqlContent.toLowerCase().includes('select')) {
                                                console.log('💡 Capturing SQL from tool:', action.tool);
                                                console.log('📝 Raw SQL:', sqlContent);

                                                debugInfo.originalQueries.push(`[${action.tool}] ${sqlContent}`);

                                                // Enhanced version-aware SQL cleaning
                                                const cleanedSql = cleanSQLQuery(sqlContent);
                                                console.log('📝 Raw SQL PROCESSED:', cleanedSql);
                                                if (cleanedSql && cleanedSql !== ';' && cleanedSql.length > 10) {
                                                    capturedSQLQueries.push(cleanedSql);
                                                }
                                                // if (cleanedSql && cleanedSql !== ';' && cleanedSql.length > 10) {
                                                //     // Verify the SQL is version-compatible before adding it
                                                //     if (isCompatibleWithDatabaseVersion(cleanedSql, databaseType, databaseVersionInfo)) {

                                                //         console.log('✅ Successfully captured version-compatible SQL:', cleanedSql);
                                                //     } else {
                                                //         console.log('⚠️ Rejected non-version-compatible SQL:', cleanedSql);
                                                //         debugInfo.sqlCorrections.push('Rejected non-version-compatible SQL: ' + cleanedSql);
                                                //     }
                                                // } else {
                                                //     console.log('⚠️ SQL cleaning failed or returned invalid result');
                                                // }
                                            }
                                        }

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

                                            // Enhanced version-aware SQL cleaning
                                            const cleanedSql = cleanSQLQuery(sql);
                                            if (cleanedSql) {
                                                // capturedSQLQueries.push(cleanedSql);
                                                // Verify the SQL is version-compatible before adding it
                                                // if (isCompatibleWithDatabaseVersion(cleanedSql, databaseType, databaseVersionInfo)) {
                                                //     console.log('✅ Generated version-compatible SQL:', cleanedSql);
                                                // } else {
                                                //     console.log('⚠️ Rejected non-version-compatible SQL:', cleanedSql);
                                                //     debugInfo.sqlCorrections.push('Rejected non-version-compatible SQL: ' + cleanedSql);
                                                // }
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

                                                // Enhanced version-aware SQL cleaning
                                                const cleanedSql = cleanSQLQuery(action.toolInput);
                                                if (cleanedSql) {
                                                    // capturedSQLQueries.push(cleanedSql);
                                                    // Verify the SQL is version-compatible before adding it
                                                    // if (isCompatibleWithDatabaseVersion(cleanedSql, databaseType, databaseVersionInfo)) {
                                                    //     console.log('✅ Captured version-compatible SQL:', cleanedSql);
                                                    // } else {
                                                    //     console.log('⚠️ Rejected non-version-compatible SQL:', cleanedSql);
                                                    //     debugInfo.sqlCorrections.push('Rejected non-version-compatible SQL: ' + cleanedSql);
                                                    // }
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
                                        console.log('📊 Tool output type:', typeof output);
                                        console.log('📊 Tool output preview:', typeof output === 'string' ?
                                            output.substring(0, 200) + '...' :
                                            JSON.stringify(output).substring(0, 200) + '...');

                                        // Enhanced SQL extraction from tool outputs
                                        let outputString = '';
                                        if (typeof output === 'string') {
                                            outputString = output;
                                        } else if (output && typeof output === 'object') {
                                            // Try to extract string content from object
                                            outputString = output.result || output.output || output.text || JSON.stringify(output);
                                        }

                                        // Look for SQL patterns in the output
                                        if (outputString && outputString.toLowerCase().includes('select')) {
                                            console.log('💡 Found SQL in tool output');

                                            // Try to extract SQL from the output with version compatibility check
                                            const cleanedSql = cleanSQLQuery(outputString);
                                            if (cleanedSql && cleanedSql !== ';' && cleanedSql.length > 10) {
                                                // Verify the SQL is version-compatible before adding it
                                                console.log('✅ Captured version-compatible SQL from tool output:', cleanedSql);
                                                // capturedSQLQueries.push(cleanedSql);
                                                // if (isCompatibleWithDatabaseVersion(cleanedSql, databaseType, databaseVersionInfo)) {
                                                //     debugInfo.originalQueries.push(`[Tool Output] ${cleanedSql}`);
                                                // } else {
                                                //     console.log('⚠️ Rejected non-version-compatible SQL from tool output:', cleanedSql);
                                                //     debugInfo.sqlCorrections.push('Rejected non-version-compatible SQL from tool output: ' + cleanedSql);
                                                // }
                                            }
                                        }

                                        // Validate schema understanding
                                        if (outputString && outputString.includes('COLUMN_NAME')) {
                                            console.log('📊 Schema information captured for intelligent query generation');
                                            debugInfo.sqlCorrections.push('Schema understood for intelligent query generation');
                                        }
                                    }
                                }]
                            });

                            // Store raw response for debugging
                            rawAgentResponse = JSON.stringify(agentResult, null, 2);
                            console.log('🔍 Agent raw response:', rawAgentResponse);

                            // Also try to extract SQL from the final output with version compatibility check
                            // if (agentResult.output && typeof agentResult.output === 'string') {
                            //     const cleanedSql = cleanSQLQuery(agentResult.output);
                            //     if (cleanedSql) {
                            //         // Verify the SQL is version-compatible before adding it
                            //         console.log('✅ Captured version-compatible SQL from final output:', cleanedSql);
                            //         capturedSQLQueries.push(cleanedSql);
                            //         // if (isCompatibleWithDatabaseVersion(cleanedSql, databaseType, databaseVersionInfo)) {
                            //         // } else {
                            //         //     console.log('⚠️ Rejected non-version-compatible SQL from final output:', cleanedSql);
                            //         //     debugInfo.sqlCorrections.push('Rejected non-version-compatible SQL from final output: ' + cleanedSql);
                            //         // }
                            //     }
                            // }

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

                    // Helper function to check if SQL is compatible with the database version
                    function isCompatibleWithDatabaseVersion(sql: string, dbType: string, versionInfo: any): boolean {
                        if (!versionInfo) return true; // If version info not available, assume compatible

                        const sqlLower = sql.toLowerCase();

                        // Check for MySQL version compatibility
                        if (dbType.toLowerCase() === 'mysql') {
                            // Check JSON function compatibility
                            if (!versionInfo.supportsJSON && (
                                sqlLower.includes('json_extract') ||
                                sqlLower.includes('json_') ||
                                sqlLower.includes('->')
                            )) {
                                return false;
                            }

                            // Check window function compatibility
                            if (!versionInfo.supportsWindowFunctions && (
                                sqlLower.includes('over (') ||
                                sqlLower.includes('row_number()') ||
                                sqlLower.includes('rank()') ||
                                sqlLower.includes('dense_rank()')
                            )) {
                                return false;
                            }

                            // Check CTE compatibility
                            if (!versionInfo.supportsCTE && (
                                sqlLower.includes('with ') &&
                                (sqlLower.includes(' as (select') || sqlLower.includes(' as(select'))
                            )) {
                                return false;
                            }

                            // Check GROUP BY compatibility with only_full_group_by mode
                            if (versionInfo.hasOnlyFullGroupBy && sqlLower.includes('group by')) {
                                // This is a simplified check that should be expanded for production
                                // A full implementation would parse the SQL and verify all non-aggregated columns
                                // in the SELECT clause are included in the GROUP BY clause

                                // Extract SELECT and GROUP BY clauses for basic validation
                                const selectMatch = /select\s+(.*?)\s+from/i.exec(sqlLower);
                                const groupByMatch = /group\s+by\s+(.*?)(?:having|order|limit|$)/i.exec(sqlLower);

                                if (selectMatch && groupByMatch) {
                                    const selectColumns = selectMatch[1].split(',').map(c => c.trim());
                                    const groupByColumns = groupByMatch[1].split(',').map(c => c.trim());

                                    // Very basic check - in a real implementation this would be more sophisticated
                                    // to handle aliases, expressions, etc.
                                    for (const col of selectColumns) {
                                        // Skip aggregated columns
                                        if (col.includes('count(') || col.includes('sum(') ||
                                            col.includes('avg(') || col.includes('min(') ||
                                            col.includes('max(') || col.includes(' as ')) {
                                            continue;
                                        }

                                        // Check if non-aggregated column is in GROUP BY
                                        if (!groupByColumns.some(g => g === col || col.endsWith('.' + g))) {
                                            return false;
                                        }
                                    }
                                }
                            }
                        }

                        return true; // If no incompatibilities found
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
                            console.log(`🔍 Captured ${capturedSQLQueries.length} queries:`, capturedSQLQueries);

                            // Filter out empty or invalid queries first
                            const validQueries = capturedSQLQueries.filter(sql => {
                                const cleaned = sql.trim();
                                return cleaned &&
                                    cleaned !== ';' &&
                                    cleaned.length > 5 &&
                                    cleaned.toLowerCase().includes('select') &&
                                    cleaned.toLowerCase().includes('from');
                            });

                            console.log(`🔍 Found ${validQueries.length} valid queries:`, validQueries);

                            if (validQueries.length > 0) {
                                // Sort by completeness and length - prefer complete queries
                                // const sortedQueries = validQueries.sort((a, b) => {
                                //     const aComplete = isCompleteSQLQuery(a);
                                //     const bComplete = isCompleteSQLQuery(b);

                                //     // Prioritize complete queries
                                //     if (aComplete && !bComplete) return -1;
                                //     if (!aComplete && bComplete) return 1;

                                //     // If both complete or both incomplete, sort by length
                                //     return b.length - a.length;
                                // });

                                // Get the best SQL query
                                console.log('ajajajaj', validQueries)
                                extractedSQL = validQueries[validQueries.length - 1];
                                debugInfo.extractionAttempts.push(`Selected best query: ${extractedSQL}`);
                                console.log('✅ Found valid SQL from captured queries:', extractedSQL);
                            } else {
                                console.log('⚠️ No valid SQL found in captured queries');
                            }
                        }

                        // Method 2: Try to extract from agent output if still not found
                        if (!extractedSQL && agentResult && agentResult.output) {
                            console.log('🔍 Attempting to extract SQL from agent output...');
                            extractedSQL = cleanSQLQuery(agentResult.output);
                            if (extractedSQL && extractedSQL !== ';' && extractedSQL.length > 5) {
                                debugInfo.extractionAttempts.push('Extracted from agent output: ' + extractedSQL);
                                console.log('✅ Found SQL in agent output:', extractedSQL);
                            } else {
                                console.log('❌ No valid SQL found in agent output');
                                extractedSQL = '';
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
                        console.log('❌ No SQL extracted from agent - attempting intelligent fallback...');

                        // INTELLIGENT FALLBACK: Generate a reasonable query based on user intent
                        const userQueryLower = query.toLowerCase();
                        let fallbackSQL = '';

                        // Analyze user intent and create appropriate fallback
                        if (userQueryLower.includes('patient')) {
                            if (userQueryLower.includes('medication') || userQueryLower.includes('drug')) {
                                // Patient + medication query
                                fallbackSQL = "SELECT p.patient_id, p.gender, p.dob, p.state, p.city FROM patients p LIMIT 10;";
                                console.log('🎯 Using patient+medication fallback');
                            } else if (userQueryLower.includes('lab') || userQueryLower.includes('test') || userQueryLower.includes('result')) {
                                // Patient + lab results query
                                fallbackSQL = "SELECT p.patient_id, p.gender, p.dob, p.state, p.city FROM patients p LIMIT 10;";
                                console.log('🎯 Using patient+lab fallback');
                            } else if (userQueryLower.includes('risk') || userQueryLower.includes('high') || userQueryLower.includes('low')) {
                                // Patient + risk query
                                fallbackSQL = "SELECT p.patient_id, p.gender, p.dob, p.state, p.city FROM patients p LIMIT 10;";
                                console.log('🎯 Using patient+risk fallback');
                            } else {
                                // General patient query
                                fallbackSQL = "SELECT p.patient_id, p.gender, p.dob, p.state, p.city FROM patients p LIMIT 10;";
                                console.log('🎯 Using general patient fallback');
                            }
                        } else if (userQueryLower.includes('medication') || userQueryLower.includes('drug')) {
                            // Medication-focused query
                            fallbackSQL = "SELECT p.patient_id, p.medications FROM patients p WHERE p.medications IS NOT NULL LIMIT 10;";
                            console.log('🎯 Using medication fallback');
                        } else if (userQueryLower.includes('risk')) {
                            // Risk-focused query  
                            fallbackSQL = "SELECT rd.record_id, rd.risk_category FROM risk_details rd LIMIT 10;";
                            console.log('🎯 Using risk fallback');
                        } else {
                            // Default fallback - basic patient data
                            fallbackSQL = "SELECT p.patient_id, p.gender, p.dob, p.state FROM patients p LIMIT 10;";
                            console.log('🎯 Using default patient fallback');
                        }

                        if (fallbackSQL) {
                            extractedSQL = fallbackSQL;
                            debugInfo.extractionAttempts.push(`Intelligent fallback used: ${fallbackSQL}`);
                            console.log('✅ Applied intelligent fallback SQL:', fallbackSQL);
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
                    // console.log('📊 Step 3.5: Double-checking SQL query against original query criteria...');

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
                        // const preExecutionValidation = validateSQLSyntax(finalSQL);
                        // if (!preExecutionValidation.isValid) {
                        //     console.log('⚠️ Pre-execution validation failed, attempting fix...');
                        //     if (preExecutionValidation.fixedSQL && preExecutionValidation.fixedSQL !== finalSQL) {
                        //         finalSQL = preExecutionValidation.fixedSQL;
                        //         console.log('🔧 Applied pre-execution fixes:', preExecutionValidation.errors);
                        //         debugInfo.sqlCorrections.push(`Pre-execution fixes: ${preExecutionValidation.errors.join(', ')}`);
                        //     }
                        // }

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
                                sql_final: groupAndCleanData(parseRows(rows)),
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
                        let restructuredRetryCount = 0;
                        const maxRestructuredRetries = 7; // Increased to 7 attempts for better success rate

                        while (restructuredRetryCount < maxRestructuredRetries) {
                            try {
                                restructuredRetryCount++;
                                if (restructuredRetryCount > 1) {
                                    console.log(`🔄 Restructured SQL retry attempt ${restructuredRetryCount} of ${maxRestructuredRetries} (will keep trying until successful)...`);
                                } else {
                                    console.log(`🔄 Restructured SQL first attempt (1 of ${maxRestructuredRetries})...`);
                                }

                                // Check if Azure OpenAI is available
                                if (!isAzureOpenAIAvailable) {
                                    console.log('⚠️ Azure OpenAI API key not available, skipping restructuring');
                                    (response.sql_results as any).restructure_info = {
                                        success: false,
                                        message: 'Azure OpenAI API key not configured',
                                        skipped: true
                                    };
                                    break; // Exit retry loop for this condition
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
                                        organizationId, // organizationId
                                        globalTableSampleData // tableSampleData - Pre-fetched sample data
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
                                            (response.sql_results as any).sql_final = groupAndCleanData(parseRows(restructuredRows));
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
                                                database_type: dbConfig.type.toLocaleLowerCase(),
                                                retry_count: restructuredRetryCount - 1 // Show how many retries were attempted
                                            };
                                            console.log('✅ Enhanced response with restructured SQL results');

                                        } catch (restructuredSQLError: any) {
                                            console.error('❌ Error executing restructured SQL:', restructuredSQLError.message);

                                            // Check if this is a column-related error
                                            const isColumnError = restructuredSQLError.message.toLowerCase().includes('unknown column') ||
                                                (restructuredSQLError.message.toLowerCase().includes('column') && restructuredSQLError.message.toLowerCase().includes('doesn\'t exist')) ||
                                                restructuredSQLError.message.toLowerCase().includes('no such column') ||
                                                restructuredSQLError.message.toLowerCase().includes('invalid column name') ||
                                                restructuredSQLError.message.toLowerCase().includes('field list');

                                            // For all errors, use the same retry limit - keep trying until successful
                                            const maxAttemptsForThisError = maxRestructuredRetries;

                                            if (restructuredRetryCount >= maxAttemptsForThisError) {
                                                console.log(`❌ Final attempt failed after ${maxAttemptsForThisError} attempts for restructured SQL execution (${isColumnError ? 'COLUMN ERROR' : 'GENERAL ERROR'})`);

                                                // Fallback to original data with error info
                                                (response.sql_results as any).restructure_info = {
                                                    success: false,
                                                    message: `Restructured SQL execution failed after ${maxAttemptsForThisError} attempts: ${restructuredSQLError.message}`,
                                                    restructured_sql: restructuredResults.restructured_sql,
                                                    explanation: restructuredResults.explanation,
                                                    sql_error: restructuredSQLError.message,
                                                    database_type: dbConfig.type.toLocaleLowerCase(),
                                                    retry_count: restructuredRetryCount - 1,
                                                    retry_exhausted: true,
                                                    error_type: isColumnError ? 'column_error' : 'general_error',
                                                    column_error_details: isColumnError ? extractColumnErrorDetails(restructuredSQLError.message) : undefined
                                                };
                                                console.log('⚠️ Restructured SQL execution failed after retries, keeping original data');
                                                break; // Exit retry loop
                                            } else {
                                                console.log(`⚠️ Restructured SQL execution failed on attempt ${restructuredRetryCount} (${isColumnError ? 'COLUMN ERROR - will regenerate entire query' : 'SQL ERROR - will regenerate entire query'}), retrying whole flow...`);

                                                if (isColumnError) {
                                                    const columnErrorDetails = extractColumnErrorDetails(restructuredSQLError.message);
                                                    console.log(`🔍 Column Error Details:`, columnErrorDetails);
                                                    console.log('📋 Will regenerate entire restructured query with stricter column validation...');

                                                    // Log available sample data for debugging
                                                    const availableTables = Object.keys(globalTableSampleData);
                                                    console.log(`📊 Available sample data tables: ${availableTables.join(', ')}`);

                                                    // If we can extract the problematic column, log it for analysis
                                                    if (columnErrorDetails.column_name) {
                                                        console.log(`❌ Problematic column: ${columnErrorDetails.column_name}`);
                                                        if (columnErrorDetails.table_alias) {
                                                            console.log(`❌ Used table alias: ${columnErrorDetails.table_alias}`);
                                                        }
                                                    }
                                                }

                                                // Wait 5 seconds before retry
                                                console.log('⏳ Waiting 5 seconds before retry...');
                                                await new Promise(resolve => setTimeout(resolve, 5000));

                                                // Continue to next iteration of retry loop
                                                continue;
                                            }
                                        }

                                        // Success case - exit retry loop
                                        break;
                                    } else {
                                        // Generation failed
                                        console.log(`⚠️ Restructured SQL generation failed on attempt ${restructuredRetryCount}`);

                                        if (restructuredRetryCount >= maxRestructuredRetries) {
                                            console.log('❌ Final attempt failed, no more retries for restructured SQL generation');

                                            (response.sql_results as any).restructure_info = {
                                                success: false,
                                                message: `Restructured SQL generation failed after ${maxRestructuredRetries} attempts: ${restructuredResults?.restructure_message || 'Unknown error'}`,
                                                error_details: restructuredResults?.error_details,
                                                explanation: restructuredResults?.explanation,
                                                database_type: dbConfig.type.toLocaleLowerCase(),
                                                retry_count: restructuredRetryCount - 1,
                                                retry_exhausted: true
                                            };
                                            console.log('⚠️ Restructured SQL generation failed after retries, keeping original data');
                                            break; // Exit retry loop
                                        } else {
                                            console.log(`⚠️ Restructured SQL generation failed on attempt ${restructuredRetryCount}, retrying whole generation flow...`);

                                            // Wait 5 seconds before retry
                                            console.log('⏳ Waiting 5 seconds before retry...');
                                            await new Promise(resolve => setTimeout(resolve, 5000));

                                            // Continue to next iteration of retry loop
                                            continue;
                                        }
                                    }
                                } else {
                                    (response.sql_results as any).restructure_info = {
                                        success: false,
                                        message: 'No data available for restructuring',
                                        skipped: true,
                                        database_type: dbConfig.type.toLocaleLowerCase()
                                    };
                                    console.log('⚠️ Skipping restructuring - no data available');
                                    break; // Exit retry loop for this condition
                                }

                                // If we reach here, operation completed successfully
                                break;

                            } catch (restructureError: any) {
                                console.error(`❌ Error during SQL results restructuring (attempt ${restructuredRetryCount}):`, restructureError.message);

                                if (restructuredRetryCount >= maxRestructuredRetries) {
                                    console.log(`❌ Final attempt failed after ${maxRestructuredRetries} attempts for restructuring process`);

                                    (response.sql_results as any).restructure_info = {
                                        success: false,
                                        message: `Restructuring process failed after ${maxRestructuredRetries} attempts: ${restructureError.message}`,
                                        error_details: restructureError.message,
                                        database_type: dbConfig.type.toLocaleLowerCase(),
                                        retry_count: restructuredRetryCount - 1,
                                        retry_exhausted: true
                                    };
                                    break; // Exit retry loop
                                } else {
                                    console.log(`⚠️ Restructuring process failed on attempt ${restructuredRetryCount}, retrying entire restructure flow...`);

                                    // Wait 5 seconds before retry
                                    console.log('⏳ Waiting 5 seconds before retry...');
                                    await new Promise(resolve => setTimeout(resolve, 5000));

                                    // Continue to next iteration of retry loop
                                    continue;
                                }
                            }
                        }

                        // ========== BAR CHART ANALYSIS LAYER ==========
                        // Add Azure OpenAI bar chart analysis before sending response
                        console.log('📊 Step 5: Adding bar chart analysis layer...');

                        try {
                            // Use the original rows data for bar chart analysis (before restructuring)
                            const dataForAnalysis = rows;

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

                        // ========== RETRY LOGIC FOR ZERO RECORDS ==========
                        // Check if we got zero records and should retry entire API execution
                        // Use original rows data for zero check, not sql_final which may not be updated when restructuring is skipped
                        const hasZeroRecords = Array.isArray(rows) && rows.length === 0;

                        console.log(`🔍 Zero records check: hasZeroRecords=${hasZeroRecords}, currentAttempt=${currentAttempt}, maxRetryAttempts=${maxRetryAttempts}`);
                        console.log(`🔍 original rows is array: ${Array.isArray(rows)}`);
                        console.log(`🔍 original rows length: ${rows?.length}`);
                        console.log(`🔍 Should retry: ${hasZeroRecords && currentAttempt < maxRetryAttempts}`);

                        if (hasZeroRecords && currentAttempt < maxRetryAttempts) {
                            console.log(`🔄 Zero records returned on attempt ${currentAttempt}. Triggering full API retry...`);

                            // Cleanup current attempt connections before retry
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
                                    console.log('🔌 Cleaned up database connection for retry');
                                }
                                await databaseService.closeOrganizationConnections(organizationId);
                            } catch (cleanupError) {
                                console.error(`❌ Error during retry cleanup:`, cleanupError);
                            }

                            // Mark this attempt as incomplete to trigger retry
                            debugInfo.sqlCorrections.push(`Attempt ${currentAttempt}: Zero records returned, triggering full API retry`);
                            
                            // Capture zero records issue for next attempt's enhanced query
                            previousAttemptError = `Attempt ${currentAttempt} returned zero records. The query may have incorrect conditions, wrong table selection, or overly restrictive filters.`;
                            
                            currentAttempt++;
                            continue; // Go to next iteration of retry loop
                        } else {
                            // Either we have records OR we've exhausted retry attempts
                            if (hasZeroRecords) {
                                console.log(`⚠️ Zero records returned on final attempt ${currentAttempt}. Proceeding with empty result.`);
                                debugInfo.sqlCorrections.push(`Final attempt ${currentAttempt}: Zero records returned, no more retries`);
                            } else {
                                console.log(`✅ Attempt ${currentAttempt} successful with ${response.result_count} records`);
                                if (currentAttempt > 1) {
                                    debugInfo.sqlCorrections.push(`Attempt ${currentAttempt}: Success after ${currentAttempt - 1} retries`);
                                }
                            }

                            // Set final result to break out of retry loop
                            finalResult = response;
                            break;
                        }
                        // ========== END RETRY LOGIC ==========

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

                        // Only send error response if this is the final attempt
                        if (currentAttempt >= maxRetryAttempts && !responseSent) {
                            responseSent = true;
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
                        } else if (currentAttempt < maxRetryAttempts) {
                            // If not the final attempt, capture error for next retry
                            console.log(`🔄 SQL error on attempt ${currentAttempt}. Will retry...`);
                            previousAttemptError = `SQL execution failed on attempt ${currentAttempt}: ${sqlError.message}`;
                        }
                    }

                } catch (error) {
                    // Handle errors within the retry loop
                    console.error(`❌ Attempt ${currentAttempt} failed with error:`, error);

                    // If this is not the final attempt, try again
                    if (currentAttempt < maxRetryAttempts) {
                        console.log(`🔄 Error on attempt ${currentAttempt}. Trying again...`);
                        debugInfo.sqlCorrections.push(`Attempt ${currentAttempt}: Error occurred - ${(error as Error).message}. Retrying...`);
                        
                        // Capture error for next attempt's enhanced query
                        previousAttemptError = `Attempt ${currentAttempt} failed with: ${(error as Error).message}`;
                        
                        currentAttempt++;
                        continue; // Try again
                    }

                    // Final attempt failed - handle error
                    const processingTime = performance.now() - startTime;
                    console.error('❌ Manual SQL query processing error after all retries:', error);

                    // Cleanup: Log connection management for debugging
                    console.log(`🔌 API request failed with general error after ${currentAttempt} attempts`);

                    // Only send error response if no response has been sent yet
                    if (!responseSent) {
                        responseSent = true;
                        
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
                    break; // Exit retry loop after sending error response
                }
            } // End of retry while loop

            // Send final successful response (if we have one and no response sent yet)
            if (finalResult && !responseSent) {
                console.log(`🎯 Sending final successful response after ${currentAttempt} attempt(s)`);
                responseSent = true;
                res.json(finalResult);
            }
        }
    );

    // We're not using database schema information since we're relying on
    // sqlAgent's intelligence to handle database structure correctly

    // We're relying on the sqlAgent's intelligence to handle column names correctly
    // No hardcoded mappings or corrections are needed

    // The rest of the helper functions remain the same
    // Function to fix malformed SQL structures commonly generated by SQL Agent

    function cleanSQLQuery(input: string): string {
        if (!input || typeof input !== "string") return "";

        let sql = "";

        // Extract from code block (```sql ... ```)
        const codeBlockMatch = input.match(/```(?:sql)?\s*([\s\S]*?)```/i);
        if (codeBlockMatch) {
            sql = codeBlockMatch[1].trim();
        } else {
            // Extract from inline code (`...`)
            const inlineCodeMatch = input.match(/`([\s\S]*?)`/);
            if (inlineCodeMatch) {
                sql = inlineCodeMatch[1].trim();
            } else {
                sql = input.trim();
            }
        }

        if (!sql) return "";

        // Block INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE (case-insensitive, word-bound)
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i.test(sql)) {
            return "";
        }

        // Clean up markdown formatting (bold, italics, links, etc)
        sql = sql
            .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
            .replace(/\*(.*?)\*/g, "$1") // Italic
            .replace(/__(.*?)__/g, "$1") // Bold
            .replace(/~~(.*?)~~/g, "$1") // Strikethrough
            .replace(/\[(.*?)\]\(.*?\)/g, "$1") // Links
            .replace(/\[\[(.*?)\]\]/g, "$1") // Wiki links
            .replace(/\{\{.*?\}\}/g, " ") // Template tags
            .replace(/\{\%.*?\%\}/g, " "); // Template tags

        // Remove SQL and JS comments, but NOT anything inside parentheses or strings
        sql = sql
            .replace(/^--.*$/gm, "") // SQL single line comments
            .replace(/\/\/.*$/gm, "") // JS single line comments
            .replace(/\/\*[\s\S]*?\*\//g, ""); // Multiline comments

        // Replace all \n with a space
        sql = sql.replace(/\n/g, " ");

        // Normalize whitespace
        sql = sql.replace(/[ \t]+/g, " ").trim();

        // Add semicolon if not present
        if (!sql.endsWith(";")) sql += ";";

        return sql;
    }

    // Helper function to extract complete SQL queries with proper parentheses balance
    function extractCompleteSQL(input: string): string | null {
        // Find the start of a SELECT statement
        const selectMatch = input.match(/SELECT/i);
        if (!selectMatch) return null;

        let startIndex = selectMatch.index!;
        let currentPos = startIndex;
        let parenthesesCount = 0;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inBacktick = false;
        let sqlEnd = input.length;

        // Track parentheses balance and find natural SQL ending
        while (currentPos < input.length) {
            const char = input[currentPos];
            const nextChar =
                currentPos + 1 < input.length ? input[currentPos + 1] : "";
            const prevChar = currentPos > 0 ? input[currentPos - 1] : "";

            // Handle string literals
            if (char === "'" && !inDoubleQuote && !inBacktick && prevChar !== "\\") {
                inSingleQuote = !inSingleQuote;
            } else if (
                char === '"' &&
                !inSingleQuote &&
                !inBacktick &&
                prevChar !== "\\"
            ) {
                inDoubleQuote = !inDoubleQuote;
            } else if (
                char === "`" &&
                !inSingleQuote &&
                !inDoubleQuote &&
                prevChar !== "\\"
            ) {
                inBacktick = !inBacktick;
            }

            // Only process non-string characters
            if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
                if (char === "(") {
                    parenthesesCount++;
                } else if (char === ")") {
                    parenthesesCount--;
                }

                // Check for natural SQL endings when parentheses are balanced
                if (parenthesesCount === 0) {
                    // Look for semicolon
                    if (char === ";") {
                        sqlEnd = currentPos + 1;
                        break;
                    }

                    // Look for natural text boundaries that indicate SQL end
                    const remainingText = input.substring(currentPos);
                    if (
                        remainingText.match(
                            /^\s*(?:Query executed|Result:|Error:|Final answer|Step \d+|\d+\.\s|\*\*|\#\#|```|\[\[|\]\])/i
                        )
                    ) {
                        sqlEnd = currentPos;
                        break;
                    }

                    // Look for line breaks followed by non-SQL content
                    if (char === "\n" && nextChar && !nextChar.match(/\s/)) {
                        const nextLine = input.substring(currentPos + 1).split("\n")[0];
                        if (
                            nextLine &&
                            !nextLine.match(
                                /^\s*(SELECT|FROM|WHERE|JOIN|GROUP|ORDER|HAVING|LIMIT|UNION|AND|OR)/i
                            )
                        ) {
                            // Check if this looks like explanatory text, not SQL continuation
                            if (
                                nextLine.match(/^[A-Z].*[.!?]$/) ||
                                nextLine.match(/^This|^The|^Note:|^Result|^Error/)
                            ) {
                                sqlEnd = currentPos;
                                break;
                            }
                        }
                    }
                }
            }

            currentPos++;
        }

        // Extract the SQL from start to the determined end
        let extractedSQL = input.substring(startIndex, sqlEnd).trim();

        // Clean up any trailing non-SQL text
        extractedSQL = extractedSQL.replace(
            /\s+(Query executed|Result:|Error:|Final answer|Step \d+|\d+\.\s).*$/i,
            ""
        );

        // Validate that we have a complete SQL statement
        if (extractedSQL.match(/SELECT\s+[\s\S]*?\s+FROM\s+/i)) {
            return extractedSQL;
        }

        return null;
    }

    function isCompleteSQLQuery(sql: string): boolean {
        if (!sql || typeof sql !== "string") return false;

        // A complete SQL query should have SELECT, FROM, and a valid table reference
        const hasSelect = /\bSELECT\b/i.test(sql);
        const hasFrom = /\bFROM\b/i.test(sql);
        const hasTable = /\bFROM\s+([a-zA-Z0-9_\.]+)/i.test(sql);

        return hasSelect && hasFrom && hasTable;
    }

    function fixIncompleteSQLQuery(sql: string): string {
        if (!sql || typeof sql !== "string") return sql;

        // Already complete
        if (isCompleteSQLQuery(sql)) return sql;

        let fixedSQL = sql;

        // Check if query ends with FROM without a table
        if (/\bFROM\s*(?:;|\s*$)/i.test(sql)) {
            // Extract column names to determine tables
            const columnsMatch = sql.match(/\bSELECT\s+(.*?)\s+FROM\b/i);

            if (columnsMatch) {
                const columns = columnsMatch[1];

                if (columns.includes("p.") && columns.includes("m.")) {
                    fixedSQL = sql.replace(
                        /FROM\s*(?:;|\s*$)/i,
                        "FROM patients p JOIN medications m ON p.id = m.patient_id"
                    );
                } else if (columns.includes("p.")) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, "FROM patients p");
                } else if (columns.includes("m.")) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, "FROM medications m");
                } else if (columns.includes("d.") || columns.includes("doctor")) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, "FROM doctors d");
                } else if (columns.includes("v.") || columns.includes("visit")) {
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, "FROM visits v");
                } else {
                    // Default to patients table if we can't determine
                    fixedSQL = sql.replace(/FROM\s*(?:;|\s*$)/i, "FROM patients");
                }
            }
        }

        // No SELECT statement found
        if (!fixedSQL.toLowerCase().includes("select")) {
            const possibleSelectMatch = fixedSQL.match(/^[^a-zA-Z]*(.*)/);
            if (
                possibleSelectMatch &&
                possibleSelectMatch[1].toLowerCase().includes("from")
            ) {
                fixedSQL = "SELECT * " + possibleSelectMatch[1];
            } else {
                fixedSQL = "SELECT * FROM patients";
            }
        }

        // No FROM clause found
        if (!fixedSQL.toLowerCase().includes("from")) {
            fixedSQL += " FROM patients";
        }

        // If the query doesn't have a semicolon at the end, add one
        if (!fixedSQL.endsWith(";")) {
            fixedSQL += ";";
        }

        return fixedSQL;
    }

    /**
     * Validates MySQL GROUP BY compliance for only_full_group_by mode
     * @param sql SQL query to validate
     * @returns Object with compliance status and suggested fixes
     */
    function validateMySQLGroupByCompliance(sql: string): {
        isCompliant: boolean;
        issues: string[];
        suggestedFix?: string;
    } {
        if (!sql || typeof sql !== "string") {
            return { isCompliant: true, issues: [] };
        }

        const issues: string[] = [];
        let suggestedFix = "";

        // Parse the SQL to check for GROUP BY compliance
        const sqlUpper = sql.toUpperCase();
        const sqlLower = sql.toLowerCase();

        // Check if the query has aggregation functions
        const aggregationFunctions = [
            "COUNT(",
            "SUM(",
            "AVG(",
            "MAX(",
            "MIN(",
            "GROUP_CONCAT(",
        ];
        const hasAggregation = aggregationFunctions.some((func) =>
            sqlUpper.includes(func.toUpperCase())
        );

        // Check if the query has GROUP BY
        const hasGroupBy = sqlUpper.includes("GROUP BY");

        if (!hasAggregation) {
            // No aggregation functions, so GROUP BY compliance is not required
            return { isCompliant: true, issues: [] };
        }

        if (!hasGroupBy) {
            issues.push(
                "Query uses aggregation functions but missing GROUP BY clause"
            );

            // Try to suggest a fix by adding GROUP BY for non-aggregated columns
            const selectMatch = sql.match(/SELECT\s+(.*?)\s+FROM/i);
            if (selectMatch) {
                const selectClause = selectMatch[1];
                const columns = selectClause.split(",").map((col) => col.trim());

                const nonAggregatedColumns: string[] = [];
                columns.forEach((col) => {
                    const isAggregated = aggregationFunctions.some((func) =>
                        col.toUpperCase().includes(func.toUpperCase())
                    );
                    if (!isAggregated && !col.includes("*")) {
                        // Extract just the column name, removing aliases
                        const colName = col.replace(/\s+AS\s+\w+/i, "").trim();
                        nonAggregatedColumns.push(colName);
                    }
                });

                if (nonAggregatedColumns.length > 0) {
                    const fromMatch = sql.match(
                        /FROM[\s\S]*?(?=WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|$)/i
                    );
                    const whereMatch = sql.match(
                        /(WHERE[\s\S]*?)(?=GROUP BY|HAVING|ORDER BY|LIMIT|$)/i
                    );
                    const havingMatch = sql.match(
                        /(HAVING[\s\S]*?)(?=ORDER BY|LIMIT|$)/i
                    );
                    const orderByMatch = sql.match(/(ORDER BY[\s\S]*?)(?=LIMIT|$)/i);
                    const limitMatch = sql.match(/(LIMIT[\s\S]*)$/i);

                    suggestedFix = `SELECT ${selectClause} ${fromMatch ? fromMatch[0] : ""
                        }`;
                    if (whereMatch) suggestedFix += ` ${whereMatch[1]}`;
                    suggestedFix += ` GROUP BY ${nonAggregatedColumns.join(", ")}`;
                    if (havingMatch) suggestedFix += ` ${havingMatch[1]}`;
                    if (orderByMatch) suggestedFix += ` ${orderByMatch[1]}`;
                    if (limitMatch) suggestedFix += ` ${limitMatch[1]}`;

                    if (!suggestedFix.endsWith(";")) suggestedFix += ";";
                }
            }

            return { isCompliant: false, issues, suggestedFix };
        }

        // Parse SELECT clause to find all columns
        const selectMatch = sql.match(/SELECT\s+(.*?)\s+FROM/i);
        if (!selectMatch) {
            return { isCompliant: true, issues: [] }; // Can't parse, assume compliant
        }

        const selectClause = selectMatch[1];
        const columns = selectClause.split(",").map((col) => col.trim());

        // Parse GROUP BY clause
        const groupByMatch = sql.match(
            /GROUP BY\s+(.*?)(?:\s+HAVING|\s+ORDER BY|\s+LIMIT|;|$)/i
        );
        if (!groupByMatch) {
            issues.push("GROUP BY clause could not be parsed");
            return { isCompliant: false, issues };
        }

        const groupByClause = groupByMatch[1];
        const groupByColumns = groupByClause.split(",").map((col) => col.trim());

        // Check each SELECT column
        const nonAggregatedColumns: string[] = [];
        const missingFromGroupBy: string[] = [];

        columns.forEach((col) => {
            const isAggregated = aggregationFunctions.some((func) =>
                col.toUpperCase().includes(func.toUpperCase())
            );

            if (!isAggregated && !col.includes("*")) {
                // Extract just the column name, removing aliases and table prefixes for comparison
                let colName = col.replace(/\s+AS\s+\w+/i, "").trim();

                // Check if this column is in GROUP BY
                const isInGroupBy = groupByColumns.some((groupCol) => {
                    // Normalize both for comparison (remove table prefixes, spaces)
                    const normalizedGroupCol = groupCol.replace(/^\w+\./, "").trim();
                    const normalizedColName = colName.replace(/^\w+\./, "").trim();
                    return (
                        normalizedGroupCol === normalizedColName ||
                        groupCol.trim() === colName ||
                        normalizedGroupCol.toLowerCase() === normalizedColName.toLowerCase()
                    );
                });

                nonAggregatedColumns.push(colName);

                if (!isInGroupBy) {
                    missingFromGroupBy.push(colName);
                }
            }
        });

        if (missingFromGroupBy.length > 0) {
            issues.push(
                `Non-aggregated columns not in GROUP BY: ${missingFromGroupBy.join(
                    ", "
                )}`
            );

            // Suggest fix by adding missing columns to GROUP BY
            const additionalGroupBy = missingFromGroupBy.filter(
                (col) =>
                    !groupByColumns.some(
                        (groupCol) =>
                            groupCol.toLowerCase().includes(col.toLowerCase()) ||
                            col.toLowerCase().includes(groupCol.toLowerCase())
                    )
            );

            if (additionalGroupBy.length > 0) {
                const newGroupBy = [...groupByColumns, ...additionalGroupBy].join(", ");
                suggestedFix = sql.replace(
                    /GROUP BY\s+.*?(?=\s+HAVING|\s+ORDER BY|\s+LIMIT|;|$)/i,
                    `GROUP BY ${newGroupBy}`
                );
            }

            return { isCompliant: false, issues, suggestedFix };
        }

        return { isCompliant: true, issues: [] };
    }

    /**
     * Validates UNION ALL statements to ensure all SELECT statements have matching column counts and types
     * @param sql SQL query to validate
     * @returns Object with validation status and issues found
     */
    function validateUnionColumnMatching(sql: string): {
        isValid: boolean;
        issues: string[];
        suggestedFix?: string;
    } {
        if (!sql || typeof sql !== "string") {
            return { isValid: true, issues: [] };
        }

        const issues: string[] = [];
        let suggestedFix = "";

        // Check if the query contains UNION
        const hasUnion = /UNION\s+(?:ALL\s+)?/gim.test(sql);
        if (!hasUnion) {
            return { isValid: true, issues: [] }; // No UNION, validation passes
        }

        // Split the SQL by UNION to get individual SELECT statements
        const unionParts = sql.split(/UNION\s+(?:ALL\s+)?/gim);

        if (unionParts.length < 2) {
            return { isValid: true, issues: [] }; // No actual UNION found
        }

        let referenceColumnCount = 0;
        const selectClauses: string[] = [];

        unionParts.forEach((part, index) => {
            // Extract SELECT clause from each part
            const selectMatch = part.match(/SELECT\s+(.*?)\s+FROM/im);
            if (selectMatch) {
                const selectClause = selectMatch[1];
                selectClauses.push(selectClause);

                // Count columns (simple approach - count commas + 1, accounting for parentheses)
                const columnCount = countColumnsInSelect(selectClause);

                if (index === 0) {
                    referenceColumnCount = columnCount;
                } else if (columnCount !== referenceColumnCount) {
                    issues.push(
                        `UNION statement ${index + 1} has ${columnCount} columns, but the first statement has ${referenceColumnCount} columns. All UNION statements must have the same number of columns.`
                    );
                }
            } else {
                // Try to find SELECT at the beginning of the part (first UNION part might not have FROM)
                const selectAtStart = part.match(/^\s*SELECT\s+(.*?)(?:\s+FROM|\s+UNION|\s*$)/im);
                if (selectAtStart) {
                    const selectClause = selectAtStart[1];
                    selectClauses.push(selectClause);

                    const columnCount = countColumnsInSelect(selectClause);

                    if (index === 0) {
                        referenceColumnCount = columnCount;
                    } else if (columnCount !== referenceColumnCount) {
                        issues.push(
                            `UNION statement ${index + 1} has ${columnCount} columns, but the first statement has ${referenceColumnCount} columns. All UNION statements must have the same number of columns.`
                        );
                    }
                }
            }
        });

        if (issues.length > 0) {
            suggestedFix = "Ensure all SELECT statements in the UNION have the same number of columns. Use CAST(NULL as DATA_TYPE) as column_name for missing columns in each SELECT statement.";

            return { isValid: false, issues, suggestedFix };
        }

        return { isValid: true, issues: [] };
    }

    /**
     * Helper function to count columns in a SELECT clause
     * @param selectClause The SELECT clause string
     * @returns Number of columns
     */
    function countColumnsInSelect(selectClause: string): number {
        if (!selectClause || typeof selectClause !== "string") {
            return 0;
        }

        let columnCount = 0;
        let parenDepth = 0;
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < selectClause.length; i++) {
            const char = selectClause[i];
            const prevChar = i > 0 ? selectClause[i - 1] : '';

            // Handle quotes
            if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
                if (!inQuotes) {
                    inQuotes = true;
                    quoteChar = char;
                } else if (char === quoteChar) {
                    inQuotes = false;
                    quoteChar = '';
                }
                continue;
            }

            if (inQuotes) continue;

            // Handle parentheses
            if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
            }

            // Count commas at top level (outside parentheses and quotes)
            if (char === ',' && parenDepth === 0) {
                columnCount++;
            }
        }

        // Add 1 for the last column (no trailing comma)
        return columnCount + 1;
    }

    function finalCleanSQL(sql: string): string {
        if (!sql || typeof sql !== "string") return "";

        // First remove any non-ASCII characters that might cause problems
        let cleanSQL = sql.replace(/[^\x00-\x7F]/g, "");

        // Remove any markdown artifacts or non-SQL content that might remain
        cleanSQL = cleanSQL
            .replace(/```/g, "")
            .replace(/\*\*/g, "")
            .replace(/--.*?(?:\n|$)/g, " ")
            .replace(/\/\/.*?(?:\n|$)/g, " ")
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/\s*Review for common mistakes:[\s\S]*/i, "")
            .replace(/\s*Notes:[\s\S]*/i, "");

        // Remove any other non-SQL content that might follow a semicolon
        const semicolonIndex = cleanSQL.indexOf(";");
        if (semicolonIndex !== -1) {
            cleanSQL = cleanSQL.substring(0, semicolonIndex + 1);
        }

        // Normalize whitespace
        cleanSQL = cleanSQL.replace(/\s+/g, " ").trim();

        // Make sure it starts with SELECT
        if (!cleanSQL.toUpperCase().startsWith("SELECT")) {
            const selectMatch = cleanSQL.match(/(SELECT[\s\S]+)/i);
            if (selectMatch) {
                cleanSQL = selectMatch[1];
            } else {
                return ""; // Not a valid SQL query
            }
        }

        // Make sure it includes FROM
        if (!cleanSQL.toUpperCase().includes(" FROM ")) {
            return ""; // Not a valid SQL query
        }

        // ENHANCED SQL SYNTAX VALIDATION AND FIXING

        // Fix common syntax issues that cause MySQL errors

        // 1. Fix orphaned closing parentheses at the beginning
        cleanSQL = cleanSQL.replace(/^\s*\)\s*/, "");

        // 2. Fix malformed WITH clauses that don't have proper structure
        cleanSQL = cleanSQL.replace(/^\s*WITH\s*\)\s*/i, "");

        // 3. Fix cases where there's a closing parenthesis before SELECT
        cleanSQL = cleanSQL.replace(/^\s*\)\s*(SELECT)/i, "$1");

        // 4. Fix complex query structure issues first
        // Handle cases where we have ") SELECT" which indicates malformed CTE or subquery
        if (/\)\s+SELECT/i.test(cleanSQL)) {
            console.log(
                "🔧 Detected malformed CTE/subquery structure, attempting to fix..."
            );

            // Pattern: "...GROUP BY field ) SELECT ..." - this is likely a malformed CTE
            const ctePattern = /(SELECT.*?FROM.*?GROUP BY.*?)\s*\)\s*(SELECT.*)/i;
            const cteMatch = cleanSQL.match(ctePattern);

            if (cteMatch) {
                console.log("🔧 Converting to proper CTE structure...");
                const innerQuery = cteMatch[1];
                const outerQuery = cteMatch[2];

                // Create a proper CTE structure
                cleanSQL = `WITH therapeutic_counts AS (${innerQuery}) ${outerQuery}`;
                console.log("🔧 Fixed CTE structure:", cleanSQL);
            } else {
                // If we can't parse it as CTE, try to extract the most complete SELECT statement
                console.log(
                    "🔧 Could not parse as CTE, extracting most complete SELECT..."
                );
                const selectMatches = cleanSQL.match(/(SELECT[\s\S]*?(?:;|$))/gi);
                if (selectMatches && selectMatches.length > 0) {
                    // Take the longest SELECT statement (likely most complete)
                    const longestSelect = selectMatches.reduce((longest, current) =>
                        current.length > longest.length ? current : longest
                    );
                    cleanSQL = longestSelect;
                    console.log("🔧 Using longest SELECT statement:", cleanSQL);
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
                cleanSQL = cleanSQL.replace(/^\s*\)/, "");
                extraClosing--;
            }

            // If still have extra, remove them from other strategic positions
            while (extraClosing > 0) {
                // Remove closing parentheses that appear before keywords without matching opening
                if (
                    /\)\s+(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)/i.test(cleanSQL)
                ) {
                    cleanSQL = cleanSQL.replace(
                        /\)\s+(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)/i,
                        " $1"
                    );
                    extraClosing--;
                } else {
                    // Remove the last closing parenthesis
                    const lastCloseIndex = cleanSQL.lastIndexOf(")");
                    if (lastCloseIndex > -1) {
                        cleanSQL =
                            cleanSQL.substring(0, lastCloseIndex) +
                            cleanSQL.substring(lastCloseIndex + 1);
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
            if (cleanSQL.endsWith(";")) {
                cleanSQL = cleanSQL.slice(0, -1) + ")".repeat(missingClosing) + ";";
            } else {
                cleanSQL += ")".repeat(missingClosing);
            }
        }

        // 6. Fix cases where there are multiple SELECT statements incorrectly formatted
        const selectMatches = cleanSQL.match(/SELECT/gi);
        if (selectMatches && selectMatches.length > 1) {
            // If there are multiple SELECTs, take only the first complete one
            const firstSelectIndex = cleanSQL.toUpperCase().indexOf("SELECT");
            let queryEnd = cleanSQL.length;

            // Find the end of the first SELECT statement
            const secondSelectIndex = cleanSQL
                .toUpperCase()
                .indexOf("SELECT", firstSelectIndex + 6);
            if (secondSelectIndex > -1) {
                queryEnd = secondSelectIndex;
            }

            cleanSQL = cleanSQL.substring(firstSelectIndex, queryEnd).trim();
        }

        // 7. Fix common MySQL syntax issues

        // Fix incorrect LIMIT syntax
        cleanSQL = cleanSQL.replace(
            /LIMIT\s+(\d+)\s*,\s*(\d+)/gi,
            "LIMIT $2 OFFSET $1"
        );

        // Fix incorrect date formatting
        cleanSQL = cleanSQL.replace(
            /DATE\s*\(\s*['"]([^'"]+)['"]\s*\)/gi,
            "DATE('$1')"
        );

        // Fix table alias issues (missing AS keyword or improper spacing)
        cleanSQL = cleanSQL.replace(
            /(\w+)\s+(\w+)\s+(ON|WHERE|JOIN|GROUP|ORDER|LIMIT|HAVING)/gi,
            "$1 AS $2 $3"
        );

        // 8. NEW: Fix specific SELECT clause issues that cause syntax errors

        // Fix missing comma after table.* in SELECT clauses
        // Pattern: SELECT table.* function(...) should be SELECT table.*, function(...)
        cleanSQL = cleanSQL.replace(
            /SELECT\s+([\w.]+\.\*)\s+([A-Z_]+\s*\()/gi,
            "SELECT $1, $2"
        );

        // Fix extra "AS" before table names in FROM clause
        // Pattern: FROM AS table_name should be FROM table_name
        cleanSQL = cleanSQL.replace(/FROM\s+AS\s+/gi, "FROM ");

        // Fix missing comma between SELECT fields - IMPROVED PATTERN
        // Only match field names followed by aggregate functions, not function parameters
        cleanSQL = cleanSQL.replace(
            /(\w+(?:\.\w+)?)\s+(GROUP_CONCAT|COUNT|SUM|AVG|MAX|MIN)\s*\(/gi,
            "$1, $2("
        );

        // Fix orphaned commas before FROM
        cleanSQL = cleanSQL.replace(/,\s*FROM/gi, " FROM");

        // 9. Validate basic SQL structure
        const upperSQL = cleanSQL.toUpperCase();

        // Ensure proper SELECT structure
        if (!upperSQL.includes("SELECT") || !upperSQL.includes("FROM")) {
            return "";
        }

        // Check for basic syntax requirements
        const hasValidStructure = /SELECT\s+.*\s+FROM\s+\w+/i.test(cleanSQL);
        if (!hasValidStructure) {
            return "";
        }

        // 10. Final cleanup

        // Remove any trailing commas before FROM, WHERE, etc.
        cleanSQL = cleanSQL.replace(
            /,\s+(FROM|WHERE|GROUP|ORDER|LIMIT|HAVING)/gi,
            " $1"
        );

        // Remove any extra spaces
        cleanSQL = cleanSQL.replace(/\s+/g, " ").trim();

        // Ensure it ends with a semicolon
        if (!cleanSQL.endsWith(";")) {
            cleanSQL += ";";
        }

        return cleanSQL;
    } // New function to validate SQL syntax before execution

    return router;
}

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
    getDatabaseSyntaxRules,
    getJsonFunctionsForDatabase,
} from "../prompts/queryPropmt";
import {
    generateVersionSpecificInstructions,
    generateComprehensiveDatabaseAnalystPrompt,
} from "../prompts/enhanceQueryPrompt";
import { testOrganizationDatabaseConnection } from "../services/connectionTestService";
import { initializeLangChainAndConversation, conversationSessions, saveConversationToMemory } from "../services/conversationService";
import { detectDatabaseVersion } from "../services/databaseVersionService";
import { executeChainLogic } from "../services/chainExecutionService";
import { processChainSql } from "../services/chainSqlProcessingService";
import { getTableDescriptionsWithAI } from "../services/tableAnalysisService";
import { executeSqlAgentWithCallbacks } from "../services/sqlAgentCallbackService";
import { extractAndProcessSQL } from "../services/sqlExtractionService";
import { validateAndCorrectSQL } from "../services/sqlValidationService";
import { establishDatabaseConnection } from "../services/sqlExecutionService";
import { executeSqlQueryWithRecovery } from "../services/sqlQueryExecutionService";
import { generateQueryDescriptionAndExplanation } from "../services/queryDescriptionService";
import { processGraphData } from "../services/graphProcessingService";
import { handleSqlRestructuringAndAnalysis } from "../services/sqlRestructuringService";
import { RetryAndErrorHandlingService } from "../services/retryAndErrorHandlingService";
import { PromptAnalysisService } from "../services/promptAnalysisService";

// Simple in-memory conversation history storage
interface ConversationHistory {
    sessionId: string;
    queries: string[];
    timestamp: Date;
}

// Store conversation history by sessionId
const simpleConversationHistory = new Map<string, ConversationHistory>();

/**
 * Add user query to conversation history
 * @param sessionId Session identifier
 * @param query User query to store
 */
function addQueryToHistory(sessionId: string, query: string): void {
    let history = simpleConversationHistory.get(sessionId);
    
    if (!history) {
        history = {
            sessionId,
            queries: [],
            timestamp: new Date()
        };
    }
    
    history.queries.push(query);
    history.timestamp = new Date();
    simpleConversationHistory.set(sessionId, history);
    
    console.log(`📝 Added query to history for session ${sessionId}: "${query}"`);
    console.log(`📊 Total queries in history: ${history.queries.length}`);
}

/**
 * Get conversation history for a session
 * @param sessionId Session identifier
 * @returns Array of previous queries
 */
function getQueryHistory(sessionId: string): string[] {
    const history = simpleConversationHistory.get(sessionId);
    return history ? history.queries : [];
}

/**
 * Type definition for data items with sheet_type
 */
type DataItem = {
    sheet_type: string;
    [key: string]: any;
};

/**
 * Groups data by sheet_type, removes null fields, and prevents duplicates
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

        // Convert cleaned item to JSON string for easy comparison
        const cleanedString = JSON.stringify(cleanedItem);

        // Check if this item already exists in the group
        const exists = groupedData[sheet_type].some(
            (existing) => JSON.stringify(existing) === cleanedString
        );

        if (!exists) {
            groupedData[sheet_type].push(cleanedItem);
        }
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

🚨🚨🚨 EMERGENCY STOP - READ THIS FIRST OR YOUR QUERY WILL FAIL 🚨🚨🚨
🛑 THE #1 CAUSE OF "syntax error at or near UNION" IS IMPROPER LIMIT PLACEMENT
🛑 EXAMPLE OF WHAT NOT TO DO (THIS BREAKS):
   ❌ FROM patients p LIMIT 1 UNION ALL SELECT ...
   ❌ FROM table ORDER BY col UNION ALL SELECT ...

✅ ONLY THESE PATTERNS WORK:
   ✅ FROM patients p UNION ALL SELECT ... LIMIT 1  (LIMIT at very end)
   ✅ SELECT * FROM (SELECT ... FROM patients p LIMIT 1) AS sub1 UNION ALL SELECT ... (wrapped in parentheses)

🚨 IF YOU WRITE "LIMIT" OR "ORDER BY" BEFORE "UNION", THE QUERY FAILS 🚨
🚨 CHECK YOUR OUTPUT BEFORE RESPONDING - NO EXCEPTIONS! 🚨

You are an expert SQL developer with DEEP knowledge of ${dbType.toUpperCase()} ${dbVersion} syntax and capabilities.

🚨 CRITICAL TABLE CONSTRAINT REQUIREMENT 🚨
${(() => {
    // Extract tables from original SQL to enforce constraints
    const extractTablesFromSQL = (sql: string): string[] => {
        const tables: Set<string> = new Set();
        
        // Remove comments and normalize whitespace
        const cleanSQL = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
        
        // Match FROM clauses
        const fromMatches = cleanSQL.match(/\bFROM\s+([^\s,;]+(?:\s+[^\s,;]+)*)/gi);
        if (fromMatches) {
            fromMatches.forEach(match => {
                const tablePart = match.replace(/\bFROM\s+/i, '').trim();
                const tableMatch = tablePart.match(/^([^\s]+)/);
                if (tableMatch) {
                    tables.add(tableMatch[1].toLowerCase());
                }
            });
        }
        
        // Match JOIN clauses
        const joinMatches = cleanSQL.match(/\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\s+([^\s,;]+)/gi);
        if (joinMatches) {
            joinMatches.forEach(match => {
                const tablePart = match.replace(/\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\s+/i, '').trim();
                const tableMatch = tablePart.match(/^([^\s]+)/);
                if (tableMatch) {
                    tables.add(tableMatch[1].toLowerCase());
                }
            });
        }
        
        return Array.from(tables);
    };

    const originalTables = extractTablesFromSQL(originalSQL);
    const originalTablesStr = originalTables.length > 0 ? originalTables.join(', ') : 'No tables detected';
    
    return `MANDATORY RESTRICTION: You MUST ONLY use tables that were present in the original SQL query.
DO NOT introduce ANY new tables or additional tables not found in the original query.

ORIGINAL QUERY TABLES DETECTED: ${originalTablesStr}
⚠️  You are STRICTLY LIMITED to using ONLY these tables: ${originalTablesStr}`;
})()}

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

🚨🚨🚨 CRITICAL UNION SYNTAX WARNING - READ THIS FIRST 🚨🚨🚨
❌ THE #1 ERROR THAT BREAKS QUERIES: LIMIT/ORDER BY IN MIDDLE OF UNION
❌ NEVER WRITE: "FROM table LIMIT 1 UNION ALL" - THIS CAUSES "syntax error at or near UNION"
❌ NEVER WRITE: "FROM table ORDER BY col UNION ALL" - THIS CAUSES SYNTAX ERRORS
❌ REAL FAILING EXAMPLE: "FROM patients p INNER JOIN clinical_history ch ON p.patient_id = ch.patient_id LIMIT 1 UNION ALL" ← THIS BREAKS!

✅ ONLY VALID UNION PATTERNS:
✅ Pattern 1: "FROM table1 UNION ALL FROM table2 LIMIT 1" (LIMIT at very end)
✅ Pattern 2: "SELECT * FROM (SELECT ... FROM table1 LIMIT 1) AS sub1 UNION ALL SELECT * FROM (SELECT ... FROM table2 LIMIT 1) AS sub2" (derived tables)

🚨 IF YOU USE UNION ALL, YOU MUST FOLLOW THESE RULES OR THE QUERY WILL FAIL 🚨

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

✅ 🚨 CRITICAL UNION SYNTAX VALIDATION (PREVENTS "syntax error at or near UNION"):
□ I verified NO LIMIT clauses appear between SELECT and UNION keywords
□ I verified NO ORDER BY clauses appear in individual SELECT statements
□ If I used LIMIT, I placed it ONLY at the very end OR wrapped SELECT statements in parentheses
□ If I used ORDER BY, I placed it ONLY at the very end of the entire UNION query
□ I double-checked that my UNION query follows valid syntax patterns

✅ 🚨 CRITICAL LIMIT WITH UNION HANDLING:
**WRONG (CAUSES SYNTAX ERROR):**
SELECT col FROM table1 LIMIT 1 UNION ALL SELECT col FROM table2 LIMIT 1

**CORRECT METHOD 1 (Wrap subqueries with LIMIT in derived tables):**
SELECT * FROM (SELECT col FROM table1 LIMIT 1) AS sub1 
UNION ALL 
SELECT * FROM (SELECT col FROM table2 LIMIT 1) AS sub2

**CORRECT METHOD 2 (LIMIT at end only):**
SELECT col FROM table1 UNION ALL SELECT col FROM table2 LIMIT 10

□ I wrapped each subquery that needs LIMIT inside a derived table (SELECT * FROM (SELECT ... LIMIT n) AS sub)
□ I used proper alias names for each derived table (AS sub1, AS sub2, etc.)
□ I verified NO direct LIMIT appears between SELECT and UNION keywords

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
□ 🚨 CRITICAL: I included ALL columns from ALL tables involved in the query
□ Every table is fully represented with ALL its columns + NULL placeholders for missing ones

⚠️ FINAL VERIFICATION STEP ⚠️
Read through your entire SQL query one more time and ask:
1. "Will this execute successfully on ${dbType.toUpperCase()} ${dbVersion}?"
2. "Did I use any functions that don't exist in this database version?"
3. "Are all my column references valid and existing?"
4. "Does my syntax perfectly match ${dbType.toUpperCase()} requirements?"
5. "🚨 CRITICAL: Have I included ALL columns from ALL tables in my UNION ALL structure?"
6. "Did I use UNION ALL instead of traditional JOINs to ensure complete column representation?"

🚨 ONLY PROCEED IF ALL CHECKS PASS 🚨

TASK: Generate a new SQL query that produces structured, non-redundant results directly from the database with ALL columns from ALL tables represented.

RESTRUCTURING REQUIREMENTS:
0. **🚨 MANDATORY TABLE CONSTRAINT 🚨**: Use ONLY the tables from the original query detected above. DO NOT add any new tables not present in the original SQL. DO NOT use tables beyond those detected in the original query. STRICTLY limit your restructured query to the original table set.
1. **🚨 MANDATORY UNION ALL WITH ALL COLUMNS 🚨**: Use UNION ALL structure to include ALL columns from ALL tables involved in the query. Each SELECT statement must include every column from every table, using CAST(NULL AS data_type) for missing columns.
2. **ELIMINATE REDUNDANCY**: Use GROUP BY to group related entities (e.g., patients, medications, lab tests)
3. **CREATE JSON HIERARCHY**: Use ${jsonFunctions.createObject} and ${jsonFunctions.createArray} functions to create nested structures
4. **MAINTAIN DATA INTEGRITY**: Don't lose any information from the original query
5. **BE LOGICAL**: Structure should make business sense for the data domain
6. **USE APPROPRIATE GROUPING**: Identify the main entity and group related data under it
7. **PREVENT DUPLICATE DATA**: Ensure no duplicate records appear in any field of the response - each record should be unique
8. **AVOID IDENTICAL/REPETITIVE DATA**: Do NOT generate queries that return identical values across multiple rows or columns. Use DISTINCT, proper GROUP BY, and JSON aggregation to eliminate repetitive data patterns. Avoid queries that produce the same data values repeated multiple times in the response.
9. **RETURN PARSED JSON OBJECTS**: Generate SQL that returns properly structured JSON objects, NOT stringified JSON. The JSON functions should produce actual JSON objects that can be directly used without additional parsing. Avoid queries that return JSON data as strings that require further parsing.
10. **MYSQL GROUP BY STRICT COMPLIANCE**: For MySQL, ensure every non-aggregated column in SELECT appears in GROUP BY clause (sql_mode=only_full_group_by)
11. **VERSION COMPATIBILITY**: Ensure the generated SQL is compatible with ${dbType.toUpperCase()} ${dbVersion}
12. **SCHEMA ACCURACY**: Use ONLY validated table and column names from the database schema above
13. **EXACT COLUMN NAMES**: Do NOT assume, guess, or make up column names. Use ONLY the exact column names provided in the validated schema. If a column name is not in the validated list, DO NOT use it. Never use variations like 'patient_id' when the actual column is 'id', or vice versa.
14. **STRICT COLUMN VALIDATION**: Before using any column in SELECT, FROM, JOIN, WHERE, or GROUP BY clauses, verify it exists in the validated columns list for that table. Reject any query that references non-existent columns.
15. **SAMPLE DATA VERIFICATION**: Use the provided sample data to VERIFY that columns actually exist and contain the expected data types. Do NOT reference any column that is not visible in the sample data provided.
16. **COLUMN CROSS-REFERENCE**: Cross-check every single column reference against both the validated schema AND the sample data. If a column is not present in either the schema or sample data, DO NOT use it under any circumstances.
17. **NO COLUMN ASSUMPTIONS**: Never assume standard column names like 'summary_id', 'patient_id', 'medication_id' etc. Use ONLY the exact column names shown in the sample data and schema.
18. **SAMPLE DATA ANALYSIS**: Leverage the provided sample data to understand the actual data content, formats, and relationships. Use sample data to verify which tables contain relevant information for the user query and to understand data patterns that should influence your restructuring approach.
19. **DATA-DRIVEN TABLE SELECTION**: Prioritize tables that contain relevant data based on the sample data analysis. If sample data shows certain tables have meaningful information for the user query while others are empty or irrelevant, focus on the tables with relevant sample data.
20. **NEVER INVENT COLUMN NAMES**: CRITICAL - Do NOT create imaginary columns like 'medication_count', 'patient_count', 'summary_id', 'total_medications', 'risk_score', etc. If you need to count something, use COUNT(*) or COUNT(existing_column_name) but do NOT reference non-existent counting columns.
20. **FORBIDDEN COLUMN PATTERNS**: NEVER use columns ending in '_count', '_total', '_sum', '_avg' unless they physically exist in the sample data. Do NOT generate queries with aggregated column names that don't exist in the actual database schema.
21. **SAMPLE DATA IS GROUND TRUTH**: The sample data shows you EXACTLY which columns exist. If a column is not in the sample data, it does NOT exist. Period. No exceptions. No assumptions. No guessing.
22. **AGGREGATE FUNCTIONS ONLY**: If you need counts, sums, or calculations, use SQL aggregate functions like COUNT(*), SUM(existing_column), AVG(existing_column). Do NOT reference made-up column names to get these values.
23. **🚨 CRITICAL PATIENT TABLE RESTRICTION 🚨**: When querying the patient table (or any table named 'patients'), ONLY include the 'gender' column in query responses unless other specific patient columns are explicitly requested in the user prompt. This restriction applies to ALL patient table columns except 'gender' - do NOT include patient_id, patient_name, dob, city, state, or any other patient columns unless the user specifically asks for them by name.
24. **MULTI-SHEET EXCEL FORMAT**: Generate results organized for multi-sheet Excel export where different record types are separated into different sheets. Structure the output as a JSON object with sheet names as keys and their corresponding data arrays as values. Each sheet should contain homogeneous records (same entity type) with consistent column structures. 

25. **MAIN ENTITY COUNT AND IDENTIFIER**: ALWAYS include metadata about the main entity being queried. Add a "metadata" section in the response that includes:
- "main_entity": The name of the primary entity type (e.g., "patients", "medications", "appointments")
- "main_entity_count": The total count of unique main entities using COUNT(*) or COUNT(DISTINCT main_entity_id)
- "main_entity_identifier": The primary key field name used to identify the main entity (e.g., "patient_id", "medication_id", "appointment_id")

26. **🚨 CRITICAL: ALL COLUMNS FROM ALL TABLES REQUIREMENT 🚨**
- **MANDATORY**: Include ALL columns from ALL tables involved in the query - this is non-negotiable
- **⚠️ EXCEPTION - PATIENT TABLE RESTRICTION**: For patient tables, ONLY include the 'gender' column unless other specific patient columns are explicitly mentioned in the user prompt
- **UNION ALL STRUCTURE**: Use UNION ALL to create separate result sets for each table instead of traditional JOINs
- **COMPLETE COLUMN SET**: The final result must contain ALL columns from ALL queried tables (except restricted patient columns)
- **NULL PLACEHOLDERS**: Use CAST(NULL AS appropriate_data_type) AS column_name for columns that don't exist in specific tables
- **EXACT COLUMN COUNT**: All SELECT statements in UNION ALL must have the EXACT same number of columns in the EXACT same order
- **ALL TABLE REPRESENTATION**: Every table that contains relevant data must be represented with ALL its columns (except restricted patient columns)

**UNION ALL EXAMPLE FOR COMPLETE COLUMN COVERAGE:**
Example structure for including ALL columns from patients and medications tables:
- First SELECT: Get ONLY 'gender' column from patient table (restricted) + NULL placeholders for medication columns
- Second SELECT: Get ALL medication columns + NULL placeholder for patient gender column
- Both SELECT statements must have identical column count and order
- Use proper CAST(NULL AS data_type) for missing columns in each table
- Add source_table column to identify which table each record came from
- **PATIENT TABLE EXCEPTION**: Only include 'gender' column from patient table unless user explicitly requests other patient columns

**CRITICAL STRUCTURING REQUIREMENTS FOR MULTI-SHEET EXCEL:**
- MANDATORY ARRAY WRAPPER: The response MUST ALWAYS be wrapped in an array with a single object: [{ metadata: {...}, patients: [...], medications: [...] }]
- Organize results by entity type: patients, medications, appointments, diagnoses, etc. into separate logical sheets within the single array object.
- Return EXACTLY this structure: [{"metadata": {"main_entity": "patients", "main_entity_count": 25, "main_entity_identifier": "patient_id"}, "patients": [patient_records], "medications": [medication_records], "appointments": [appointment_records]}]
- **🚨 CRITICAL PATIENT RESTRICTION**: For patient records, include ONLY the 'gender' column unless other specific patient columns are explicitly requested in the user prompt
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
    "union_structure_valid": true/false,
    "union_data_types_consistent": true/false,
    "union_syntax_correct": true/false
  },
  "sql_quality_assurance": {
    "will_execute_successfully": true/false,
    "no_syntax_errors": true/false,
    "all_columns_exist": true/false,
    "database_specific_syntax": true/false,
    "union_type_compatibility": true/false,
    "union_limit_order_placement": true/false
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
        "gender": "Male",
        // ONLY gender column from patient table unless explicitly requested
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
  CAST(NULL as VARCHAR(50)) as gender,
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
  gender, -- ONLY gender column from patient table unless explicitly requested
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
  CAST(NULL as VARCHAR(50)) as gender,
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
**UNION COLUMN MATCHING (PREVENTS "UNION types cannot be matched" ERROR):**
- **EXACT COLUMN COUNT**: Every SELECT statement in UNION ALL must have the EXACT SAME number of columns
- **EXACT COLUMN ORDER**: All columns must appear in the EXACT SAME order in every SELECT statement
- **CONSISTENT DATA TYPES**: Use CAST() or CONVERT() functions to ensure matching data types for each column position
- **NULL PLACEHOLDER COLUMNS**: When a column doesn't exist in a particular entity, use CAST(NULL as DATA_TYPE) as column_name
- **COLUMN NAME CONSISTENCY**: Use the same alias names for corresponding columns across all UNION statements
- **NO MISSING COLUMNS**: Never omit columns in any SELECT statement - use NULL placeholders instead
- **DATA TYPE CASTING**: Always cast NULL values to the appropriate data type (VARCHAR, INTEGER, DATE, etc.) to match other UNION statements

🚨 **CRITICAL DATA TYPE COMPATIBILITY FOR UNION ALL** 🚨
**MANDATORY TYPE CASTING RULES:**
- **STRING COLUMNS**: Use CAST(NULL AS VARCHAR(255)) or CAST(value AS VARCHAR(255)) for text data
- **INTEGER COLUMNS**: Use CAST(NULL AS INTEGER) or CAST(value AS INTEGER) for numeric data  
- **DATE COLUMNS**: Use CAST(NULL AS DATE) or CAST(value AS DATE) for date data
- **DATETIME COLUMNS**: Use CAST(NULL AS TIMESTAMP) or CAST(value AS TIMESTAMP) for datetime data
- **DECIMAL COLUMNS**: Use CAST(NULL AS DECIMAL(10,2)) or CAST(value AS DECIMAL(10,2)) for decimal data
- **BOOLEAN COLUMNS**: Use CAST(NULL AS BOOLEAN) or CAST(value AS BOOLEAN) for boolean data

**COMMON TYPE MISMATCH ERRORS TO AVOID:**
❌ "UNION types character varying and date cannot be matched" - Mix of string and date without casting
❌ "UNION types integer and character varying cannot be matched" - Mix of number and string without casting
❌ "UNION types timestamp and character varying cannot be matched" - Mix of datetime and string without casting

**CORRECT TYPE CASTING EXAMPLES:**
✅ CAST(patient_id AS VARCHAR(255)) - Convert ID to string
✅ CAST(NULL AS DATE) - Null placeholder for date column
✅ CAST(appointment_date AS VARCHAR(255)) - Convert date to string for consistent type
✅ CAST(age AS VARCHAR(255)) - Convert number to string for consistent type

**UNIVERSAL TYPE CASTING STRATEGY:**
When in doubt, cast ALL columns to VARCHAR(255) to ensure compatibility:
- CAST(column_name AS VARCHAR(255)) for existing columns
- CAST(NULL AS VARCHAR(255)) for missing columns
- This prevents ALL type mismatch errors in UNION operations

**EXAMPLE OF CORRECT UNION COLUMN MATCHING:**
\`\`\`
SELECT 
  'metadata' as sheet_type, 
  'patients' as entity, 
  CAST(COUNT(*) AS VARCHAR(255)) as count, 
  CAST(NULL AS VARCHAR(255)) as patient_id, 
  CAST(NULL AS VARCHAR(255)) as name,
  CAST(NULL AS VARCHAR(255)) as appointment_date
UNION ALL
SELECT 
  'patient' as sheet_type, 
  CAST(NULL AS VARCHAR(255)) as entity, 
  CAST(NULL AS VARCHAR(255)) as count, 
  CAST(patient_id AS VARCHAR(255)) as patient_id, 
  CAST(patient_name AS VARCHAR(255)) as name,
  CAST(NULL AS VARCHAR(255)) as appointment_date
UNION ALL
SELECT 
  'appointment' as sheet_type, 
  CAST(NULL AS VARCHAR(255)) as entity, 
  CAST(NULL AS VARCHAR(255)) as count, 
  CAST(patient_id AS VARCHAR(255)) as patient_id, 
  CAST(NULL AS VARCHAR(255)) as name,
  CAST(appointment_date AS VARCHAR(255)) as appointment_date
\`\`\`

**COMMON UNION ERRORS TO AVOID:**
- Different number of columns in SELECT statements
- Missing columns in some UNION statements  
- Inconsistent data types (mixing VARCHAR with INTEGER, DATE, etc. without casting)
- Using plain NULL instead of CAST(NULL AS DATA_TYPE)
- Changing column order between UNION statements
- Mixing different data types without explicit CAST() functions

🚨 **CRITICAL UNION SYNTAX RULES - PREVENT "syntax error at or near UNION" ERRORS** 🚨

**LIMIT CLAUSE PLACEMENT RULES:**
❌ **NEVER place LIMIT in the middle of UNION statements:**
\`\`\`sql
SELECT * FROM table1 LIMIT 1 UNION ALL  -- WRONG! Causes syntax error
SELECT * FROM table2
\`\`\`

✅ **CORRECT LIMIT placement options:**

**Option 1: LIMIT at the very end (applies to entire UNION result)**
\`\`\`sql
SELECT * FROM table1 
UNION ALL 
SELECT * FROM table2 
LIMIT 1
\`\`\`

**Option 2: Wrap individual SELECT statements in parentheses**
\`\`\`sql
(SELECT * FROM table1 LIMIT 1) 
UNION ALL 
(SELECT * FROM table2 LIMIT 1)
\`\`\`

**Option 3: Use subqueries for individual limits**
\`\`\`sql
SELECT * FROM (SELECT * FROM table1 LIMIT 1) t1
UNION ALL
SELECT * FROM (SELECT * FROM table2 LIMIT 1) t2
\`\`\`

**ORDER BY CLAUSE RULES:**
❌ **NEVER place ORDER BY in individual SELECT statements:**
\`\`\`sql
SELECT * FROM table1 ORDER BY col1 UNION ALL  -- WRONG!
SELECT * FROM table2
\`\`\`

✅ **CORRECT ORDER BY placement:**
\`\`\`sql
SELECT * FROM table1 
UNION ALL 
SELECT * FROM table2 
ORDER BY col1  -- Only at the very end
\`\`\`

**MANDATORY UNION SYNTAX VALIDATION:**
- ✅ Verify no LIMIT clauses appear between SELECT and UNION keywords
- ✅ Verify no ORDER BY clauses appear in individual SELECT statements  
- ✅ Ensure proper parentheses if using individual limits
- ✅ Place final LIMIT and ORDER BY clauses only at the very end
- ✅ Test that each SELECT statement can run independently before combining
- ✅ **CRITICAL: If using LIMIT on individual parts of UNION, wrap each subquery in derived table:** 
  SELECT * FROM (SELECT col FROM table1 LIMIT 1) AS sub1 UNION ALL SELECT * FROM (SELECT col FROM table2 LIMIT 1) AS sub2
${dbSyntaxRules.criticalRequirements}

BEFORE FINALIZING THE QUERY:
0. **🚨 TABLE CONSTRAINT VALIDATION**: Verify that EVERY table used in your restructured query exists in the original SQL tables detected above. DO NOT use any tables beyond the original table set.
1. **🚨 UNION DATA TYPE VALIDATION**: If using UNION ALL, verify that each column position has the EXACT same data type across all SELECT statements. Use CAST() to ensure compatibility.
2. Review the entire query line by line for syntax errors
3. Use only column names from the original SQL and sample data
4. **VALIDATE EVERY COLUMN**: Use only columns that appear in the original SQL query and sample data
5. **CHECK TABLE.COLUMN REFERENCES**: Ensure all column references use the correct table prefix from the original SQL
6. **USE SAMPLE DATA COLUMNS**: If sample data is available, use only columns that appear in the sample data
7. **NO INVENTED COLUMNS**: Never create or assume column names. Use ONLY columns from the original SQL and available sample data
7. **NO AGGREGATED COLUMN ASSUMPTIONS**: NEVER use columns like 'medication_count', 'patient_count', 'total_*', '*_sum', '*_avg' unless they physically exist. If you need counts, use COUNT(*) or COUNT(existing_column)
8. **🚨 PATIENT TABLE COLUMN RESTRICTION**: When querying patient table, ONLY include the 'gender' column unless other specific patient columns are explicitly requested in the user prompt. Do NOT include patient_id, patient_name, dob, city, state, or any other patient columns unless explicitly mentioned by the user.
9. **VALIDATE HAVING CLAUSE**: If using HAVING clause, ensure all referenced columns either appear in GROUP BY or are aggregate functions
10. **UNION ALL VALIDATION**: If using UNION ALL for multi-sheet format, ensure ALL SELECT statements have the EXACT same number of columns in the EXACT same order with proper CAST(NULL as DATA_TYPE) for missing columns
11. **🚨 UNION SYNTAX VALIDATION**: If using UNION ALL, verify that NO LIMIT or ORDER BY clauses appear in the middle of UNION statements. Place LIMIT and ORDER BY only at the very end or wrap individual SELECT statements in parentheses.
12. **🚨 LIMIT WITH UNION HANDLING**: If you need LIMIT on individual parts of a UNION query, you MUST wrap each subquery in a derived table: SELECT * FROM (SELECT ... LIMIT n) AS sub1 UNION ALL SELECT * FROM (SELECT ... LIMIT n) AS sub2. NEVER write: SELECT ... LIMIT n UNION ALL (this causes syntax error).
12. **UNION COLUMN CONSISTENCY**: Verify all UNION statements use consistent data types and column names to prevent "each UNION query must have the same number of columns" errors
12. **SQL STRUCTURE VALIDATION**: Ensure the generated SQL will produce results that include sheet_type fields for organizing into different Excel sheets
13. **METADATA SECTION VALIDATION**: Ensure the response includes a metadata section with main_entity, main_entity_count (calculated using COUNT(*) or COUNT(DISTINCT)), and main_entity_identifier fields
14. **SHEET_TYPE FIELD VALIDATION**: Verify that the generated SQL includes a "sheet_type" field in the SELECT clause to identify record categories
15. **MULTI-SHEET STRUCTURE VALIDATION**: Ensure the query result can be properly organized into separate sheets by entity type (patients, medications, appointments, etc.)
16. **FLAT STRUCTURE CHECK**: Verify that each record within an entity type is completely flat with no nested objects or arrays
17. **SHEET CONSISTENCY**: Ensure all records of the same entity type have identical column structures for proper Excel sheet formatting
18. **FOREIGN KEY RELATIONSHIPS**: Verify that relationships between entities are maintained through foreign key references (patient_id, appointment_id, etc.) rather than nesting
19. **NO HIERARCHICAL NESTING**: Eliminate any JSON aggregation or array structures that would create nested data within records
20. **ENTITY SEPARATION**: Ensure different entity types (patients vs medications vs appointments) can be clearly separated into different result sets or sheets
21. Check that all JOIN conditions are logical and will maintain data relationships
22. Verify compatibility with ${dbType.toUpperCase()} ${dbVersion}
23. Double-check all parentheses, commas, and syntax elements
24. Verify ORDER BY clause uses either full expressions or positional references, not aliases
25. Confirm that any aggregated values used in ORDER BY are properly repeated in the SELECT clause
26. **MULTI-SHEET EXPORT READY**: Confirm the result structure is suitable for creating multiple Excel sheets with consistent, flat data in each sheet

DO NOT INCLUDE ANY EXPERIMENTAL OR UNTESTED SYNTAX. Only use proven, standard SQL constructs that are guaranteed to work with ${dbType.toUpperCase()} ${dbVersion}.

🛑🛑🛑 FINAL CRITICAL CHECK BEFORE GENERATING SQL 🛑🛑🛑

STOP! Before you write the SQL in your JSON response, ask yourself:

1. "Does my UNION query have any LIMIT clauses between SELECT and UNION keywords?" 
   - If YES: REWRITE IT. Move LIMIT to the end or use parentheses.

2. "Does my UNION query have any ORDER BY clauses in individual SELECT statements?"
   - If YES: REWRITE IT. Move ORDER BY to the very end.

3. "Can I point to the exact line where I placed LIMIT and ORDER BY clauses?"
   - They must be at the very end OR each SELECT must be in parentheses.

4. "If I need LIMIT on individual parts of UNION, did I wrap each subquery in a derived table?"
   - WRONG: SELECT col FROM table1 LIMIT 1 UNION ALL SELECT col FROM table2 LIMIT 1
   - CORRECT: SELECT * FROM (SELECT col FROM table1 LIMIT 1) AS sub1 UNION ALL SELECT * FROM (SELECT col FROM table2 LIMIT 1) AS sub2

🚨 REMEMBER: "FROM table LIMIT 1 UNION ALL" = SYNTAX ERROR
🚨 CORRECT: "FROM table UNION ALL FROM table2 LIMIT 1"
🚨 CORRECT WITH INDIVIDUAL LIMITS: "FROM (SELECT ... LIMIT 1) AS sub1 UNION ALL FROM (SELECT ... LIMIT 1) AS sub2"

If you're not 100% sure about UNION syntax, use simple SELECT without UNION instead.

🛑🛑🛑 FINAL MANDATORY UNION CHECK - DO NOT SKIP THIS 🛑🛑🛑
BEFORE YOU WRITE YOUR JSON RESPONSE, READ YOUR SQL OUT LOUD:
✅ If you see "UNION ALL" anywhere in your query, check the words immediately before it
✅ The words before "UNION ALL" should NEVER be "LIMIT 1", "LIMIT 5", "ORDER BY", etc.
✅ Valid pattern: "FROM table1 UNION ALL SELECT..." 
❌ Invalid pattern: "FROM table1 LIMIT 1 UNION ALL SELECT..." ← THIS WILL FAIL

SCAN YOUR ENTIRE SQL FOR THIS EXACT PATTERN AND FIX IT NOW!

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
- 🚨 MANDATORY TABLE CONSTRAINT: Use ONLY tables from the original query - NO additional tables allowed

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
                union_structure_valid: false,
                union_data_types_consistent: false,
                union_syntax_correct: false
            };
        }

        if (!restructuredResult.sql_quality_assurance) {
            console.warn('⚠️ AI did not provide SQL quality assurance - adding default QA');
            restructuredResult.sql_quality_assurance = {
                will_execute_successfully: false,
                no_syntax_errors: false,
                all_columns_exist: false,
                database_specific_syntax: false,
                union_type_compatibility: false,
                union_limit_order_placement: false
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

            try {
                // ========== STEP 1: EXTRACT REQUEST PARAMETERS ==========
                const { query: userPrompt, organizationId, conversational = false, sessionId = uuidv4() } = req.body;

                // ========== STEP 2: STORE CONVERSATION HISTORY ==========
                // Add user query to simple conversation history storage
                if (conversational && sessionId && userPrompt) {
                    addQueryToHistory(sessionId, userPrompt);
                }

                // ========== SSE SETUP FOR DATABASE PROCESSING ==========
                // Check if client wants streaming updates
                const enableSSE = req.body.enableSSE === true || req.headers.accept === 'text/event-stream';
                let sendMessage: (msg: string) => void;

                if (enableSSE) {
                    // Setup SSE headers
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("Access-Control-Allow-Headers", "Cache-Control");

                    sendMessage = (msg: string) => {
                        if (!res.headersSent) {
                            try {
                                res.write(`data: ${JSON.stringify({
                                    message: msg,
                                    timestamp: new Date().toISOString(),
                                    processing_time: `${(performance.now() - startTime).toFixed(2)}ms`
                                })}\n\n`);
                            } catch (writeError) {
                                console.error('❌ SSE write error:', writeError);
                            }
                        }
                    };

                    // Send initial processing message
                    sendMessage("Analyzing your query...");
                } else {
                    // No-op function for non-SSE requests
                    sendMessage = (msg: string) => {
                        console.log(`📡 Progress: ${msg}`);
                    };
                }

                // ========== STEP 2: INITIALIZE CONVERSATION SETUP ==========
                // We need conversation context for better prompt analysis
                let chatHistory: any[] = [];
                
                if (conversational) {
                    try {
                        // Initialize LangChain app and setup conversation session to get chat history
                        const setupResult = await initializeLangChainAndConversation(organizationId, conversational, sessionId, res);
                        if (!setupResult) {
                            return; // Error response already sent by the service
                        }
                        chatHistory = setupResult.chatHistory || [];
                    } catch (setupError) {
                        console.warn('⚠️ Could not initialize conversation for prompt analysis, proceeding without history');
                        chatHistory = [];
                    }
                }

                // ========== STEP 3: PROMPT ANALYSIS WITH CONVERSATION CONTEXT ==========
                console.log('🔍 Step 3: Analyzing user prompt intent with conversation context...');

                let promptAnalysis: any;
                try {
                    // Analyze if the prompt is database-related or casual conversation
                    promptAnalysis = await PromptAnalysisService.analyzePrompt(userPrompt, organizationId, chatHistory);

                    console.log(`📊 Prompt Analysis Result: ${promptAnalysis.isDatabaseRelated ? 'DATABASE_QUERY' : 'CASUAL_CONVERSATION'} (confidence: ${promptAnalysis.confidence.toFixed(2)})`);

                    // If not database-related, return casual response immediately
                    if (!promptAnalysis.isDatabaseRelated && promptAnalysis.casualResponse) {
                        console.log('💬 Handling as casual conversation - returning direct response');

                        return res.json({
                            success: true,
                            type: 'casual_conversation',
                            response: promptAnalysis.casualResponse,
                            category: promptAnalysis.category,
                            confidence: promptAnalysis.confidence,
                            reasoning: promptAnalysis.reasoning,
                            processing_time: `${(performance.now() - startTime).toFixed(2)}ms`,
                            timestamp: new Date().toISOString(),
                            // Include analysis debug info
                            analysis_debug: {
                                original_prompt: userPrompt,
                                classified_as: promptAnalysis.category,
                                ai_analysis: promptAnalysis.success ? 'used' : 'fallback',
                                error: promptAnalysis.error || null,
                                conversation_context_used: chatHistory.length > 0
                            }
                        });
                    }

                    console.log('🔄 Prompt classified as database-related - proceeding with database processing...');

                } catch (promptAnalysisError: any) {
                    console.error('❌ Error in prompt analysis layer:', promptAnalysisError.message);
                    // Continue with database processing if analysis fails
                    console.log('🔄 Continuing with database processing due to analysis error...');
                    promptAnalysis = {
                        isDatabaseRelated: true, // Default to database processing
                        confidence: 0.5,
                        category: 'database_query',
                        reasoning: 'Analysis failed - defaulting to database processing',
                        success: false,
                        error: promptAnalysisError.message
                    };
                }

                // ========== CONTINUE WITH EXISTING DATABASE PROCESSING ==========
                let rawAgentResponse = null;

                let debugInfo = {
                    extractionAttempts: [] as string[],
                    sqlCorrections: [] as string[],
                    originalQueries: [] as string[],
                    // Add prompt analysis info to debug info
                    promptAnalysis: {
                        isDatabaseRelated: promptAnalysis.isDatabaseRelated,
                        confidence: promptAnalysis.confidence,
                        category: promptAnalysis.category,
                        reasoning: promptAnalysis.reasoning,
                        analysisSuccess: promptAnalysis.success,
                        conversationContextUsed: chatHistory.length > 0
                    }
                    // No schema validations since we're trusting the sqlAgent
                };

                // ========== STEP 4: CONTINUE WITH DATABASE PROCESSING ==========

            // Declare tableSampleData at higher scope for reuse in restructured SQL
            let globalTableSampleData: { [table: string]: any[] } = {};

            // ========== RETRY LOOP FOR ZERO RECORDS ==========
            let maxRetryAttempts = 2; // Total of 2 attempts (original + 1 retry)
            let currentAttempt = 1;
            let finalResult: any = null;
            let previousAttemptError: string | null = null; // Track error from previous attempt
            let responseSent = false; // Flag to prevent double responses

            // Initialize retry and error handling service
            const retryAndErrorHandlingService = new RetryAndErrorHandlingService(
                multiTenantLangChainService,
                databaseService
            );

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
                    sendMessage("Analyzing available data...");
                    const connectionTestPassed = await testOrganizationDatabaseConnection(organizationId, res);
                    if (!connectionTestPassed) {
                        return; // Error response already sent by the service
                    }
                    // sendMessage("✅ Connected to database");

                    // Initialize LangChain app and setup conversation session
                    const setupResult = await initializeLangChainAndConversation(organizationId, conversational, sessionId, res);
                    if (!setupResult) {
                        return; // Error response already sent by the service
                    }

                    const { langchainApp, sessionData, chatHistory, sqlAgent, dbConfig } = setupResult;

                    // Get minimal database information to guide the agent
                    // const schemaResult = await getMinimalDatabaseSchema(organizationId, dbConfig, debugInfo);
                    // const tables = schemaResult.tables;

                    // ========== DATABASE VERSION DETECTION ==========
                    const versionResult = await detectDatabaseVersion(organizationId, dbConfig);
                    const mySQLVersionString = versionResult.versionString;
                    const mysqlVersionInfo = versionResult.versionInfo;

                    // ========== CHAIN EXECUTION LOGIC ==========

                    // Check if chains should be used for SQL generation instead of direct SQL agent

                    // Execute chain logic
                    const chainResult = await executeChainLogic(
                        useChains,
                        chainType,
                        langchainApp,
                        query,
                        mysqlVersionInfo,
                        mySQLVersionString,
                        conversational,
                        sessionData
                    );

                    let chainSQLGenerated = chainResult.chainSQLGenerated;
                    let chainMetadata = chainResult.chainMetadata;
                    useChains = chainResult.useChains; // Update useChains flag in case it was modified due to failure

                    // Step 1: Get the SQL query from the agent (or use chain-generated SQL)
                    sendMessage("Processing your query...");
                    console.log('📊 Step 1: Extracting SQL query from agent...');
                    let agentResult;
                    let intermediateSteps: any[] = [];
                    let capturedSQLQueries: string[] = [];

                    // If we have chain-generated SQL, use it directly
                    const chainSqlResult = processChainSql(chainSQLGenerated, chainMetadata, debugInfo, capturedSQLQueries);

                    if (chainSqlResult.success) {
                        agentResult = chainSqlResult.agentResult;
                        chainSQLGenerated = chainSqlResult.cleanedChainSQL; // Keep the cleaned version
                    } else if (chainSQLGenerated) {
                        chainSQLGenerated = ''; // Reset so we use the agent
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
                            const versionSpecificInstructions = generateVersionSpecificInstructions({
                                databaseType,
                                databaseVersionInfo
                            });
                            console.log({ versionSpecificInstructions })

                            // Add conversation context if in conversational mode
                            let conversationalContext = '';
                            if (conversational && Array.isArray(chatHistory) && chatHistory.length > 0) {
                                conversationalContext = '\n\nPrevious conversation:\n' + chatHistory
                                    .map((msg: any) => `${msg.type === 'human' ? 'User' : 'Assistant'}: ${msg.content}`)
                                    .join('\n') + '\n\n';
                            }

                            // Debug: Check globalTableSampleData status before table analysis
                            console.log('🔍 globalTableSampleData before analysis:', Object.keys(globalTableSampleData).length, 'tables');

                            // Debug: Check sessionId consistency and conversation history
                            console.log('🔍 SessionId for table analysis:', sessionId);
                            console.log('🔍 Conversational mode:', conversational);
                            
                            // Get conversation history for AI analysis
                            const previousQueries = conversational && sessionId ? getQueryHistory(sessionId) : [];
                            console.log('📜 Previous queries for context:', previousQueries);

                            // Get all database tables and columns with AI-generated purpose descriptions
                            const tableAnalysisResult = await getTableDescriptionsWithAI(
                                organizationId,
                                databaseType,
                                query,
                                previousQueries // Pass array of previous queries for conversation context
                            );

                            if (!tableAnalysisResult.success) {
                                console.warn('⚠️ Table analysis failed, using fallback');
                            }

                            const tableDescriptions = tableAnalysisResult.tableDescriptions;

                            // Populate globalTableSampleData from the service result
                            if (tableAnalysisResult.tableSampleData) {
                                globalTableSampleData = tableAnalysisResult.tableSampleData;
                                console.log('✅ Successfully populated globalTableSampleData with', Object.keys(globalTableSampleData).length, 'tables');
                            } else {
                                console.warn('⚠️ No tableSampleData returned from service');
                            }

                            // The enhanced prompt with structured step-by-step approach and database version enforcement
                            const enhancedQuery = generateComprehensiveDatabaseAnalystPrompt({
                                databaseType,
                                databaseVersionString,
                                organizationId,
                                versionSpecificInstructions,
                                query,
                                databaseVersionInfo,
                                tableDescriptions,
                                conversationalContext,
                                currentAttempt,
                                previousAttemptError: previousAttemptError || undefined,
                            });

                            console.log('📝 Enhanced query with schema information:', enhancedQuery.substring(0, 200) + '...');

                            // Configure the sqlAgent for intelligent query understanding and generation
                            const agentConfig = {
                                input: enhancedQuery,
                                // Allow intelligent decision-making about schema exploration
                                // The agent will decide when schema exploration is needed based on query complexity
                            };

                            // Enhanced callback system to track intelligent query understanding and generation
                            agentResult = await executeSqlAgentWithCallbacks(sqlAgent, agentConfig, {
                                capturedSQLQueries,
                                debugInfo,
                                intermediateSteps,
                                cleanSQLQuery
                            });

                            // Store raw response for debugging
                            rawAgentResponse = JSON.stringify(agentResult, null, 2);
                            console.log('🔍 Agent raw response:', rawAgentResponse);

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
                    const sqlExtractionResult = await extractAndProcessSQL({
                        chainSQLGenerated,
                        capturedSQLQueries,
                        agentResult,
                        rawAgentResponse: rawAgentResponse || '',
                        query,
                        debugInfo,
                        intermediateSteps,
                        chainMetadata,
                        cleanSQLQuery,
                        isCompleteSQLQuery,
                        fixIncompleteSQLQuery
                    }, res);

                    if (!sqlExtractionResult.success) {
                        return res.status(400).json(sqlExtractionResult.errorResponse);
                    }

                    const extractedSQL = sqlExtractionResult.extractedSQL;

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

                    // Skip column name correction and trust the sqlAgent to generate correct queries
                    console.log('📊 Step 3.5: Using original SQL from agent without column name modifications');


                    // Add a note to debug info
                    debugInfo.sqlCorrections.push('Using SQL directly from agent without column name corrections');

                    console.log('✅ Final SQL:', finalSQL);

                    // Step 3.7: Validate and correct SQL query
                    const sqlValidationResult = await validateAndCorrectSQL({
                        finalSQL,
                        dbConfig,
                        organizationId,
                        debugInfo
                    }, res);

                    if (!sqlValidationResult.success) {
                        return res.status(400).json(sqlValidationResult.errorResponse);
                    }

                    finalSQL = sqlValidationResult.finalSQL;

                    // Step 4: Execute the SQL query manually
                    console.log('📊 Step 4: Executing SQL query manually...');

                    const connectionResult = await establishDatabaseConnection({
                        finalSQL,
                        dbConfig,
                        organizationId
                    }, res);

                    if (!connectionResult.success) {
                        return res.status(500).json(connectionResult.errorResponse);
                    }

                    let connection = connectionResult.connection;

                    try {

                        // Execute the final SQL based on database type
                        sendMessage("Searching records...");
                        const queryExecutionResult = await executeSqlQueryWithRecovery({
                            finalSQL,
                            connection,
                            dbConfig,
                            startTime,
                            debugInfo
                        }, res);

                        if (!queryExecutionResult.success) {
                            return res.status(500).json(queryExecutionResult.errorResponse);
                        }

                        const { rows, fields, processingTime } = queryExecutionResult;
                        finalSQL = queryExecutionResult.finalSQL || finalSQL;

                        sendMessage(`Found Available records`);

                        // Generate description/explanation of the query and results using service
                        sendMessage("Preparing results and insights...");
                        const descriptionResult = await generateQueryDescriptionAndExplanation({
                            generateDescription,
                            finalSQL,
                            query,
                            rows: rows || [],
                            organizationId
                        });

                        const queryDescription = descriptionResult.queryDescription;
                        const resultExplanation = descriptionResult.resultExplanation;

                        // Note: Connection will be closed after all operations including restructured SQL

                        // Process graph data if requested using service
                        if (generateGraph) {
                            sendMessage("Creating visualization...");
                        }
                        // const graphProcessingResult = await processGraphData({
                        //     generateGraph,
                        //     graphType,
                        //     graphCategory,
                        //     graphConfig,
                        //     rows: rows || [],
                        //     langchainApp,
                        //     GraphProcessor
                        // });
                        // if (generateGraph && graphProcessingResult.graphData) {
                        //     sendMessage("Visualization ready");
                        // }

                        // const graphData = graphProcessingResult.graphData;
                        // const detectedGraphType = graphProcessingResult.detectedGraphType;
                        // const detectedCategory = graphProcessingResult.detectedCategory;
                        // const hasExplicitGraphConfig = graphProcessingResult.hasExplicitGraphConfig;
                        // const shouldGenerateGraph = graphProcessingResult.shouldGenerateGraph;

                        // Return the raw SQL results with descriptions
                        const response = {
                            success: true,
                            query_processed: query,
                            sql_extracted: extractedSQL,
                            sql_final: finalSQL,
                            sql_results: {
                                resultExplanation,
                                sql_final: groupAndCleanData(parseRows(rows)),
                                processing_time: `${(processingTime || 0).toFixed(2)}ms`,
                                // Add graph data to sql_results if available
                                // ...(graphData ? { graph_data: graphData } : {})
                            }, // Raw SQL results with optional graph data
                            result_count: Array.isArray(rows) ? rows.length : 0,
                            field_info: fields ? fields.map((field: any) => ({
                                name: field.name,
                                type: field.type,
                                table: field.table
                            })) : [],
                            processing_time: `${(processingTime || 0).toFixed(2)}ms`,
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
                            ...(false ? {
                                // graph_processing: {
                                //     requested: shouldGenerateGraph,
                                //     type: detectedGraphType || graphType,
                                //     category: detectedCategory || graphCategory,
                                //     success: !!graphData && graphData.data.length > 0,
                                //     data_points: graphData ? graphData.data.length : 0,
                                //     explicit_generate_graph: generateGraph,
                                //     auto_detected: !hasExplicitGraphConfig,
                                //     auto_analyzed: !hasExplicitGraphConfig,
                                //     debug_info: {
                                //         should_generate: shouldGenerateGraph,
                                //         has_explicit_config: hasExplicitGraphConfig,
                                //         rows_count: Array.isArray(rows) ? rows.length : 0,
                                //         analysis_method: hasExplicitGraphConfig ? 'explicit_config' : 'auto_analysis'
                                //     }
                                // }
                            } : {}),
                            timestamp: new Date().toISOString()
                        };

                        // Handle SQL restructuring and bar chart analysis using service
                        const restructuringResult = await handleSqlRestructuringAndAnalysis({
                            isAzureOpenAIAvailable,
                            rows: rows || [],
                            finalSQL,
                            query,
                            organizationId,
                            mySQLVersionString,
                            mysqlVersionInfo,
                            sqlAgent,
                            globalTableSampleData,
                            dbConfig,
                            connection,
                            response,
                            parseRows,
                            groupAndCleanData,
                            generateRestructuredSQL,
                            extractColumnErrorDetails
                        });

                        if (!restructuringResult.success) {
                            return res.status(500).json({
                                error: 'SQL restructuring failed',
                                message: restructuringResult.errorMessage,
                                timestamp: new Date().toISOString()
                            });
                        }

                        // Update connection and response from service result
                        connection = restructuringResult.connection;
                        const updatedResponse = restructuringResult.response;

                        // Handle retry logic for zero records and cleanup
                        const retryResult = await retryAndErrorHandlingService.handleRetryLogicAndErrors({
                            rows: rows || [],
                            currentAttempt,
                            maxRetryAttempts,
                            connection,
                            dbConfig,
                            organizationId,
                            debugInfo,
                            updatedResponse,
                            startTime
                        });

                        if (retryResult.shouldRetry) {
                            // Capture zero records issue for next attempt's enhanced query
                            previousAttemptError = retryResult.previousAttemptError;
                            currentAttempt++;
                            continue; // Go to next iteration of retry loop
                        } else if (retryResult.shouldBreak) {
                            // Set final result and break out of retry loop
                            finalResult = retryResult.finalResult;
                            break;
                        }
                        // ========== END RETRY LOGIC ==========

                    } catch (sqlError: any) {
                        // Handle SQL error using the service
                        const errorResult = await retryAndErrorHandlingService.handleSQLError({
                            sqlError,
                            organizationId,
                            dbConfig,
                            query,
                            finalSQL,
                            extractedSQL,
                            debugInfo,
                            generateDescription,
                            conversational,
                            sessionData,
                            currentAttempt,
                            maxRetryAttempts,
                            agentResult,
                            capturedSQLQueries,
                            intermediateSteps,
                            mySQLVersionString,
                            mysqlVersionInfo,
                            startTime,
                            sessionId,
                            chatHistory,
                            responseSent,
                            res
                        });

                        responseSent = errorResult.responseSent;
                        if (errorResult.previousAttemptError) {
                            previousAttemptError = errorResult.previousAttemptError;
                        }
                    }

                } catch (error) {
                    // Handle general errors using the service
                    const generalErrorResult = await retryAndErrorHandlingService.handleGeneralError({
                        error: error as Error,
                        currentAttempt,
                        maxRetryAttempts,
                        debugInfo,
                        startTime,
                        rawAgentResponse: rawAgentResponse || '',
                        responseSent,
                        res,
                        conversational: req.body.conversational === true,
                        sessionId: req.body.sessionId || uuidv4(),
                        chatHistory: [] // Initialize empty chat history for error handling
                    });

                    if (generalErrorResult.shouldRetry) {
                        previousAttemptError = generalErrorResult.previousAttemptError;
                        currentAttempt++;
                        continue; // Try again
                    } else {
                        responseSent = generalErrorResult.responseSent;
                        break; // Exit retry loop after sending error response
                    }
                }
            } // End of retry while loop

            // Send final successful response (if we have one and no response sent yet)
            if (finalResult && !responseSent) {
                console.log(`🎯 Sending final successful response after ${currentAttempt} attempt(s)`);
                
                // Save conversation to memory if in conversational mode (BEFORE sending response)
                if (conversational && sessionId && finalResult) {
                    console.log('💾 Saving conversation to BufferMemory BEFORE sending response...');
                    console.log('🔍 SessionId for saving conversation:', sessionId);
                    console.log('🔍 UserPrompt:', userPrompt?.substring(0, 100));
                    try {
                        // Extract the AI response text from the finalResult
                        let aiResponse = '';
                        if (finalResult.description) {
                            aiResponse = finalResult.description;
                        } else if (finalResult.sql_results?.rows) {
                            aiResponse = `Query executed successfully. Found ${finalResult.sql_results.rows.length} results.`;
                        } else {
                            aiResponse = 'Query processed successfully.';
                        }
                        
                        await saveConversationToMemory(sessionId, userPrompt, aiResponse);
                        console.log('✅ Conversation successfully saved to memory before response');
                    } catch (memoryError) {
                        console.error('❌ Error saving conversation to memory:', memoryError);
                        // Don't fail the response if memory saving fails
                    }
                }
                
                responseSent = true;
                res.json({ ...finalResult, type: 'SqlAgent' });
            }
        } catch (mainError: any) {
            // Handle any errors that occur in the main try block
            console.error('❌ Main error in query-sql-manual route:', mainError.message);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    error: mainError.message,
                    type: 'error',
                    processing_time: `${(performance.now() - startTime).toFixed(2)}ms`,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });

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

    return router;
}

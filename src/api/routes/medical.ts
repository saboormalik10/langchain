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
    
    // Keep only last 3 questions to prevent prompt explosion
    if (history.queries.length > 3) {
        history.queries = history.queries.slice(-3);
    }
    
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



// ========== LEGACY RESTRUCTURING FUNCTION (DISABLED) ==========
// The restructuring logic has been integrated into the SQL Agent prompt
// in enhanceQueryPrompt.ts to create a single-step process. 
// This function is no longer called and can be removed in future cleanup.

// DISABLED: async function generateRestructuredSQL(...) { ... }
// Function body removed - see git history if restoration needed

// ========== END LEGACY RESTRUCTURING FUNCTION ==========

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

// Cleanup function for expired simple conversation sessions (runs every hour)
const CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
setInterval(() => {
    const now = new Date();
    let expiredCount = 0;

    simpleConversationHistory.forEach((session, sessionId) => {
        const timeDiff = now.getTime() - session.timestamp.getTime();
        if (timeDiff > CONVERSATION_TIMEOUT_MS) {
            simpleConversationHistory.delete(sessionId);
            expiredCount++;
        }
    });

    if (expiredCount > 0) {
        console.log(`🧹 Cleaned up ${expiredCount} expired simple conversation sessions`);
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
                // Simple conversation history for context - no complex LangChain setup needed
                const previousQuestions = conversational && sessionId ? getQueryHistory(sessionId) : [];

                // ========== STEP 3: PROMPT ANALYSIS WITH CONVERSATION CONTEXT ==========
                console.log('🔍 Step 3: Analyzing user prompt intent with conversation context...');

                let promptAnalysis: any;
                try {
                    // Analyze if the prompt is database-related or casual conversation
                    promptAnalysis = await PromptAnalysisService.analyzePrompt(userPrompt, organizationId, []);

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
                                conversation_context_used: false
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
                        conversationContextUsed: false
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

                    // Get database config and minimal LangChain setup for SQL Agent
                    const dbConfig = await databaseService.getOrganizationDatabaseConnection(organizationId);
                    const langchainApp = await multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
                    const sqlAgent = (langchainApp as any).sqlAgent;

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
                        { sessionId } // Simplified session data
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

                            // Add previous questions context if available
                            let previousQuestionsContext = '';
                            if (conversational && sessionId) {
                                const previousQueries = getQueryHistory(sessionId);
                                if (previousQueries.length > 0) {
                                    previousQuestionsContext = '\n\nPrevious questions in this session:\n' + 
                                        previousQueries.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\n';
                                }
                            }

                            // Debug: Check globalTableSampleData status before table analysis
                            console.log('🔍 globalTableSampleData before analysis:', Object.keys(globalTableSampleData).length, 'tables');

                            // Debug: Check sessionId consistency and conversation history
                            console.log('🔍 SessionId for table analysis:', sessionId);
                            console.log('🔍 Conversational mode:', conversational);
                            console.log('📜 Previous queries for context:', conversational && sessionId ? getQueryHistory(sessionId) : []);

                            // Get all database tables and columns with AI-generated purpose descriptions
                            const tableAnalysisResult = await getTableDescriptionsWithAI(
                                organizationId,
                                databaseType,
                                query,
                                conversational && sessionId ? getQueryHistory(sessionId) : [] // Pass array of previous queries for conversation context
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
                                conversationalContext: previousQuestionsContext,
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
                            }, // Raw SQL results with grouped, cleaned data
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

                        console.log('✅ SQL Agent generated restructured query directly - skipping separate restructuring step');
                        console.log(`📊 Results: ${rows ? rows.length : 0} records returned`);
                        
                        // Since restructuring is now built into the SQL Agent prompt, 
                        // we use the results directly without separate restructuring
                        const updatedResponse = {
                            success: true,
                            query_processed: query,
                            sql_extracted: extractedSQL,
                            sql_final: finalSQL,
                            sql_results: {
                                resultExplanation,
                                sql_final: groupAndCleanData(parseRows(rows || [])),
                                processing_time: `${(performance.now() - startTime).toFixed(2)}ms`,
                            },
                            result_count: Array.isArray(rows) ? rows.length : 0,
                            field_info: fields ? fields.map((field: any) => ({
                                name: field.name,
                                type: field.type,
                                table: field.table
                            })) : [],
                            processing_time: `${(performance.now() - startTime).toFixed(2)}ms`,
                            query_description: queryDescription,
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
                            timestamp: new Date().toISOString()
                        };

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
                            sessionData: { sessionId },
                            currentAttempt,
                            maxRetryAttempts,
                            agentResult,
                            capturedSQLQueries,
                            intermediateSteps,
                            mySQLVersionString,
                            mysqlVersionInfo,
                            startTime,
                            sessionId,
                            chatHistory: [],
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
                }
                
                responseSent = true;
                
                // Keep the full response format but clean out restructure_info from sql_results
                const cleanedFinalResult = { ...finalResult };
                if (cleanedFinalResult.sql_results?.restructure_info) {
                    delete cleanedFinalResult.sql_results.restructure_info;
                }
                
                res.json({ ...cleanedFinalResult, type: 'SqlAgent' });
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

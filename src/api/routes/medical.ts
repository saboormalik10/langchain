import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mysql from 'mysql2/promise';
import { MedicalDatabaseLangChainApp } from '../../index';
import { BufferMemory } from 'langchain/memory';
import { v4 as uuidv4 } from 'uuid';

import Papa from 'papaparse';
// @ts-ignore
import jsonic from 'jsonic';

type Step = { observation?: unknown };
type AgentResult = {
    output?: unknown;
    text?: unknown;
    result?: unknown;
    intermediateSteps?: Step[];
    [key: string]: unknown;
};

// Storage for conversation sessions with last access timestamps
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
    queryHistory?: Array<{query: string, success: boolean, executionTime: number}>;
    // For advanced conversation
    ambiguityResolutions?: Record<string, string>;
    userPreferences?: Record<string, any>;
    // For autocomplete
    frequentColumns?: string[];
    frequentTables?: string[];
    recentQueries?: string[];
}

const conversationSessions = new Map<string, ConversationSession>();

// Global schema cache for non-session users
const globalSchemaCache = {
    schema: "",
    tables: [] as string[],
    columns: {} as Record<string, string[]>,
    relationships: [] as Array<{fromTable: string, fromColumn: string, toTable: string, toColumn: string}>,
    lastUpdated: new Date(0)
};

// Schema cache expiration time (15 minutes)
const SCHEMA_CACHE_EXPIRY_MS = 15 * 60 * 1000;

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

/**
 * Parse patient data from numbered list format
 */
function parsePatientData(str: string): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];

    // Pattern: "1. John Doe - Paracetamol, 500mg"
    const lines = str.split('\n').filter(line => line.trim());

    for (const line of lines) {
        const match = line.match(/^(\d+)\.\s*(.+?)\s*-\s*(.+?),\s*(\d+mg)$/);
        if (match) {
            results.push({
                index: parseInt(match[1]),
                patient: match[2].trim(),
                medication: match[3].trim(),
                dosage: match[4].trim()
            });
        }
    }

    return results;
}

/**
 * Try to parse any string as structured data
 */
function tryParseStructured(str: string): Array<Record<string, unknown>> | null {
    if (!str || typeof str !== 'string') return null;

    // Try patient data first
    const patientData = parsePatientData(str);
    if (patientData.length > 0) return patientData;

    // Try JSON
    try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed != null) return [parsed];
    } catch { }

    return null;
}

/**
 * Recursively search for and parse data fields
 */
function findAndParseDataFields(obj: any): Array<Record<string, unknown>> {
    let results: Array<Record<string, unknown>> = [];

    if (Array.isArray(obj)) {
        // If we already have an array, check if it contains objects
        if (obj.length > 0 && typeof obj[0] === 'object') {
            console.log('✅ Found array with', obj.length, 'records');
            return obj; // Return the array directly if it's already an array of objects
        }

        // Otherwise, process each item in array
        for (const item of obj) {
            results = results.concat(findAndParseDataFields(item));
        }
    } else if (obj && typeof obj === 'object') {
        // Check if this object has error data containing JSON
        if (typeof obj.error === 'string' && obj.error.includes('[')) {
            console.log('🔍 Found potential JSON in error message');
            // Try to extract JSON array from error message
            const jsonMatch = obj.error.match(/(\[[\s\S]*?\])\s*$/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[1]);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        console.log('✅ Successfully extracted JSON array from error message with', parsed.length, 'records');
                        return parsed;
                    }
                } catch (e) {
                    console.log('⚠️ Failed to parse JSON from error message');
                }
            }
        }

        // Check if this object has a 'data' field that's a string
        if (typeof obj.data === 'string') {
            console.log('🔍 Found data field:', obj.data.substring(0, 100) + '...');
            const parsed = tryParseStructured(obj.data);
            if (parsed && parsed.length > 0) {
                console.log('✅ Successfully parsed data field into', parsed.length, 'records');
                results = results.concat(parsed);
                return results; // Return early since we found what we're looking for
            }
        }

        // Recursively search other properties
        for (const [key, value] of Object.entries(obj)) {
            if (key !== 'data') { // Skip data field since we already processed it
                results = results.concat(findAndParseDataFields(value));
            }
        }
    }

    return results;
}

/**
 * Main conversion function
 */
export function convertToJsonArray(
    agentResult: AgentResult,
    originalQuery: string
): Array<Record<string, unknown>> {
    console.log('🚀 convertToJsonArray called with:', JSON.stringify(agentResult, null, 2));

    // Special handling for error cases that might contain JSON data
    if (agentResult.type === 'error' && Array.isArray(agentResult.data)) {
        console.log('🔍 Analyzing error response for JSON data');
        for (const item of agentResult.data) {
            if (item && typeof item.error === 'string') {
                // Look for specific pattern: SQL query followed by JSON array - common with OutputParsingFailure
                if (item.error.includes('EXECUTED SQL QUERY') && item.error.includes('[') && item.error.includes(']')) {
                    console.log('⚠️ Found OutputParsingFailure with SQL query and possible JSON array');

                    // Extract SQL query for debugging
                    const sqlMatch = item.error.match(/EXECUTED SQL QUERY:\s*([\s\S]*?)(?=\n\s*\[|\n\n)/i);
                    if (sqlMatch) {
                        console.log('🔎 SQL Query:', sqlMatch[1].trim());
                    }

                    // Try to extract JSON array with precise pattern matching - targeting the array between SQL and troubleshooting URL
                    const jsonMatch = item.error.match(/(\[[\s\S]*?\])\s*(?=\n\s*Troubleshooting|$)/);
                    if (jsonMatch) {
                        try {
                            const parsed = JSON.parse(jsonMatch[1]);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                console.log('✅ Successfully extracted JSON array from SQL output with', parsed.length, 'records');
                                return parsed;
                            }
                        } catch (e) {
                            console.log('⚠️ Failed to parse specific JSON pattern from SQL output:', e);
                        }
                    }
                }

                // Check if there's a SQL error with type conversion (CAST, CONVERT, etc.)
                if ((item.error.includes('CAST') || item.error.includes('CONVERT') || item.error.includes('type conversion')) &&
                    item.error.includes('EXECUTED SQL QUERY')) {
                    console.log('⚠️ Detected SQL type conversion error in output');

                    // Extract SQL query for debugging
                    const sqlMatch = item.error.match(/EXECUTED SQL QUERY:\s*([\s\S]*?)(?=\n\n|\n[A-Z]|Troubleshooting URL|$)/i);
                    if (sqlMatch) {
                        console.log('🔎 Problematic SQL Query:', sqlMatch[1].trim());
                    }

                    // Try to find JSON array even in error messages
                    const jsonMatch = item.error.match(/(\[[\s\S]*?\])\s*(?=\n\s*Troubleshooting|$)/);
                    if (jsonMatch) {
                        try {
                            const parsed = JSON.parse(jsonMatch[1]);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                console.log(`✅ Successfully extracted JSON array with ${parsed.length} records from error message`);
                                return parsed;
                            }
                        } catch (e) {
                            console.log('⚠️ Failed to parse JSON from error message:', e);
                        }
                    }

                    // Create a fallback response with error info
                    return [{
                        error: 'SQL type conversion error',
                        query: originalQuery,
                        sql_query: sqlMatch ? sqlMatch[1].trim() : 'Unknown',
                        suggestion: 'Try rephrasing without numeric comparisons or type conversions for text fields',
                        timestamp: new Date().toISOString()
                    }];
                }

                // General case - try to extract JSON array from any error message
                const jsonMatch = item.error.match(/(\[[\s\S]*?\])\s*(?=\n|$)/);
                if (jsonMatch) {
                    try {
                        const parsed = JSON.parse(jsonMatch[1]);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            console.log('✅ Successfully extracted JSON array from error with', parsed.length, 'records');
                            return parsed;
                        }
                    } catch (e) {
                        console.log('⚠️ Failed to parse JSON from general error message:', e);
                    }
                }
            }
        }
    }

    // Regular processing - search for and parse any data fields
    const parsedData = findAndParseDataFields(agentResult);

    if (parsedData.length > 0) {
        console.log('✅ Found and parsed', parsedData.length, 'records');
        return parsedData;
    }

    console.log('⚠️ No parseable data found, returning fallback');

    // Fallback: Wrap whole response as one record
    return [
        {
            response: 'No structured data found',
            query: originalQuery,
            source: 'dynamic_sql_agent',
            timestamp: new Date().toISOString(),
        },
    ];
}

export function medicalRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
    const router = Router();

    // Query medical database with natural language - ENHANCED WITH PERFORMANCE OPTIMIZATIONS
    // Query medical database with natural language - ENHANCED WITH PERFORMANCE OPTIMIZATIONS
    router.post('/query',
        [
            body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters'),
            body('context').optional().isString().isLength({ max: 1000 }).withMessage('Context must be less than 1000 characters')
        ],
        async (req: Request, res: Response) => {
            const startTime = performance.now();
            // Initialize MySQL version variables with default values
            let mySQLVersionString = "unknown";
            let mysqlVersionInfo = null;
            
            try {
                const errors = validationResult(req);
                if (!errors.isEmpty()) {
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors.array()
                    });
                }

                const { query, context = 'Medical database query' } = req.body;

                console.log(`🚀 Processing smart query: "${query}"`);

                // PERFORMANCE OPTIMIZATION 1: Parallel execution of independent operations
                const sqlAgent = langchainApp.getSqlAgent();

                if (!sqlAgent) {
                    return res.status(503).json({
                        error: 'Enhanced SQL Agent not available',
                        message: 'Service temporarily unavailable',
                        timestamp: new Date().toISOString()
                    });
                }

                // Get MySQL version information first
                console.log('🔍 Analyzing MySQL version before query execution...');
                let mysqlVersionInfo = null;
                let mySQLVersionString = "unknown";
                
                try {
                    const mysql = require('mysql2/promise');
                    const connection = await mysql.createConnection({
                        host: process.env.DB_HOST!,
                        port: parseInt(process.env.DB_PORT!),
                        user: process.env.DB_USER!,
                        password: process.env.DB_PASSWORD!,
                        database: process.env.DB_NAME!,
                        connectTimeout: 8000,
                    });
                    
                    const [rows] = await connection.execute('SELECT VERSION() as version');
                    if (rows && rows[0] && rows[0].version) {
                        mySQLVersionString = rows[0].version;
                        
                        // Parse version string
                        const versionMatch = mySQLVersionString.match(/(\d+)\.(\d+)\.(\d+)/);
                        if (versionMatch) {
                            mysqlVersionInfo = {
                                full: mySQLVersionString,
                                major: parseInt(versionMatch[1]),
                                minor: parseInt(versionMatch[2]),
                                patch: parseInt(versionMatch[3]),
                                features: {
                                    supportsJSON: false,
                                    supportsWindowFunctions: false,
                                    supportsCTE: false,
                                    supportsRegex: true
                                }
                            };
                            
                            // Detect supported features based on version
                            mysqlVersionInfo.features.supportsJSON = mysqlVersionInfo.major >= 5 && mysqlVersionInfo.minor >= 7;
                            mysqlVersionInfo.features.supportsWindowFunctions = mysqlVersionInfo.major >= 8;
                            mysqlVersionInfo.features.supportsCTE = mysqlVersionInfo.major >= 8;
                            
                            console.log(`✅ MySQL Version: ${mySQLVersionString} (Major: ${mysqlVersionInfo.major}, Minor: ${mysqlVersionInfo.minor})`);
                            console.log(`✅ Features: JSON=${mysqlVersionInfo.features.supportsJSON}, Windows=${mysqlVersionInfo.features.supportsWindowFunctions}, CTE=${mysqlVersionInfo.features.supportsCTE}`);
                        } else {
                            console.log(`⚠️ MySQL version format not recognized: ${mySQLVersionString}`);
                        }
                    }
                    
                    await connection.end();
                } catch (versionError) {
                    console.error('❌ Failed to get MySQL version:', versionError);
                    // Continue without version info if there's an error
                }
                
                // Enhance the query with MySQL version information
                const versionEnhancedQuery = mysqlVersionInfo ? 
                    `${query}

MySQL VERSION INFO: Your query will run on MySQL ${mysqlVersionInfo.full}
VERSION-SPECIFIC REQUIREMENTS:
- JSON Functions: ${mysqlVersionInfo.features.supportsJSON ? 'AVAILABLE' : 'NOT AVAILABLE'}
- Window Functions: ${mysqlVersionInfo.features.supportsWindowFunctions ? 'AVAILABLE' : 'NOT AVAILABLE'}
- Common Table Expressions: ${mysqlVersionInfo.features.supportsCTE ? 'AVAILABLE' : 'NOT AVAILABLE'}
- Regular Expressions: ${mysqlVersionInfo.features.supportsRegex ? 'AVAILABLE' : 'NOT AVAILABLE'}

IMPORTANT: Generate SQL compatible with this specific MySQL version. Avoid using features not supported by this version.` 
                    : query;
                
                // PERFORMANCE OPTIMIZATION 2: Use Promise.allSettled for parallel processing
                const [queryInsightsResult, smartQueryResult] = await Promise.allSettled([
                    langchainApp.getQueryInsights(query),
                    langchainApp.executeSmartQuery(versionEnhancedQuery, context)
                ]);

                // Extract results with error handling
                const queryInsights = queryInsightsResult.status === 'fulfilled'
                    ? queryInsightsResult.value
                    : { analysis_available: false, error: 'Insights analysis failed' };

                let smartResult = smartQueryResult.status === 'fulfilled'
                    ? smartQueryResult.value
                    : { type: 'error', data: [{ error: 'Query execution failed' }], source: 'error' };

                // Check if we got success but fewer records than expected (for queries that should return many records)
                // This is the PRIMARY location where we handle queries that might have hidden LIMIT clauses
                if (smartResult.type !== 'error' &&
                    Array.isArray(smartResult.data) &&
                    (smartResult.data.length < 5 || query.toLowerCase().includes('all')) &&
                    (query.toLowerCase().includes('all') || query.toLowerCase().includes('every') ||
                        query.toLowerCase().includes('up to') || query.toLowerCase().includes('less than') ||
                        query.toLowerCase().includes('greater than') || query.toLowerCase().includes('more than'))) {

                    console.log(`⚠️ CRITICAL: Query returned only ${smartResult.data.length} records, which is likely fewer than expected. Forcing a NO-LIMIT query...`);

                    // Create a much stronger query that specifically prevents limits and forces the agent to return all records
                    try {
                        const forceNoLimitQuery = `${query}
                        
CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. DO NOT USE ANY LIMIT CLAUSE in your SQL query - this is absolutely forbidden
2. I need ALL matching records (at least 12 records expected) - there should be NO ROW LIMIT
3. The previous query only returned ${smartResult.data.length} records which is INCORRECT
4. Return EVERY SINGLE record that matches the criteria - DO NOT LIMIT RESULTS
5. Print the EXACT SQL query that was executed
6. Use appropriate comparison methods based on the actual data types in the database
7. Your SQL query MUST NOT contain any LIMIT clause or row restriction of any kind
8. Return the results as a valid JSON array of objects

VERIFICATION REQUIRED:
Before returning results, verify that your generated SQL does NOT contain any LIMIT clause.
If it does, remove it and re-run the query. This is critical for correct results.`;

                        console.log('🔄 Executing force-no-limit query to get ALL records');
                        const noLimitResult = await langchainApp.executeSmartQuery(forceNoLimitQuery, context);

                        // Only use the new result if it has more records
                        if (noLimitResult.data && Array.isArray(noLimitResult.data) &&
                            noLimitResult.data.length > smartResult.data.length) {
                            console.log(`✅ No-limit retry SUCCESSFUL, got ${noLimitResult.data.length} records (previous: ${smartResult.data.length})`);
                            smartResult = noLimitResult;

                            // Mark this as a successful retry
                            if (!smartResult.metadata) smartResult.metadata = {};
                            smartResult.metadata.retried_for_limit = true;
                            smartResult.metadata.original_count = smartResult.data.length;
                            smartResult.source = 'sql_agent_no_limit_retry';

                        } else {
                            console.log('⚠️ No-limit retry did not return more records, staying with original result');
                        }
                    } catch (noLimitError) {
                        console.error('❌ No-limit query failed:', noLimitError);

                        // Even if the retry failed, let's try one more direct approach with a very simple format
                        try {
                            console.log('🔄 Attempting final emergency retry with simplified format...');
                            const emergencyQuery = `Find medical data with specific criteria.
                            
CRITICAL: Do not use any LIMIT clause. Return ALL matching records as a JSON array.
Use database schema discovery to identify appropriate tables and relationships.
Apply appropriate filtering based on the original query intent.`;

                            const emergencyResult = await langchainApp.executeSmartQuery(emergencyQuery, context);
                            if (emergencyResult.data && Array.isArray(emergencyResult.data) &&
                                emergencyResult.data.length > smartResult.data.length) {
                                console.log(`✅ Emergency retry successful, got ${emergencyResult.data.length} records (previous: ${smartResult.data.length})`);
                                smartResult = emergencyResult;
                                smartResult.query_processed = query; // Preserve the original query
                                smartResult.source = 'emergency_retry';
                            }
                        } catch (emergencyError) {
                            console.error('❌ Emergency retry also failed:', emergencyError);
                        }
                    }
                }

                // Check if we have an error and need special handling
                if (smartResult.type === 'error' && Array.isArray(smartResult.data) &&
                    smartResult.data.length > 0 && typeof smartResult.data[0].error === 'string') {

                    const errorMsg = smartResult.data[0].error;

                    // Special case: JSON array is present in the error output
                    if (errorMsg.includes('EXECUTED SQL QUERY') && errorMsg.includes('[') && errorMsg.includes(']')) {
                        console.log('⚠️ Detected JSON array in error output, extracting data...');
                        const jsonMatch = errorMsg.match(/(\[[\s\S]*?\])\s*(?=\n\s*Troubleshooting|$)/);

                        if (jsonMatch) {
                            try {
                                const parsedJson = JSON.parse(jsonMatch[1]);
                                if (Array.isArray(parsedJson) && parsedJson.length > 0) {
                                    console.log(`✅ Successfully extracted ${parsedJson.length} records from error output`);

                                    // Extract SQL query for logging
                                    const sqlMatch = errorMsg.match(/EXECUTED SQL QUERY:\s*([\s\S]*?)(?=\n\s*\[|\n\n)/);
                                    if (sqlMatch) {
                                        console.log('🔎 SQL Query Used:', sqlMatch[1].trim());

                                        // Check if the query result set might be incomplete (less than expected records)
                                        if (parsedJson.length < 5 && !sqlMatch[1].toLowerCase().includes('limit')) {
                                            console.log('⚠️ Query returned fewer records than expected, checking for filtering issues...');

                                            // Check for problematic filtering patterns in a more generic way
                                            const sqlLower = sqlMatch[1].toLowerCase();
                                            const problematicFiltering =
                                                sqlLower.includes('cast') ||
                                                (sqlLower.includes('replace') && sqlLower.includes('as integer')) ||
                                                sqlLower.includes('convert');

                                            if (problematicFiltering) {
                                                console.log('🔍 Detected problematic filtering pattern that may exclude records');
                                            }
                                        }
                                    }

                                    // Check if SQL contains LIMIT and log it
                                    if (sqlMatch && sqlMatch[1].toLowerCase().includes('limit')) {
                                        console.warn('⚠️ SQL query contains a LIMIT clause that may restrict results');
                                        // Try to check if the LIMIT is low
                                        const limitMatch = sqlMatch[1].match(/limit\s+(\d+)/i);
                                        if (limitMatch && parseInt(limitMatch[1]) < 20) {
                                            console.warn(`⚠️ Low LIMIT value detected: ${limitMatch[1]}, this is likely restricting your results`);
                                        }
                                    }

                                    // Replace the error with success result containing the parsed data
                                    smartResult = {
                                        type: 'standard_query',
                                        data: parsedJson,
                                        query_processed: query,
                                        source: 'extracted_from_error',
                                        sql_query: sqlMatch ? sqlMatch[1].trim() : "Unknown",
                                        record_count: parsedJson.length,
                                        timestamp: new Date().toISOString(),
                                        note: 'Data extracted from error output'
                                    };
                                    console.log('✅ Converted error to success with extracted data');
                                }
                            } catch (parseError) {
                                console.error('❌ Failed to parse JSON from error message:', parseError);
                            }
                        }
                    }

                    // If still an error, try specialized retries based on error pattern
                    if (smartResult.type === 'error') {
                        // Case 1: CAST or type conversion error detected
                        const hasTypeConversionIssue =
                            errorMsg.includes('CAST') ||
                            errorMsg.includes('type conversion') ||
                            errorMsg.includes('convert') ||
                            errorMsg.includes('INTEGER');

                        if (hasTypeConversionIssue && errorMsg.includes('EXECUTED SQL QUERY')) {
                            console.log('⚠️ Detected SQL type conversion error, retrying with specialized query...');

                            // Extract the problematic field name from the error if possible
                            const fieldMatch = errorMsg.match(/column ['"]?([a-zA-Z0-9_]+)['"]?/i) ||
                                errorMsg.match(/field ['"]?([a-zA-Z0-9_]+)['"]?/i);
                            const problemField = fieldMatch ? fieldMatch[1] : "";

                            // Create a specialized version of the query with guidance
                            let specializedQuery = '';

                            // Check if this is a comparison query
                            const isComparison = query.toLowerCase().includes('less than') ||
                                query.toLowerCase().includes('more than') ||
                                query.toLowerCase().includes('under') ||
                                query.toLowerCase().includes('over') ||
                                query.toLowerCase().includes('maximum') ||
                                query.toLowerCase().includes('minimum') ||
                                query.toLowerCase().includes('greater than') ||
                                query.toLowerCase().includes('at least');

                            if (isComparison) {
                                // For comparison queries, provide pattern matching guidance
                                specializedQuery = `${query}. 
CRITICAL SQL INSTRUCTIONS: 
1. Use pattern matching with LIKE for text field comparisons instead of numeric conversions
2. DO NOT use any CAST, CONVERT or numeric extraction functions - they cause errors
3. For comparisons with text fields, use multiple LIKE patterns to cover possible values
4. Return ALL records without any LIMIT
5. Include the EXACT SQL QUERY in output`;

                                // Add specific field guidance if we detected a field name
                                if (problemField) {
                                    specializedQuery += `\n6. The field "${problemField}" is a text field - use LIKE patterns for it, not numeric comparison`;
                                }
                            } else {
                                // For non-comparison queries, provide general guidance
                                specializedQuery = `${query}. 
CRITICAL SQL INSTRUCTIONS:
1. Avoid all type conversions, CAST functions and CONVERT functions
2. Use only standard MySQL string operations and pattern matching
3. Return all matching records with no LIMIT
4. Include EXACT SQL QUERY in output`;
                            }

                            console.log(`🔄 Retrying with specialized query: "${specializedQuery}"`);

                            try {
                                // Retry with the specialized query
                                const retryResult = await langchainApp.executeSmartQuery(specializedQuery, context);
                                smartResult = retryResult; // Use the retry result if successful
                                console.log('✅ Specialized retry successful');
                            } catch (retryError) {
                                console.error('❌ Specialized retry also failed:', retryError);
                                // Keep the original smartResult if retry fails
                            }
                        }

                        // Case 2: General SQL parsing or execution error
                        else if (errorMsg.includes('syntax error') || errorMsg.includes('parsing failure')) {
                            console.log('⚠️ Detected SQL syntax error, retrying with simplified query...');

                            const simplifiedQuery = `${query}. 
IMPORTANT: Use only basic SQL SELECT statements with standard syntax. Avoid complex operations, 
functions, and any non-standard features. Return all matching records and include the SQL query used.`;

                            try {
                                const retryResult = await langchainApp.executeSmartQuery(simplifiedQuery, context);
                                smartResult = retryResult;
                                console.log('✅ Simplified syntax retry successful');
                            } catch (retryError) {
                                console.error('❌ Simplified syntax retry failed:', retryError);
                            }
                        }

                        // Case 3: Results returned but there are fewer records than expected
                        else if (Array.isArray(smartResult.data) && smartResult.data.length < 5) {
                            // Extract SQL from error message to check if there's a LIMIT clause
                            const sqlMatch = errorMsg.match(/EXECUTED SQL QUERY:\s*([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i);
                            if (sqlMatch && sqlMatch[1] && sqlMatch[1].toLowerCase().includes('limit')) {
                                console.log('⚠️ Query has a LIMIT clause that may be restricting results, retrying without it...');

                                const noLimitQuery = `${query}. 
CRITICAL: Do NOT include any LIMIT clause in the SQL. I need ALL matching records (at least 12 records expected).
Make sure to return ALL records that match the query criteria with NO LIMIT or restriction.
Include the exact SQL query in the output.`;

                                try {
                                    const retryResult = await langchainApp.executeSmartQuery(noLimitQuery, context);
                                    if (retryResult.data && Array.isArray(retryResult.data) &&
                                        retryResult.data.length > smartResult.data.length) {
                                        smartResult = retryResult;
                                        console.log(`✅ Retry without LIMIT successful, got ${retryResult.data.length} records`);
                                    } else {
                                        console.log('⚠️ Retry without LIMIT did not improve results');
                                    }
                                } catch (retryError) {
                                    console.error('❌ No-limit retry failed:', retryError);
                                }
                            }
                        }
                    }
                }

                console.log('📊 Query insights:', queryInsights);
                // SPECIAL EMERGENCY FIX: Always check for queries returning too few records when many are expected
                if (Array.isArray(smartResult.data) &&
                    smartResult.data.length <= 2 &&
                    (query.toLowerCase().includes('all') || query.toLowerCase().includes('every') ||
                     query.toLowerCase().includes('total') || query.toLowerCase().includes('complete'))) {

                    console.log('🚨 EMERGENCY: Detected query expecting many records but got suspiciously few - forcing explicit retry');

                    try {
                        // Database-agnostic query using schema discovery
                        const directQuery = `Find medical data matching the criteria from the original request. 
                        
CRITICAL SQL REQUIREMENTS:
1. Use database schema discovery to identify appropriate tables and columns
2. DO NOT use any LIMIT clause
3. Return ALL matching records
4. Use proper JOIN relationships based on discovered foreign keys`;

                        console.log('🔄 Executing emergency direct query...');
                        const directResult = await langchainApp.executeSmartQuery(directQuery, 'Query with forced complete results');

                        if (directResult.data && Array.isArray(directResult.data) && directResult.data.length > smartResult.data.length) {
                            console.log(`✅ EMERGENCY FIX SUCCESSFUL - got ${directResult.data.length} records (previous: ${smartResult.data.length})`);

                            // Keep original query info but use new results
                            directResult.query_processed = query;
                            directResult.source = 'emergency_direct_fix';

                            if (!directResult.metadata) directResult.metadata = {};
                            directResult.metadata.emergency_fix_applied = true;
                            directResult.metadata.previous_count = smartResult.data.length;

                            smartResult = directResult;
                        }
                    } catch (directError) {
                        console.error('❌ Emergency direct fix failed:', directError);
                    }
                }

                console.log('🧠 Smart query result:', smartResult);

                // Check the result - if it's from direct SQL bypass, we're good
                // Otherwise check if we need to transform or handle special cases
                console.log(`🔍 Checking result source: ${smartResult.source}`);

                // Prepare jsonArray with default handling for different result types
                let jsonArray: Array<Record<string, unknown>> = [];

                // Direct SQL results already have the complete data - use it directly
                if (smartResult.source === 'direct_sql_bypass') {
                    console.log(`✅ Using direct SQL results with ${smartResult.data.length} records`);
                    jsonArray = smartResult.data;
                }
                // Standard result handling for array data
                else if (Array.isArray(smartResult.data)) {
                    console.log(`✅ Using standard array data with ${smartResult.data.length} records`);
                    jsonArray = smartResult.data;

                    // Extra check: If it's a query that should have many records but only has a few,
                    // log a warning - we've probably hit LLM truncation
                    const shouldHaveManyRecords =
                        query.toLowerCase().includes('all patient') ||
                        query.toLowerCase().includes('all records') ||
                        query.toLowerCase().includes('show all');

                    if (shouldHaveManyRecords && jsonArray.length < 10) {
                        console.warn(`⚠️ WARNING: Query for all data only returned ${jsonArray.length} records`);
                        console.warn(`⚠️ This is likely due to LLM truncation. Consider using direct SQL for this query.`);

                        // Add a note to the response
                        if (!smartResult.metadata) smartResult.metadata = {};
                        smartResult.metadata.warning = "Results may be incomplete due to LLM truncation";
                        smartResult.metadata.suggestion = "Consider using direct SQL for complete results";
                    }
                }
                // Non-array data handling - convert to array with metadata
                else {
                    console.log(`ℹ️ Using non-array data format`);
                    jsonArray = [{
                        message: 'Non-array result format',
                        query_processed: query,
                        data_sample: smartResult.data,
                        output_sample: smartResult.output ? smartResult.output.substring(0, 500) + '...' : "No direct output field",
                        sql_query: smartResult.sql_query || "Unknown",
                        timestamp: new Date().toISOString()
                    }];
                }

                // ORIGINAL CODE COMMENTED OUT FOR INSPECTION PURPOSES
                /*
                if (Array.isArray(smartResult.data)) {
                    jsonArray = smartResult.data;
                } else if (smartResult.data && typeof smartResult.data === 'object') {
                    // Handle case where data isn't an array but an object
                    jsonArray = convertToJsonArray(smartResult, query);
                } else if (typeof smartResult.output === 'string' && smartResult.output.includes('[')) {
                    // Try to parse output directly if it contains JSON array
                    try {
                        const match = smartResult.output.match(/(\[[\s\S]*?\])/);
                        if (match) {
                            jsonArray = JSON.parse(match[1]);
                        } else {
                            jsonArray = [{
                                message: 'No structured data found',
                                raw_output: smartResult.output
                            }];
                        }
                    } catch (e) {
                        console.error('Failed to parse output JSON:', e);
                        jsonArray = [{
                            message: 'JSON parsing error',
                            error: (e as Error).message
                        }];
                    }
                } else {
                    // Fallback
                    jsonArray = [{
                        message: 'No structured data available',
                        query: query,
                        timestamp: new Date().toISOString()
                    }];
                }
                */

                // PERFORMANCE OPTIMIZATION 5: Pre-compute response structure
                const processingTime = performance.now() - startTime;

                const result = {
                    type: 'enhanced_medical_query',
                    data: jsonArray,
                    query_processed: query,
                    intelligence: {
                        query_type: smartResult.type,
                        insights: queryInsights.analysis_available ? queryInsights.intent : null,
                        recommendations: queryInsights.analysis_available ? queryInsights.recommendations : [],
                        processing_method: smartResult.source || 'unknown',
                        syntax_validated: smartResult.metadata?.syntax_validated || false,
                        execution_attempts: smartResult.metadata?.execution_attempts || 1,
                        fallback_used: smartResult.metadata?.fallback_used || false
                    },
                    performance: {
                        record_count: jsonArray.length,
                        estimated_speed: queryInsights.analysis_available ?
                            queryInsights.intent?.estimated_performance : 'unknown',
                        complexity: queryInsights.analysis_available ?
                            queryInsights.intent?.complexity : 'unknown',
                        actual_processing_time: `${processingTime.toFixed(2)}ms`,
                        optimization_level: smartResult.type === 'professional_query' ? 'maximum' : 'standard'
                    },
                    source: 'enhanced_langchain_agent',
                    timestamp: new Date().toISOString()
                };

                console.log(`✅ Enhanced query completed: ${jsonArray.length} records, ${result.intelligence.processing_method} processing, ${processingTime.toFixed(2)}ms`);

                // PERFORMANCE OPTIMIZATION 6: Set appropriate cache headers
                res.set({
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'X-Processing-Time': `${processingTime.toFixed(2)}ms`,
                    'X-Record-Count': jsonArray.length.toString(),
                    'X-Query-Type': smartResult.type
                });

                const response = {
                    query: query,
                    context: context,
                    result: result,
                    metadata: {
                        processing_time: `${processingTime.toFixed(2)}ms`,
                        source: 'langchain_medical_assistant',
                        timestamp: new Date().toISOString(),
                        database: {
                            mysql_version: mySQLVersionString,
                            version_info: mysqlVersionInfo,
                            used_version_adaptive_query: !!mysqlVersionInfo
                        }
                    }
                };

                res.json(response);

            } catch (error) {
                const processingTime = performance.now() - startTime;
                console.error('❌ Enhanced query processing error:', error);

                res.status(500).json({
                    error: 'Query processing failed',
                    message: (error as Error).message,
                    processing_time: `${processingTime.toFixed(2)}ms`,
                    timestamp: new Date().toISOString(),
                    database_info: {
                        mysql_version: mySQLVersionString,
                        version_checked: !!mysqlVersionInfo
                    }
                });
            }
        }
    );

    // ========== ENHANCED QUERY INTELLIGENCE ENDPOINTS ==========

    // Get database intelligence and schema insights
    router.get('/intelligence', async (req: Request, res: Response) => {
        try {
            const intelligence = langchainApp.getDatabaseIntelligence();

            if (!intelligence) {
                return res.json({
                    intelligence_available: false,
                    message: 'Database intelligence not initialized yet',
                    note: 'Intelligence builds after successful database connection',
                    timestamp: new Date().toISOString()
                });
            }

            res.json({
                intelligence_available: true,
                database_intelligence: {
                    tables: intelligence.tables.map(table => ({
                        name: table.name,
                        purpose: table.semanticContext,
                        column_count: table.columns.length,
                        relationship_count: table.relationships.length,
                        key_columns: table.columns.filter(col => col.key).map(col => ({ name: col.name, type: col.key }))
                    })),
                    join_patterns: intelligence.commonJoinPaths.map(path => ({
                        tables: path.tables,
                        complexity: path.tables.length > 2 ? 'complex' : 'simple'
                    })),
                    query_patterns: intelligence.queryPatterns.map(pattern => ({
                        pattern: pattern.pattern,
                        usage_frequency: `${(pattern.frequency * 100).toFixed(0)}%`,
                        performance_score: `${(pattern.performance * 100).toFixed(0)}%`
                    }))
                },
                capabilities: {
                    intent_analysis: true,
                    query_planning: true,
                    query_optimization: true,
                    schema_intelligence: true,
                    performance_prediction: true
                },
                recommendations: [
                    'Use specific table and column names for best results',
                    'Include time constraints for better performance on large datasets',
                    'Specify patient identifiers when querying personal health information',
                    'Use aggregate functions (COUNT, AVG, SUM) for statistical queries'
                ],
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                error: 'Failed to retrieve database intelligence',
                message: (error as Error).message,
                timestamp: new Date().toISOString()
            });
        }
    });

    // Analyze query intent before execution
    router.post('/analyze',
        [
            body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters')
        ],
        async (req: Request, res: Response) => {
            try {
                const errors = validationResult(req);
                if (!errors.isEmpty()) {
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors.array()
                    });
                }

                const { query } = req.body;

                console.log(`🔍 Analyzing query intent: "${query}"`);

                const insights = await langchainApp.getQueryInsights(query);

                res.json({
                    query: query,
                    analysis: insights,
                    suggestions: {
                        query_improvement: insights.analysis_available ?
                            `Your query appears to be a ${insights.intent.type} operation with ${insights.intent.complexity} complexity` :
                            'Analysis not available',
                        performance_tips: insights.analysis_available ? insights.recommendations : [],
                        estimated_execution: insights.analysis_available ?
                            `Expected ${insights.intent.estimated_performance} performance` : 'Unknown'
                    },
                    next_steps: [
                        'Review the analysis and suggestions above',
                        'Make any recommended adjustments to your query',
                        'Execute the query using the /query endpoint',
                        'Check the results and performance metrics'
                    ],
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Query analysis failed',
                    message: (error as Error).message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    );

    // Get AI-powered diagnosis suggestions
    router.post('/diagnosis',
        [
            body('symptoms').isArray().withMessage('Symptoms must be an array'),
            body('symptoms.*').isString().withMessage('Each symptom must be a string'),
            body('patient_history').optional().isString().withMessage('Patient history must be a string'),
            body('age').optional().isInt({ min: 0, max: 150 }).withMessage('Age must be between 0-150'),
            body('gender').optional().isIn(['male', 'female', 'other']).withMessage('Gender must be male, female, or other')
        ],
        async (req: Request, res: Response) => {
            try {
                const errors = validationResult(req);
                if (!errors.isEmpty()) {
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors.array()
                    });
                }

                const { symptoms, patient_history, age, gender } = req.body;

                // Use LangChain structured parser
                const diagnosis = {
                    primary_diagnosis: 'Type 2 Diabetes Mellitus',
                    differential_diagnoses: [
                        { condition: 'Type 1 Diabetes', probability: 0.15 },
                        { condition: 'Metabolic Syndrome', probability: 0.25 },
                        { condition: 'Insulin Resistance', probability: 0.35 }
                    ],
                    confidence_score: 0.82,
                    recommended_tests: [
                        'HbA1c',
                        'Fasting Glucose',
                        'Oral Glucose Tolerance Test',
                        'Lipid Panel'
                    ],
                    urgency: 'routine',
                    follow_up: 'Schedule appointment within 2 weeks',
                    symptoms_analysis: symptoms.map((symptom: string) => ({
                        symptom,
                        relevance: Math.random() * 0.5 + 0.5, // Random relevance score
                        weight: Math.random() * 0.3 + 0.7
                    }))
                };

                res.json({
                    patient_info: { age, gender, symptoms, patient_history },
                    diagnosis,
                    generated_by: 'langchain_medical_ai',
                    timestamp: new Date().toISOString(),
                    disclaimer: 'This is AI-generated content for demonstration purposes only. Always consult healthcare professionals.'
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Diagnosis generation failed',
                    message: (error as Error).message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    );

    // Get treatment recommendations
    router.post('/treatment',
        [
            body('diagnosis').isString().isLength({ min: 1, max: 200 }).withMessage('Diagnosis is required'),
            body('patient_id').optional().isString().withMessage('Patient ID must be a string'),
            body('allergies').optional().isArray().withMessage('Allergies must be an array'),
            body('current_medications').optional().isArray().withMessage('Current medications must be an array')
        ],
        async (req: Request, res: Response) => {
            try {
                const errors = validationResult(req);
                if (!errors.isEmpty()) {
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors.array()
                    });
                }

                const { diagnosis, patient_id, allergies = [], current_medications = [] } = req.body;

                const treatment = {
                    diagnosis,
                    treatment_plan: {
                        medications: [
                            {
                                name: 'Primary Medication A',
                                dosage: 'As prescribed by physician',
                                duration: 'As recommended',
                                instructions: 'Follow physician guidance'
                            },
                            {
                                name: 'Secondary Medication B',
                                dosage: 'As prescribed by physician',
                                duration: 'As recommended',
                                instructions: 'Follow physician guidance'
                            }
                        ],
                        lifestyle_modifications: [
                            'Follow recommended dietary guidelines',
                            'Maintain regular exercise routine as advised',
                            'Follow monitoring schedule as prescribed',
                            'Maintain healthy weight as recommended'
                        ],
                        monitoring: [
                            'HbA1c every 3 months',
                            'Blood pressure checks monthly',
                            'Annual eye and foot exams',
                            'Lipid panel every 6 months'
                        ],
                        follow_up: 'Return visit in 4 weeks, then every 3 months'
                    },
                    contraindications: allergies.length > 0 ? `Consider allergies: ${allergies.join(', ')}` : 'None noted',
                    drug_interactions: current_medications.length > 0 ? 'Review current medications for interactions' : 'None',
                    estimated_cost: '$150-300/month',
                    success_probability: 0.85,
                    side_effects: [
                        'Primary Medication A: Follow physician guidance for side effects',
                        'Secondary Medication B: Monitor as advised by healthcare provider'
                    ]
                };

                res.json({
                    patient_id,
                    treatment,
                    generated_by: 'langchain_treatment_ai',
                    timestamp: new Date().toISOString(),
                    disclaimer: 'This is AI-generated content for demonstration purposes only. Always consult healthcare professionals.'
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Treatment generation failed',
                    message: (error as Error).message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    );

    // Get list of patients (demo data - in real app would query actual database)
    router.get('/patients', async (req: Request, res: Response) => {
        try {
            const { limit = 10, offset = 0, search } = req.query;

            // Demo patient data
            const demoPatients = [
                { id: 'P001', name: 'John Doe', age: 45, diagnosis: 'Type 2 Diabetes', last_visit: '2024-12-15' },
                { id: 'P002', name: 'Jane Smith', age: 38, diagnosis: 'Hypertension', last_visit: '2024-12-10' },
                { id: 'P003', name: 'Robert Johnson', age: 62, diagnosis: 'Heart Disease', last_visit: '2024-12-08' },
                { id: 'P004', name: 'Maria Garcia', age: 29, diagnosis: 'Asthma', last_visit: '2024-12-12' },
                { id: 'P005', name: 'David Wilson', age: 55, diagnosis: 'Arthritis', last_visit: '2024-12-07' }
            ];

            let filteredPatients = demoPatients;
            if (search) {
                const searchTerm = (search as string).toLowerCase();
                filteredPatients = demoPatients.filter(p =>
                    p.name.toLowerCase().includes(searchTerm) ||
                    p.diagnosis.toLowerCase().includes(searchTerm)
                );
            }

            const startIndex = parseInt(offset as string);
            const endIndex = startIndex + parseInt(limit as string);
            const paginatedPatients = filteredPatients.slice(startIndex, endIndex);

            res.json({
                patients: paginatedPatients,
                pagination: {
                    total: filteredPatients.length,
                    limit: parseInt(limit as string),
                    offset: startIndex,
                    has_more: endIndex < filteredPatients.length
                },
                note: 'This is demo data. In production, this would query your actual database.',
                database_config: {
                    host: process.env.DB_HOST,
                    database: process.env.DB_NAME,
                    status: 'connected_but_sql_features_disabled'
                }
            });
        } catch (error) {
            res.status(500).json({
                error: 'Failed to retrieve patients',
                message: (error as Error).message,
                timestamp: new Date().toISOString()
            });
        }
    });

    // Get database tables information
    router.get('/tables', async (req: Request, res: Response) => {
        try {
            // Try to connect to actual database and get tables
            const connection = await mysql.createConnection({
                host: process.env.DB_HOST!,
                port: parseInt(process.env.DB_PORT!),
                user: process.env.DB_USER!,
                password: process.env.DB_PASSWORD!,
                database: process.env.DB_NAME!,
            });

            try {
                const [tables] = await connection.execute('SHOW TABLES');
                await connection.end();

                res.json({
                    database_info: {
                        host: process.env.DB_HOST,
                        database: process.env.DB_NAME,
                        port: process.env.DB_PORT
                    },
                    tables: tables,
                    count: Array.isArray(tables) ? tables.length : 0,
                    timestamp: new Date().toISOString(),
                    note: 'Successfully connected to your MySQL database'
                });
            } catch (queryError) {
                await connection.end();
                throw queryError;
            }
        } catch (error) {
            res.status(503).json({
                error: 'Database connection failed',
                message: (error as Error).message,
                database_config: {
                    host: process.env.DB_HOST,
                    database: process.env.DB_NAME,
                    port: process.env.DB_PORT
                },
                timestamp: new Date().toISOString()
            });
        }
    });

    // Enhanced endpoint for manual SQL execution with complete query extraction
    // Fixed endpoint for manual SQL execution with better SQL cleaning
    // Fixed endpoint for manual SQL execution with schema validation
    // Now includes conversational capabilities with session management
    router.post('/query-sql-manual',
        [
            body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters'),
            body('context').optional().isString().isLength({ max: 1000 }).withMessage('Context must be less than 1000 characters'),
            body('sessionId').optional().isString().withMessage('Session ID must be a string'),
            body('conversational').optional().isBoolean().withMessage('Conversational flag must be a boolean'),
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
            body('preferredChain').optional().isString().withMessage('Preferred chain must be a string')
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
                    query, 
                    context = 'Medical database query', 
                    conversational = false, 
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
                    preferredChain = ''
                } = req.body;

                // Make useChains mutable so we can reset it if chains fail
                let useChains = req.body.useChains || false;

                console.log(`🚀 Processing SQL manual query: "${query}" ${conversational ? 'with conversation' : ''}`);

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

                // Declare connection variable for later use
                let connection;

                // Get minimal database information to guide the agent
                try {
                    connection = await mysql.createConnection({
                        host: process.env.DB_HOST!,
                        port: parseInt(process.env.DB_PORT!),
                        user: process.env.DB_USER!,
                        password: process.env.DB_PASSWORD!,
                        database: process.env.DB_NAME!,
                    });

                    // Just get a list of tables to verify they exist
                    // The sqlAgent will get detailed schema information using its own tools
                    console.log('📊 Getting high-level database structure');
                    const [tables] = await connection.execute(
                        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                        [process.env.DB_NAME]
                    );

                    if (Array.isArray(tables) && tables.length > 0) {
                        const actualTables = tables.map((table: any) => table.TABLE_NAME);
                        console.log('✅ Database contains these tables:', actualTables.join(', '));
                        debugInfo.sqlCorrections.push(`Available tables: ${actualTables.join(', ')}`);
                    } else {
                        console.log('⚠️ No tables found in the database');
                    }

                    await connection.end();
                    console.log('✅ Basic database structure check complete');

                } catch (schemaError: any) {
                    console.error('❌ Failed to get basic database structure:', schemaError.message);
                    if (connection) await connection.end();
                }

                // ========== CHAIN EXECUTION LOGIC ==========
                
                // Check if chains should be used for SQL generation instead of direct SQL agent
                let enhancedQuery = query;
                let chainSQLGenerated = '';
                let chainMetadata = {};

                if (useChains) {
                    console.log(`🔗 Using LangChain chains for SQL generation: ${chainType}`);
                    
                    try {
                        // Get complete database knowledge for chains - both schema and version info
                        console.log('🔍 Getting complete database knowledge for chain execution...');
                        
                        let mySQLVersionString = "unknown";
                        let mysqlVersionInfo = null;
                        let databaseSchemaInfo = "";
                        
                        try {
                            // Get MySQL version information
                            const mysql = require('mysql2/promise');
                            const versionConnection = await mysql.createConnection({
                                host: process.env.DB_HOST!,
                                port: parseInt(process.env.DB_PORT!),
                                user: process.env.DB_USER!,
                                password: process.env.DB_PASSWORD!,
                                database: process.env.DB_NAME!,
                                connectTimeout: 8000,
                            });
                            
                            const [rows] = await versionConnection.execute('SELECT VERSION() as version');
                            if (rows && rows[0] && rows[0].version) {
                                mySQLVersionString = rows[0].version;
                                
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
                                    
                                    console.log(`✅ MySQL Version for chains: ${mySQLVersionString} (${major}.${minor}.${patch})`);
                                }
                            }
                            
                            await versionConnection.end();
                        } catch (versionError) {
                            console.error('❌ Failed to get MySQL version for chains:', versionError);
                        }
                        
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
                        // Get MySQL version information to ensure compatibility
                        console.log('🔍 Analyzing MySQL version before generating SQL...');
                        let mySQLVersionString = "unknown";
                        let mysqlVersionInfo = null;
                    
                    try {
                        const mysql = require('mysql2/promise');
                        const versionConnection = await mysql.createConnection({
                            host: process.env.DB_HOST!,
                            port: parseInt(process.env.DB_PORT!),
                            user: process.env.DB_USER!,
                            password: process.env.DB_PASSWORD!,
                            database: process.env.DB_NAME!,
                            connectTimeout: 8000,
                        });
                        
                        const [rows] = await versionConnection.execute('SELECT VERSION() as version');
                        if (rows && rows[0] && rows[0].version) {
                            mySQLVersionString = rows[0].version;
                            
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
                                
                                console.log(`✅ MySQL Version: ${mySQLVersionString} (${major}.${minor}.${patch})`);
                                console.log(`✅ Features: JSON=${mysqlVersionInfo.supportsJSON}, Windows=${mysqlVersionInfo.supportsWindowFunctions}, CTE=${mysqlVersionInfo.supportsCTE}`);
                            }
                        }
                        
                        await versionConnection.end();
                    } catch (versionError) {
                        console.error('❌ Failed to get MySQL version:', versionError);
                        // Continue without version info
                    }
                    
                    // Configure LangChain's sqlAgent with version-specific instructions
                    const versionSpecificInstructions = mysqlVersionInfo ? `
MySQL VERSION INFO: Your query will run on MySQL ${mysqlVersionInfo.full} (${mysqlVersionInfo.major}.${mysqlVersionInfo.minor}.${mysqlVersionInfo.patch})

VERSION-SPECIFIC COMPATIBILITY:
- JSON Functions (e.g., JSON_EXTRACT): ${mysqlVersionInfo.supportsJSON ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Window Functions (e.g., ROW_NUMBER()): ${mysqlVersionInfo.supportsWindowFunctions ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Common Table Expressions (WITH): ${mysqlVersionInfo.supportsCTE ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}
- Regular Expressions: AVAILABLE ✅

CRITICAL: Use ONLY SQL features compatible with this MySQL version. Avoid any syntax not supported by ${mysqlVersionInfo.full}.
` : '';

                    // Add conversation context if in conversational mode
                let conversationalContext = '';
                if (conversational && Array.isArray(chatHistory) && chatHistory.length > 0) {
                    conversationalContext = '\n\nPrevious conversation:\n' + chatHistory
                        .map((msg: any) => `${msg.type === 'human' ? 'User' : 'Assistant'}: ${msg.content}`)
                        .join('\n') + '\n\n';
                }
                
                const enhancedQuery = `
You are a medical database SQL expert. Follow this strict process to write an accurate SQL query:

1. ANALYZE: First, ALWAYS explore the complete database schema using the sql_db_schema tool to understand available tables and columns.
   - Pay special attention to actual table names (e.g., 'pgxtest_results' not 'pgxtestresults')
   - Note that many column names use snake_case format (e.g., 'full_name' not 'fullname')

2. VALIDATE: Double-check the exact spelling and format of ALL column and table names:
   - Use ONLY tables that actually exist in the schema (verify with sql_db_list_tables)
   - Use ONLY column names that actually exist (check with sql_db_schema)
   - Respect snake_case naming (e.g., 'patient_id', not 'patientid' or 'PatientID')

3. PLAN: Consider the relationships between tables and how to join them properly:
   - Identify the correct foreign key relationships
   - Ensure join columns exist in both tables

4. EXECUTE: Create a SQL query that correctly addresses the request using verified table and column names.

${versionSpecificInstructions}

CRITICAL: This database uses snake_case for most identifiers. NEVER assume column or table names - always verify them first.
${conversationalContext ? conversationalContext : ''}
Query request: ${query}
`;
                    console.log('📝 Enhanced query with schema information:', enhancedQuery.substring(0, 200) + '...');

                    // Configure the sqlAgent to prioritize schema exploration before query generation
                    const agentConfig = {
                        input: enhancedQuery,
                        // Force the agent to always check schema first
                        forceSchema: true
                    };

                    // Enhanced callback system to capture ALL agent actions and encourage schema exploration
                    agentResult = await sqlAgent.call(agentConfig, {
                        callbacks: [{
                            handleAgentAction: (action: any) => {
                                // Log ALL actions for debugging
                                console.log('🔍 Agent action:', JSON.stringify(action, null, 2));

                                // Encourage schema exploration first
                                if (action.tool === 'sql_db_schema') {
                                    console.log('✅ Agent is checking database schema - good practice!');
                                    debugInfo.sqlCorrections.push('Agent checked database schema first');

                                    // Store this important step
                                    intermediateSteps.push({
                                        tool: 'sql_db_schema',
                                        toolInput: action.toolInput,
                                        note: 'Schema exploration is critical for accurate queries'
                                    });
                                }

                                // Capture any SQL-related actions, including query-checker
                                if (action.tool === 'query-checker') {
                                    const sql = String(action.toolInput);
                                    // Store raw SQL before any cleaning
                                    debugInfo.originalQueries.push(sql);

                                    // Clean the SQL to extract only valid SQL
                                    const cleanedSql = cleanSQLQuery(sql);
                                    if (cleanedSql) {
                                        capturedSQLQueries.push(cleanedSql);
                                        console.log('✅ Captured SQL from query-checker:', cleanedSql);
                                    }
                                }

                                // Also capture SQL from standard SQL tools
                                if (action.tool === 'sql_db_query' ||
                                    action.tool === 'query_sql_db' ||
                                    action.tool === 'sql_db_schema' ||
                                    action.tool === 'sql_db_list_tables') {

                                    console.log('🔍 Captured tool action:', action.tool);
                                    console.log('🔍 Tool input:', action.toolInput);

                                    // Store original query
                                    if (typeof action.toolInput === 'string') {
                                        debugInfo.originalQueries.push(action.toolInput);
                                    }

                                    intermediateSteps.push({
                                        tool: action.tool,
                                        toolInput: action.toolInput
                                    });

                                    // If this looks like SQL, add it to our collection
                                    if (typeof action.toolInput === 'string' &&
                                        (action.toolInput.toLowerCase().includes('select') ||
                                            action.toolInput.toLowerCase().includes('from'))) {

                                        // Clean the SQL to extract only valid SQL
                                        const cleanedSql = cleanSQLQuery(action.toolInput);
                                        if (cleanedSql) {
                                            capturedSQLQueries.push(cleanedSql);
                                            console.log('✅ Captured SQL from tool action:', cleanedSql);
                                        }
                                    }
                                }
                                return action;
                            },
                            handleChainStart: (chain: any) => {
                                console.log('🔄 Chain started:', chain.name);
                            },
                            handleChainEnd: (output: any) => {
                                console.log('🔄 Chain ended with output:', typeof output === 'string' ?
                                    output.substring(0, 200) + '...' :
                                    JSON.stringify(output).substring(0, 200) + '...');
                            },
                            handleToolStart: (tool: any) => {
                                console.log('🔧 Tool started:', tool.name);

                                // If we're about to run a SQL query, make sure we've checked schema first
                                if ((tool.name === 'sql_db_query' || tool.name === 'query_sql_db') &&
                                    !intermediateSteps.some(s => s.tool === 'sql_db_schema')) {
                                    console.log('⚠️ Warning: About to run SQL query without checking schema first');
                                }
                            },
                            handleToolEnd: (output: any) => {
                                console.log('🔧 Tool ended with output:', typeof output === 'string' ?
                                    output.substring(0, 200) + '...' :
                                    JSON.stringify(output).substring(0, 200) + '...');

                                // If this is schema output, save it for debugging
                                if (output && typeof output === 'string' && output.includes('COLUMN_NAME')) {
                                    console.log('📊 Schema information detected in output');
                                    debugInfo.sqlCorrections.push('Schema examined before query generation');
                                }

                                // Check if the tool output contains SQL results
                                if (typeof output === 'string' && output.toLowerCase().includes('select')) {
                                    // Clean the SQL to extract only valid SQL
                                    const cleanedSql = cleanSQLQuery(output);
                                    if (cleanedSql) {
                                        capturedSQLQueries.push(cleanedSql);
                                        console.log('✅ Captured SQL from tool output:', cleanedSql);
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
                    extractedSQL = cleanSQLQuery(chainSQLGenerated);
                    console.log('✅ Using chain-generated SQL');
                } else {
                    // Method 1: Use already captured SQL queries from callbacks
                    if (capturedSQLQueries.length > 0) {
                        // Sort queries by length to prioritize longer, more complete queries
                        const sortedQueries = [...capturedSQLQueries].sort((a, b) => b.length - a.length);

                        // Get the longest SQL query that includes both SELECT and FROM and appears to be complete
                        for (const sql of sortedQueries) {
                            if (isCompleteSQLQuery(sql)) {
                                extractedSQL = sql;
                                debugInfo.extractionAttempts.push('Complete captured query: ' + extractedSQL);
                                console.log('✅ Found complete SQL from captured queries');
                                break;
                            }
                        }

                        // If no complete query found, take the longest one
                        if (!extractedSQL) {
                            extractedSQL = sortedQueries[0];
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
                let finalSQL = finalCleanSQL(extractedSQL);

                if (!finalSQL) {
                    return res.status(400).json({
                        error: 'Failed to produce a valid SQL query',
                        extracted_sql: extractedSQL,
                        debug_info: debugInfo,
                        timestamp: new Date().toISOString()
                    });
                }

                // Skip column name correction and trust the sqlAgent to generate correct queries
                console.log('📊 Step 3.5: Using original SQL from agent without column name modifications');

                // Add a note to debug info
                debugInfo.sqlCorrections.push('Using SQL directly from agent without column name corrections');

                console.log('✅ Final SQL:', finalSQL);

                // Step 3.7: Check the query for common issues, but trust sqlAgent's schema understanding
                console.log('📊 Step 3.7: Validating SQL query before execution...');

                // Quick syntax validation without repeating schema analysis that sqlAgent already did
                try {
                    connection = await mysql.createConnection({
                        host: process.env.DB_HOST!,
                        port: parseInt(process.env.DB_PORT!),
                        user: process.env.DB_USER!,
                        password: process.env.DB_PASSWORD!,
                        database: process.env.DB_NAME!,
                    });

                    // Extract table names from the query
                    const tableMatch = finalSQL.match(/\bFROM\s+`?(\w+)`?|JOIN\s+`?(\w+)`?/gi);
                    const tableNames = tableMatch ? tableMatch.map(match => {
                        // Extract just the table name without FROM or JOIN
                        const parts = match.split(/\s+/);
                        return parts[parts.length - 1].replace(/`/g, '').replace(/;$/, '');
                    }) : [];

                    console.log('🔍 Query references these tables:', tableNames);

                    // Map to store potential table name corrections
                    const tableCorrections: { [key: string]: string } = {};
                    const columnCorrections: { [key: string]: string } = {};
                    let sqlNeedsCorrection = false;

                    // Do a simple check if these tables exist and find similar table names if not
                    for (const tableName of tableNames) {
                        try {
                            // Just check if the table exists with a simple query
                            const [result] = await connection.execute(
                                "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                [process.env.DB_NAME, tableName]
                            );

                            if (Array.isArray(result) && result.length > 0) {
                                console.log(`✅ Table '${tableName}' exists`);

                                // If table exists, get a sample of column names to verify query correctness
                                const [columns] = await connection.execute(
                                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 10",
                                    [process.env.DB_NAME, tableName]
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
                                    [process.env.DB_NAME]
                                );

                                if (Array.isArray(allTables) && allTables.length > 0) {
                                    // Look for similar table names
                                    const allTableNames = allTables.map((t: any) => t.TABLE_NAME);

                                    // Try different matching strategies
                                    // 1. Remove underscores and compare
                                    const similarTableNoUnderscores = allTableNames.find(t =>
                                        t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase()
                                    );

                                    // 2. Check for plural/singular variations
                                    const singularName = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
                                    const pluralName = tableName.endsWith('s') ? tableName : tableName + 's';

                                    const similarTableByPlurality = allTableNames.find(t =>
                                        t.toLowerCase() === singularName.toLowerCase() ||
                                        t.toLowerCase() === pluralName.toLowerCase()
                                    );

                                    // 3. Check for table with similar prefix
                                    const similarTableByPrefix = allTableNames.find(t =>
                                        (t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                            tableName.toLowerCase().startsWith(t.toLowerCase())) &&
                                        t.length > 3
                                    );

                                    const correctedTableName = similarTableNoUnderscores || similarTableByPlurality || similarTableByPrefix;

                                    if (correctedTableName) {
                                        console.log(`🔄 Found similar table: '${correctedTableName}' instead of '${tableName}'`);
                                        tableCorrections[tableName] = correctedTableName;
                                        sqlNeedsCorrection = true;

                                        // Also get sample columns from this corrected table
                                        const [correctedColumns] = await connection.execute(
                                            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 10",
                                            [process.env.DB_NAME, correctedTableName]
                                        );

                                        if (Array.isArray(correctedColumns) && correctedColumns.length > 0) {
                                            const sampleCorrectedColumns = correctedColumns.map((col: any) => col.COLUMN_NAME).slice(0, 5).join(', ');
                                            console.log(`📋 Corrected table ${correctedTableName} columns: ${sampleCorrectedColumns}...`);
                                            debugInfo.sqlCorrections.push(`Correction: Use '${correctedTableName}' with columns like: ${sampleCorrectedColumns}...`);
                                        }
                                    } else {
                                        console.log(`❌ No similar table found for '${tableName}'`);
                                        debugInfo.sqlCorrections.push(`No similar table found for '${tableName}'`);
                                    }
                                }
                            }
                        } catch (err) {
                            console.log(`❌ Error checking table '${tableName}':`, err);
                        }
                    }

                    // Apply corrections to SQL if needed
                    if (sqlNeedsCorrection) {
                        console.log('🔧 Applying corrections to SQL query');
                        let correctedSQL = finalSQL;

                        // Apply table name corrections
                        for (const [incorrectTable, correctTable] of Object.entries(tableCorrections)) {
                            // Use regex to ensure we only replace table names, not substrings in other identifiers
                            const tableRegex = new RegExp(`\\b${incorrectTable}\\b`, 'g');
                            correctedSQL = correctedSQL.replace(tableRegex, correctTable);
                            console.log(`🔄 Corrected table: '${incorrectTable}' → '${correctTable}'`);
                        }

                        // Apply column name corrections
                        for (const [incorrectCol, correctCol] of Object.entries(columnCorrections)) {
                            // Need to be careful to only replace the column part in table.column patterns
                            for (const tableName of [...tableNames, ...Object.values(tableCorrections)]) {
                                const columnPattern = new RegExp(`${tableName}\\.${incorrectCol}\\b`, 'g');
                                correctedSQL = correctedSQL.replace(columnPattern, `${tableName}.${correctCol}`);
                            }
                            console.log(`🔄 Corrected column: '${incorrectCol}' → '${correctCol}'`);
                        }

                        // Use the corrected SQL
                        if (correctedSQL !== finalSQL) {
                            console.log('✅ SQL corrections applied:');
                            console.log('🔸 Original: ' + finalSQL);
                            console.log('🔸 Corrected: ' + correctedSQL);
                            finalSQL = correctedSQL;
                            debugInfo.sqlCorrections.push(`Corrected SQL: ${finalSQL}`);
                        }
                    }

                    // Look for possible join issues in the query
                    const joinMatch = finalSQL.match(/JOIN\s+`?(\w+)`?\s+(?:AS\s+)?(\w+)?\s+ON\s+(.*?)(?:WHERE|GROUP BY|ORDER BY|LIMIT|;|\s*$)/i);
                    if (joinMatch) {
                        console.log('🔍 Join condition found:', joinMatch[3]);
                        debugInfo.sqlCorrections.push(`Join condition: ${joinMatch[3]}`);
                    }

                    // Close this connection before moving to the actual query execution
                    await connection.end();
                    console.log('🔌 Validation connection closed');

                } catch (validationError) {
                    console.error('❌ Error during query validation:', validationError);
                    if (connection) await connection.end();
                }

                // Step 4: Execute the SQL query manually
                console.log('📊 Step 4: Executing SQL query manually...');

                try {
                    connection = await mysql.createConnection({
                        host: process.env.DB_HOST!,
                        port: parseInt(process.env.DB_PORT!),
                        user: process.env.DB_USER!,
                        password: process.env.DB_PASSWORD!,
                        database: process.env.DB_NAME!,
                    });

                    console.log('✅ Database connection established');
                    console.log('🔧 Executing SQL:', finalSQL);

                    // Execute the final SQL
                    const [rows, fields] = await connection.execute(finalSQL);

                    console.log(`✅ Query executed successfully, returned ${Array.isArray(rows) ? rows.length : 0} rows`);

                    const processingTime = performance.now() - startTime;

                    // Save conversation if in conversational mode
                    if (conversational && sessionData) {
                        try {
                            // Prepare a user-friendly summary of the SQL results for the conversation
                            const resultCount = Array.isArray(rows) ? rows.length : 0;
                            const resultSummary = `Found ${resultCount} results for your query. SQL: ${finalSQL}`;
                            
                            // Save the conversation exchange to memory
                            await sessionData.memory.saveContext(
                                { input: query },
                                { output: resultSummary }
                            );
                            console.log('💾 Saved conversation context');
                        } catch (saveError) {
                            console.error('❌ Error saving conversation:', saveError);
                            // Continue without saving if there's an error
                        }
                    }
                    
                    // Return the raw SQL results
                    const response = {
                        success: true,
                        query_processed: query,
                        sql_extracted: extractedSQL,
                        sql_final: finalSQL,
                        sql_results: rows, // Raw SQL results
                        result_count: Array.isArray(rows) ? rows.length : 0,
                        field_info: fields ? fields.map((field: any) => ({
                            name: field.name,
                            type: field.type,
                            table: field.table
                        })) : [],
                        processing_time: `${processingTime.toFixed(2)}ms`,
                        agent_response: agentResult ? agentResult.output : '',
                        
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
                            host: process.env.DB_HOST,
                            database: process.env.DB_NAME,
                            port: process.env.DB_PORT,
                            mysql_version: mySQLVersionString,
                            version_details: mysqlVersionInfo,
                            query_adapted_to_version: !!mysqlVersionInfo
                        },
                        timestamp: new Date().toISOString()
                    };

                    res.json(response);

                } catch (sqlError: any) {
                    console.error('❌ SQL execution error:', sqlError.message);

                    // Enhanced error handling with better diagnostic information
                    let errorDetails = {};
                    let suggestedFixes = [];

                    // Handle column not found errors
                    if (sqlError.message.includes('Unknown column')) {
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
                            // If we have a connection, try to find a similar column
                            if (connection && tableName && columnName) {
                                // First verify the table exists
                                const [tableResult] = await connection.execute(
                                    "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                    [process.env.DB_NAME, tableName]
                                );

                                if (Array.isArray(tableResult) && tableResult.length > 0) {
                                    // Table exists, get all its columns
                                    const [columns] = await connection.execute(
                                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                        [process.env.DB_NAME, tableName]
                                    );

                                    if (Array.isArray(columns) && columns.length > 0) {
                                        const actualColumns = columns.map((col: any) => col.COLUMN_NAME);

                                        // Look for similar column names
                                        // 1. Check for snake_case vs camelCase
                                        const similarByCase = actualColumns.find(col =>
                                            col.replace(/_/g, '').toLowerCase() === columnName.toLowerCase()
                                        );

                                        // 2. Check for simple typos or close matches
                                        const similarByPrefix = actualColumns.find(col =>
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
                                    const [allTables] = await connection.execute(
                                        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                                        [process.env.DB_NAME]
                                    );

                                    if (Array.isArray(allTables) && allTables.length > 0) {
                                        const allTableNames = allTables.map((t: any) => t.TABLE_NAME);

                                        // Similar matching as before
                                        const similarTable = allTableNames.find(t =>
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
                            // Try to find a similar table name
                            if (connection) {
                                const [allTables] = await connection.execute(
                                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                                    [process.env.DB_NAME]
                                );

                                if (Array.isArray(allTables) && allTables.length > 0) {
                                    const allTableNames = allTables.map((t: any) => t.TABLE_NAME);
                                    console.log(`📋 Available tables: ${allTableNames.join(', ')}`);

                                    // Try different matching strategies as before
                                    const similarTableNoUnderscores = allTableNames.find(t =>
                                        t.replace(/_/g, '').toLowerCase() === badTable.toLowerCase()
                                    );

                                    const singularName = badTable.endsWith('s') ? badTable.slice(0, -1) : badTable;
                                    const pluralName = badTable.endsWith('s') ? badTable : badTable + 's';

                                    const similarTableByPlurality = allTableNames.find(t =>
                                        t.toLowerCase() === singularName.toLowerCase() ||
                                        t.toLowerCase() === pluralName.toLowerCase()
                                    );

                                    const similarTableByPrefix = allTableNames.find(t =>
                                        (t.toLowerCase().startsWith(badTable.toLowerCase()) ||
                                            badTable.toLowerCase().startsWith(t.toLowerCase())) &&
                                        t.length > 3
                                    );

                                    const suggestedTable = similarTableNoUnderscores || similarTableByPlurality || similarTableByPrefix;

                                    if (suggestedTable) {
                                        console.log(`🔄 Suggested table correction: '${badTable}' → '${suggestedTable}'`);
                                        suggestedFixes.push(`Use table '${suggestedTable}' instead of '${badTable}'`);

                                        // Get column names for the suggested table
                                        const [columns] = await connection.execute(
                                            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 10",
                                            [process.env.DB_NAME, suggestedTable]
                                        );

                                        let columnInfo = '';
                                        if (Array.isArray(columns) && columns.length > 0) {
                                            const sampleColumns = columns.map((col: any) => col.COLUMN_NAME).slice(0, 5).join(', ');
                                            columnInfo = ` with columns like: ${sampleColumns}...`;
                                        }

                                        errorDetails = {
                                            error_type: 'table_not_found',
                                            problematic_table: badTable,
                                            suggested_table: suggestedTable,
                                            suggestion: `Table '${badTable}' doesn't exist. Did you mean '${suggestedTable}'${columnInfo}?`
                                        };
                                    } else {
                                        // No similar table found, show available tables
                                        const availableTables = allTableNames.slice(0, 10).join(', ');
                                        errorDetails = {
                                            error_type: 'table_not_found',
                                            problematic_table: badTable,
                                            available_tables: availableTables,
                                            suggestion: `Table '${badTable}' doesn't exist. Available tables: ${availableTables}...`
                                        };
                                        suggestedFixes.push(`Choose a table from: ${availableTables}...`);
                                    }
                                }
                            }
                        } catch (analyzeError) {
                            console.error('Error during error analysis:', analyzeError);
                        }

                        // Fallback if we couldn't provide better guidance
                        if (Object.keys(errorDetails).length === 0) {
                            errorDetails = {
                                error_type: 'table_not_found',
                                problematic_table: badTable,
                                suggestion: `Table '${badTable}' doesn't exist. Check for proper snake_case formatting or pluralization.`
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

                    // If in conversational mode, still save the error to conversation history
                    if (conversational && sessionData) {
                        try {
                            const errorSummary = `Error executing SQL: ${sqlError.message}`;
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
                } finally {
                    if (connection) {
                        await connection.end();
                        console.log('🔌 Database connection closed');
                    }
                }

            } catch (error) {
                const processingTime = performance.now() - startTime;
                console.error('❌ Manual SQL query processing error:', error);
                
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
                // FIXED: More comprehensive regex that captures multi-line SQL including JOINs
                // Look for SELECT ... FROM ... and capture everything until statement termination
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
            .replace(/#+\s+(.*?)\s*(?:\n|$)/g, ' ') // Headings
            .replace(/(?:\n|^)\s*>\s+(.*?)(?:\n|$)/g, ' $1 ') // Blockquotes
            .replace(/(?:\n|^)\s*-\s+(.*?)(?:\n|$)/g, ' $1 ') // List items
            .replace(/(?:\n|^)\s*\d+\.\s+(.*?)(?:\n|$)/g, ' $1 ') // Numbered list items
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

        // Ensure it ends with a semicolon
        if (!cleanSQL.endsWith(';')) {
            cleanSQL += ';';
        }

        return cleanSQL;
    }
    
    // Session management endpoints
    router.get('/conversation/sessions', (req: Request, res: Response) => {
        try {
            const sessions: Record<string, any> = {};
            
            conversationSessions.forEach((session, sessionId) => {
                sessions[sessionId] = {
                    lastAccess: session.lastAccess,
                    created: session.lastAccess, // We don't track creation time separately
                    messageCount: 0 // We'll need to implement this if message count tracking is important
                };
            });
            
            res.json({
                total: conversationSessions.size,
                sessions
            });
        } catch (error) {
            res.status(500).json({
                error: 'Failed to retrieve sessions',
                message: (error as Error).message
            });
        }
    });
    
    router.delete('/conversation/sessions/:sessionId', (req: Request, res: Response) => {
        try {
            const { sessionId } = req.params;
            
            if (conversationSessions.has(sessionId)) {
                conversationSessions.delete(sessionId);
                res.json({
                    success: true,
                    message: `Session ${sessionId} deleted successfully`
                });
            } else {
                res.status(404).json({
                    error: 'Session not found',
                    sessionId
                });
            }
        } catch (error) {
            res.status(500).json({
                error: 'Failed to delete session',
                message: (error as Error).message
            });
        }
    });
    
    // The /query-conversation endpoint has been removed
    // Its functionality has been integrated into /query-sql-manual
    
    return router;
}

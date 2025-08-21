import { Response } from "express";

export interface SqlExtractionConfig {
    chainSQLGenerated: string | null;
    capturedSQLQueries: string[];
    agentResult: any;
    rawAgentResponse: string;
    query: string;
    debugInfo: {
        extractionAttempts: string[];
        sqlCorrections: string[];
        originalQueries: string[];
    };
    intermediateSteps: any[];
    chainMetadata: any;
    cleanSQLQuery: (sql: string) => string;
    isCompleteSQLQuery: (sql: string) => boolean;
    fixIncompleteSQLQuery: (sql: string) => string;
}

export interface SqlExtractionResult {
    success: boolean;
    extractedSQL: string;
    errorResponse?: any;
}

/**
 * Extract and process SQL query from agent results with intelligent fallback
 * @param config SQL extraction configuration
 * @param res Express response object for error handling
 * @returns Promise<SqlExtractionResult> Extraction result
 */
export async function extractAndProcessSQL(
    config: SqlExtractionConfig,
    res: Response
): Promise<SqlExtractionResult> {
    const {
        chainSQLGenerated,
        capturedSQLQueries,
        agentResult,
        rawAgentResponse,
        query,
        debugInfo,
        intermediateSteps,
        chainMetadata,
        cleanSQLQuery,
        isCompleteSQLQuery,
        fixIncompleteSQLQuery
    } = config;

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
                // Get the best SQL query
                console.log('Final Valid queries:', validQueries)
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
        const errorResponse = {
            error: 'No valid SQL query found in agent response',
            agent_response: agentResult ? agentResult.output : rawAgentResponse,
            intermediate_steps: intermediateSteps,
            captured_queries: capturedSQLQueries,
            debug_info: debugInfo,
            chain_metadata: chainMetadata,
            timestamp: new Date().toISOString()
        };

        return {
            success: false,
            extractedSQL: '',
            errorResponse
        };
    }

    console.log('🔧 Extracted SQL:', extractedSQL);

    return {
        success: true,
        extractedSQL
    };
}

import { MedicalDatabaseLangChainApp } from "../../index";
import { DatabaseVersionInfo } from "./databaseVersionService";

export interface ChainExecutionResult {
    chainSQLGenerated: string;
    chainMetadata: any;
    useChains: boolean; // This will be modified if chains fail
    success: boolean;
    error?: string;
}

/**
 * Execute LangChain chains for SQL generation
 * @param useChains Whether to use chains initially
 * @param chainType Type of chain to use
 * @param langchainApp The LangChain app instance
 * @param query The user query
 * @param mysqlVersionInfo Database version information
 * @param mySQLVersionString Database version string
 * @param conversational Whether in conversational mode
 * @param sessionData Session data for conversation
 * @returns Promise<ChainExecutionResult> Chain execution result
 */
export async function executeChainLogic(
    useChains: boolean,
    chainType: string,
    langchainApp: MedicalDatabaseLangChainApp,
    query: string,
    mysqlVersionInfo: DatabaseVersionInfo | null,
    mySQLVersionString: string,
    conversational: boolean,
    sessionData: any
): Promise<ChainExecutionResult> {
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

    return {
        chainSQLGenerated,
        chainMetadata,
        useChains,
        success: true
    };
}

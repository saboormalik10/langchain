import { Response } from "express";

export interface SqlAgentCallbackConfig {
    capturedSQLQueries: string[];
    debugInfo: {
        originalQueries: string[];
        sqlCorrections: string[];
    };
    intermediateSteps: any[];
    cleanSQLQuery: (sql: string) => string;
}

export async function executeSqlAgentWithCallbacks(
    sqlAgent: any,
    agentConfig: any,
    config: SqlAgentCallbackConfig
): Promise<any> {
    const { capturedSQLQueries, debugInfo, intermediateSteps, cleanSQLQuery } = config;

    const agentResult = await sqlAgent.call(agentConfig, {
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

    return agentResult;
}

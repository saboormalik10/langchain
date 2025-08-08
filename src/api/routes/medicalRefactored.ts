import express, { Request, Response, Router } from 'express';
import { validationResult } from 'express-validator';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { BufferMemory } from 'langchain/memory';

// Import all the services and utilities we've refactored
import { GraphType, MedicalDataCategory } from '../../types/graph';
import { GraphConfig, ConversationSession } from '../../interfaces/medical';
import { getAzureOpenAIClient, conversationSessions } from '../../config/azure';
import { generateRestructuredSQL } from '../../services/sqlGenerationService';
import { generateBarChartAnalysis } from '../../services/chartAnalysisService';
import { GraphProcessor } from '../../services/graphProcessorService';
import { AIGraphAnalyzer } from '../../services/aiGraphAnalyzerService';
import { EnhancedQueryService } from '../../services/enhancedQueryService';
import { cleanSQLQuery, fixMalformedSQLStructures, validateSQLSyntax } from '../../utils/sqlUtils';
import { validateSQLAgainstCriteria, correctSQLQuery } from '../../utils/queryValidation';
import { medicalQueryValidation } from '../../validators/medicalValidation';
import multiTenantLangChainService from '../../services/multiTenantLangChainService';
import databaseService from '../../services/databaseService';
import { MedicalDatabaseLangChainApp } from '../../index';

const router: Router = express.Router();

// Medical routes function
export function medicalRoutes() {
    // Enhanced endpoint for manual SQL execution with complete query extraction
    router.post('/query-sql-manual', 
        medicalQueryValidation,
        async (req: Request, res: Response) => {
            const startTime = performance.now();
            let rawAgentResponse = null;
            // Initialize MySQL version variables
            let mySQLVersionString = "unknown";
            let mysqlVersionInfo = null;

            let debugInfo = {
                availableTables: [] as string[],
                databaseVersion: "unknown",
                enhancedQuery: ""
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
                    autoRetry = false,
                    enableAutoCorrect = false,
                    generateSummary = false,
                    summarizeResults = false,
                    useSchemaCache = true,
                    enableSchemaCache = true,
                    multiAgentMode = false,
                    enableMultiAgent = false,
                    detailedAnalytics = false,
                    enableToolTracing = false,
                    friendlyErrors = true,
                    advancedConversation = false,
                    enableAgentQuestions = false,
                    autocompleteMode = true,
                    enableAutoComplete = true,
                    maxRetries = 3,
                    summaryFormat = 'text',
                    analyzePatterns = false,
                    returnSQLExplanation = false,
                    // Chain parameters
                    useChains = false,
                    chainType = 'simple',
                    preferredChain = '',
                    // Graph parameters
                    generateGraph = false,
                    graphType = GraphType.BAR_CHART,
                    graphCategory = undefined,
                    graphConfig = {}
                } = req.body;

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
                            debugInfo.availableTables = tables;
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
                            debugInfo.availableTables = tables;
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

                // ========== ENHANCED QUERY CREATION ==========
                // Create enhanced query with database context and version info using the service
                console.log('🔍 Creating enhanced query for SQL Agent...');
                
                const enhancedQuery = EnhancedQueryService.createEnhancedQuery({
                    query,
                    organizationId,
                    databaseType: dbConfig.type,
                    databaseVersionString: mySQLVersionString,
                    databaseVersionInfo: mysqlVersionInfo,
                    conversational,
                    chatHistory,
                    availableTables: debugInfo.availableTables
                });
                
                debugInfo.enhancedQuery = enhancedQuery;
                debugInfo.databaseVersion = mysqlVersionInfo?.full || mySQLVersionString;
                console.log('📝 Enhanced query created:', enhancedQuery.substring(0, 300) + '...');

                // ========== SQL AGENT EXECUTION ==========
                let agentResponse: any;

                try {
                    console.log('🤖 Sending enhanced query to SQL Agent...');
                    agentResponse = await sqlAgent.call({
                        input: enhancedQuery
                    });
                    
                    rawAgentResponse = agentResponse;
                    console.log('✅ SQL Agent response received');

                } catch (agentError: any) {
                    console.error('❌ SQL Agent error:', agentError);
                    return res.status(500).json({
                        error: 'SQL Agent execution error',
                        message: agentError.message,
                        timestamp: new Date().toISOString()
                    });
                }

                // Extract SQL from agent response
                let sql = cleanSQLQuery(agentResponse.output || agentResponse);
                if (!sql) {
                    return res.status(500).json({
                        error: 'No SQL generated',
                        message: 'SQL Agent did not generate valid SQL',
                        timestamp: new Date().toISOString()
                    });
                }

                console.log('🔧 Extracted SQL:', sql);

                // Execute the SQL query
                let queryResults: any[] = [];
                let totalResults = 0;
                
                try {
                    if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                        const connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                        const [results] = await connection.execute(sql);
                        queryResults = Array.isArray(results) ? results : [];
                        await connection.end();
                    } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                        const client = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                        const result = await client.query(sql);
                        queryResults = result.rows || [];
                        await client.end();
                    }
                    
                    totalResults = queryResults.length;
                    console.log(`✅ Query executed successfully, ${totalResults} results`);

                } catch (sqlError: any) {
                    console.error('❌ SQL execution error:', sqlError);
                    return res.status(400).json({
                        error: 'SQL execution error',
                        message: sqlError.message,
                        sql: sql,
                        timestamp: new Date().toISOString()
                    });
                }

                // ========== STRUCTURED QUERY GENERATION ==========
                // Generate restructured SQL with database schema context
                let restructuredResults: any = null;
                if (queryResults.length > 0) {
                    try {
                        console.log('🔄 Generating structured query with enhanced schema context...');
                        
                        // Collect table schemas for structured query context
                        const tableSchemas: Record<string, any[]> = {};
                        
                        // Get schemas for each available table
                        if (debugInfo.availableTables.length > 0) {
                            for (const tableName of debugInfo.availableTables.slice(0, 10)) { // Limit to prevent excessive calls
                                try {
                                    const schemaResponse = await sqlAgent.call({
                                        input: `sql_db_schema("${tableName}")`,
                                        chat_history: []
                                    });
                                    
                                    // Parse schema response to extract column information
                                    const schemaText = schemaResponse.output || schemaResponse;
                                    // Simple parsing - could be enhanced based on actual response format
                                    const columns: any[] = [];
                                    
                                    // Extract column information (this might need adjustment based on actual SQL Agent response format)
                                    const lines = schemaText.split('\n');
                                    for (const line of lines) {
                                        if (line.includes('column') || line.includes('Column') || line.includes('|')) {
                                            // Basic column parsing - enhance based on actual format
                                            const parts = line.split(/[\s|]+/).filter((part: string) => part.length > 0);
                                            if (parts.length >= 2) {
                                                columns.push({
                                                    name: parts[0],
                                                    type: parts[1] || 'unknown',
                                                    column_name: parts[0]
                                                });
                                            }
                                        }
                                    }
                                    
                                    if (columns.length > 0) {
                                        tableSchemas[tableName] = columns;
                                        console.log(`📋 Schema collected for ${tableName}: ${columns.length} columns`);
                                    }
                                } catch (schemaError) {
                                    console.error(`❌ Failed to get schema for table ${tableName}:`, schemaError);
                                }
                            }
                        }

                        restructuredResults = await generateRestructuredSQL(
                            sql,
                            queryResults,
                            query,
                            dbConfig.type,
                            mySQLVersionString,
                            3, // sample size
                            sqlAgent,
                            organizationId,
                            mysqlVersionInfo, // database version info
                            tableSchemas, // table schemas
                            debugInfo.availableTables // available tables
                        );
                        
                        console.log('✅ Structured query generation completed');

                        // If we successfully generated a restructured SQL, execute it like in original medical.ts
                        if (restructuredResults && restructuredResults.restructure_success && restructuredResults.restructured_sql) {
                            try {
                                console.log('🔄 Executing restructured SQL query...');
                                console.log('🔧 Restructured SQL:', restructuredResults.restructured_sql);

                                let restructuredRows: any[] = [];
                                
                                // Execute the restructured SQL query
                                if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                    const connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                                    const [results] = await connection.execute(restructuredResults.restructured_sql);
                                    restructuredRows = Array.isArray(results) ? results : [];
                                    await connection.end();
                                } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                    const client = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                                    const result = await client.query(restructuredResults.restructured_sql);
                                    restructuredRows = result.rows || [];
                                    await client.end();
                                }

                                // Add the restructured data to the results
                                restructuredResults.restructured_data = restructuredRows;
                                restructuredResults.restructured_count = restructuredRows.length;
                                
                                console.log(`✅ Restructured SQL executed successfully, ${restructuredRows.length} records returned`);
                                
                            } catch (restructuredSQLError: any) {
                                console.error('❌ Error executing restructured SQL:', restructuredSQLError);
                                restructuredResults.restructure_message += ` | Execution failed: ${restructuredSQLError.message}`;
                                restructuredResults.restructured_data = [];
                                // Continue with original results
                            }
                        }
                    } catch (restructError: any) {
                        console.error('❌ Structured query generation error:', restructError);
                        // Continue without restructured results
                        restructuredResults = {
                            restructure_success: false,
                            restructure_message: `Structured query generation failed: ${restructError.message}`,
                            restructured_data: []
                        };
                    }
                }

                // Save conversation if in conversational mode
                if (conversational && sessionData) {
                    try {
                        await sessionData.memory.saveContext(
                            { input: query },
                            { output: `Found ${totalResults} results` }
                        );
                    } catch (memoryError) {
                        console.error('❌ Error saving conversation:', memoryError);
                    }
                }

                // Generate graph if requested
                let graphData = null;
                if (generateGraph && queryResults.length > 0) {
                    try {
                        // Get Azure OpenAI client for graph analysis
                        const azureClient = getAzureOpenAIClient();
                        if (azureClient) {
                            const graphAnalysis = await AIGraphAnalyzer.analyzeDataWithAI(
                                queryResults,
                                azureClient
                            );

                            graphData = GraphProcessor.processGraphData(
                                queryResults,
                                graphAnalysis.config
                            );

                            console.log('📊 Graph data generated successfully');
                        }
                    } catch (graphError) {
                        console.error('❌ Graph generation error:', graphError);
                        // Continue without graph data
                    }
                }

                // Generate description if requested
                let description = null;
                if (generateDescription && queryResults.length > 0) {
                    try {
                        description = await generateBarChartAnalysis(
                            sql,
                            query,
                            queryResults,
                            organizationId
                        );
                    } catch (descError) {
                        console.error('❌ Description generation error:', descError);
                    }
                }

                const endTime = performance.now();
                const duration = Math.round(endTime - startTime);

                // Return comprehensive response
                const response = {
                    success: true,
                    query: query,
                    enhancedQuery: enhancedQuery,
                    sql: sql,
                    results: queryResults,
                    totalResults: totalResults,
                    executionTime: duration,
                    graphData: graphData,
                    description: description,
                    restructuredResults: restructuredResults,
                    conversational: conversational,
                    sessionId: conversational ? sessionId : undefined,
                    organizationId: organizationId,
                    timestamp: new Date().toISOString(),
                    databaseInfo: {
                        type: dbConfig.type,
                        version: mySQLVersionString,
                        availableTables: debugInfo.availableTables
                    },
                    debugInfo: debugInfo
                };

                res.json(response);

                // Cleanup: Close database connections to prevent "Too many connections" errors like in medical.ts
                try {
                    await databaseService.closeOrganizationConnections(organizationId);
                    console.log(`🔌 Closed all database connections for organization: ${organizationId}`);
                } catch (cleanupError) {
                    console.error(`❌ Error closing database connections for organization ${organizationId}:`, cleanupError);
                }

            } catch (error: any) {
                console.error('❌ Unexpected error in medical query:', error);
                const endTime = performance.now();
                const duration = Math.round(endTime - startTime);

                // Extract organizationId from request for cleanup
                const organizationIdForCleanup = req.body?.organizationId;

                // Cleanup database connections on error
                if (organizationIdForCleanup) {
                    try {
                        await databaseService.closeOrganizationConnections(organizationIdForCleanup);
                        console.log(`🔌 Closed database connections for organization: ${organizationIdForCleanup} (error cleanup)`);
                    } catch (cleanupError) {
                        console.error(`❌ Error closing database connections during cleanup for organization ${organizationIdForCleanup}:`, cleanupError);
                    }
                }

                return res.status(500).json({
                    success: false,
                    error: 'Internal server error',
                    message: error.message,
                    executionTime: duration,
                    timestamp: new Date().toISOString(),
                    debugInfo: debugInfo
                });
            }
        }
    );

    return router;
}

export default medicalRoutes;

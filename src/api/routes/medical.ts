import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mysql from 'mysql2/promise';
import { MedicalDatabaseLangChainApp } from '../../index';
import { BufferMemory } from 'langchain/memory';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/databaseService';
import multiTenantLangChainService from '../../services/multiTenantLangChainService';

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





export function medicalRoutes(): Router {
    const router = Router();

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
                    organizationId,
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

                // Declare connection variable for later use
                let connection;

                // Get minimal database information to guide the agent
                try {
                    connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                    const dbConfig = await databaseService.getOrganizationDatabaseConnection(organizationId);

                    // Just get a list of tables to verify they exist
                    // The sqlAgent will get detailed schema information using its own tools
                    console.log('📊 Getting high-level database structure');
                    const [tables] = await connection.execute(
                        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                        [dbConfig.database]
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

                                    // Capture any SQL-related actions, including query-checker and query-sql
                                    if (action.tool === 'query-checker' || action.tool === 'query-sql') {
                                        const sql = String(action.toolInput);
                                        // Store raw SQL before any cleaning
                                        debugInfo.originalQueries.push(sql);

                                        // Clean the SQL to extract only valid SQL
                                        const cleanedSql = cleanSQLQuery(sql);
                                        if (cleanedSql) {
                                            capturedSQLQueries.push(cleanedSql);
                                            console.log(`✅ Captured SQL from ${action.tool}:`, cleanedSql);
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
                    connection = await databaseService.createOrganizationMySQLConnection(organizationId);
                    const dbConfig = await databaseService.getOrganizationDatabaseConnection(organizationId);

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
                                            [dbConfig.database, correctedTableName]
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
                    connection = await databaseService.createOrganizationMySQLConnection(organizationId);

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
                                // Get database configuration for error handling
                                const dbConfigForError = await databaseService.getOrganizationDatabaseConnection(organizationId);
                                
                                // First verify the table exists
                                const [tableResult] = await connection.execute(
                                    "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                    [dbConfigForError.database, tableName]
                                );

                                if (Array.isArray(tableResult) && tableResult.length > 0) {
                                    // Table exists, get all its columns
                                    const [columns] = await connection.execute(
                                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                                        [dbConfigForError.database, tableName]
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
                                        [dbConfigForError.database]
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
                                // Get database configuration for error handling
                                const dbConfigForTableError = await databaseService.getOrganizationDatabaseConnection(organizationId);
                                
                                const [allTables] = await connection.execute(
                                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                                    [dbConfigForTableError.database]
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
                                            [dbConfigForTableError.database, suggestedTable]
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


    // The /query-conversation endpoint has been removed
    // Its functionality has been integrated into /query-sql-manual

    return router;
}

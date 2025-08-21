import { MultiTenantLangChainService } from '../../services/multiTenantLangChainService';
import { DatabaseService } from '../../services/databaseService';
import { v4 as uuidv4 } from 'uuid';

export class RetryAndErrorHandlingService {
    constructor(
        private multiTenantLangChainService: MultiTenantLangChainService,
        private databaseService: DatabaseService
    ) {}

    /**
     * Handles zero records retry logic and comprehensive error analysis
     * @param params - Parameters for retry and error handling
     * @returns Object containing retry decision, cleanup status, and error analysis
     */
    async handleRetryLogicAndErrors(params: {
        rows: any[];
        currentAttempt: number;
        maxRetryAttempts: number;
        connection: any;
        dbConfig: any;
        organizationId: string;
        debugInfo: any;
        updatedResponse: any;
        sqlError?: any;
        query?: string;
        finalSQL?: string;
        extractedSQL?: string;
        generateDescription?: boolean;
        conversational?: boolean;
        sessionData?: any;
        agentResult?: any;
        capturedSQLQueries?: any[];
        intermediateSteps?: any[];
        mySQLVersionString?: string;
        mysqlVersionInfo?: any;
        startTime: number;
        rawAgentResponse?: string;
    }) {
        const {
            rows,
            currentAttempt,
            maxRetryAttempts,
            connection,
            dbConfig,
            organizationId,
            debugInfo,
            updatedResponse,
            sqlError,
            query = '',
            finalSQL = '',
            extractedSQL = '',
            generateDescription = false,
            conversational = false,
            sessionData,
            agentResult,
            capturedSQLQueries = [],
            intermediateSteps = [],
            mySQLVersionString = '',
            mysqlVersionInfo,
            startTime,
            rawAgentResponse = ''
        } = params;

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
                await this.databaseService.closeOrganizationConnections(organizationId);
            } catch (cleanupError) {
                console.error(`❌ Error during retry cleanup:`, cleanupError);
            }

            // Mark this attempt as incomplete to trigger retry
            debugInfo.sqlCorrections.push(`Attempt ${currentAttempt}: Zero records returned, triggering full API retry`);

            // Capture zero records issue for next attempt's enhanced query
            const previousAttemptError = `Attempt ${currentAttempt} returned zero records. The query may have incorrect conditions, wrong table selection, or overly restrictive filters.`;

            return {
                shouldRetry: true,
                shouldBreak: false,
                finalResult: null,
                previousAttemptError,
                responseSent: false
            };
        } else {
            // Either we have records OR we've exhausted retry attempts
            if (hasZeroRecords) {
                console.log(`⚠️ Zero records returned on final attempt ${currentAttempt}. Proceeding with empty result.`);
                debugInfo.sqlCorrections.push(`Final attempt ${currentAttempt}: Zero records returned, no more retries`);
            } else {
                console.log(`✅ Attempt ${currentAttempt} successful with ${updatedResponse.result_count} records`);
                if (currentAttempt > 1) {
                    debugInfo.sqlCorrections.push(`Attempt ${currentAttempt}: Success after ${currentAttempt - 1} retries`);
                }
            }

            // Set final result to break out of retry loop
            const finalResult = updatedResponse;
            
            // ========== CLEANUP: Close database connections ==========
            // Cleanup connections after successful processing
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

                await this.databaseService.closeOrganizationConnections(organizationId);
                console.log(`🔌 Closed all database connections for organization: ${organizationId}`);
            } catch (cleanupError) {
                console.error(`❌ Error closing database connections for organization ${organizationId}:`, cleanupError);
            }
            // ========================================================
            
            return {
                shouldRetry: false,
                shouldBreak: true,
                finalResult,
                previousAttemptError: null,
                responseSent: false
            };
        }
    }

    /**
     * Handles comprehensive SQL error analysis and user-friendly error responses
     * @param params - Parameters for error handling
     * @returns Error response object with detailed analysis
     */
    async handleSQLError(params: {
        sqlError: any;
        organizationId: string;
        dbConfig: any;
        query: string;
        finalSQL: string;
        extractedSQL: string;
        debugInfo: any;
        generateDescription: boolean;
        conversational: boolean;
        sessionData?: any;
        currentAttempt: number;
        maxRetryAttempts: number;
        agentResult: any;
        capturedSQLQueries: any[];
        intermediateSteps: any[];
        mySQLVersionString: string;
        mysqlVersionInfo: any;
        startTime: number;
        sessionId?: string;
        chatHistory?: any[];
        responseSent: boolean;
        res: any;
    }) {
        const {
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
            chatHistory = [],
            responseSent,
            res
        } = params;

        console.error('❌ SQL execution failed:', sqlError.message);

        // Cleanup: Close database connections to prevent "Too many connections" errors
        try {
            await this.databaseService.closeOrganizationConnections(organizationId);
            console.log(`🔌 Closed database connections for organization: ${organizationId}`);
        } catch (cleanupError) {
            console.error(`❌ Error closing database connections for organization ${organizationId}:`, cleanupError);
        }

        // Enhanced error analysis and suggestions
        const suggestedFixes: string[] = [];
        let errorDetails: any = {};

        // Handle column not found errors
        if (sqlError.message.includes('Unknown column') || sqlError.message.includes('column') && sqlError.message.includes('doesn\'t exist')) {
            errorDetails = await this.analyzeColumnError(sqlError, organizationId, dbConfig, suggestedFixes, debugInfo);
        }
        // Handle table not found errors
        else if (sqlError.message.includes('doesn\'t exist')) {
            errorDetails = await this.analyzeTableError(sqlError, organizationId, dbConfig, suggestedFixes, debugInfo);
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
            errorDescription = await this.generateErrorDescription(organizationId, query, finalSQL, sqlError, errorDetails);
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
            const errorResponse = {
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
            };

            res.status(500).json(errorResponse);
            return { responseSent: true, previousAttemptError: null };
        } else if (currentAttempt < maxRetryAttempts) {
            // If not the final attempt, capture error for next retry
            console.log(`🔄 SQL error on attempt ${currentAttempt}. Will retry...`);
            const previousAttemptError = `SQL execution failed on attempt ${currentAttempt}: ${sqlError.message}`;
            return { responseSent, previousAttemptError };
        }

        return { responseSent, previousAttemptError: null };
    }

    /**
     * Analyzes column-related SQL errors and provides suggestions
     */
    private async analyzeColumnError(sqlError: any, organizationId: string, dbConfig: any, suggestedFixes: string[], debugInfo: any) {
        // Extract the problematic column name
        const columnMatch = sqlError.message.match(/Unknown column '([^']+)'/);
        const badColumn = columnMatch ? columnMatch[1] : 'unknown';

        console.log(`🚨 Column error detected: "${badColumn}"`);

        // Determine if it's a table.column pattern
        let tableName, columnName;
        if (badColumn.includes('.')) {
            [tableName, columnName] = badColumn.split('.');
        }

        let errorDetails: any = {};

        try {
            // Create a new connection for error analysis
            let errorConnection: any;
            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                errorConnection = await this.databaseService.createOrganizationMySQLConnection(organizationId);
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                errorConnection = await this.databaseService.createOrganizationPostgreSQLConnection(organizationId);
            }

            if (errorConnection && tableName && columnName) {
                // Get database configuration for error handling
                const dbConfigForError = await this.databaseService.getOrganizationDatabaseConnection(organizationId);

                if (dbConfigForError.type === 'mysql') {
                    errorDetails = await this.analyzeMySQLColumnError(errorConnection, dbConfigForError, tableName, columnName, badColumn, suggestedFixes);
                } else if (dbConfigForError.type === 'postgresql') {
                    errorDetails = await this.analyzePostgreSQLColumnError(errorConnection, tableName, columnName, badColumn, suggestedFixes);
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
        return errorDetails;
    }

    /**
     * Analyzes MySQL column errors
     */
    private async analyzeMySQLColumnError(errorConnection: any, dbConfigForError: any, tableName: string, columnName: string, badColumn: string, suggestedFixes: string[]) {
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

                    return {
                        error_type: 'column_not_found',
                        problematic_column: badColumn,
                        suggested_column: `${tableName}.${suggestedColumn}`,
                        suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Did you mean '${suggestedColumn}'?`
                    };
                } else {
                    // No similar column found, show available columns
                    const availableColumns = actualColumns.slice(0, 10).join(', ');
                    suggestedFixes.push(`Choose a column from: ${availableColumns}...`);
                    
                    return {
                        error_type: 'column_not_found',
                        problematic_column: badColumn,
                        available_columns: availableColumns,
                        suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Available columns: ${availableColumns}...`
                    };
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
                const similarTable = this.findSimilarTableName(allTableNames, tableName);

                if (similarTable) {
                    console.log(`🔄 Table '${tableName}' doesn't exist, but found similar table '${similarTable}'`);
                    suggestedFixes.push(`Use table '${similarTable}' instead of '${tableName}'`);
                    
                    return {
                        error_type: 'table_and_column_not_found',
                        problematic_table: tableName,
                        problematic_column: columnName,
                        suggested_table: similarTable,
                        suggestion: `Both table '${tableName}' and column '${columnName}' have issues. Try using table '${similarTable}' instead.`
                    };
                }
            }
        }

        return {};
    }

    /**
     * Analyzes PostgreSQL column errors
     */
    private async analyzePostgreSQLColumnError(errorConnection: any, tableName: string, columnName: string, badColumn: string, suggestedFixes: string[]) {
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

                    return {
                        error_type: 'column_not_found',
                        problematic_column: badColumn,
                        suggested_column: `${tableName}.${suggestedColumn}`,
                        suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Did you mean '${suggestedColumn}'?`
                    };
                } else {
                    const availableColumns = actualColumns.slice(0, 10).join(', ');
                    suggestedFixes.push(`Choose a column from: ${availableColumns}...`);
                    
                    return {
                        error_type: 'column_not_found',
                        problematic_column: badColumn,
                        available_columns: availableColumns,
                        suggestion: `The column '${columnName}' does not exist in table '${tableName}'. Available columns: ${availableColumns}...`
                    };
                }
            }
        } else {
            // Table doesn't exist, look for similar table names
            const allTablesResult = await errorConnection.query(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
            );

            if (allTablesResult.rows && allTablesResult.rows.length > 0) {
                const allTableNames = allTablesResult.rows.map((t: any) => t.tablename);
                const similarTable = this.findSimilarTableName(allTableNames, tableName);

                if (similarTable) {
                    console.log(`🔄 Table '${tableName}' doesn't exist, but found similar table '${similarTable}'`);
                    suggestedFixes.push(`Use table '${similarTable}' instead of '${tableName}'`);
                    
                    return {
                        error_type: 'table_and_column_not_found',
                        problematic_table: tableName,
                        problematic_column: columnName,
                        suggested_table: similarTable,
                        suggestion: `Both table '${tableName}' and column '${columnName}' have issues. Try using table '${similarTable}' instead.`
                    };
                }
            }
        }

        return {};
    }

    /**
     * Analyzes table-related SQL errors and provides suggestions
     */
    private async analyzeTableError(sqlError: any, organizationId: string, dbConfig: any, suggestedFixes: string[], debugInfo: any) {
        // Extract the problematic table name
        const tableMatch = sqlError.message.match(/Table '.*\.(\w+)' doesn't exist/);
        const badTable = tableMatch ? tableMatch[1] : 'unknown';

        console.log(`🚨 Table error detected: "${badTable}"`);

        let errorDetails: any = {};

        try {
            // Create a new connection for error analysis
            let errorConnection: any;
            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                errorConnection = await this.databaseService.createOrganizationMySQLConnection(organizationId);
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                errorConnection = await this.databaseService.createOrganizationPostgreSQLConnection(organizationId);
            }

            if (errorConnection) {
                // Get database configuration for error handling
                const dbConfigForTableError = await this.databaseService.getOrganizationDatabaseConnection(organizationId);

                if (dbConfigForTableError.type === 'mysql') {
                    const [allTables] = await errorConnection.execute(
                        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                        [dbConfigForTableError.database]
                    );

                    if (Array.isArray(allTables) && allTables.length > 0) {
                        const allTableNames = allTables.map((t: any) => t.TABLE_NAME);
                        const similarTable = this.findSimilarTableName(allTableNames, badTable);

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
                        const similarTable = this.findSimilarTableName(allTableNames, badTable);

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
        return errorDetails;
    }

    /**
     * Finds similar table names using fuzzy matching
     */
    private findSimilarTableName(allTableNames: string[], targetTable: string): string | undefined {
        return allTableNames.find((t: string) =>
            t.replace(/_/g, '').toLowerCase() === targetTable.toLowerCase() ||
            t.toLowerCase().startsWith(targetTable.toLowerCase()) ||
            targetTable.toLowerCase().startsWith(t.toLowerCase())
        );
    }

    /**
     * Generates user-friendly error descriptions using LLM
     */
    private async generateErrorDescription(organizationId: string, query: string, finalSQL: string, sqlError: any, errorDetails: any): Promise<string> {
        try {
            const langchainApp = await this.multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
            const llm = (langchainApp as any).llm;

            if (llm) {
                const errorDescriptionPrompt = `You are a helpful database assistant. A user's SQL query failed with an error. Explain what went wrong in simple, non-technical terms and suggest how to fix it.

User's Original Question: ${query}
Generated SQL: ${finalSQL}
Error Message: ${sqlError.message}
Error Type: ${errorDetails.error_type || 'unknown'}

Provide a brief, user-friendly explanation (2-3 sentences) that:
1. Explains what went wrong in simple terms
2. Suggests how the user could rephrase their question
3. Is encouraging and helpful

Avoid technical jargon and focus on helping the user get the information they need.`;

                const errorDescResponse = await llm.invoke(errorDescriptionPrompt);
                const errorDescription = typeof errorDescResponse === 'string' ? errorDescResponse : errorDescResponse.content || '';
                console.log('✅ Generated error description');
                return errorDescription;
            } else {
                return 'An error occurred while processing your query. Please try rephrasing your question or contact support.';
            }
        } catch (descError) {
            console.error('❌ Error generating error description:', descError);
            return 'An error occurred while processing your query. Please try rephrasing your question.';
        }
    }

    /**
     * Handles general errors within the retry loop
     */
    async handleGeneralError(params: {
        error: Error;
        currentAttempt: number;
        maxRetryAttempts: number;
        debugInfo: any;
        startTime: number;
        rawAgentResponse: string;
        responseSent: boolean;
        res: any;
        conversational?: boolean;
        sessionId?: string;
        chatHistory?: any[];
    }) {
        const {
            error,
            currentAttempt,
            maxRetryAttempts,
            debugInfo,
            startTime,
            rawAgentResponse,
            responseSent,
            res,
            conversational = false,
            sessionId = uuidv4(),
            chatHistory = []
        } = params;

        console.error(`❌ Attempt ${currentAttempt} failed with error:`, error);

        // If this is not the final attempt, try again
        if (currentAttempt < maxRetryAttempts) {
            console.log(`🔄 Error on attempt ${currentAttempt}. Trying again...`);
            debugInfo.sqlCorrections.push(`Attempt ${currentAttempt}: Error occurred - ${error.message}. Retrying...`);

            // Capture error for next attempt's enhanced query
            const previousAttemptError = `Attempt ${currentAttempt} failed with: ${error.message}`;

            return {
                shouldRetry: true,
                previousAttemptError,
                responseSent
            };
        }

        // Final attempt failed - handle error
        const processingTime = performance.now() - startTime;
        console.error('❌ Manual SQL query processing error after all retries:', error);

        // Cleanup: Log connection management for debugging
        console.log(`🔌 API request failed with general error after ${currentAttempt} attempts`);

        // Only send error response if no response has been sent yet
        if (!responseSent) {
            const errorResponse = {
                error: 'Manual SQL query processing failed',
                message: error.message,
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
            };

            res.status(500).json(errorResponse);
            return {
                shouldRetry: false,
                previousAttemptError: null,
                responseSent: true
            };
        }

        return {
            shouldRetry: false,
            previousAttemptError: null,
            responseSent
        };
    }
}

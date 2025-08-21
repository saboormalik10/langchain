import { Response } from "express";

/**
 * SQL Query Execution Service
 * Handles SQL query execution with error recovery and syntax fixing
 */

interface SqlQueryExecutionParams {
    finalSQL: string;
    connection: any;
    dbConfig: any;
    startTime: number;
    debugInfo: any;
}

interface SqlQueryExecutionResult {
    success: boolean;
    rows?: any[];
    fields?: any;
    finalSQL?: string;
    processingTime?: number;
    errorResponse?: any;
}

/**
 * Executes SQL query with automatic error recovery and syntax fixing
 * @param params SQL query execution parameters
 * @param res Express response object
 * @returns SQL query execution result
 */
export async function executeSqlQueryWithRecovery(
    params: SqlQueryExecutionParams,
    res: Response
): Promise<SqlQueryExecutionResult> {
    const { finalSQL, connection, dbConfig, startTime, debugInfo } = params;
    
    let rows: any[] = [];
    let fields: any = null;
    let executedSQL = finalSQL;

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
                executedSQL = fixedSQL; // Use the fixed SQL for logging
                debugInfo.sqlCorrections.push('Applied auto-fix for syntax error during execution');
            } catch (retryError: any) {
                console.error('❌ Retry also failed:', retryError.message);
                return {
                    success: false,
                    errorResponse: {
                        error: 'SQL execution failed after retry',
                        originalError: executionError.message,
                        retryError: retryError.message,
                        sql: finalSQL,
                        timestamp: new Date().toISOString()
                    }
                };
            }
        } else {
            return {
                success: false,
                errorResponse: {
                    error: 'SQL execution failed',
                    details: executionError.message,
                    sql: finalSQL,
                    timestamp: new Date().toISOString()
                }
            };
        }
    }

    const processingTime = performance.now() - startTime;

    return {
        success: true,
        rows,
        fields,
        finalSQL: executedSQL,
        processingTime
    };
}

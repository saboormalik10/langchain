import { Response } from "express";
import databaseService from "../../services/databaseService";

/**
 * SQL Execution Service
 * Handles database connection establishment and SQL query execution
 */

interface SqlExecutionParams {
    finalSQL: string;
    dbConfig: any;
    organizationId: string;
}

interface SqlExecutionResult {
    success: boolean;
    connection?: any;
    errorResponse?: any;
}

/**
 * Establishes database connection and prepares for SQL execution
 * @param params SQL execution parameters
 * @param res Express response object
 * @returns SQL execution result
 */
export async function establishDatabaseConnection(
    params: SqlExecutionParams,
    res: Response
): Promise<SqlExecutionResult> {
    const { finalSQL, dbConfig, organizationId } = params;

    try {
        let connection: any;
        if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
            connection = await databaseService.createOrganizationMySQLConnection(organizationId);
        } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
            connection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
        }

        console.log('✅ Database connection established');
        console.log('🔧 Executing SQL:', finalSQL);

        return {
            success: true,
            connection
        };
    } catch (error) {
        console.error('❌ Database connection error:', error);
        return {
            success: false,
            errorResponse: {
                error: 'Failed to establish database connection',
                details: error,
                timestamp: new Date().toISOString()
            }
        };
    }
}

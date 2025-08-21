import { Response } from 'express';
import databaseService from '../../services/databaseService';

/**
 * Interface for SQL validation result
 */
export interface SqlValidationResult {
    success: boolean;
    finalSQL: string;
    corrections: string[];
    errorResponse?: any;
}

/**
 * Interface for SQL validation parameters
 */
export interface SqlValidationParams {
    finalSQL: string;
    dbConfig: any;
    organizationId: string;
    debugInfo: any;
}

/**
 * Service for validating and correcting SQL queries against the database schema
 * Handles table and column validation, name corrections, and syntax fixes
 */
export async function validateAndCorrectSQL(
    params: SqlValidationParams,
    res: Response
): Promise<SqlValidationResult> {
    const { finalSQL, dbConfig, organizationId, debugInfo } = params;

    try {
        console.log('📊 Step 3.7: Validating SQL query before execution...');

        // Quick syntax validation without repeating schema analysis that sqlAgent already did
        let connection: any;
        if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
            connection = await databaseService.createOrganizationMySQLConnection(organizationId);
        } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
            connection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
        }

        // Extract table names from the query
        const tableNamePattern = /FROM\s+(\w+)|JOIN\s+(\w+)/gi;
        const tableMatches = [...finalSQL.matchAll(tableNamePattern)];
        const tableNames = tableMatches
            .map(match => match[1] || match[2])
            .filter(name => name && !['SELECT', 'WHERE', 'AND', 'OR', 'ORDER', 'GROUP', 'HAVING', 'LIMIT'].includes(name.toUpperCase()));

        console.log('🔍 Query references these tables:', tableNames);

        // Map to store potential table name corrections
        const tableCorrections: { [key: string]: string } = {};
        const columnCorrections: { [key: string]: string } = {};
        let sqlNeedsCorrection = false;

        // Do a simple check if these tables exist and find similar table names if not
        for (const tableName of tableNames) {
            try {
                if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                    // MySQL table validation
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
                            const similarTableNoUnderscores = allTableNames.find((t: string) =>
                                t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase()
                            );

                            // 2. Check for plural/singular variations
                            const singularName = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
                            const pluralName = tableName.endsWith('s') ? tableName : tableName + 's';

                            const similarTableByPlurality = allTableNames.find((t: string) =>
                                t.toLowerCase() === singularName.toLowerCase() ||
                                t.toLowerCase() === pluralName.toLowerCase()
                            );

                            // 3. Check for table with similar prefix
                            const similarTableByPrefix = allTableNames.find((t: string) =>
                                (t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                    tableName.toLowerCase().startsWith(t.toLowerCase())) &&
                                t.length > 3
                            );

                            const correctedTableName = similarTableNoUnderscores || similarTableByPlurality || similarTableByPrefix;

                            if (correctedTableName) {
                                console.log(`🔄 Found similar table: '${correctedTableName}' instead of '${tableName}'`);
                                tableCorrections[tableName] = correctedTableName;
                                sqlNeedsCorrection = true;
                            }
                        }
                    }
                } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                    // PostgreSQL table validation
                    const result = await connection.query(
                        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
                        [tableName]
                    );

                    if (result.rows && result.rows.length > 0) {
                        console.log(`✅ Table '${tableName}' exists`);

                        // If table exists, get a sample of column names to verify query correctness
                        const columnsResult = await connection.query(
                            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 LIMIT 10",
                            [tableName]
                        );

                        if (columnsResult.rows && columnsResult.rows.length > 0) {
                            const sampleColumns = columnsResult.rows.map((col: any) => col.column_name).slice(0, 5).join(', ');
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
                            const actualColumns = columnsResult.rows.map((col: any) => col.column_name);
                            for (const queriedCol of queriedColumns) {
                                if (!actualColumns.includes(queriedCol)) {
                                    // Try to find a similar column name (e.g., 'fullname' vs 'full_name')
                                    const similarCol = actualColumns.find((col: string) =>
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
                        const allTablesResult = await connection.query(
                            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                        );

                        if (allTablesResult.rows && allTablesResult.rows.length > 0) {
                            // Look for similar table names
                            const allTableNames = allTablesResult.rows.map((t: any) => t.tablename);

                            // Try different matching strategies
                            // 1. Remove underscores and compare
                            const similarTableNoUnderscores = allTableNames.find((t: string) =>
                                t.replace(/_/g, '').toLowerCase() === tableName.toLowerCase()
                            );

                            // 2. Check for plural/singular variations
                            const singularName = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
                            const pluralName = tableName.endsWith('s') ? tableName : tableName + 's';

                            const similarTableByPlurality = allTableNames.find((t: string) =>
                                t.toLowerCase() === singularName.toLowerCase() ||
                                t.toLowerCase() === pluralName.toLowerCase()
                            );

                            // 3. Check for table with similar prefix
                            const similarTableByPrefix = allTableNames.find((t: string) =>
                                (t.toLowerCase().startsWith(tableName.toLowerCase()) ||
                                    tableName.toLowerCase().startsWith(t.toLowerCase())) &&
                                t.length > 3
                            );

                            const correctedTableName = similarTableNoUnderscores || similarTableByPlurality || similarTableByPrefix;

                            if (correctedTableName) {
                                console.log(`🔄 Found similar table: '${correctedTableName}' instead of '${tableName}'`);
                                tableCorrections[tableName] = correctedTableName;
                                sqlNeedsCorrection = true;
                            }
                        }
                    }
                }
            } catch (tableError: any) {
                console.error(`❌ Error validating table '${tableName}':`, tableError.message);
            }
        }

        // Apply corrections if needed
        let correctedSQL = finalSQL;
        if (sqlNeedsCorrection) {
            // Apply table name corrections
            for (const [oldName, newName] of Object.entries(tableCorrections)) {
                const tableRegex = new RegExp(`\\b${oldName}\\b`, 'gi');
                correctedSQL = correctedSQL.replace(tableRegex, newName);
                console.log(`🔄 Corrected table name: '${oldName}' → '${newName}'`);
            }

            // Apply column name corrections
            for (const [oldName, newName] of Object.entries(columnCorrections)) {
                const columnRegex = new RegExp(`\\b${oldName}\\b`, 'gi');
                correctedSQL = correctedSQL.replace(columnRegex, newName);
                console.log(`🔄 Corrected column name: '${oldName}' → '${newName}'`);
            }

            if (correctedSQL !== finalSQL) {
                console.log('🔄 Applied SQL corrections');
                debugInfo.sqlCorrections.push('Applied table/column name corrections');
            }
        }

        // Close connection
        if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
            await connection.end();
        } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
            await connection.end();
        }

        console.log('✅ Database connection established');

        return {
            success: true,
            finalSQL: correctedSQL,
            corrections: debugInfo.sqlCorrections
        };

    } catch (validationError: any) {
        console.error('❌ Error during query validation:', validationError);
        
        return {
            success: false,
            finalSQL: finalSQL,
            corrections: [],
            errorResponse: {
                error: 'SQL validation failed',
                details: validationError.message,
                timestamp: new Date().toISOString()
            }
        };
    }
}

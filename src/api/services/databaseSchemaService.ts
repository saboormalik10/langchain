import databaseService from "../../services/databaseService";

export interface DatabaseSchemaResult {
    tables: string[];
    success: boolean;
    error?: string;
}

/**
 * Get minimal database information to guide the agent
 * @param organizationId Organization identifier
 * @param dbConfig Database configuration object
 * @param debugInfo Debug information object to store corrections
 * @returns Promise<DatabaseSchemaResult> Schema discovery result
 */
export async function getMinimalDatabaseSchema(
    organizationId: string, 
    dbConfig: any, 
    debugInfo: any
): Promise<DatabaseSchemaResult> {
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
                debugInfo.sqlCorrections.push(`Available tables: ${tables.join(', ')}`);
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
                debugInfo.sqlCorrections.push(`Available tables: ${tables.join(', ')}`);
            } else {
                console.log('⚠️ No tables found in the PostgreSQL database');
            }

            await client.end();
            console.log('✅ Basic PostgreSQL database structure check complete');

        } else {
            throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
        }

        return {
            tables,
            success: true
        };

    } catch (schemaError: any) {
        console.error('❌ Failed to get basic database structure:', schemaError.message);
        return {
            tables: [],
            success: false,
            error: schemaError.message
        };
    }
}

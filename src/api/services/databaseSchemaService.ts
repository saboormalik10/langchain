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
        console.log('� Getting database schema (with caching)...');
        
        // Use the cached schema method instead of direct database calls
        const schemaCache = await databaseService.getOrganizationSchema(organizationId);
        const tables = schemaCache.tables;

        if (tables && tables.length > 0) {
            console.log(`✅ Found ${tables.length} tables:`, tables.join(', '));
            debugInfo.sqlCorrections.push(`Available tables: ${tables.join(', ')}`);
        } else {
            console.log('⚠️ No tables found in the database');
        }

        return {
            tables,
            success: true
        };

    } catch (schemaError: any) {
        console.error('❌ Failed to get database schema:', schemaError.message);
        return {
            tables: [],
            success: false,
            error: schemaError.message
        };
    }
}

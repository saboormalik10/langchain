import databaseService from "../../services/databaseService";

export interface DatabaseVersionInfo {
    full: string;
    major: number;
    minor: number;
    patch: number;
    supportsJSON: boolean;
    supportsWindowFunctions: boolean;
    supportsCTE: boolean;
    supportsRegex: boolean;
    hasOnlyFullGroupBy?: boolean; // MySQL specific
}

export interface DatabaseVersionResult {
    versionString: string;
    versionInfo: DatabaseVersionInfo | null;
    success: boolean;
    error?: string;
}

/**
 * Detect database version for both chain and non-chain modes
 * @param organizationId Organization identifier
 * @param dbConfig Database configuration object
 * @returns Promise<DatabaseVersionResult> Version detection result
 */
export async function detectDatabaseVersion(
    organizationId: string,
    dbConfig: any
): Promise<DatabaseVersionResult> {
    console.log('🔍 Detecting database version for query optimization...');

    try {
        let mySQLVersionString = "unknown";
        let mysqlVersionInfo: DatabaseVersionInfo | null = null;

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

        return {
            versionString: mySQLVersionString,
            versionInfo: mysqlVersionInfo,
            success: true
        };

    } catch (versionError: any) {
        console.error('❌ Failed to get database version:', versionError);
        return {
            versionString: "unknown",
            versionInfo: null,
            success: false,
            error: versionError.message
        };
    }
}

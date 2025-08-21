import * as dotenv from 'dotenv';
import { Pool, QueryResult } from 'pg';
import * as mysql from 'mysql2/promise';
import * as CryptoJS from 'crypto-js';

// Load environment variables
dotenv.config();

interface DatabaseConnection {
    id: string;
    organization_id: string;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string; // encrypted
    type: 'mysql' | 'postgresql' | 'mariadb';
    created_at: Date;
    updated_at: Date;
}

interface DecryptedDatabaseConnection {
    id: string;
    organization_id: string;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string; // decrypted
    type: 'mysql' | 'postgresql' | 'mariadb';
}

// Cache interfaces for comprehensive caching system
interface SchemaCache {
    organizationId: string;
    tables: string[];
    tableColumns: { [tableName: string]: string[] };
    tableRelationships: any[];
    primaryKeys: { [tableName: string]: string };
    foreignKeys: any[];
    lastUpdated: Date;
    expirationTime: Date;
}

interface DatabaseVersionCache {
    organizationId: string;
    dbType: 'mysql' | 'postgresql' | 'mariadb';
    version: string;
    versionInfo: any;
    jsonFunctions: any;
    syntaxRules: any;
    capabilities: string[];
    lastChecked: Date;
    expirationTime: Date;
}

interface TableSampleCache {
    organizationId: string;
    tableName: string;
    sampleData: any[];
    columnTypes: { [column: string]: string };
    lastRefreshed: Date;
    expirationTime: Date;
}

interface SQLPatternCache {
    organizationId: string;
    queryPattern: string;
    optimizedSQL: string;
    resultStructure: any;
    hitCount: number;
    lastUsed: Date;
    expirationTime: Date;
}

interface AIClientCache {
    apiKey: string;
    endpoint: string;
    client: any; // AzureOpenAI client
    createdAt: Date;
    expirationTime: Date;
}

class DatabaseService {
    private pgPool: Pool;
    private encryptionKey: string;
    private isMainDbConnected: boolean = false;
    private organizationConnections: Map<string, any[]> = new Map(); // Track active connections per organization

    // Comprehensive caching system
    private schemaCache: Map<string, SchemaCache> = new Map();
    private versionCache: Map<string, DatabaseVersionCache> = new Map();
    private tableDataCache: Map<string, TableSampleCache> = new Map();
    private sqlPatternCache: Map<string, SQLPatternCache> = new Map();
    private aiClientCache: Map<string, AIClientCache> = new Map();
    private cacheCleanupInterval: NodeJS.Timeout | null = null;

    constructor() {
        // Initialize PostgreSQL connection pool for main database
        console.log('🔌 Initializing PostgreSQL connection pool...', process.env.DATABASE_URL);
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is not set');
        }

        // this.pgPool = new Pool({
        //     connectionString: process.env.DATABASE_URL, // your connection string here
        //     max: 20,
        //     idleTimeoutMillis: 30000,
        //     connectionTimeoutMillis: 60000,
        //     ssl: { rejectUnauthorized: false }
        // });
        this.pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        this.encryptionKey = process.env.ENCRYPTION_KEY || 'vi0BJFHWT8yTlwokRILzAcwyp9gXBE0q';
    }

    /**
     * Test and initialize the main PostgreSQL database connection
     */
    async initializeMainDatabase(): Promise<void> {
        try {
            console.log('🔌 Testing main PostgreSQL database connection...');

            // Test the connection
            const client = await this.pgPool.connect();
            const result = await client.query('SELECT NOW() as current_time, current_database() as database_name');
            client.release();

            console.log(`✅ Main PostgreSQL database connected successfully!`);
            console.log(`📊 Database: ${result.rows[0].database_name}`);
            console.log(`⏰ Server Time: ${result.rows[0].current_time}`);

            this.isMainDbConnected = true;

            // Initialize cache cleanup interval - runs every 15 minutes
            this.startCacheCleanupInterval();
        } catch (error) {
            console.error('❌ Failed to connect to main PostgreSQL database:', error);
            throw new Error(`Main database connection failed: ${(error as Error).message}`);
        }
    }

    /**
     * Check if main database is connected
     */
    isMainDatabaseConnected(): boolean {
        return this.isMainDbConnected;
    }

    /**
     * Decrypt encrypted password
     */
    private decrypt(encryptedData: string): string {
        try {
            if (!encryptedData) {
                console.warn('⚠️  Empty encrypted data provided for decryption');
                return '';
            }

            if (!this.encryptionKey) {
                throw new Error('Encryption key not found in environment variables');
            }

            console.log(`🔐 Decrypting password data (length: ${encryptedData.length})`);
            const bytes = CryptoJS.AES.decrypt(encryptedData, this.encryptionKey);
            const decryptedPassword = bytes.toString(CryptoJS.enc.Utf8);

            if (!decryptedPassword) {
                throw new Error('Decryption resulted in empty password - check encryption key');
            }

            console.log(`✅ Password decrypted successfully (length: ${decryptedPassword.length})`);
            return decryptedPassword;
        } catch (error) {
            console.error('❌ Decryption failed:', error);
            throw new Error(`Decryption failed: ${(error as Error).message}`);
        }
    }

    // ========== COMPREHENSIVE CACHING SYSTEM ==========

    /**
     * Get or fetch database schema information with caching
     * Cache duration: 24 hours (schema rarely changes)
     */
    async getOrganizationSchema(organizationId: string): Promise<SchemaCache> {
        const cached = this.schemaCache.get(organizationId);
        console.log({ cached })
        if (cached && cached.expirationTime > new Date()) {
            console.log('📋 Using cached schema information');
            return cached;
        }

        console.log('🔄 Fetching fresh schema information...');
        const schema = await this.fetchSchemaFromDatabase(organizationId);

        const cacheEntry: SchemaCache = {
            organizationId,
            tables: schema.tables || [],
            tableColumns: schema.tableColumns || {},
            tableRelationships: schema.tableRelationships || [],
            primaryKeys: schema.primaryKeys || {},
            foreignKeys: schema.foreignKeys || [],
            lastUpdated: new Date(),
            expirationTime: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        };

        this.schemaCache.set(organizationId, cacheEntry);
        console.log(`💾 Cached schema for organization: ${organizationId}`);
        return cacheEntry;
    }

    /**
     * Get or detect database version with caching
     * Cache duration: 7 days (version rarely changes)
     */
    async getDatabaseVersion(organizationId: string): Promise<DatabaseVersionCache> {
        const cached = this.versionCache.get(organizationId);

        if (cached && cached.expirationTime > new Date()) {
            console.log('⚙️ Using cached database version info');
            return cached;
        }

        console.log('🔄 Detecting database version...');
        const versionInfo = await this.detectDatabaseVersionFromDB(organizationId);

        const cacheEntry: DatabaseVersionCache = {
            organizationId,
            dbType: (versionInfo.dbType || 'mysql') as 'mysql' | 'postgresql' | 'mariadb',
            version: versionInfo.version || 'unknown',
            versionInfo: versionInfo.versionInfo || {},
            jsonFunctions: versionInfo.jsonFunctions || [],
            syntaxRules: versionInfo.syntaxRules || {},
            capabilities: versionInfo.capabilities || [],
            lastChecked: new Date(),
            expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
        };

        this.versionCache.set(organizationId, cacheEntry);
        console.log(`💾 Cached database version for organization: ${organizationId}`);
        return cacheEntry;
    }

    /**
     * Get or fetch table sample data with caching
     * Cache duration: 6 hours (data changes frequently)
     */
    async getTableSampleData(organizationId: string, tableName: string): Promise<any[]> {
        const cacheKey = `${organizationId}:${tableName}`;
        const cached = this.tableDataCache.get(cacheKey);

        if (cached && cached.expirationTime > new Date()) {
            console.log(`📊 Using cached sample data for ${tableName}`);
            return cached.sampleData;
        }

        console.log(`🔄 Fetching fresh sample data for ${tableName}...`);
        const sampleData = await this.fetchTableSamples(organizationId, tableName);

        const cacheEntry: TableSampleCache = {
            organizationId,
            tableName,
            sampleData: sampleData.slice(0, 5), // Cache first 5 records
            columnTypes: this.detectColumnTypes(sampleData),
            lastRefreshed: new Date(),
            expirationTime: new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 hours
        };

        this.tableDataCache.set(cacheKey, cacheEntry);
        console.log(`💾 Cached sample data for table: ${tableName}`);
        return sampleData;
    }

    /**
     * Get or cache frequently used SQL patterns
     * Cache duration: 2 hours
     */
    async getSQLPattern(organizationId: string, queryPattern: string): Promise<SQLPatternCache | null> {
        const cacheKey = `${organizationId}:${this.hashString(queryPattern)}`;
        const cached = this.sqlPatternCache.get(cacheKey);

        if (cached && cached.expirationTime > new Date()) {
            cached.hitCount++;
            cached.lastUsed = new Date();
            console.log(`🔍 Using cached SQL pattern (hits: ${cached.hitCount})`);
            return cached;
        }

        return null; // No cached pattern found
    }

    /**
     * Cache optimized SQL pattern
     */
    async cacheSQLPattern(organizationId: string, queryPattern: string, optimizedSQL: string, resultStructure: any): Promise<void> {
        const cacheKey = `${organizationId}:${this.hashString(queryPattern)}`;

        const cacheEntry: SQLPatternCache = {
            organizationId,
            queryPattern,
            optimizedSQL,
            resultStructure,
            hitCount: 1,
            lastUsed: new Date(),
            expirationTime: new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours
        };

        this.sqlPatternCache.set(cacheKey, cacheEntry);
        console.log(`💾 Cached SQL pattern for future use`);
    }

    /**
     * Get or cache AI client instances
     * Cache duration: 2 hours
     */
    async getAIClient(apiKey: string, endpoint: string): Promise<any> {
        const cacheKey = `${apiKey}:${endpoint}`;
        const cached = this.aiClientCache.get(cacheKey);

        if (cached && cached.expirationTime > new Date()) {
            console.log('🤖 Using cached AI client');
            return cached.client;
        }

        console.log('🔄 Creating new AI client...');
        // This would be implemented based on your AI client creation logic
        const client = await this.createAIClient(apiKey, endpoint);

        const cacheEntry: AIClientCache = {
            apiKey,
            endpoint,
            client,
            createdAt: new Date(),
            expirationTime: new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours
        };

        this.aiClientCache.set(cacheKey, cacheEntry);
        console.log(`💾 Cached AI client`);
        return client;
    }

    // ========== CACHE HELPER METHODS ==========

    /**
     * Fetch schema information from database
     */
    private async fetchSchemaFromDatabase(organizationId: string): Promise<Partial<SchemaCache>> {
        try {
            const tables = await this.getOrganizationTables(organizationId);
            const tableColumns: { [tableName: string]: string[] } = {};
            const primaryKeys: { [tableName: string]: string } = {};

            for (const tableName of tables) {
                const schema = await this.getOrganizationTableSchema(organizationId, tableName);
                tableColumns[tableName] = schema.map((col: any) => col.column_name);

                // Find primary key
                const pkColumn = schema.find((col: any) => col.column_key === 'PRI' || col.is_primary);
                if (pkColumn) {
                    primaryKeys[tableName] = pkColumn.column_name;
                }
            }

            return {
                tables,
                tableColumns,
                tableRelationships: [], // Could be enhanced to detect relationships
                primaryKeys,
                foreignKeys: [] // Could be enhanced to detect foreign keys
            };
        } catch (error) {
            console.error('❌ Error fetching schema:', error);
            throw error;
        }
    }

    /**
     * Detect database version and capabilities
     */
    private async detectDatabaseVersionFromDB(organizationId: string): Promise<Partial<DatabaseVersionCache>> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);
            let versionQuery = '';

            switch (dbConfig.type.toLowerCase()) {
                case 'mysql':
                case 'mariadb':
                    versionQuery = 'SELECT VERSION() as version';
                    break;
                case 'postgresql':
                    versionQuery = 'SELECT version()';
                    break;
                default:
                    throw new Error(`Unsupported database type: ${dbConfig.type}`);
            }

            const result = await this.executeOrganizationQuery(organizationId, versionQuery);
            const versionString = result[0]?.version || 'Unknown';

            return {
                dbType: dbConfig.type as 'mysql' | 'postgresql' | 'mariadb',
                version: versionString,
                versionInfo: this.parseVersionInfo(versionString, dbConfig.type),
                jsonFunctions: this.getJSONFunctions(dbConfig.type, versionString),
                syntaxRules: this.getSyntaxRules(dbConfig.type),
                capabilities: this.getCapabilities(dbConfig.type, versionString)
            };
        } catch (error) {
            console.error('❌ Error detecting database version:', error);
            throw error;
        }
    }

    /**
     * Fetch sample data from table
     */
    private async fetchTableSamples(organizationId: string, tableName: string): Promise<any[]> {
        try {
            const query = `SELECT * FROM ${tableName} LIMIT 5`;
            return await this.executeOrganizationQuery(organizationId, query);
        } catch (error) {
            console.error(`❌ Error fetching sample data for ${tableName}:`, error);
            return [];
        }
    }

    /**
     * Detect column types from sample data
     */
    private detectColumnTypes(sampleData: any[]): { [column: string]: string } {
        const columnTypes: { [column: string]: string } = {};

        if (sampleData.length === 0) return columnTypes;

        const firstRow = sampleData[0];
        for (const [column, value] of Object.entries(firstRow)) {
            if (value === null || value === undefined) {
                columnTypes[column] = 'unknown';
            } else if (typeof value === 'number') {
                columnTypes[column] = Number.isInteger(value) ? 'integer' : 'decimal';
            } else if (typeof value === 'boolean') {
                columnTypes[column] = 'boolean';
            } else if (value instanceof Date) {
                columnTypes[column] = 'datetime';
            } else if (typeof value === 'string') {
                // Try to detect date strings
                if (value.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    columnTypes[column] = 'date';
                } else if (value.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
                    columnTypes[column] = 'datetime';
                } else {
                    columnTypes[column] = 'text';
                }
            } else {
                columnTypes[column] = 'unknown';
            }
        }

        return columnTypes;
    }

    /**
     * Create AI client (placeholder - implement based on your needs)
     */
    private async createAIClient(apiKey: string, endpoint: string): Promise<any> {
        // This would be your AI client creation logic
        // For now, returning a placeholder
        return { apiKey, endpoint, created: new Date() };
    }

    /**
     * Parse version information
     */
    private parseVersionInfo(versionString: string, dbType: string): any {
        const versionMatch = versionString.match(/(\d+)\.(\d+)\.(\d+)/);
        if (!versionMatch) {
            return { major: 0, minor: 0, patch: 0, full: versionString };
        }

        return {
            major: parseInt(versionMatch[1]),
            minor: parseInt(versionMatch[2]),
            patch: parseInt(versionMatch[3]),
            full: versionString
        };
    }

    /**
     * Get available JSON functions for database type/version
     */
    private getJSONFunctions(dbType: string, versionString: string): any {
        // Implementation would depend on your existing logic
        return {
            createObject: dbType === 'mysql' ? 'JSON_OBJECT' : 'json_build_object',
            createArray: dbType === 'mysql' ? 'JSON_ARRAY' : 'json_agg',
            supported: true
        };
    }

    /**
     * Get syntax rules for database type
     */
    private getSyntaxRules(dbType: string): any {
        return {
            quoteChar: dbType === 'mysql' ? '`' : '"',
            limitSyntax: dbType === 'mysql' ? 'LIMIT n' : 'LIMIT n',
            caseSensitive: dbType === 'postgresql'
        };
    }

    /**
     * Get database capabilities
     */
    private getCapabilities(dbType: string, versionString: string): string[] {
        const capabilities = ['SELECT', 'JOIN', 'AGGREGATE'];

        if (dbType === 'mysql' || dbType === 'postgresql') {
            capabilities.push('JSON_FUNCTIONS');
        }

        return capabilities;
    }

    /**
     * Hash string for cache keys
     */
    private hashString(str: string): string {
        return CryptoJS.MD5(str).toString();
    }

    // ========== CACHE INVALIDATION METHODS ==========

    /**
     * Invalidate schema cache for organization
     */
    invalidateSchemaCache(organizationId: string): void {
        this.schemaCache.delete(organizationId);
        console.log(`🗑️ Invalidated schema cache for organization ${organizationId}`);
    }

    /**
     * Invalidate version cache for organization
     */
    invalidateVersionCache(organizationId: string): void {
        this.versionCache.delete(organizationId);
        console.log(`🗑️ Invalidated version cache for organization ${organizationId}`);
    }

    /**
     * Invalidate table data cache for specific table
     */
    invalidateTableDataCache(organizationId: string, tableName?: string): void {
        if (tableName) {
            const cacheKey = `${organizationId}:${tableName}`;
            this.tableDataCache.delete(cacheKey);
            console.log(`🗑️ Invalidated table data cache for ${tableName}`);
        } else {
            // Invalidate all table data for organization
            const keysToDelete = Array.from(this.tableDataCache.keys())
                .filter(key => key.startsWith(`${organizationId}:`));
            keysToDelete.forEach(key => this.tableDataCache.delete(key));
            console.log(`🗑️ Invalidated all table data cache for organization ${organizationId}`);
        }
    }

    /**
     * Clear expired cache entries
     */
    cleanupExpiredCache(): void {
        const now = new Date();
        let cleanedCount = 0;

        // Clean schema cache
        for (const [key, entry] of this.schemaCache.entries()) {
            if (entry.expirationTime < now) {
                this.schemaCache.delete(key);
                cleanedCount++;
            }
        }

        // Clean version cache
        for (const [key, entry] of this.versionCache.entries()) {
            if (entry.expirationTime < now) {
                this.versionCache.delete(key);
                cleanedCount++;
            }
        }

        // Clean table data cache
        for (const [key, entry] of this.tableDataCache.entries()) {
            if (entry.expirationTime < now) {
                this.tableDataCache.delete(key);
                cleanedCount++;
            }
        }

        // Clean SQL pattern cache
        for (const [key, entry] of this.sqlPatternCache.entries()) {
            if (entry.expirationTime < now) {
                this.sqlPatternCache.delete(key);
                cleanedCount++;
            }
        }

        // Clean AI client cache
        for (const [key, entry] of this.aiClientCache.entries()) {
            if (entry.expirationTime < now) {
                this.aiClientCache.delete(key);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} expired cache entries`);
        }
    }

    /**
     * Start automatic cache cleanup interval
     */
    private startCacheCleanupInterval(): void {
        // Clean up expired cache entries every 15 minutes
        this.cacheCleanupInterval = setInterval(() => {
            this.cleanupExpiredCache();
        }, 15 * 60 * 1000);
        console.log('🔄 Started automatic cache cleanup (every 15 minutes)');
    }

    /**
     * Stop automatic cache cleanup interval
     */
    private stopCacheCleanupInterval(): void {
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
            this.cacheCleanupInterval = null;
            console.log('🛑 Stopped automatic cache cleanup');
        }
    }

    /**
     * Get comprehensive cache statistics
     */
    getCacheStatistics(): any {
        return {
            schema: {
                size: this.schemaCache.size,
                entries: Array.from(this.schemaCache.keys())
            },
            version: {
                size: this.versionCache.size,
                entries: Array.from(this.versionCache.keys())
            },
            tableData: {
                size: this.tableDataCache.size,
                entries: Array.from(this.tableDataCache.keys())
            },
            sqlPattern: {
                size: this.sqlPatternCache.size,
                totalHits: Array.from(this.sqlPatternCache.values())
                    .reduce((sum, entry) => sum + entry.hitCount, 0)
            },
            aiClient: {
                size: this.aiClientCache.size,
                entries: Array.from(this.aiClientCache.keys())
            },
            totalCacheSize: this.schemaCache.size + this.versionCache.size +
                this.tableDataCache.size + this.sqlPatternCache.size +
                this.aiClientCache.size
        };
    }

    // ========== DATABASE QUERY METHODS ==========

    /**
     * Get table schema for a specific organization table
     */
    async getOrganizationTableSchema(organizationId: string, tableName: string): Promise<any> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            if (dbConfig.type.toLocaleLowerCase() === 'mysql' || dbConfig.type.toLocaleLowerCase() === 'mariadb') {
                const connection = await this.createOrganizationMySQLConnection(organizationId);
                const [columns] = await connection.execute(
                    `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY
                     FROM INFORMATION_SCHEMA.COLUMNS 
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? 
                     ORDER BY ORDINAL_POSITION`,
                    [dbConfig.database, tableName]
                );
                await connection.end();

                return (columns as any[]).map((col: any) => ({
                    column_name: col.COLUMN_NAME,
                    data_type: col.DATA_TYPE,
                    is_nullable: col.IS_NULLABLE === 'YES',
                    column_default: col.COLUMN_DEFAULT,
                    extra: col.EXTRA,
                    column_key: col.COLUMN_KEY,
                    is_primary: col.COLUMN_KEY === 'PRI'
                }));
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                const client = await this.createOrganizationPostgreSQLConnection(organizationId);
                const result = await client.query(
                    `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                            CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END as is_primary
                     FROM information_schema.columns c
                     LEFT JOIN information_schema.key_column_usage kcu 
                       ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name
                     LEFT JOIN information_schema.table_constraints tc 
                       ON kcu.constraint_name = tc.constraint_name
                     WHERE c.table_schema = 'public' AND c.table_name = $1 
                     ORDER BY c.ordinal_position`,
                    [tableName]
                );
                await client.end();

                return (result as any).rows || [];
            } else {
                throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
            }
        } catch (error) {
            console.error(`❌ Failed to get schema for table ${tableName} in organization ${organizationId}:`, error);
            throw new Error(`Failed to get schema for table ${tableName}: ${(error as Error).message}`);
        }
    }

    /**
     * Execute a SQL query for an organization
     */
    async executeOrganizationQuery(organizationId: string, query: string, params: any[] = []): Promise<any> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            if (dbConfig.type.toLocaleLowerCase() === 'mysql' || dbConfig.type.toLocaleLowerCase() === 'mariadb') {
                const connection = await this.createOrganizationMySQLConnection(organizationId);
                const [rows] = await connection.execute(query, params);
                await connection.end();
                return rows;
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                const client = await this.createOrganizationPostgreSQLConnection(organizationId);
                const result = await client.query(query, params);
                await client.end();
                return (result as any).rows || [];
            } else {
                throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
            }
        } catch (error) {
            console.error(`❌ Failed to execute query for organization ${organizationId}:`, error);
            throw new Error(`Failed to execute query: ${(error as Error).message}`);
        }
    }

    /**
     * Get organization database connection details from PostgreSQL
     */
    async getOrganizationDatabaseConnection(organizationId: string): Promise<DecryptedDatabaseConnection> {
        try {
            if (!this.isMainDbConnected) {
                throw new Error('Main database not connected. Please ensure the server started properly.');
            }

            const query = `
  SELECT
    "id",
    "organizationId",
    "type",
    "host",
    "port",
    "database",
    "username",
    "password",
    "connectionString",
    "schema",
    "schemaUpdatedAt",
    "isConnected",
    "lastConnectedAt",
    "connectionError",
    "createdAt",
    "updatedAt"
  FROM database_connections
  WHERE "organizationId" = $1
  ORDER BY "createdAt" DESC
  LIMIT 1;
`;

            console.log(`🔍 Fetching database connection for organization: ${organizationId}`);
            const result = await this.pgPool.query(query, [organizationId]);

            if (result.rows.length === 0) {
                throw new Error(`No database connection found for organization: ${organizationId}`);
            }

            const dbConnection = result.rows[0] as DatabaseConnection;
            console.log(`📊 Found database connection: ${dbConnection.type}://${dbConnection.username}@${dbConnection.host}:${dbConnection.port}/${dbConnection.database}`);

            // Decrypt the password
            const decryptedPassword = this.decrypt(dbConnection.password);

            // Ensure password is a string (additional validation)
            if (typeof decryptedPassword !== 'string') {
                throw new Error('Decrypted password is not a string');
            }

            return {
                id: dbConnection.id,
                organization_id: dbConnection.organization_id,
                host: dbConnection.host,
                port: dbConnection.port,
                database: dbConnection.database,
                username: dbConnection.username,
                password: decryptedPassword,
                type: dbConnection.type,
            };
        } catch (error) {
            console.error('Error fetching organization database connection:', error);
            throw new Error(`Failed to fetch database connection for organization ${organizationId}: ${(error as Error).message}`);
        }
    }

    /**
     * Create MySQL connection for organization
     */
    async createOrganizationMySQLConnection(organizationId: string): Promise<mysql.Connection> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            console.log(`🔌 Creating MySQL connection for organization ${organizationId} to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

            const connection = await mysql.createConnection({
                host: dbConfig.host,
                port: dbConfig.port,
                user: dbConfig.username,
                password: dbConfig.password,
                database: dbConfig.database,
                connectTimeout: 10000,
                charset: 'utf8mb4'
            });

            // Track the connection for cleanup
            this.trackConnection(organizationId, connection);

            return connection;
        } catch (error) {
            console.error(`❌ Failed to create MySQL connection for organization ${organizationId}:`, error);
            throw new Error(`Failed to create database connection for organization ${organizationId}: ${(error as Error).message}`);
        }
    }

    /**
     * Create PostgreSQL connection for organization
     */
    async createOrganizationPostgreSQLConnection(organizationId: string): Promise<any> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            if (dbConfig.type.toLocaleLowerCase() !== 'postgresql') {
                throw new Error(`Database type mismatch: expected 'postgresql' but got '${dbConfig.type.toLocaleLowerCase()}'`);
            }

            console.log(`🔌 Creating PostgreSQL connection for organization ${organizationId} to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

            const { Client } = require('pg');
            const client = new Client({
                host: dbConfig.host,
                port: dbConfig.port,
                database: dbConfig.database,
                user: dbConfig.username,
                password: dbConfig.password,
                connectionTimeoutMillis: 60000,
                ssl: {
                    rejectUnauthorized: false,
                    sslmode: 'require'
                }
            });

            await client.connect();

            // Track the connection for cleanup
            this.trackConnection(organizationId, client);

            console.log(`✅ PostgreSQL connection established for organization ${organizationId}`);
            return client;
        } catch (error) {
            console.error(`❌ Failed to create PostgreSQL connection for organization ${organizationId}:`, error);
            throw new Error(`Failed to create PostgreSQL connection for organization ${organizationId}: ${(error as Error).message}`);
        }
    }

    /**
     * Test organization database connection
     */
    async testOrganizationConnection(organizationId: string): Promise<boolean> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);
            console.log('dbConfig', dbConfig);
            if (dbConfig.type.toLocaleLowerCase() === 'mysql' || dbConfig.type.toLocaleLowerCase() === 'mariadb') {
                console.log('HI');
                const connection = await this.createOrganizationMySQLConnection(organizationId);
                await connection.ping();
                await connection.end();
                console.log(`✅ MySQL connection test successful for organization ${organizationId}`);
                return true;
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                const client = await this.createOrganizationPostgreSQLConnection(organizationId);
                await client.query('SELECT 1');
                await client.end();
                console.log(`✅ PostgreSQL connection test successful for organization ${organizationId}`);
                return true;
            } else {
                throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
            }
        } catch (error) {
            console.error(`❌ Database connection test failed for organization ${organizationId}:`, error);
            return false;
        }
    }

    /**
     * Get organization tables based on database type
     */
    async getOrganizationTables(organizationId: string): Promise<string[]> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            if (dbConfig.type.toLocaleLowerCase() === 'mysql' || dbConfig.type.toLocaleLowerCase() === 'mariadb') {
                const connection = await this.createOrganizationMySQLConnection(organizationId);
                const [tables] = await connection.execute(
                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                    [dbConfig.database]
                );
                await connection.end();

                return (tables as any[]).map((table: any) => table.TABLE_NAME);
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                const client = await this.createOrganizationPostgreSQLConnection(organizationId);
                const result = await client.query(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                );
                await client.end();

                const rows = (result as any).rows || [];
                return rows.map((row: any) => row.tablename);
            } else {
                throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
            }
        } catch (error) {
            console.error(`❌ Failed to get tables for organization ${organizationId}:`, error);
            throw new Error(`Failed to get tables for organization ${organizationId}: ${(error as Error).message}`);
        }
    }

    /**
     * Get MySQL version for organization database
     */
    async getOrganizationMySQLVersion(organizationId: string): Promise<{
        full: string;
        major: number;
        minor: number;
        patch: number;
        supportsJSON: boolean;
        supportsWindowFunctions: boolean;
        supportsCTE: boolean;
        supportsRegex: boolean;
    } | null> {
        let connection: mysql.Connection | null = null;
        try {
            connection = await this.createOrganizationMySQLConnection(organizationId);

            const [rows] = await connection.execute('SELECT VERSION() as version');
            if (rows && Array.isArray(rows) && rows[0] && (rows[0] as any).version) {
                const versionString = (rows[0] as any).version;

                // Parse version string
                const versionMatch = versionString.match(/(\d+)\.(\d+)\.(\d+)/);
                if (versionMatch) {
                    const major = parseInt(versionMatch[1]);
                    const minor = parseInt(versionMatch[2]);
                    const patch = parseInt(versionMatch[3]);

                    return {
                        full: versionString,
                        major,
                        minor,
                        patch,
                        supportsJSON: major >= 5 && minor >= 7,
                        supportsWindowFunctions: major >= 8,
                        supportsCTE: major >= 8,
                        supportsRegex: true
                    };
                }
            }
            return null;
        } catch (error) {
            console.error(`❌ Failed to get MySQL version for organization ${organizationId}:`, error);
            return null;
        } finally {
            if (connection) {
                await connection.end();
            }
        }
    }

    /**
     * Get PostgreSQL version for organization database
     */
    async getOrganizationPostgreSQLVersion(organizationId: string): Promise<{
        full: string;
        major: number;
        minor: number;
        patch: number;
        supportsJSON: boolean;
        supportsWindowFunctions: boolean;
        supportsCTE: boolean;
        supportsRegex: boolean;
    } | null> {
        let client: any = null;
        try {
            client = await this.createOrganizationPostgreSQLConnection(organizationId);

            const result = await client.query('SELECT version() as version');
            if (result && result.rows && result.rows[0] && result.rows[0].version) {
                const versionString = result.rows[0].version;

                // Parse version string (PostgreSQL format: "PostgreSQL 15.4 on x86_64-pc-linux-gnu...")
                const versionMatch = versionString.match(/PostgreSQL (\d+)\.(\d+)(?:\.(\d+))?/);
                if (versionMatch) {
                    const major = parseInt(versionMatch[1]);
                    const minor = parseInt(versionMatch[2]);
                    const patch = parseInt(versionMatch[3] || '0');

                    return {
                        full: versionString,
                        major,
                        minor,
                        patch,
                        supportsJSON: major >= 9, // JSON support introduced in PostgreSQL 9.2
                        supportsWindowFunctions: major >= 8, // Window functions available since PostgreSQL 8.4
                        supportsCTE: major >= 8, // CTE support available since PostgreSQL 8.4
                        supportsRegex: true
                    };
                }
            }
            return null;
        } catch (error) {
            console.error(`❌ Failed to get PostgreSQL version for organization ${organizationId}:`, error);
            return null;
        } finally {
            if (client) {
                await client.end();
            }
        }
    }

    /**
     * Get database version for organization (supports both MySQL and PostgreSQL)
     */
    async getOrganizationDatabaseVersion(organizationId: string): Promise<{
        full: string;
        major: number;
        minor: number;
        patch: number;
        supportsJSON: boolean;
        supportsWindowFunctions: boolean;
        supportsCTE: boolean;
        supportsRegex: boolean;
        databaseType: string;
    } | null> {
        try {
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            if (dbConfig.type.toLocaleLowerCase() === 'mysql' || dbConfig.type.toLocaleLowerCase() === 'mariadb') {
                const mysqlVersion = await this.getOrganizationMySQLVersion(organizationId);
                return mysqlVersion ? { ...mysqlVersion, databaseType: 'mysql' } : null;
            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                const postgresVersion = await this.getOrganizationPostgreSQLVersion(organizationId);
                return postgresVersion ? { ...postgresVersion, databaseType: 'postgresql' } : null;
            } else {
                throw new Error(`Unsupported database type: ${dbConfig.type.toLocaleLowerCase()}`);
            }
        } catch (error) {
            console.error(`❌ Failed to get database version for organization ${organizationId}:`, error);
            return null;
        }
    }

    /**
     * Close PostgreSQL pool and cleanup resources
     */
    async close(): Promise<void> {
        // Stop cache cleanup interval
        this.stopCacheCleanupInterval();
        
        // Close database pool
        await this.pgPool.end();
        
        console.log('🔌 Database service closed successfully');
    }

    /**
     * Track a connection for an organization
     */
    private trackConnection(organizationId: string, connection: any): void {
        if (!this.organizationConnections.has(organizationId)) {
            this.organizationConnections.set(organizationId, []);
        }
        this.organizationConnections.get(organizationId)!.push(connection);
    }

    /**
     * Close all connections for an organization
     */
    async closeOrganizationConnections(organizationId: string): Promise<void> {
        const connections = this.organizationConnections.get(organizationId);
        if (connections && connections.length > 0) {
            console.log(`🔌 Closing ${connections.length} connections for organization: ${organizationId}`);
            for (const connection of connections) {
                try {
                    await connection.end();
                } catch (error) {
                    console.error(`❌ Error closing connection for organization ${organizationId}:`, error);
                }
            }
            this.organizationConnections.delete(organizationId);
        }
    }

    /**
     * Get connection count for an organization
     */
    getOrganizationConnectionCount(organizationId: string): number {
        const connections = this.organizationConnections.get(organizationId);
        return connections ? connections.length : 0;
    }
}

export default new DatabaseService();
export { DatabaseService, DecryptedDatabaseConnection };

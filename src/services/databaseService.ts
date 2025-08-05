import * as dotenv from 'dotenv';
import { Pool, QueryResult } from 'pg';
import mysql from 'mysql2/promise';
import CryptoJS from 'crypto-js';

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

class DatabaseService {
    private pgPool: Pool;
    private encryptionKey: string;
    private isMainDbConnected: boolean = false;
    private organizationConnections: Map<string, any[]> = new Map(); // Track active connections per organization

    constructor() {
        // Initialize PostgreSQL connection pool for main database
        console.log('🔌 Initializing PostgreSQL connection pool...', process.env.DATABASE_URL);
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is not set');
        }

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
     * Close PostgreSQL pool
     */
    async close(): Promise<void> {
        await this.pgPool.end();
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

import * as dotenv from 'dotenv';
import { Pool } from 'pg';
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
                database: dbConfig.database,
                user: dbConfig.username,
                password: dbConfig.password,
                charset: 'utf8mb4',
                connectTimeout: 60000,
            });

            console.log(`✅ MySQL connection established for organization ${organizationId}`);
            return connection;
        } catch (error) {
            console.error(`❌ Failed to create MySQL connection for organization ${organizationId}:`, error);
            throw new Error(`Failed to create database connection for organization ${organizationId}: ${(error as Error).message}`);
        }
    }

    /**
     * Test organization database connection
     */
    async testOrganizationConnection(organizationId: string): Promise<boolean> {
        let connection: mysql.Connection | null = null;
        try {
            connection = await this.createOrganizationMySQLConnection(organizationId);

            // Test the connection with a simple query
            await connection.execute('SELECT 1 as test');

            console.log(`✅ Database connection test successful for organization ${organizationId}`);
            return true;
        } catch (error) {
            console.error(`❌ Database connection test failed for organization ${organizationId}:`, error);
            return false;
        } finally {
            if (connection) {
                await connection.end();
            }
        }
    }

    /**
     * Get all tables from organization database
     */
    async getOrganizationTables(organizationId: string): Promise<string[]> {
        let connection: mysql.Connection | null = null;
        try {
            connection = await this.createOrganizationMySQLConnection(organizationId);
            const dbConfig = await this.getOrganizationDatabaseConnection(organizationId);

            const [rows] = await connection.execute(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                [dbConfig.database]
            );

            if (Array.isArray(rows)) {
                return rows.map((row: any) => row.TABLE_NAME);
            }
            return [];
        } catch (error) {
            console.error(`❌ Failed to get tables for organization ${organizationId}:`, error);
            throw error;
        } finally {
            if (connection) {
                await connection.end();
            }
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
     * Close PostgreSQL pool
     */
    async close(): Promise<void> {
        await this.pgPool.end();
    }
}

export default new DatabaseService();
export { DatabaseService, DecryptedDatabaseConnection };

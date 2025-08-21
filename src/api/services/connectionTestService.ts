import { Response } from 'express';
import databaseService from '../../services/databaseService';

/**
 * Tests the database connection for a specific organization
 * @param organizationId - The organization ID to test connection for
 * @param res - Express response object
 * @returns boolean indicating if connection test passed, or sends error response and returns false
 */
export async function testOrganizationDatabaseConnection(
    organizationId: string, 
    res: Response
): Promise<boolean> {
    try {
        const connectionTest = await databaseService.testOrganizationConnection(organizationId);
        if (!connectionTest) {
            res.status(400).json({
                error: 'Database connection failed',
                message: `Unable to connect to database for organization: ${organizationId}`,
                timestamp: new Date().toISOString()
            });
            return false;
        }
        console.log(`✅ Database connection verified for organization: ${organizationId}`);
        return true;
    } catch (connectionError: any) {
        console.error(`❌ Database connection error for organization ${organizationId}:`, connectionError.message);
        res.status(500).json({
            error: 'Database connection error',
            message: connectionError.message,
            timestamp: new Date().toISOString()
        });
        return false;
    }
}

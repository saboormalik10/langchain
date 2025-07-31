import { MedicalDatabaseLangChainApp } from '../index';
import databaseService, { DecryptedDatabaseConnection } from './databaseService';

interface OrganizationLangChainApp {
  app: MedicalDatabaseLangChainApp;
  organizationId: string;
  lastAccessed: Date;
  dbConfig: DecryptedDatabaseConnection;
}

class MultiTenantLangChainService {
  private langchainApps: Map<string, OrganizationLangChainApp> = new Map();
  private readonly CACHE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  constructor() {
    // Clean up expired LangChain apps every 10 minutes
    setInterval(() => {
      this.cleanupExpiredApps();
    }, 10 * 60 * 1000);
  }

  /**
   * Get or create LangChain app for organization
   */
  async getOrganizationLangChainApp(organizationId: string): Promise<MedicalDatabaseLangChainApp> {
    try {
      // Check if we have a cached app for this organization
      const cachedApp = this.langchainApps.get(organizationId);
      
      if (cachedApp) {
        // Check if cache is still valid
        const now = new Date();
        const timeDiff = now.getTime() - cachedApp.lastAccessed.getTime();
        
        if (timeDiff < this.CACHE_TIMEOUT_MS) {
          // Update last accessed time
          cachedApp.lastAccessed = now;
          console.log(`✅ Using cached LangChain app for organization ${organizationId}`);
          return cachedApp.app;
        } else {
          // Cache expired, remove it
          console.log(`⏰ Cache expired for organization ${organizationId}, creating new instance`);
          this.langchainApps.delete(organizationId);
        }
      }

      console.log(`🔧 Creating new LangChain app for organization ${organizationId}`);

      // Get database configuration for this organization
      const dbConfig = await databaseService.getOrganizationDatabaseConnection(organizationId);

      // Create new LangChain app instance with organization-specific database config
      const app = new MedicalDatabaseLangChainApp(dbConfig);
      
      // Initialize the app with proper sequence
      console.log(`🔗 Initializing LangChain components for organization ${organizationId}...`);
      await app.connectToDatabase();
      await app.initializeChains();
      await app.initializeTools();
      await app.initializeAgents();

      // Cache the app
      const organizationApp: OrganizationLangChainApp = {
        app,
        organizationId,
        lastAccessed: new Date(),
        dbConfig
      };

      this.langchainApps.set(organizationId, organizationApp);

      console.log(`✅ Created and cached LangChain app for organization ${organizationId}`);
      return app;
    } catch (error) {
      console.error(`❌ Failed to create LangChain app for organization ${organizationId}:`, error);
      throw new Error(`Failed to initialize LangChain for organization ${organizationId}: ${(error as Error).message}`);
    }
  }

  /**
   * Test organization LangChain app
   */
  async testOrganizationLangChainApp(organizationId: string): Promise<boolean> {
    try {
      const app = await this.getOrganizationLangChainApp(organizationId);
      
      // Test basic functionality
      const sqlAgent = app.getSqlAgent();
      const sqlDatabase = app.getSqlDatabase();
      
      if (!sqlAgent || !sqlDatabase) {
        console.error(`❌ LangChain app missing components for organization ${organizationId}`);
        return false;
      }

      console.log(`✅ LangChain app test successful for organization ${organizationId}`);
      return true;
    } catch (error) {
      console.error(`❌ LangChain app test failed for organization ${organizationId}:`, error);
      return false;
    }
  }

  /**
   * Remove LangChain app from cache
   */
  removeLangChainApp(organizationId: string): void {
    const removed = this.langchainApps.delete(organizationId);
    if (removed) {
      console.log(`🗑️ Removed LangChain app cache for organization ${organizationId}`);
    }
  }

  /**
   * Clean up expired LangChain apps
   */
  private cleanupExpiredApps(): void {
    const now = new Date();
    let cleanedCount = 0;

    this.langchainApps.forEach((orgApp, organizationId) => {
      const timeDiff = now.getTime() - orgApp.lastAccessed.getTime();
      if (timeDiff > this.CACHE_TIMEOUT_MS) {
        this.langchainApps.delete(organizationId);
        cleanedCount++;
      }
    });

    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} expired LangChain app caches`);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalCachedApps: number;
    organizationIds: string[];
    oldestCache: Date | null;
    newestCache: Date | null;
  } {
    const organizationIds = Array.from(this.langchainApps.keys());
    const timestamps = Array.from(this.langchainApps.values()).map(app => app.lastAccessed);
    
    return {
      totalCachedApps: this.langchainApps.size,
      organizationIds,
      oldestCache: timestamps.length > 0 ? new Date(Math.min(...timestamps.map(t => t.getTime()))) : null,
      newestCache: timestamps.length > 0 ? new Date(Math.max(...timestamps.map(t => t.getTime()))) : null
    };
  }
}

export default new MultiTenantLangChainService();
export { MultiTenantLangChainService };

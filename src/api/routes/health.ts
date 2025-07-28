import { Router, Request, Response } from 'express';
import { MedicalDatabaseLangChainApp } from '../../index';

export function healthRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
  const router = Router();

  // General health check
  router.get('/', async (req: Request, res: Response) => {
    try {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0',
        services: {
          api: 'healthy',
          database: 'unknown',
          llm: 'unknown'
        }
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Database health check
  router.get('/database', async (req: Request, res: Response) => {
    try {
      await langchainApp.connectToDatabase();
      
      res.json({
        status: 'healthy',
        service: 'database',
        timestamp: new Date().toISOString(),
        connection: {
          host: process.env.DB_HOST,
          database: process.env.DB_NAME,
          port: process.env.DB_PORT,
          status: 'connected'
        }
      });
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        service: 'database',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // LLM health check
  router.get('/llm', async (req: Request, res: Response) => {
    try {
      // Test LLM with a simple query
      const testResponse = await langchainApp.demonstrateMemoryTypes();
      
      res.json({
        status: 'healthy',
        service: 'llm',
        timestamp: new Date().toISOString(),
        llm: {
          model: process.env.OPENAI_MODEL,
          endpoint: process.env.AZURE_OPENAI_ENDPOINT,
          deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
          status: 'connected'
        }
      });
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        service: 'llm',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

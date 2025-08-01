import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { json, urlencoded } from 'express';
import { medicalRoutes } from './routes/medical';
import databaseService from '../services/databaseService';

class MedicalLangChainAPI {
  private app: express.Application;
  private port: number;

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.PORT || '3001');

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private setupMiddleware(): void {
    // Security middleware
    this.app.use(helmet());
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: {
        error: 'Too many requests from this IP, please try again later.'
      }
    });
    this.app.use(limiter);

    // Body parsing
    this.app.use(json({ limit: '10mb' }));
    this.app.use(urlencoded({ extended: true, limit: '10mb' }));

    // Logging
    this.app.use(morgan('combined'));
  }

  private setupRoutes(): void {
    // Medical routes now use multi-tenant approach
    this.app.use('/api/medical', medicalRoutes());

    // Health check endpoint
    this.app.get('/api/health', (req, res) => {
      const dbStatus = databaseService.isMainDatabaseConnected();
      res.json({
        status: dbStatus ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        mode: 'multi-tenant',
        database: {
          main: dbStatus ? 'connected' : 'disconnected'
        },
        message: 'API server is running. LangChain instances are created per organization on-demand.'
      });
    });

    // API documentation endpoint
    this.app.get('/api/docs', (req, res) => {
      res.json({
        title: 'Medical LangChain API',
        version: '1.0.0',
        description: 'REST API for medical database operations using LangChain with multi-tenant support',
        mode: 'Multi-tenant',
        endpoints: {
          medical: {
            'POST /api/medical/query-sql-manual': 'Manual SQL query with organizationId parameter - creates LangChain instance on-demand'
          },
          system: {
            'GET /api/health': 'API health status',
            'GET /api/docs': 'API documentation'
          }
        },
        requirements: {
          organizationId: 'Required parameter for all medical endpoints to determine database connection'
        }
      });
    });

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        message: 'Medical LangChain API is running',
        version: '1.0.0',
        mode: 'Multi-tenant',
        documentation: '/api/docs',
        health: '/api/health'
      });
    });
  }

  private setupErrorHandling(): void {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Endpoint not found',
        message: `The endpoint ${req.method} ${req.originalUrl} does not exist`,
        documentation: '/api/docs'
      });
    });

    // Global error handler
    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('API Error:', error);

      res.status(error.status || 500).json({
        error: error.message || 'Internal server error',
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      });
    });
  }

  public async start(): Promise<void> {
    try {
      console.log('🚀 Starting Medical LangChain API server...');

      // Initialize main database connection first
      console.log('📊 Initializing main PostgreSQL database connection...');
      await databaseService.initializeMainDatabase();

      console.log('📋 Multi-tenant mode: LangChain instances will be initialized on-demand per organization');

      // Start server after database initialization
      this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`Server running on port ${this.port}`);
        console.log(`🚀 Medical LangChain API is running on port ${this.port}`);
        console.log(`📚 API Documentation: http://localhost:${this.port}/api/docs`);
        console.log(`❤️  Health Check: http://localhost:${this.port}/api/health`);
        console.log(`🏢 Multi-tenant: Each organization gets its own LangChain instance on first API call`);

      });

    } catch (error) {
      console.error('❌ Failed to start API server:', error);
      process.exit(1);
    }
  }
}

export { MedicalLangChainAPI };

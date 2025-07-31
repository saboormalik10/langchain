import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { json, urlencoded } from 'express';
import { MedicalDatabaseLangChainApp } from '../index';
import { medicalRoutes } from './routes/medical';

class MedicalLangChainAPI {
  private app: express.Application;
  private langchainApp: MedicalDatabaseLangChainApp;
  private port: number;

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.PORT || '3000');
    this.langchainApp = new MedicalDatabaseLangChainApp();

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
    // Pass langchainApp instance to routes
    this.app.use('/api/medical', medicalRoutes(this.langchainApp));

    // API documentation endpoint
    this.app.get('/api/docs', (req, res) => {
      res.json({
        title: 'Medical LangChain API',
        version: '1.0.0',
        description: 'REST API for medical database operations using LangChain',
        endpoints: {
          medical: {
            'POST /api/medical/query-sql-manual': 'Manual SQL query with optional conversational capabilities'
          }
        }
      });
    });

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        message: 'Medical LangChain API is running',
        version: '1.0.0',
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
      // Initialize LangChain application (continue even if database fails)
      console.log('🔧 Initializing LangChain application...');

      try {
        await this.langchainApp.connectToDatabase();
        console.log('✅ Database connected successfully');
      } catch (dbError) {
        console.warn('⚠️  Database connection failed, but API will still start:', (dbError as Error).message);
      }

      try {
        await this.langchainApp.initializeChains();
        await this.langchainApp.initializeTools();
        await this.langchainApp.initializeAgents();
        console.log('✅ LangChain components initialized');
      } catch (initError) {
        console.warn('⚠️  Some LangChain components failed to initialize:', (initError as Error).message);
      }

      // Start server regardless of database/LangChain initialization status
      this.app.listen(this.port, () => {
        console.log(`🚀 Medical LangChain API is running on port ${this.port}`);
        console.log(`📚 API Documentation: http://localhost:${this.port}/api/docs`);
        console.log(`❤️  Health Check: http://localhost:${this.port}/api/health`);
        console.log(`🔍 Database Status: ${process.env.DB_HOST} - Check /api/health/database for details`);
      });
    } catch (error) {
      console.error('❌ Failed to start API server:', error);
      process.exit(1);
    }
  }
}

export { MedicalLangChainAPI };

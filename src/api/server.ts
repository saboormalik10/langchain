import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { json, urlencoded } from 'express';
import { MedicalDatabaseLangChainApp } from '../index';
import { medicalRoutes } from './routes/medical';
import { memoryRoutes } from './routes/memory';
import { promptRoutes } from './routes/prompts';
import { parserRoutes } from './routes/parsers';
import { healthRoutes } from './routes/health';
import { jsonRoutes } from './routes/json';

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
    this.app.use('/api/health', healthRoutes(this.langchainApp));
    this.app.use('/api/medical', medicalRoutes(this.langchainApp));
    this.app.use('/api/json', jsonRoutes(this.langchainApp));
    this.app.use('/api/memory', memoryRoutes(this.langchainApp));
    this.app.use('/api/prompts', promptRoutes(this.langchainApp));
    this.app.use('/api/parsers', parserRoutes(this.langchainApp));

    // API documentation endpoint
    this.app.get('/api/docs', (req, res) => {
      res.json({
        title: 'Medical LangChain API',
        version: '1.0.0',
        description: 'REST API for medical database operations using LangChain',
        endpoints: {
          health: {
            'GET /api/health': 'Check API health status',
            'GET /api/health/database': 'Check database connectivity',
            'GET /api/health/llm': 'Check LLM connectivity'
          },
          medical: {
            'POST /api/medical/query': 'Query medical database with natural language',
            'POST /api/medical/diagnosis': 'Get AI-powered diagnosis suggestions',
            'POST /api/medical/treatment': 'Get treatment recommendations',
            'GET /api/medical/patients': 'List patients (demo data)',
            'GET /api/medical/tables': 'List available database tables'
          },
          json: {
            'POST /api/json/blood-tests': 'Get blood test records as JSON array',
            'POST /api/json/patients': 'Get patient records as JSON array'
          },
          memory: {
            'POST /api/memory/conversation': 'Save conversation to memory',
            'GET /api/memory/conversation': 'Retrieve conversation history',
            'DELETE /api/memory/conversation': 'Clear conversation memory',
            'GET /api/memory/summary': 'Get conversation summary'
          },
          prompts: {
            'POST /api/prompts/medical': 'Generate medical prompts',
            'POST /api/prompts/fewshot': 'Create few-shot prompts',
            'POST /api/prompts/chat': 'Format chat prompts',
            'POST /api/prompts/system': 'Create system prompts'
          },
          parsers: {
            'POST /api/parsers/structured': 'Parse structured medical data',
            'POST /api/parsers/list': 'Parse comma-separated lists',
            'POST /api/parsers/validate': 'Validate and sanitize output'
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

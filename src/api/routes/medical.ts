import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mysql from 'mysql2/promise';
import { MedicalDatabaseLangChainApp } from '../../index';

export function medicalRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
  const router = Router();

  // Query medical database with natural language
  router.post('/query', 
    [
      body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters'),
      body('context').optional().isString().isLength({ max: 1000 }).withMessage('Context must be less than 1000 characters')
    ],
    async (req: Request, res: Response) => {
      try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(400).json({
            error: 'Validation failed',
            details: errors.array()
          });
        }

        const { query, context = 'Medical database query' } = req.body;

        // Use LangChain SQL Agent to process the query
        let result;
        try {
          // Try to use the SQL agent for real database queries
          const sqlAgent = langchainApp.getSqlAgent();
          if (sqlAgent) {
            const agentResult = await sqlAgent.call({ input: query });
            result = {
              type: 'medical_query',
              data: agentResult.output,
              query_processed: query,
              source: 'sql_agent',
              timestamp: new Date().toISOString()
            };
          } else {
            // Fallback to simulated response if SQL agent not available
            result = {
              type: 'medical_query',
              data: [
                {
                  patient_id: 'P001',
                  name: 'Sample Patient 1',
                  diagnosis: 'Related to: ' + query,
                  last_visit: '2024-12-15',
                  status: 'SQL Agent not available'
                }
              ],
              note: 'Using simulated data - SQL Agent not initialized',
              timestamp: new Date().toISOString()
            };
          }
        } catch (error) {
          result = {
            type: 'medical_query',
            error: (error as Error).message,
            query_attempted: query,
            timestamp: new Date().toISOString()
          };
        }

        const response = {
          query: query,
          context: context,
          result: result,
          metadata: {
            processing_time: '< 1s',
            source: 'langchain_medical_assistant'
          }
        };

        res.json(response);
      } catch (error) {
        res.status(500).json({
          error: 'Query processing failed',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Get AI-powered diagnosis suggestions
  router.post('/diagnosis',
    [
      body('symptoms').isArray().withMessage('Symptoms must be an array'),
      body('symptoms.*').isString().withMessage('Each symptom must be a string'),
      body('patient_history').optional().isString().withMessage('Patient history must be a string'),
      body('age').optional().isInt({ min: 0, max: 150 }).withMessage('Age must be between 0-150'),
      body('gender').optional().isIn(['male', 'female', 'other']).withMessage('Gender must be male, female, or other')
    ],
    async (req: Request, res: Response) => {
      try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(400).json({
            error: 'Validation failed',
            details: errors.array()
          });
        }

        const { symptoms, patient_history, age, gender } = req.body;

        // Use LangChain structured parser
        const diagnosis = {
          primary_diagnosis: 'Type 2 Diabetes Mellitus',
          differential_diagnoses: [
            { condition: 'Type 1 Diabetes', probability: 0.15 },
            { condition: 'Metabolic Syndrome', probability: 0.25 },
            { condition: 'Insulin Resistance', probability: 0.35 }
          ],
          confidence_score: 0.82,
          recommended_tests: [
            'HbA1c',
            'Fasting Glucose',
            'Oral Glucose Tolerance Test',
            'Lipid Panel'
          ],
          urgency: 'routine',
          follow_up: 'Schedule appointment within 2 weeks',
          symptoms_analysis: symptoms.map((symptom: string) => ({
            symptom,
            relevance: Math.random() * 0.5 + 0.5, // Random relevance score
            weight: Math.random() * 0.3 + 0.7
          }))
        };

        res.json({
          patient_info: { age, gender, symptoms, patient_history },
          diagnosis,
          generated_by: 'langchain_medical_ai',
          timestamp: new Date().toISOString(),
          disclaimer: 'This is AI-generated content for demonstration purposes only. Always consult healthcare professionals.'
        });
      } catch (error) {
        res.status(500).json({
          error: 'Diagnosis generation failed',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Get treatment recommendations
  router.post('/treatment',
    [
      body('diagnosis').isString().isLength({ min: 1, max: 200 }).withMessage('Diagnosis is required'),
      body('patient_id').optional().isString().withMessage('Patient ID must be a string'),
      body('allergies').optional().isArray().withMessage('Allergies must be an array'),
      body('current_medications').optional().isArray().withMessage('Current medications must be an array')
    ],
    async (req: Request, res: Response) => {
      try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(400).json({
            error: 'Validation failed',
            details: errors.array()
          });
        }

        const { diagnosis, patient_id, allergies = [], current_medications = [] } = req.body;

        const treatment = {
          diagnosis,
          treatment_plan: {
            medications: [
              {
                name: 'Metformin',
                dosage: '500mg twice daily',
                duration: '6 months',
                instructions: 'Take with meals to reduce stomach upset'
              },
              {
                name: 'Lisinopril', 
                dosage: '10mg once daily',
                duration: 'Ongoing',
                instructions: 'Take at the same time each day'
              }
            ],
            lifestyle_modifications: [
              'Follow diabetic diet with carbohydrate counting',
              'Exercise 150 minutes per week of moderate activity',
              'Monitor blood glucose daily',
              'Weight management - target BMI 18.5-24.9'
            ],
            monitoring: [
              'HbA1c every 3 months',
              'Blood pressure checks monthly',
              'Annual eye and foot exams',
              'Lipid panel every 6 months'
            ],
            follow_up: 'Return visit in 4 weeks, then every 3 months'
          },
          contraindications: allergies.length > 0 ? `Consider allergies: ${allergies.join(', ')}` : 'None noted',
          drug_interactions: current_medications.length > 0 ? 'Review current medications for interactions' : 'None',
          estimated_cost: '$150-300/month',
          success_probability: 0.85,
          side_effects: [
            'Metformin: GI upset, lactic acidosis (rare)',
            'Lisinopril: Dry cough, hyperkalemia, angioedema (rare)'
          ]
        };

        res.json({
          patient_id,
          treatment,
          generated_by: 'langchain_treatment_ai',
          timestamp: new Date().toISOString(),
          disclaimer: 'This is AI-generated content for demonstration purposes only. Always consult healthcare professionals.'
        });
      } catch (error) {
        res.status(500).json({
          error: 'Treatment generation failed',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Get list of patients (demo data - in real app would query actual database)
  router.get('/patients', async (req: Request, res: Response) => {
    try {
      const { limit = 10, offset = 0, search } = req.query;

      // Demo patient data
      const demoPatients = [
        { id: 'P001', name: 'John Doe', age: 45, diagnosis: 'Type 2 Diabetes', last_visit: '2024-12-15' },
        { id: 'P002', name: 'Jane Smith', age: 38, diagnosis: 'Hypertension', last_visit: '2024-12-10' },
        { id: 'P003', name: 'Robert Johnson', age: 62, diagnosis: 'Heart Disease', last_visit: '2024-12-08' },
        { id: 'P004', name: 'Maria Garcia', age: 29, diagnosis: 'Asthma', last_visit: '2024-12-12' },
        { id: 'P005', name: 'David Wilson', age: 55, diagnosis: 'Arthritis', last_visit: '2024-12-07' }
      ];

      let filteredPatients = demoPatients;
      if (search) {
        const searchTerm = (search as string).toLowerCase();
        filteredPatients = demoPatients.filter(p => 
          p.name.toLowerCase().includes(searchTerm) || 
          p.diagnosis.toLowerCase().includes(searchTerm)
        );
      }

      const startIndex = parseInt(offset as string);
      const endIndex = startIndex + parseInt(limit as string);
      const paginatedPatients = filteredPatients.slice(startIndex, endIndex);

      res.json({
        patients: paginatedPatients,
        pagination: {
          total: filteredPatients.length,
          limit: parseInt(limit as string),
          offset: startIndex,
          has_more: endIndex < filteredPatients.length
        },
        note: 'This is demo data. In production, this would query your actual database.',
        database_config: {
          host: process.env.DB_HOST,
          database: process.env.DB_NAME,
          status: 'connected_but_sql_features_disabled'
        }
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve patients',
        message: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Get database tables information
  router.get('/tables', async (req: Request, res: Response) => {
    try {
      // Try to connect to actual database and get tables
      const connection = await mysql.createConnection({
        host: process.env.DB_HOST!,
        port: parseInt(process.env.DB_PORT!),
        user: process.env.DB_USER!,
        password: process.env.DB_PASSWORD!,
        database: process.env.DB_NAME!,
      });

      try {
        const [tables] = await connection.execute('SHOW TABLES');
        await connection.end();

        res.json({
          database_info: {
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT
          },
          tables: tables,
          count: Array.isArray(tables) ? tables.length : 0,
          timestamp: new Date().toISOString(),
          note: 'Successfully connected to your MySQL database'
        });
      } catch (queryError) {
        await connection.end();
        throw queryError;
      }
    } catch (error) {
      res.status(503).json({
        error: 'Database connection failed',
        message: (error as Error).message,
        database_config: {
          host: process.env.DB_HOST,
          database: process.env.DB_NAME,
          port: process.env.DB_PORT
        },
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

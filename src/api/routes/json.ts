import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { MedicalDatabaseLangChainApp } from '../../index';

export function jsonRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
  const router = Router();

  // Get blood test data in JSON array format
  router.post('/blood-tests', 
    [
      body('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1-50')
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

        const { limit = 15 } = req.body;
        console.log(`Getting blood test data in JSON format, limit: ${limit}`);

        try {
          const sqlDatabase = langchainApp.getSqlDatabase();
          if (!sqlDatabase) {
            return res.status(503).json({
              error: 'Database not available',
              message: 'SQL database connection not initialized'
            });
          }

          const sqlQuery = `
            SELECT 
              p.id,
              p.full_name as name,
              p.age,
              p.gender,
              p.email,
              bt.hemoglobin,
              bt.wbc_count,
              bt.platelet_count
            FROM patients p 
            INNER JOIN blood_tests bt ON p.id = bt.patient_id 
            WHERE bt.hemoglobin IS NOT NULL
            ORDER BY p.id
            LIMIT ${limit}
          `;

          console.log('Executing direct SQL query for blood test JSON data');
          const rawResults = await sqlDatabase.run(sqlQuery);
          console.log('Raw SQL results:', rawResults);
          
          // Parse results into JSON array
          const records = [];
          if (typeof rawResults === 'string' && rawResults.trim()) {
            try {
              // Try to parse as JSON first
              const jsonResults = JSON.parse(rawResults);
              if (Array.isArray(jsonResults)) {
                jsonResults.forEach((row: any) => {
                  records.push({
                    id: row.id || null,
                    name: row.name || '',
                    age: row.age || null,
                    gender: row.gender || '',
                    email: row.email || '',
                    blood_tests: {
                      hemoglobin: row.hemoglobin || null,
                      wbc_count: row.wbc_count || null,
                      platelet_count: row.platelet_count || null
                    }
                  });
                });
              }
            } catch (jsonError) {
              // If JSON parsing fails, try tab-separated parsing
              const lines = rawResults.trim().split('\n');
              
              // Skip header row and parse data
              for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split('\t');
                if (values.length >= 8) {
                  records.push({
                    id: parseInt(values[0]) || values[0],
                    name: values[1] || '',
                    age: parseInt(values[2]) || null,
                    gender: values[3] || '',
                    email: values[4] || '',
                    blood_tests: {
                      hemoglobin: parseFloat(values[5]) || null,
                      wbc_count: parseInt(values[6]) || null,
                      platelet_count: parseInt(values[7]) || null
                    }
                  });
                }
              }
            }
          }

          res.json({
            data: records,
            record_count: records.length,
            limit: limit,
            source: 'direct_sql_query',
            query_type: 'blood_tests',
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          console.error(`Blood test query error:`, error);
          res.status(500).json({
            error: 'Query execution failed',
            message: (error as Error).message,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        res.status(500).json({
          error: 'Request processing failed',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Get patients data in JSON array format
  router.post('/patients', 
    [
      body('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1-50')
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

        const { limit = 20 } = req.body;
        console.log(`Getting patients data in JSON format, limit: ${limit}`);

        try {
          const sqlDatabase = langchainApp.getSqlDatabase();
          if (!sqlDatabase) {
            return res.status(503).json({
              error: 'Database not available',
              message: 'SQL database connection not initialized'
            });
          }

          const sqlQuery = `
            SELECT 
              id,
              full_name as name,
              age,
              gender,
              email
            FROM patients 
            ORDER BY id
            LIMIT ${limit}
          `;

          console.log('Executing direct SQL query for patients JSON data');
          const rawResults = await sqlDatabase.run(sqlQuery);
          console.log('Raw SQL results:', rawResults);
          
          // Parse results into JSON array
          const records = [];
          if (typeof rawResults === 'string' && rawResults.trim()) {
            try {
              // Try to parse as JSON first
              const jsonResults = JSON.parse(rawResults);
              if (Array.isArray(jsonResults)) {
                jsonResults.forEach((row: any) => {
                  records.push({
                    id: row.id || null,
                    name: row.name || '',
                    age: row.age || null,
                    gender: row.gender || '',
                    email: row.email || ''
                  });
                });
              }
            } catch (jsonError) {
              // If JSON parsing fails, try tab-separated parsing
              const lines = rawResults.trim().split('\n');
              
              // Skip header row and parse data
              for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split('\t');
                if (values.length >= 5) {
                  records.push({
                    id: parseInt(values[0]) || values[0],
                    name: values[1] || '',
                    age: parseInt(values[2]) || null,
                    gender: values[3] || '',
                    email: values[4] || ''
                  });
                }
              }
            }
          }

          res.json({
            data: records,
            record_count: records.length,
            limit: limit,
            source: 'direct_sql_query',
            query_type: 'patients',
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          console.error(`Patients query error:`, error);
          res.status(500).json({
            error: 'Query execution failed',
            message: (error as Error).message,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        res.status(500).json({
          error: 'Request processing failed',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  return router;
}

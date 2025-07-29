import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mysql from 'mysql2/promise';
import { MedicalDatabaseLangChainApp } from '../../index';

import Papa from 'papaparse';
// @ts-ignore
import jsonic from 'jsonic';

type Step = { observation?: unknown };
type AgentResult = {
    output?: unknown;
    text?: unknown;
    result?: unknown;
    intermediateSteps?: Step[];
    [key: string]: unknown;
};

/**
 * Parse patient data from numbered list format
 */
function parsePatientData(str: string): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];

    // Pattern: "1. John Doe - Paracetamol, 500mg"
    const lines = str.split('\n').filter(line => line.trim());

    for (const line of lines) {
        const match = line.match(/^(\d+)\.\s*(.+?)\s*-\s*(.+?),\s*(\d+mg)$/);
        if (match) {
            results.push({
                index: parseInt(match[1]),
                patient: match[2].trim(),
                medication: match[3].trim(),
                dosage: match[4].trim()
            });
        }
    }

    return results;
}

/**
 * Try to parse any string as structured data
 */
function tryParseStructured(str: string): Array<Record<string, unknown>> | null {
    if (!str || typeof str !== 'string') return null;

    // Try patient data first
    const patientData = parsePatientData(str);
    if (patientData.length > 0) return patientData;

    // Try JSON
    try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed != null) return [parsed];
    } catch { }

    return null;
}

/**
 * Recursively search for and parse data fields
 */
function findAndParseDataFields(obj: any): Array<Record<string, unknown>> {
    let results: Array<Record<string, unknown>> = [];

    if (Array.isArray(obj)) {
        // Process each item in array
        for (const item of obj) {
            results = results.concat(findAndParseDataFields(item));
        }
    } else if (obj && typeof obj === 'object') {
        // Check if this object has a 'data' field that's a string
        if (typeof obj.data === 'string') {
            console.log('🔍 Found data field:', obj.data.substring(0, 100) + '...');
            const parsed = tryParseStructured(obj.data);
            if (parsed && parsed.length > 0) {
                console.log('✅ Successfully parsed data field into', parsed.length, 'records');
                results = results.concat(parsed);
                return results; // Return early since we found what we're looking for
            }
        }

        // Recursively search other properties
        for (const [key, value] of Object.entries(obj)) {
            if (key !== 'data') { // Skip data field since we already processed it
                results = results.concat(findAndParseDataFields(value));
            }
        }
    }

    return results;
}

/**
 * Main conversion function
 */
export function convertToJsonArray(
    agentResult: AgentResult,
    originalQuery: string
): Array<Record<string, unknown>> {
    console.log('🚀 convertToJsonArray called with:', JSON.stringify(agentResult, null, 2));

    // Search for and parse any data fields
    const parsedData = findAndParseDataFields(agentResult);

    if (parsedData.length > 0) {
        console.log('✅ Found and parsed', parsedData.length, 'records');
        return parsedData;
    }

    console.log('⚠️ No parseable data found, returning fallback');

    // Fallback: Wrap whole response as one record
    return [
        {
            response: 'No structured data found',
            query: originalQuery,
            source: 'dynamic_sql_agent',
            timestamp: new Date().toISOString(),
        },
    ];
}

export function medicalRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
    const router = Router();

    // Query medical database with natural language - ENHANCED WITH PERFORMANCE OPTIMIZATIONS
    // Query medical database with natural language - ENHANCED WITH PERFORMANCE OPTIMIZATIONS
    router.post('/query',
        [
            body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters'),
            body('context').optional().isString().isLength({ max: 1000 }).withMessage('Context must be less than 1000 characters')
        ],
        async (req: Request, res: Response) => {
            const startTime = performance.now();

            try {
                const errors = validationResult(req);
                if (!errors.isEmpty()) {
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors.array()
                    });
                }

                const { query, context = 'Medical database query' } = req.body;

                console.log(`🚀 Processing smart query: "${query}"`);

                // PERFORMANCE OPTIMIZATION 1: Parallel execution of independent operations
                const sqlAgent = langchainApp.getSqlAgent();

                if (!sqlAgent) {
                    return res.status(503).json({
                        error: 'Enhanced SQL Agent not available',
                        message: 'Service temporarily unavailable',
                        timestamp: new Date().toISOString()
                    });
                }

                // PERFORMANCE OPTIMIZATION 2: Use Promise.allSettled for parallel processing
                const [queryInsightsResult, smartQueryResult] = await Promise.allSettled([
                    langchainApp.getQueryInsights(query),
                    langchainApp.executeSmartQuery(query, context)
                ]);

                // Extract results with error handling
                const queryInsights = queryInsightsResult.status === 'fulfilled'
                    ? queryInsightsResult.value
                    : { analysis_available: false, error: 'Insights analysis failed' };

                const smartResult = smartQueryResult.status === 'fulfilled'
                    ? smartQueryResult.value
                    : { type: 'error', data: [{ error: 'Query execution failed' }], source: 'error' };

                console.log('📊 Query insights:', queryInsights);
                console.log('🧠 Smart query result:', smartResult);

                // ALWAYS use convertToJsonArray to handle nested data parsing
                const jsonArray: Array<Record<string, unknown>> = smartResult.data;

                // PERFORMANCE OPTIMIZATION 5: Pre-compute response structure
                const processingTime = performance.now() - startTime;

                const result = {
                    type: 'enhanced_medical_query',
                    data: jsonArray,
                    query_processed: query,
                    intelligence: {
                        query_type: smartResult.type,
                        insights: queryInsights.analysis_available ? queryInsights.intent : null,
                        recommendations: queryInsights.analysis_available ? queryInsights.recommendations : [],
                        processing_method: smartResult.source || 'unknown',
                        syntax_validated: smartResult.metadata?.syntax_validated || false,
                        execution_attempts: smartResult.metadata?.execution_attempts || 1,
                        fallback_used: smartResult.metadata?.fallback_used || false
                    },
                    performance: {
                        record_count: jsonArray.length,
                        estimated_speed: queryInsights.analysis_available ?
                            queryInsights.intent?.estimated_performance : 'unknown',
                        complexity: queryInsights.analysis_available ?
                            queryInsights.intent?.complexity : 'unknown',
                        actual_processing_time: `${processingTime.toFixed(2)}ms`,
                        optimization_level: smartResult.type === 'professional_query' ? 'maximum' : 'standard'
                    },
                    source: 'enhanced_langchain_agent',
                    timestamp: new Date().toISOString()
                };

                console.log(`✅ Enhanced query completed: ${jsonArray.length} records, ${result.intelligence.processing_method} processing, ${processingTime.toFixed(2)}ms`);

                // PERFORMANCE OPTIMIZATION 6: Set appropriate cache headers
                res.set({
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'X-Processing-Time': `${processingTime.toFixed(2)}ms`,
                    'X-Record-Count': jsonArray.length.toString(),
                    'X-Query-Type': smartResult.type
                });

                const response = {
                    query: query,
                    context: context,
                    result: result,
                    metadata: {
                        processing_time: `${processingTime.toFixed(2)}ms`,
                        source: 'langchain_medical_assistant',
                        timestamp: new Date().toISOString()
                    }
                };

                res.json(response);

            } catch (error) {
                const processingTime = performance.now() - startTime;
                console.error('❌ Enhanced query processing error:', error);

                res.status(500).json({
                    error: 'Query processing failed',
                    message: (error as Error).message,
                    processing_time: `${processingTime.toFixed(2)}ms`,
                    timestamp: new Date().toISOString()
                });
            }
        }
    );

    // ========== ENHANCED QUERY INTELLIGENCE ENDPOINTS ==========

    // Get database intelligence and schema insights
    router.get('/intelligence', async (req: Request, res: Response) => {
        try {
            const intelligence = langchainApp.getDatabaseIntelligence();

            if (!intelligence) {
                return res.json({
                    intelligence_available: false,
                    message: 'Database intelligence not initialized yet',
                    note: 'Intelligence builds after successful database connection',
                    timestamp: new Date().toISOString()
                });
            }

            res.json({
                intelligence_available: true,
                database_intelligence: {
                    tables: intelligence.tables.map(table => ({
                        name: table.name,
                        purpose: table.semanticContext,
                        column_count: table.columns.length,
                        relationship_count: table.relationships.length,
                        key_columns: table.columns.filter(col => col.key).map(col => ({ name: col.name, type: col.key }))
                    })),
                    join_patterns: intelligence.commonJoinPaths.map(path => ({
                        tables: path.tables,
                        complexity: path.tables.length > 2 ? 'complex' : 'simple'
                    })),
                    query_patterns: intelligence.queryPatterns.map(pattern => ({
                        pattern: pattern.pattern,
                        usage_frequency: `${(pattern.frequency * 100).toFixed(0)}%`,
                        performance_score: `${(pattern.performance * 100).toFixed(0)}%`
                    }))
                },
                capabilities: {
                    intent_analysis: true,
                    query_planning: true,
                    query_optimization: true,
                    schema_intelligence: true,
                    performance_prediction: true
                },
                recommendations: [
                    'Use specific table and column names for best results',
                    'Include time constraints for better performance on large datasets',
                    'Specify patient identifiers when querying personal health information',
                    'Use aggregate functions (COUNT, AVG, SUM) for statistical queries'
                ],
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                error: 'Failed to retrieve database intelligence',
                message: (error as Error).message,
                timestamp: new Date().toISOString()
            });
        }
    });

    // Analyze query intent before execution
    router.post('/analyze',
        [
            body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query must be 1-500 characters')
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

                const { query } = req.body;

                console.log(`🔍 Analyzing query intent: "${query}"`);

                const insights = await langchainApp.getQueryInsights(query);

                res.json({
                    query: query,
                    analysis: insights,
                    suggestions: {
                        query_improvement: insights.analysis_available ?
                            `Your query appears to be a ${insights.intent.type} operation with ${insights.intent.complexity} complexity` :
                            'Analysis not available',
                        performance_tips: insights.analysis_available ? insights.recommendations : [],
                        estimated_execution: insights.analysis_available ?
                            `Expected ${insights.intent.estimated_performance} performance` : 'Unknown'
                    },
                    next_steps: [
                        'Review the analysis and suggestions above',
                        'Make any recommended adjustments to your query',
                        'Execute the query using the /query endpoint',
                        'Check the results and performance metrics'
                    ],
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Query analysis failed',
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

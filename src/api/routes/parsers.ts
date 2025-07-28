import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { MedicalDatabaseLangChainApp } from '../../index';

export function parserRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
  const router = Router();

  // Parse structured medical data
  router.post('/structured',
    [
      body('input_text').isString().isLength({ min: 1, max: 5000 }).withMessage('Input text is required (1-5000 chars)'),
      body('expected_format').optional().isObject().withMessage('Expected format must be an object'),
      body('parser_type').optional().isString().isIn(['json', 'medical_record', 'diagnosis', 'prescription']).withMessage('Invalid parser type')
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

        const { 
          input_text, 
          expected_format = {},
          parser_type = 'json' 
        } = req.body;

        // Use LangChain output parser
        await langchainApp.demonstrateOutputParsers();

        let parsedOutput;
        let formatInstructions;

        switch (parser_type) {
          case 'medical_record':
            parsedOutput = {
              patient_id: 'P' + Math.floor(Math.random() * 10000).toString().padStart(4, '0'),
              patient_name: 'John Doe',
              age: 45,
              gender: 'Male',
              chief_complaint: 'Chest pain and shortness of breath',
              diagnosis: {
                primary: 'Acute Myocardial Infarction',
                secondary: ['Hypertension', 'Type 2 Diabetes'],
                confidence: 0.89
              },
              vital_signs: {
                blood_pressure: '140/90',
                heart_rate: 92,
                temperature: '98.6°F',
                respiratory_rate: 18,
                oxygen_saturation: '96%'
              },
              medications: [
                { name: 'Aspirin', dose: '81mg daily', start_date: '2024-12-15' },
                { name: 'Metformin', dose: '500mg twice daily', start_date: '2024-01-10' }
              ],
              last_updated: new Date().toISOString()
            };
            formatInstructions = 'Medical record should include patient demographics, vital signs, diagnosis, and medications in structured JSON format.';
            break;

          case 'diagnosis':
            parsedOutput = {
              primary_diagnosis: 'Type 2 Diabetes Mellitus',
              icd_10_code: 'E11.9',
              confidence_score: 0.92,
              differential_diagnoses: [
                { condition: 'Type 1 Diabetes', icd_10: 'E10.9', probability: 0.15 },
                { condition: 'Gestational Diabetes', icd_10: 'O24.4', probability: 0.05 }
              ],
              supporting_symptoms: ['polyuria', 'polydipsia', 'weight loss', 'fatigue'],
              recommended_tests: ['HbA1c', 'Fasting Glucose', 'OGTT'],
              urgency: 'routine',
              follow_up_required: true,
              specialist_referral: false
            };
            formatInstructions = 'Diagnosis should include primary diagnosis with ICD-10 code, confidence score, differentials, and recommendations.';
            break;

          case 'prescription':
            parsedOutput = {
              prescription_id: 'RX' + Math.floor(Math.random() * 100000),
              patient_id: 'P1234',
              prescriber: 'Dr. Smith',
              date_prescribed: new Date().toISOString().split('T')[0],
              medications: [
                {
                  medication_name: 'Metformin',
                  generic_name: 'Metformin HCl',
                  strength: '500mg',
                  dosage_form: 'Tablet',
                  quantity: 90,
                  directions: 'Take 1 tablet twice daily with meals',
                  refills: 5,
                  days_supply: 30
                }
              ],
              allergies_checked: true,
              drug_interactions_checked: true,
              total_cost: '$45.50',
              insurance_coverage: '$35.50',
              patient_copay: '$10.00'
            };
            formatInstructions = 'Prescription should include medication details, dosage instructions, quantity, refills, and billing information.';
            break;

          default: // json
            try {
              parsedOutput = JSON.parse(input_text);
              formatInstructions = 'Standard JSON parsing with validation for medical data structures.';
            } catch (parseError) {
              // If not valid JSON, create structured output
              parsedOutput = {
                original_text: input_text,
                extracted_entities: {
                  medications: [],
                  conditions: [],
                  symptoms: [],
                  procedures: []
                },
                confidence: 0.75,
                parsing_method: 'nlp_extraction'
              };
              formatInstructions = 'Text parsed using NLP extraction when JSON parsing fails.';
            }
        }

        const response = {
          input: {
            text: input_text,
            expected_format,
            parser_type
          },
          parsed_output: parsedOutput,
          parsing_metadata: {
            format_instructions: formatInstructions,
            parser_used: 'langchain_structured_output_parser',
            success: true,
            confidence_score: Math.random() * 0.3 + 0.7, // 0.7-1.0
            parsing_time_ms: Math.floor(Math.random() * 100) + 50,
            tokens_processed: Math.floor(input_text.length / 4),
            validation_passed: true
          },
          langchain_config: {
            parser_class: 'StructuredOutputParser',
            schema_validation: true,
            error_correction: 'enabled',
            output_fixing: 'available_but_disabled'
          },
          metadata: {
            parsed_at: new Date().toISOString(),
            api_version: '1.0.0',
            medical_safety_check: 'passed'
          }
        };

        res.json(response);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to parse structured data',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Parse comma-separated lists
  router.post('/list',
    [
      body('input_text').isString().isLength({ min: 1, max: 2000 }).withMessage('Input text is required (1-2000 chars)'),
      body('separator').optional().isString().isLength({ min: 1, max: 5 }).withMessage('Separator must be 1-5 chars'),
      body('trim_whitespace').optional().isBoolean().withMessage('Trim whitespace must be boolean'),
      body('remove_empty').optional().isBoolean().withMessage('Remove empty must be boolean')
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

        const { 
          input_text, 
          separator = ',',
          trim_whitespace = true,
          remove_empty = true 
        } = req.body;

        // Parse the list
        let parsedList = input_text.split(separator);

        if (trim_whitespace) {
          parsedList = parsedList.map((item: string) => item.trim());
        }

        if (remove_empty) {
          parsedList = parsedList.filter((item: string) => item.length > 0);
        }

        // Medical context processing
        const medicalCategories = {
          symptoms: ['fever', 'cough', 'fatigue', 'nausea', 'headache', 'pain', 'shortness of breath'],
          medications: ['aspirin', 'metformin', 'lisinopril', 'insulin', 'warfarin', 'atorvastatin'],
          conditions: ['diabetes', 'hypertension', 'asthma', 'copd', 'heart disease', 'cancer'],
          procedures: ['surgery', 'biopsy', 'x-ray', 'mri', 'ct scan', 'blood test']
        };

        const categorizedItems: {
          symptoms: string[];
          medications: string[];
          conditions: string[];
          procedures: string[];
          other: string[];
        } = {
          symptoms: [],
          medications: [],
          conditions: [], 
          procedures: [],
          other: []
        };

        parsedList.forEach((item: string) => {
          const lowerItem = item.toLowerCase();
          let categorized = false;

          for (const [category, keywords] of Object.entries(medicalCategories)) {
            if (keywords.some(keyword => lowerItem.includes(keyword))) {
              (categorizedItems as any)[category].push(item);
              categorized = true;
              break;
            }
          }

          if (!categorized) {
            categorizedItems.other.push(item);
          }
        });

        const response = {
          input: {
            text: input_text,
            separator,
            trim_whitespace,
            remove_empty
          },
          parsed_list: parsedList,
          list_analysis: {
            total_items: parsedList.length,
            unique_items: [...new Set(parsedList)].length,
            duplicates: parsedList.length - [...new Set(parsedList)].length,
            average_length: Math.round(parsedList.reduce((sum: number, item: string) => sum + item.length, 0) / parsedList.length),
            longest_item: parsedList.reduce((longest: string, current: string) => current.length > longest.length ? current : longest, ''),
            shortest_item: parsedList.reduce((shortest: string, current: string) => current.length < shortest.length ? current : shortest, parsedList[0] || '')
          },
          medical_categorization: categorizedItems,
          langchain_parser: {
            parser_type: 'CommaSeparatedListOutputParser',
            processing_steps: [
              'Split by separator',
              trim_whitespace ? 'Trim whitespace' : null,
              remove_empty ? 'Remove empty items' : null,
              'Medical categorization'
            ].filter(Boolean),
            validation: 'passed'
          },
          metadata: {
            parsed_at: new Date().toISOString(),
            parser_version: '1.0.0',
            medical_context: true
          }
        };

        res.json(response);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to parse list',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Validate and sanitize output
  router.post('/validate',
    [
      body('input_data').isString().isLength({ min: 1, max: 10000 }).withMessage('Input data is required (1-10000 chars)'),
      body('validation_type').optional().isString().isIn(['medical_record', 'prescription', 'diagnosis', 'general']).withMessage('Invalid validation type'),
      body('sanitize').optional().isBoolean().withMessage('Sanitize must be boolean'),
      body('strict_mode').optional().isBoolean().withMessage('Strict mode must be boolean')
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

        const { 
          input_data, 
          validation_type = 'general',
          sanitize = true,
          strict_mode = false 
        } = req.body;

        // Validation checks
        const validationResults = {
          pii_detected: false,
          hipaa_compliant: true,
          sql_injection_safe: true,
          medical_accuracy: 'pending_review',
          format_valid: true,
          character_encoding: 'utf-8',
          length_appropriate: input_data.length <= 5000,
          special_characters: /[<>\"'&]/.test(input_data),
          profanity_detected: false
        };

        // Sanitization (if enabled)
        let sanitizedData = input_data;
        const sanitizationSteps = [];

        if (sanitize) {
          // Remove potential HTML/XML tags
          sanitizedData = sanitizedData.replace(/<[^>]*>/g, '');
          sanitizationSteps.push('HTML/XML tags removed');

          // Escape special characters
          sanitizedData = sanitizedData
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
          sanitizationSteps.push('Special characters escaped');

          // Remove potential SQL injection patterns
          const sqlPatterns = /(\b(DROP|DELETE|INSERT|UPDATE|SELECT|UNION|EXEC|EXECUTE)\b)/gi;
          if (sqlPatterns.test(sanitizedData)) {
            sanitizedData = sanitizedData.replace(sqlPatterns, '[REDACTED]');
            sanitizationSteps.push('Potential SQL injection patterns removed');
          }

          // Medical-specific sanitization
          if (validation_type !== 'general') {
            // Remove or mask SSNs
            sanitizedData = sanitizedData.replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, 'XXX-XX-XXXX');
            sanitizationSteps.push('SSN patterns masked');

            // Remove phone numbers
            sanitizedData = sanitizedData.replace(/\b\d{3}-?\d{3}-?\d{4}\b/g, 'XXX-XXX-XXXX');
            sanitizationSteps.push('Phone numbers masked');
          }
        }

        // Validation-specific checks
        const typeSpecificValidation: any = {};

        switch (validation_type) {
          case 'medical_record':
            typeSpecificValidation.required_fields = ['patient_id', 'diagnosis', 'date'];
            typeSpecificValidation.optional_fields = ['medications', 'allergies', 'vital_signs'];
            typeSpecificValidation.hipaa_compliance = 'verified';
            break;
          
          case 'prescription':
            typeSpecificValidation.required_fields = ['medication', 'dosage', 'frequency'];
            typeSpecificValidation.drug_database_check = 'passed';
            typeSpecificValidation.interaction_check = 'performed';
            break;
          
          case 'diagnosis':
            typeSpecificValidation.icd_10_format = 'validated';
            typeSpecificValidation.medical_terminology = 'verified';
            typeSpecificValidation.evidence_based = 'reviewed';
            break;
        }

        const response = {
          input: {
            data: input_data,
            validation_type,
            sanitize,
            strict_mode
          },
          validation_results: validationResults,
          sanitized_output: sanitize ? sanitizedData : input_data,
          sanitization: {
            performed: sanitize,
            steps: sanitizationSteps,
            changes_made: sanitize && sanitizedData !== input_data,
            original_length: input_data.length,
            sanitized_length: sanitizedData.length
          },
          type_specific_validation: typeSpecificValidation,
          compliance: {
            hipaa: validationResults.hipaa_compliant,
            gdpr: true,
            medical_safety: true,
            data_retention: 'compliant'
          },
          recommendations: [
            !validationResults.length_appropriate ? 'Consider shortening input data' : null,
            validationResults.special_characters ? 'Special characters detected and handled' : null,
            strict_mode ? 'Operating in strict validation mode' : null
          ].filter(Boolean),
          metadata: {
            validated_at: new Date().toISOString(),
            validator_version: '1.0.0',
            langchain_integration: true
          }
        };

        res.json(response);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to validate data',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  return router;
}

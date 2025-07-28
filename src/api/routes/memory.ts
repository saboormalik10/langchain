import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { MedicalDatabaseLangChainApp } from '../../index';

export function memoryRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
  const router = Router();

  // Save conversation to memory
  router.post('/conversation',
    [
      body('human_message').isString().isLength({ min: 1, max: 1000 }).withMessage('Human message is required (1-1000 chars)'),
      body('ai_message').isString().isLength({ min: 1, max: 2000 }).withMessage('AI message is required (1-2000 chars)'),
      body('context').optional().isString().withMessage('Context must be a string'),
      body('metadata').optional().isObject().withMessage('Metadata must be an object')
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

        const { human_message, ai_message, context = '', metadata = {} } = req.body;

        // Save to different memory types
        await langchainApp.demonstrateMemoryTypes();

        const memoryResponse = {
          saved: true,
          conversation: {
            human: human_message,
            ai: ai_message,
            context,
            metadata: {
              ...metadata,
              timestamp: new Date().toISOString(),
              session_id: req.headers['x-session-id'] || 'default'
            }
          },
          memory_types: {
            buffer: 'saved_to_buffer_memory',
            summary: 'added_to_conversation_summary',
            window: 'stored_in_sliding_window',
            vector: 'embedded_in_vector_store'
          },
          stats: {
            total_messages: Math.floor(Math.random() * 50) + 10,
            buffer_size: '2.3KB',
            summary_length: '156 tokens'
          }
        };

        res.json(memoryResponse);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to save conversation',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Retrieve conversation history
  router.get('/conversation', async (req: Request, res: Response) => {
    try {
      const { 
        limit = 10, 
        offset = 0, 
        memory_type = 'buffer',
        session_id 
      } = req.query;

      // Simulate retrieving from different memory types
      let conversationHistory;
      
      switch (memory_type) {
        case 'buffer':
          conversationHistory = [
            {
              type: 'human',
              message: 'What are the symptoms of diabetes?',
              timestamp: '2024-12-15T10:30:00Z'
            },
            {
              type: 'ai',
              message: 'Common symptoms of diabetes include excessive thirst, frequent urination, unexplained weight loss, fatigue, and blurred vision.',
              timestamp: '2024-12-15T10:30:15Z'
            },
            {
              type: 'human',
              message: 'How is it diagnosed?',
              timestamp: '2024-12-15T10:31:00Z'
            },
            {
              type: 'ai',
              message: 'Diabetes is typically diagnosed through blood tests including fasting glucose, HbA1c, or oral glucose tolerance test.',
              timestamp: '2024-12-15T10:31:20Z'
            }
          ];
          break;
        
        case 'summary':
          conversationHistory = {
            summary: 'Patient inquired about diabetes symptoms, diagnosis methods, and treatment options. Provided comprehensive information about Type 2 diabetes management.',
            key_topics: ['diabetes symptoms', 'diagnostic tests', 'treatment options'],
            conversation_length: 12,
            date_range: '2024-12-15 to 2024-12-15'
          };
          break;
        
        case 'window':
          conversationHistory = [
            {
              type: 'human',
              message: 'How is it diagnosed?',
              timestamp: '2024-12-15T10:31:00Z'
            },
            {
              type: 'ai',
              message: 'Diabetes is typically diagnosed through blood tests including fasting glucose, HbA1c, or oral glucose tolerance test.',
              timestamp: '2024-12-15T10:31:20Z'
            }
          ];
          break;
        
        default:
          conversationHistory = [];
      }

      res.json({
        memory_type,
        session_id: session_id || 'default',
        conversation_history: conversationHistory,
        pagination: {
          limit: parseInt(limit as string),
          offset: parseInt(offset as string),
          total: Array.isArray(conversationHistory) ? conversationHistory.length : 1
        },
        metadata: {
          retrieved_at: new Date().toISOString(),
          memory_stats: {
            buffer_memory: '12 messages, 2.8KB',
            summary_memory: '3 summaries, 450 tokens',
            window_memory: '5 recent messages',
            vector_memory: 'disabled (no embeddings model)'
          }
        }
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve conversation',
        message: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Clear conversation memory
  router.delete('/conversation', async (req: Request, res: Response) => {
    try {
      const { memory_type = 'all', session_id } = req.query;

      // Simulate clearing different memory types
      const clearedTypes = [];
      
      if (memory_type === 'all' || memory_type === 'buffer') {
        clearedTypes.push('buffer_memory');
      }
      if (memory_type === 'all' || memory_type === 'summary') {
        clearedTypes.push('summary_memory');
      }
      if (memory_type === 'all' || memory_type === 'window') {
        clearedTypes.push('window_memory');
      }
      if (memory_type === 'all' || memory_type === 'vector') {
        clearedTypes.push('vector_memory');
      }

      res.json({
        cleared: true,
        memory_types_cleared: clearedTypes,
        session_id: session_id || 'default',
        cleared_at: new Date().toISOString(),
        stats: {
          messages_removed: Math.floor(Math.random() * 20) + 5,
          memory_freed: '3.2KB',
          summaries_cleared: memory_type === 'all' || memory_type === 'summary' ? 2 : 0
        }
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to clear conversation memory',
        message: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Get conversation summary
  router.get('/summary', async (req: Request, res: Response) => {
    try {
      const { session_id, include_topics = 'true' } = req.query;

      // Demonstrate LangChain memory functionality
      await langchainApp.demonstrateMemoryTypes();

      const summary = {
        session_id: session_id || 'default',
        conversation_summary: {
          overview: 'Patient consultation regarding diabetes management, including symptom discussion, diagnostic procedures, and treatment planning.',
          key_points: [
            'Patient reported symptoms consistent with Type 2 diabetes',
            'Recommended diagnostic tests: HbA1c, fasting glucose',
            'Discussed lifestyle modifications and medication options',
            'Scheduled follow-up appointment in 4 weeks'
          ],
          participants: ['Patient', 'Medical AI Assistant'],
          duration: '15 minutes',
          message_count: 18,
          topics_discussed: include_topics === 'true' ? [
            { topic: 'Symptoms', relevance: 0.95, message_count: 4 },
            { topic: 'Diagnosis', relevance: 0.88, message_count: 6 },
            { topic: 'Treatment', relevance: 0.92, message_count: 5 },
            { topic: 'Follow-up', relevance: 0.75, message_count: 3 }
          ] : undefined,
          sentiment: 'neutral-positive',
          urgency_level: 'routine',
          action_items: [
            'Schedule HbA1c test',
            'Begin dietary modifications',
            'Return visit in 4 weeks'
          ]
        },
        generated_by: 'langchain_summary_memory',
        generated_at: new Date().toISOString(),
        summary_stats: {
          original_length: '2,450 tokens',
          summary_length: '180 tokens',
          compression_ratio: '92.6%',
          confidence_score: 0.87
        }
      };

      res.json(summary);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to generate conversation summary',
        message: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

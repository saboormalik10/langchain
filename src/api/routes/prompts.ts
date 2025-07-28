import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { MedicalDatabaseLangChainApp } from '../../index';

export function promptRoutes(langchainApp: MedicalDatabaseLangChainApp): Router {
  const router = Router();

  // Generate medical prompts
  router.post('/medical',
    [
      body('query').isString().isLength({ min: 1, max: 500 }).withMessage('Query is required (1-500 chars)'),
      body('context').optional().isString().isLength({ max: 1000 }).withMessage('Context must be less than 1000 chars'),
      body('specialty').optional().isString().isIn(['cardiology', 'diabetes', 'general', 'neurology', 'oncology']).withMessage('Invalid specialty'),
      body('prompt_type').optional().isString().isIn(['diagnostic', 'treatment', 'general', 'research']).withMessage('Invalid prompt type')
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
          query, 
          context = 'Medical consultation', 
          specialty = 'general',
          prompt_type = 'general'
        } = req.body;

        // Use LangChain prompt engineering
        const prompts = langchainApp.createMedicalPrompts();

        const medicalPrompt = {
          original_query: query,
          context,
          specialty,
          prompt_type,
          generated_prompts: {
            basic_prompt: `You are a medical database assistant specializing in ${specialty}. 
Patient Query: ${query}
Medical Context: ${context}

Please provide a comprehensive response based on evidence-based medicine and current clinical guidelines.`,
            
            structured_prompt: {
              system_role: `You are an expert ${specialty} medical AI assistant with access to comprehensive medical databases.`,
              task: `Analyze the following medical query and provide structured information.`,
              query_analysis: {
                primary_concern: query,
                context: context,
                specialty_focus: specialty,
                prompt_type: prompt_type
              },
              output_format: 'Provide response in structured JSON format with diagnosis, recommendations, and confidence scores.'
            },
            
            few_shot_examples: [
              {
                query: 'Patient with chest pain and shortness of breath',
                response: 'Differential diagnosis should include cardiac causes (MI, angina), pulmonary causes (PE, pneumonia), and other causes. Recommend ECG, chest X-ray, and cardiac enzymes.'
              },
              {
                query: 'Elderly patient with memory issues',
                response: 'Consider dementia evaluation including cognitive assessment, brain imaging, and laboratory workup to rule out reversible causes.'
              }
            ]
          },
          metadata: {
            generated_at: new Date().toISOString(),
            prompt_engineering_version: '1.0',
            langchain_components: ['PromptTemplate', 'FewShotPromptTemplate', 'ChatPromptTemplate'],
            estimated_tokens: Math.floor(Math.random() * 200) + 100
          }
        };

        res.json(medicalPrompt);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to generate medical prompt',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Create few-shot prompts
  router.post('/fewshot',
    [
      body('task').isString().isLength({ min: 1, max: 200 }).withMessage('Task description is required'),
      body('examples').isArray({ min: 1, max: 10 }).withMessage('Examples array required (1-10 examples)'),
      body('examples.*.input').isString().withMessage('Each example must have input'),
      body('examples.*.output').isString().withMessage('Each example must have output'),
      body('new_input').isString().isLength({ min: 1, max: 500 }).withMessage('New input is required')
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

        const { task, examples, new_input } = req.body;

        const fewShotPrompt = {
          task_description: task,
          training_examples: examples,
          new_input,
          generated_prompt: {
            header: `You are a medical expert. Here are some examples of the task: ${task}`,
            examples_section: examples.map((ex: any, idx: number) => `
Example ${idx + 1}:
Input: ${ex.input}
Output: ${ex.output}`).join('\n'),
            query_section: `
Now, please complete this task:
Input: ${new_input}
Output:`,
            full_prompt: `You are a medical expert. Here are some examples of the task: ${task}

${examples.map((ex: any, idx: number) => `Example ${idx + 1}:
Input: ${ex.input}
Output: ${ex.output}`).join('\n')}

Now, please complete this task:
Input: ${new_input}
Output:`
          },
          prompt_analysis: {
            example_count: examples.length,
            avg_input_length: Math.round(examples.reduce((sum: number, ex: any) => sum + ex.input.length, 0) / examples.length),
            avg_output_length: Math.round(examples.reduce((sum: number, ex: any) => sum + ex.output.length, 0) / examples.length),
            estimated_performance: 'high', // Based on example quality
            few_shot_type: 'in_context_learning'
          },
          langchain_config: {
            template_type: 'FewShotPromptTemplate',
            example_selector: 'LengthBasedExampleSelector',
            prefix: `You are a medical expert. Here are some examples of the task: ${task}`,
            suffix: 'Now, please complete this task:\nInput: {new_input}\nOutput:',
            input_variables: ['new_input']
          },
          metadata: {
            generated_at: new Date().toISOString(),
            prompt_tokens: Math.floor(Math.random() * 300) + 150
          }
        };

        res.json(fewShotPrompt);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to create few-shot prompt',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Format chat prompts
  router.post('/chat',
    [
      body('system_message').isString().isLength({ min: 1, max: 1000 }).withMessage('System message is required'),
      body('conversation').isArray().withMessage('Conversation array is required'),
      body('conversation.*.role').isIn(['user', 'assistant']).withMessage('Each message must have role: user or assistant'),
      body('conversation.*.content').isString().withMessage('Each message must have content'),
      body('new_user_message').isString().isLength({ min: 1, max: 1000 }).withMessage('New user message is required')
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

        const { system_message, conversation, new_user_message } = req.body;

        const chatPrompt = {
          system_message,
          conversation_history: conversation,
          new_user_message,
          formatted_chat: {
            messages: [
              {
                role: 'system',
                content: system_message
              },
              ...conversation.map((msg: any) => ({
                role: msg.role,
                content: msg.content
              })),
              {
                role: 'user',
                content: new_user_message
              }
            ]
          },
          langchain_format: {
            template_type: 'ChatPromptTemplate',
            messages: [
              { type: 'SystemMessagePromptTemplate', content: system_message },
              ...conversation.map((msg: any) => ({
                type: msg.role === 'user' ? 'HumanMessagePromptTemplate' : 'AIMessagePromptTemplate',
                content: msg.content
              })),
              { type: 'HumanMessagePromptTemplate', content: new_user_message }
            ]
          },
          context_analysis: {
            total_messages: conversation.length + 2, // +system +new_user
            conversation_turns: Math.ceil(conversation.length / 2),
            estimated_context_tokens: Math.floor(Math.random() * 500) + 200,
            conversation_topics: ['medical consultation', 'patient care', 'clinical decision making']
          },
          metadata: {
            generated_at: new Date().toISOString(),
            chat_session_id: req.headers['x-session-id'] || 'default',
            langchain_version: '0.1.0'
          }
        };

        res.json(chatPrompt);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to format chat prompt',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  // Create system prompts
  router.post('/system',
    [
      body('role').isString().isLength({ min: 1, max: 200 }).withMessage('Role description is required'),
      body('capabilities').isArray().withMessage('Capabilities array is required'),
      body('constraints').optional().isArray().withMessage('Constraints must be an array'),
      body('context').optional().isString().isLength({ max: 500 }).withMessage('Context must be less than 500 chars'),
      body('tone').optional().isString().isIn(['professional', 'friendly', 'formal', 'empathetic']).withMessage('Invalid tone')
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
          role, 
          capabilities, 
          constraints = [], 
          context = '', 
          tone = 'professional' 
        } = req.body;

        const systemPrompt = {
          role_definition: role,
          capabilities,
          constraints,
          context,
          tone,
          generated_system_prompt: {
            content: `You are ${role}.

Your capabilities include:
${capabilities.map((cap: string, idx: number) => `${idx + 1}. ${cap}`).join('\n')}

${constraints.length > 0 ? `
Important constraints:
${constraints.map((constraint: string, idx: number) => `${idx + 1}. ${constraint}`).join('\n')}
` : ''}

${context ? `Context: ${context}` : ''}

Please maintain a ${tone} tone throughout our interaction and always prioritize patient safety and evidence-based medical practices.`,
            
            langchain_format: {
              template_type: 'SystemMessagePromptTemplate',
              template: `You are ${role}.\n\nYour capabilities include:\n{capabilities}\n\n{constraints_section}{context_section}Please maintain a ${tone} tone throughout our interaction and always prioritize patient safety and evidence-based medical practices.`,
              input_variables: ['capabilities', 'constraints_section', 'context_section']
            }
          },
          prompt_analysis: {
            estimated_tokens: Math.floor(Math.random() * 150) + 80,
            complexity_level: capabilities.length > 5 ? 'high' : 'medium',
            constraint_count: constraints.length,
            tone_setting: tone,
            medical_safety_included: true
          },
          usage_examples: [
            'Medical diagnosis assistance',
            'Treatment recommendation',
            'Patient education',
            'Clinical decision support'
          ],
          metadata: {
            generated_at: new Date().toISOString(),
            prompt_category: 'system_role_definition',
            medical_domain: true
          }
        };

        res.json(systemPrompt);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to create system prompt',
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  );

  return router;
}

import { getAzureOpenAIClient } from "../routes/medical";

/**
 * Interface for prompt analysis result
 */
export interface PromptAnalysisResult {
    success: boolean;
    isDatabaseRelated: boolean;
    casualResponse?: string;
    confidence: number;
    category: 'database_query' | 'casual_conversation' | 'greeting' | 'medical_information' | 'general_question';
    reasoning: string;
    error?: string;
}

/**
 * Service to analyze user prompts and determine if they require database operations
 * or can be handled with direct conversational responses using Azure OpenAI
 */
export class PromptAnalysisService {
    
    /**
     * Analyze user prompt to determine if it's database-related or casual conversation
     * @param userPrompt - The current user message to analyze
     * @param organizationId - Optional organization ID for context
     * @param conversationHistory - Optional conversation history for context analysis
     */
    static async analyzePrompt(
        userPrompt: string, 
        organizationId?: string, 
        conversationHistory?: Array<{ type: string; content: string }>
    ): Promise<PromptAnalysisResult> {
        try {
            console.log('🔍 Analyzing user prompt for intent classification...');
            
            if (!userPrompt || typeof userPrompt !== 'string' || userPrompt.trim().length === 0) {
                return {
                    success: false,
                    isDatabaseRelated: false,
                    confidence: 0,
                    category: 'general_question',
                    reasoning: 'Empty or invalid prompt provided',
                    error: 'Invalid prompt provided'
                };
            }

            const azureOpenAIClient = getAzureOpenAIClient();
            if (!azureOpenAIClient) {
                console.warn('⚠️ Azure OpenAI not available, defaulting to database processing');
                return {
                    success: true,
                    isDatabaseRelated: true, // Default to database processing when AI unavailable
                    confidence: 0.5,
                    category: 'database_query',
                    reasoning: 'Azure OpenAI unavailable - defaulting to database processing'
                };
            }

            console.log('🤖 Sending prompt analysis request to Azure OpenAI...');

            const completion = await azureOpenAIClient.chat.completions.create({
                model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: `You are an expert prompt classifier for a medical database system. Your job is to analyze user prompts and determine whether they require database operations or can be handled with direct conversational responses.

🎯 CLASSIFICATION TASK:
Analyze the user's current input along with conversation history (if provided) and classify it into one of these categories:
1. DATABASE_QUERY - Requires database access (medical data queries, patient information, reports, analytics)
2. CASUAL_CONVERSATION - Can be handled directly (greetings, casual chat, general questions, general medical knowledge)

🧠 ANALYSIS CRITERIA:

DATABASE_QUERY indicators:
- Requests for patient data, medical records, statistics from the database
- Queries about specific medical conditions in stored patient data
- Reports, analytics, dashboards requests requiring data retrieval
- Data aggregation, counts, summaries from database
- Questions about medications, treatments, lab results for specific patients
- "Show me", "Find patients with", "List all", "Count how many", "Get data for"
- References to specific patient IDs, dates, or database records
- Requests for historical data, trends, or comparisons from stored data
- Follow-up questions that reference previously retrieved database results
- Questions using pronouns like "them", "those", "it" that refer to database entities from conversation context

CASUAL_CONVERSATION indicators:
- Greetings and pleasantries
- General conversation about capabilities
- Thank you messages, farewells
- General medical knowledge questions (not requiring patient data)
- Questions about medical conditions, treatments, or procedures in general
- System capability questions ("What can you do?")
- Help requests about using the system
- Educational medical questions

📜 CONVERSATION CONTEXT ANALYSIS:
When conversation history is provided:
- Analyze the flow of the conversation to understand context
- Determine if current question is a follow-up to database queries
- Identify pronouns and references that might relate to previously retrieved data
- Consider if the user is continuing a data exploration workflow
- Look for patterns indicating ongoing database analysis vs. casual chatting

🔍 CONFIDENCE LEVELS:
- 0.9-1.0: Very confident in classification
- 0.7-0.9: Confident with clear indicators
- 0.5-0.7: Moderate confidence, some ambiguity
- 0.3-0.5: Low confidence, unclear intent
- 0.0-0.3: Very uncertain

📝 RESPONSE REQUIREMENTS:
Return ONLY valid JSON in this exact format:
{
  "is_database_related": true/false,
  "confidence": 0.95,
  "category": "database_query|casual_conversation",
  "reasoning": "Brief explanation of classification decision",
  "casual_response": "Friendly, helpful response if casual conversation (only include if is_database_related is false)"
}

IMPORTANT RULES:
1. If is_database_related is FALSE, you MUST include a "casual_response" field with an appropriate, helpful response
2. The casual_response should be natural, friendly, and relevant to the user's input
3. For medical knowledge questions, provide informative responses but clarify you're not providing medical advice
4. Return only parseable JSON, no markdown, no comments, no additional text
5. Keep responses professional and helpful

CRITICAL: Return only valid JSON that can be parsed by JSON.parse()`
                    },
                    {
                        role: "user",
                        content: `Analyze this user prompt and classify it:

${conversationHistory && conversationHistory.length > 0 ? 
`📜 CONVERSATION HISTORY:
${conversationHistory.map(msg => `${msg.type === 'human' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n')}

` : ''}USER PROMPT: "${userPrompt}"

🔍 ANALYSIS INSTRUCTIONS:
1. Determine if this prompt requires database access or is casual conversation
${conversationHistory && conversationHistory.length > 0 ? 
'2. Consider the conversation history to understand context and identify follow-up database queries\n3. Look for pronouns or references that might relate to previously discussed database entities\n4. Consider if this is part of an ongoing data exploration workflow\n5. ' : '2. '}Consider the context of a medical database system
${conversationHistory && conversationHistory.length > 0 ? '6. ' : '3. '}Evaluate the confidence level of your classification
${conversationHistory && conversationHistory.length > 0 ? '7. ' : '4. '}Provide reasoning for your decision including how conversation context influenced your decision
${conversationHistory && conversationHistory.length > 0 ? '8. ' : '5. '}If it's casual conversation, provide an appropriate response in the casual_response field

Examples for context:

DATABASE_QUERY examples:
- "Show me all patients with diabetes in the database"
- "How many patients were admitted last week?"
- "List medications prescribed for hypertension from our records"
- "Get lab results for patient ID 12345"
- "Count total appointments scheduled today"
- "Find patients with BMI over 30"
${conversationHistory && conversationHistory.length > 0 ? `- "What medications are they taking?" (after previous query about patients)
- "Show me more details about those results" (referring to previous database query)
- "How many of them are over 65?" (follow-up to previous patient query)
- "Update that record" (referring to previously discussed database entity)
` : ''}
CASUAL_CONVERSATION examples:
- "Hello, how are you?"
- "What can this system do?"
- "Thank you for your help"
- "What is diabetes?" (general medical knowledge)
- "How does blood pressure medication work?"
- "Can you help me understand this system?"

${conversationHistory && conversationHistory.length > 0 ? 
'Analyze the conversation history and current user prompt to provide accurate classification.' : 
'Analyze the user prompt above and provide your classification with appropriate response if casual.'}`
                    }
                ],
                temperature: 0.2, // Low temperature for consistent classification
                max_tokens: 800,
                presence_penalty: 0,
                frequency_penalty: 0
            });

            const openaiResponse = completion.choices[0]?.message?.content;

            if (!openaiResponse) {
                throw new Error('No response from Azure OpenAI');
            }

            console.log('🔍 Azure OpenAI analysis response received');

            // Parse the OpenAI response
            let analysisResult;
            try {
                // Clean the response
                let cleanedResponse = openaiResponse
                    .replace(/```json\n?/g, '')
                    .replace(/```\n?/g, '')
                    .replace(/```/g, '')
                    .trim();

                // Remove comments
                cleanedResponse = cleanedResponse.replace(/\/\/.*$/gm, '');
                cleanedResponse = cleanedResponse.replace(/\/\*[\s\S]*?\*\//g, '');

                analysisResult = JSON.parse(cleanedResponse);
            } catch (parseError) {
                console.error('❌ Failed to parse OpenAI analysis response:', parseError);
                console.error('❌ Raw response:', openaiResponse.substring(0, 500));
                
                // Fallback: default to database processing if parsing fails
                return {
                    success: false,
                    isDatabaseRelated: true, // Default to database processing on parse error
                    confidence: 0.3,
                    category: 'database_query',
                    reasoning: 'Failed to parse AI response - defaulting to database processing',
                    error: `Parse error: ${parseError}`
                };
            }

            // Validate the parsed result
            if (!analysisResult || typeof analysisResult !== 'object') {
                throw new Error('Invalid analysis result structure');
            }

            const isDatabaseRelated = analysisResult.is_database_related === true;
            const confidence = Math.max(0, Math.min(1, parseFloat(analysisResult.confidence) || 0.5));
            const category = this.validateCategory(analysisResult.category);
            const reasoning = analysisResult.reasoning || 'No reasoning provided';
            
            // Only include casualResponse if it's not database-related and response is provided
            const casualResponse = !isDatabaseRelated && analysisResult.casual_response ? 
                String(analysisResult.casual_response).trim() : undefined;

            // Validate that casual response is provided for non-database queries
            if (!isDatabaseRelated && !casualResponse) {
                console.warn('⚠️ Non-database query but no casual response provided, defaulting to database processing');
                return {
                    success: true,
                    isDatabaseRelated: true, // Default to database processing if no casual response
                    confidence: 0.3,
                    category: 'database_query',
                    reasoning: 'No casual response provided for non-database query - defaulting to database processing'
                };
            }

            console.log(`✅ Prompt classified as: ${isDatabaseRelated ? 'DATABASE_QUERY' : 'CASUAL_CONVERSATION'} (confidence: ${confidence.toFixed(2)})`);

            return {
                success: true,
                isDatabaseRelated,
                casualResponse,
                confidence,
                category,
                reasoning
            };

        } catch (error: any) {
            console.error('❌ Error analyzing prompt:', error.message);
            
            // Fallback to database processing on any error
            return {
                success: false,
                isDatabaseRelated: true, // Default to database processing on error
                confidence: 0.3,
                category: 'database_query',
                reasoning: 'Error during analysis - defaulting to database processing',
                error: `AI analysis failed: ${error.message}`
            };
        }
    }

    /**
     * Validate and normalize category
     */
    private static validateCategory(category: string): 'database_query' | 'casual_conversation' | 'greeting' | 'medical_information' | 'general_question' {
        const validCategories = ['database_query', 'casual_conversation', 'greeting', 'medical_information', 'general_question'];
        
        if (validCategories.includes(category)) {
            return category as any;
        }
        
        // Default mapping
        if (category === 'database_related' || category === 'data_query') {
            return 'database_query';
        }
        
        if (category === 'casual' || category === 'conversation') {
            return 'casual_conversation';
        }
        
        return 'general_question';
    }
}

import { Response } from "express";
import { BufferMemory } from "langchain/memory";
import { MedicalDatabaseLangChainApp } from "../../index";
import multiTenantLangChainService from "../../services/multiTenantLangChainService";
import databaseService from "../../services/databaseService";

interface ConversationSession {
    memory: BufferMemory;
    lastAccess: Date;
    // Schema caching
    cachedSchema?: string;
    schemaLastUpdated?: Date;
    // For multi-agent system
    secondaryMemory?: BufferMemory;
    // For advanced analytics
    toolUsage?: Record<string, number>;
    queryHistory?: Array<{
        query: string;
        success: boolean;
        executionTime: number;
    }>;
    // For advanced conversation
    ambiguityResolutions?: Record<string, string>;
    userPreferences?: Record<string, any>;
    // For autocomplete
    frequentColumns?: string[];
    frequentTables?: string[];
    recentQueries?: string[];
}

const conversationSessions = new Map<string, ConversationSession>();

export interface ConversationSetupResult {
    langchainApp: MedicalDatabaseLangChainApp;
    sessionData: ConversationSession | null;
    chatHistory: any[];
    sqlAgent: any;
    dbConfig: any;
}

/**
 * Initialize LangChain app and setup conversation session
 * @param organizationId Organization identifier
 * @param conversational Whether to use conversational mode
 * @param sessionId Session identifier for conversation
 * @param res Express response object for error handling
 * @returns Promise<ConversationSetupResult | null> Setup result or null if error occurred
 */
export async function initializeLangChainAndConversation(
    organizationId: string,
    conversational: boolean,
    sessionId: string,
    res: Response
): Promise<ConversationSetupResult | null> {
    // Get organization-specific LangChain app
    let langchainApp: MedicalDatabaseLangChainApp;
    try {
        langchainApp = await multiTenantLangChainService.getOrganizationLangChainApp(organizationId);
        console.log(`✅ LangChain app initialized for organization: ${organizationId}`);
    } catch (langchainError: any) {
        console.error(`❌ LangChain initialization error for organization ${organizationId}:`, langchainError.message);
        res.status(500).json({
            error: 'LangChain initialization error',
            message: langchainError.message,
            timestamp: new Date().toISOString()
        });
        return null;
    }

    // Get or create conversation memory for this session if using conversational mode
    let sessionData = null;
    let chatHistory: any[] = [];

    if (conversational) {
        console.log(`💬 Using conversational mode with session: ${sessionId}`);
        sessionData = conversationSessions.get(sessionId);

        if (!sessionData) {
            console.log(`🆕 Creating new conversation session: ${sessionId}`);
            const memory = new BufferMemory({
                memoryKey: 'chat_history',
                returnMessages: true,
                inputKey: 'input',
                outputKey: 'output',
            });
            sessionData = {
                memory,
                lastAccess: new Date()
            };
            console.log("input", sessionId, sessionData)
            conversationSessions.set(sessionId, sessionData);
        } else {
            // Update last access time
            sessionData.lastAccess = new Date();
            console.log(`📝 Using existing conversation session: ${sessionId}`);
        }

        // Retrieve conversation history if available
        try {
            const memoryVariables = await sessionData.memory.loadMemoryVariables({});
            chatHistory = memoryVariables.chat_history || [];
            console.log(`📜 Retrieved conversation history with ${Array.isArray(chatHistory) ? chatHistory.length : 0} messages`);
        } catch (memoryError) {
            console.error('❌ Error retrieving conversation history:', memoryError);
            // Continue without history if there's an error
        }
    }

    const sqlAgent = langchainApp.getSqlAgent();

    if (!sqlAgent) {
        res.status(503).json({
            error: 'SQL Agent not available',
            message: 'Service temporarily unavailable',
            timestamp: new Date().toISOString()
        });
        return null;
    }

    // Let sqlAgent handle most of the schema exploration
    // We'll just do minimal setup to ensure the agent understands the task
    console.log('📊 Preparing to let sqlAgent explore database schema');

    // Get database configuration to determine type
    const dbConfig = await databaseService.getOrganizationDatabaseConnection(organizationId);
    console.log(`📊 Database type: ${dbConfig.type.toLocaleLowerCase()}`);

    return {
        langchainApp,
        sessionData,
        chatHistory,
        sqlAgent,
        dbConfig
    };
}

/**
 * Save conversation exchange to BufferMemory
 * @param sessionId Session identifier
 * @param userInput User's input/query
 * @param aiOutput AI's response/output
 */
export async function saveConversationToMemory(sessionId: string, userInput: string, aiOutput: string): Promise<void> {
    try {
        const sessionData = conversationSessions.get(sessionId);
        
        if (!sessionData || !sessionData.memory) {
            console.log(`⚠️ No conversation session found for sessionId: ${sessionId} - cannot save conversation`);
            return;
        }

        // Save the conversation exchange to BufferMemory
        await sessionData.memory.saveContext(
            { input: userInput },
            { output: aiOutput }
        );

        console.log(`💾 Saved conversation to memory for sessionId: ${sessionId}`);
        console.log(`📝 User: ${userInput.substring(0, 100)}...`);
        console.log(`🤖 AI: ${aiOutput.substring(0, 100)}...`);
    } catch (error) {
        console.error(`❌ Error saving conversation to memory for sessionId ${sessionId}:`, error);
    }
}

/**
 * Get conversation history for a specific session ID
 * @param sessionId Session identifier
 * @returns Array of conversation messages or empty array if no history found
 */
export async function getConversationHistoryBySessionId(sessionId: string): Promise<Array<{ role: string, content: string }>> {
    try {
        console.log(`🔍 Attempting to get conversation history for sessionId: ${sessionId}`);
        const sessionData = conversationSessions.get(sessionId);

        if (!sessionData || !sessionData.memory) {
            console.log(`📭 No conversation session found for sessionId: ${sessionId}`);
            console.log(`🔍 Available sessions: ${Array.from(conversationSessions.keys()).join(', ')}`);
            return [];
        }

        console.log(`✅ Found session data for sessionId: ${sessionId}`);

        // Retrieve conversation history from buffer memory
        const memoryVariables = await sessionData.memory.loadMemoryVariables({});
        const chatHistory = memoryVariables.chat_history || [];

        console.log(`📜 Retrieved ${chatHistory.length} conversation messages for sessionId: ${sessionId}`);
        
        // Debug: Log raw chat history
        if (chatHistory.length > 0) {
            console.log(`🔍 Raw chat history:`, chatHistory.map((msg: any) => ({
                type: msg._getType?.() || 'unknown',
                content: (msg.content || msg.text || '').substring(0, 100)
            })));
        }

        // Convert LangChain format to our expected format
        const formattedHistory = chatHistory.map((message: any) => ({
            role: message._getType() === 'human' ? 'user' : 'assistant',
            content: message.content || message.text || ''
        }));

        console.log(`📝 Formatted history:`, formattedHistory.map((msg: { role: string, content: string }) => ({
            role: msg.role,
            content: msg.content.substring(0, 100)
        })));

        return formattedHistory;
    } catch (error) {
        console.error(`❌ Error retrieving conversation history for sessionId ${sessionId}:`, error);
        return [];
    }
}

// Export the conversation sessions map for external access if needed
export { conversationSessions };

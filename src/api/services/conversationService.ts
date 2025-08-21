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

// Export the conversation sessions map for external access if needed
export { conversationSessions };

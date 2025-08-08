import { AzureOpenAI } from 'openai';
import { ConversationSession } from '../interfaces/medical';

export const conversationSessions = new Map<string, ConversationSession>();

// Initialize Azure OpenAI client only if API key is available
let azureOpenAI: AzureOpenAI | null = null;
export const isAzureOpenAIAvailable = !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);

// Function to get Azure OpenAI client lazily
export function getAzureOpenAIClient(): AzureOpenAI | null {
    if (!isAzureOpenAIAvailable) {
        return null;
    }

    if (!azureOpenAI) {
        azureOpenAI = new AzureOpenAI({
            apiKey: process.env.AZURE_OPENAI_API_KEY,
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
        });
    }

    return azureOpenAI;
}

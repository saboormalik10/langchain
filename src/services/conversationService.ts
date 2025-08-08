import { ConversationSession } from '../interfaces/medical';
import { conversationSessions } from '../config/azure';

// Cleanup function for expired conversations (runs every hour)
const CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

export function initializeConversationCleanup() {
    setInterval(() => {
        const now = new Date();
        let expiredCount = 0;

        conversationSessions.forEach((session, sessionId) => {
            const timeDiff = now.getTime() - session.lastAccess.getTime();
            if (timeDiff > CONVERSATION_TIMEOUT_MS) {
                conversationSessions.delete(sessionId);
                expiredCount++;
            }
        });

        if (expiredCount > 0) {
            console.log(`🧹 Cleaned up ${expiredCount} expired conversation sessions`);
        }
    }, 60 * 60 * 1000); // Check every hour
}

export function getConversationSession(sessionId: string): ConversationSession | undefined {
    return conversationSessions.get(sessionId);
}

export function setConversationSession(sessionId: string, session: ConversationSession): void {
    conversationSessions.set(sessionId, session);
}

export function hasConversationSession(sessionId: string): boolean {
    return conversationSessions.has(sessionId);
}

export function updateSessionAccess(sessionId: string): void {
    const session = conversationSessions.get(sessionId);
    if (session) {
        session.lastAccess = new Date();
    }
}

import { GraphType, MedicalDataCategory } from '../types/graph';
import { BufferMemory } from 'langchain/memory';

// Graph Configuration Interface
export interface GraphConfig {
    type: GraphType;
    category?: MedicalDataCategory;
    xAxis?: string;
    yAxis?: string;
    colorBy?: string;
    sizeBy?: string;
    groupBy?: string;
    sortBy?: string;
    limit?: number;
    aggregation?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';
    timeFormat?: string;
    showTrends?: boolean;
    showOutliers?: boolean;
    includeNulls?: boolean;
    customColors?: string[];
    title?: string;
    subtitle?: string;
    description?: string;
}

// Graph Data Interface
export interface GraphData {
    type: GraphType;
    data: any[];
    config: GraphConfig;
    metadata: {
        totalRecords: number;
        processedAt: string;
        dataQuality: {
            completeness: number;
            accuracy: number;
            consistency: number;
        };
        insights: string[];
        recommendations: string[];
    };
}

export interface ConversationSession {
    memory: BufferMemory;
    lastAccess: Date;
    // Schema caching
    cachedSchema?: string;
    schemaLastUpdated?: Date;
    // For multi-agent system
    secondaryMemory?: BufferMemory;
    // For advanced analytics
    toolUsage?: Record<string, number>;
    queryHistory?: Array<{ query: string, success: boolean, executionTime: number }>;
    // For advanced conversation
    ambiguityResolutions?: Record<string, string>;
    userPreferences?: Record<string, any>;
    // For autocomplete
    frequentColumns?: string[];
    frequentTables?: string[];
    recentQueries?: string[];
}

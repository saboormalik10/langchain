import { Response } from "express";
import databaseService from "../../services/databaseService";
import { getAzureOpenAIClient } from "../routes/medical";

// Global variables for table sample data
let globalTableSampleData: any = {};



export interface TableAnalysisResult {
    tableDescriptions: string;
    tableSampleData?: { [table: string]: any[] };
    success: boolean;
    error?: string;
}

/**
 * Get comprehensive database table analysis with AI-generated descriptions
 * @param organizationId Organization identifier
 * @param databaseType Database type (mysql, postgresql, etc.)
 * @param query User query for context-aware analysis
 * @param conversationHistory Array of previous conversation queries for context-aware relevance assessment
 * @returns Promise<TableAnalysisResult> Table analysis result
 */
export async function getTableDescriptionsWithAI(
    organizationId: string,
    databaseType: string,
    query: string,
    conversationHistory: string[] = []
): Promise<TableAnalysisResult> {
    let tableDescriptions = '';

    try {
        console.log('🔍 Getting all database tables and columns for AI analysis...');

        // Use the provided conversation history directly
        console.log(`📜 Using provided conversation history with ${conversationHistory.length} previous queries`);

        // Reset global sample data for fresh collection
        globalTableSampleData = {};

        // Use cached schema instead of direct database calls - PERFORMANCE IMPROVEMENT
        console.log('🚀 Using cached database schema for faster performance...');
        const schemaCache = await databaseService.getOrganizationSchema(organizationId);
        const allTables = schemaCache.tables;
        console.log(`📊 Found ${allTables.length} tables from cache:`, allTables);

        if (allTables.length > 0) {
            const tableSchemaData: any = {};

            // Use cached schema information - MAJOR PERFORMANCE IMPROVEMENT
            console.log(`� Using cached schema for ${allTables.length} tables - no database connections needed!`);

            for (const tableName of allTables) {
                try {
                    // Get column information from cache instead of database
                    const columns = schemaCache.tableColumns[tableName] || [];

                    // Convert cached column names to expected format for AI processing
                    const columnInfo = columns.map(columnName => ({
                        COLUMN_NAME: columnName,
                        DATA_TYPE: 'cached', // Type info could be enhanced in future
                        IS_NULLABLE: 'YES',
                        COLUMN_DEFAULT: null,
                        COLUMN_COMMENT: ''
                    }));

                    tableSchemaData[tableName] = columnInfo;
                    console.log(`✅ Used cached schema for table ${tableName}: ${columnInfo.length} columns`);
                } catch (schemaError) {
                    console.warn(`⚠️ Could not get cached schema for table ${tableName}:`, schemaError);
                    tableSchemaData[tableName] = [];
                }
            }

            // Get sample data using cache where possible - PERFORMANCE OPTIMIZATION
            console.log(`� Fetching sample data for ${allTables.length} tables using cache optimization...`);

            // Create array of sample data fetch promises with cache fallback
            const sampleDataPromises = allTables.map(async (tableName) => {
                try {
                    // Try to get cached sample data first
                    const cachedSamples = await databaseService.getTableSampleData(organizationId, tableName);
                    globalTableSampleData[tableName] = Array.isArray(cachedSamples) ? cachedSamples.slice(0, 3) : [];
                    console.log(`✅ Got sample data for table ${tableName}: ${globalTableSampleData[tableName].length} records (cached: ${cachedSamples.length > 0})`);
                    return { tableName, success: true };
                } catch (sampleError) {
                    console.warn(`⚠️ Could not get sample data for table ${tableName}:`, sampleError);
                    globalTableSampleData[tableName] = [];
                    return { tableName, success: false, error: (sampleError as any)?.message || 'Unknown error' };
                }
            });

            // Execute all sample data fetching in parallel
            try {
                const sampleResults = await Promise.all(sampleDataPromises);
                const successCount = sampleResults.filter(r => r.success).length;
                console.log(`🎯 Sample data collection completed: ${successCount}/${allTables.length} tables successful`);
            } catch (parallelError) {
                console.error('❌ Error during parallel sample data fetching:', parallelError);
            }

            // Generate AI descriptions for all tables
            const azureClient = getAzureOpenAIClient();
            if (azureClient && azureClient.chat) {
                console.log('🤖 Generating AI purpose descriptions for database tables...');
                try {
                    const schemaDescription = Object.entries(tableSchemaData)
                        .map(([tableName, columns]: [string, any]) => {
                            const columnList = Array.isArray(columns) ?
                                columns.map((col: any) => `${col.COLUMN_NAME} (${col.DATA_TYPE})`).join(', ') :
                                'No columns available';

                            const sampleData = globalTableSampleData[tableName] || [];
                            const sampleDataStr = sampleData.length > 0 ?
                                `\nSample Data (first ${sampleData.length} records):\n${JSON.stringify(sampleData, null, 2)}` :
                                '\nNo sample data available';

                            return `Table: ${tableName}\nColumns: ${columnList}${sampleDataStr}`;
                        })
                        .join('\n\n');

                    const aiPrompt = `You are a database schema analyst helping an SQL agent choose the correct tables for a specific query. 

Current User Query: "${query}"

${conversationHistory.length > 0 ? `Conversation History (Previous context):
${conversationHistory.map((query, index) => `${index + 1}. User: ${query}`).join('\n')}

🔍 **CRITICAL CONVERSATION CONTEXT ANALYSIS:**

**STEP 1: Analyze Current Query in Context**
- Is the current query "${query}" a follow-up to previous questions?
- Does it contain pronouns (it, them, that), numbers (1, 5, first, etc.), or vague references that rely on previous context?
- Does it reference previous results (e.g., "show me 1" after asking for "all patients")?

**STEP 2: Identify Context Dependencies**
- If current query is vague/contextual: Which entities from previous questions is it referring to?
- If current query is completely new: Treat as independent query
- Examples of contextual queries: "show me 1", "get the first one", "what about medications", "now give me details"
- Examples of independent queries: "show me all doctors", "what medications exist"

**STEP 3: Context-Aware Relevance Assignment**
- **CONTEXTUAL QUERY**: If current query depends on previous context, prioritize tables from previous relevant queries
- **INDEPENDENT QUERY**: If current query is self-contained, ignore conversation history for relevance

**EXAMPLE SCENARIO:**
Previous: "Give me all patients" → Current: "Now give me 1"
Analysis: "1" refers to 1 patient from previous context
Result: patients table = HIGH, unrelated tables = LOW

` : 'No previous conversation history available - analyze query in isolation.'}

Database Tables with Schema and Sample Data:
${schemaDescription}

🎯 **SMART RELEVANCE ASSIGNMENT RULES:**

${conversationHistory.length > 0 ? `
**FOR CONTEXTUAL/FOLLOW-UP QUERIES:**
- **HIGH**: Tables that were relevant in recent conversation AND match current contextual reference
- **MEDIUM**: Tables that might provide additional context for the follow-up
- **LOW**: Tables completely unrelated to conversation thread

**FOR INDEPENDENT/NEW TOPIC QUERIES:**
- **HIGH**: Tables directly needed for current query (ignore conversation history)
- **MEDIUM**: Tables that might provide supporting information for current query
- **LOW**: Tables unlikely to be useful for current query

**DECISION PROCESS:**
1. First determine: Is "${query}" contextual (referring to previous conversation) or independent?
2. If contextual: What entity/table from previous questions does it reference?
3. If independent: What tables does current query actually need?
4. Assign relevance based on the analysis above
` : `
**FOR INDEPENDENT QUERIES:**
- **HIGH**: Tables directly needed for current query
- **MEDIUM**: Tables that might provide supporting information
- **LOW**: Tables unlikely to be useful for current query
`}

**CRITICAL: Do NOT default all tables to HIGH relevance. Analyze the actual query context and be selective.**

Provide descriptions in this format:
**Table: table_name** - Relevance: **[HIGH/MEDIUM/LOW]** ${conversationHistory.length > 0 ? '(Context: [CONTEXTUAL/INDEPENDENT])' : ''} - Brief description explaining your relevance decision based on${conversationHistory.length > 0 ? ' conversation analysis and' : ''} actual query needs.

Keep descriptions concise (1-2 sentences) and focus on WHY each table got its relevance level based on the specific query context.`;
                    console.log({ aiPrompt });
                    const aiResponse = await azureClient.chat.completions.create({
                        model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1",
                        messages: [{
                            role: "user",
                            content: aiPrompt
                        }],
                        max_tokens: 2000,
                        temperature: 0.3,
                    });

                    if (aiResponse.choices && aiResponse.choices[0]?.message?.content) {
                        tableDescriptions = `

=== DATABASE TABLE PURPOSE DESCRIPTIONS (AI-Generated with Sample Data Analysis) ===
${aiResponse.choices[0].message.content}

This database contains ${allTables.length} tables with comprehensive schema and sample data analysis:
${Object.entries(tableSchemaData).map(([tableName, columns]: [string, any]) => {
                            const columnCount = Array.isArray(columns) ? columns.length : 0;
                            const sampleRecordCount = globalTableSampleData[tableName] ? globalTableSampleData[tableName].length : 0;
                            return `• ${tableName} (${columnCount} columns, ${sampleRecordCount} sample records analyzed)`;
                        }).join('\n')}
========================`;
                        console.log('✅ Successfully generated AI table descriptions', tableDescriptions);
                    } else {
                        console.warn('⚠️ Azure OpenAI returned empty response for table descriptions');
                    }
                } catch (aiError) {
                    console.warn('⚠️ Could not generate AI descriptions for tables:', aiError);
                    // Fallback: create basic descriptions without AI
                    tableDescriptions = `

=== DATABASE TABLES OVERVIEW WITH SAMPLE DATA ===
This database contains ${allTables.length} tables:
${Object.entries(tableSchemaData).map(([tableName, columns]: [string, any]) => {
                        const columnCount = Array.isArray(columns) ? columns.length : 0;
                        const sampleColumns = Array.isArray(columns) && columns.length > 0
                            ? columns.slice(0, 5).map((col: any) => col.COLUMN_NAME).join(', ')
                            : 'No columns available';

                        const sampleData = globalTableSampleData[tableName] || [];
                        const sampleDataPreview = sampleData.length > 0
                            ? `\n  Sample Data (${sampleData.length} records): ${JSON.stringify(sampleData.slice(0, 2), null, 2)}`
                            : '\n  No sample data available';

                        return `• **${tableName}** (${columnCount} columns) - Contains: ${sampleColumns}${columns.length > 5 ? ', ...' : ''}${sampleDataPreview}`;
                    }).join('\n')}
========================`;
                }
            } else {
                console.warn('⚠️ Azure OpenAI not available, creating basic table overview');
                // Fallback: create basic descriptions without AI
                tableDescriptions = `

=== DATABASE TABLES OVERVIEW WITH SAMPLE DATA ===
This database contains ${allTables.length} tables:
${Object.entries(tableSchemaData).map(([tableName, columns]: [string, any]) => {
                    const columnCount = Array.isArray(columns) ? columns.length : 0;
                    const sampleColumns = Array.isArray(columns) && columns.length > 0
                        ? columns.slice(0, 5).map((col: any) => col.COLUMN_NAME).join(', ')
                        : 'No columns available';

                    const sampleData = globalTableSampleData[tableName] || [];
                    const sampleDataPreview = sampleData.length > 0
                        ? `\n  Sample Data (${sampleData.length} records): ${JSON.stringify(sampleData.slice(0, 2), null, 2)}`
                        : '\n  No sample data available';

                    return `• **${tableName}** (${columnCount} columns) - Contains: ${sampleColumns}${columns.length > 5 ? ', ...' : ''}${sampleDataPreview}`;
                }).join('\n')}
========================`;
            }
        } else {
            tableDescriptions = '\n=== DATABASE TABLES ===\nNo tables found in the database.\n========================';
            globalTableSampleData = {}; // Ensure it's empty when no tables exist
        }

        console.log('🔍 Final globalTableSampleData status:', {
            tableCount: Object.keys(globalTableSampleData).length,
            tables: Object.keys(globalTableSampleData),
            recordCounts: Object.entries(globalTableSampleData).map(([table, data]) =>
                `${table}: ${Array.isArray(data) ? data.length : 'unknown'} records`)
        });

        return {
            tableDescriptions,
            tableSampleData: globalTableSampleData,
            success: true
        };

    } catch (tableError) {
        console.error('❌ Error getting table descriptions:', tableError);
        return {
            tableDescriptions: '\n=== DATABASE TABLES ===\nError retrieving table information.\n========================',
            tableSampleData: {},
            success: false,
            error: (tableError as any)?.message || 'Unknown error'
        };
    }
}

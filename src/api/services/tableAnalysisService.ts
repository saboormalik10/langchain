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
 * @returns Promise<TableAnalysisResult> Table analysis result
 */
export async function getTableDescriptionsWithAI(
    organizationId: string,
    databaseType: string,
    query: string
): Promise<TableAnalysisResult> {
    let tableDescriptions = '';
    
    try {
        console.log('🔍 Getting all database tables and columns for AI analysis...');

        // Reset global sample data for fresh collection
        globalTableSampleData = {};

        // Get all tables for this organization
        const allTables = await databaseService.getOrganizationTables(organizationId);
        console.log(`📊 Found ${allTables.length} tables:`, allTables);

        if (allTables.length > 0) {
            const tableSchemaData: any = {};
            // Use the global tableSampleData instead of local declaration

            // Get schema for each table using single connection
            console.log(`🔄 Fetching schema for ${allTables.length} tables using single connection...`);
            let schemaConnection: any = null;

            try {
                // Create one shared connection for all schema fetching
                if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                    schemaConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                } else if (databaseType.toLowerCase() === 'postgresql') {
                    schemaConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                }

                for (const tableName of allTables) {
                    try {
                        let columnInfo: any[] = [];

                        if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                            const [rows] = await schemaConnection.execute(
                                `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT 
                             FROM INFORMATION_SCHEMA.COLUMNS 
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? 
                             ORDER BY ORDINAL_POSITION`,
                                [tableName]
                            );
                            columnInfo = rows as any[];
                        } else if (databaseType.toLowerCase() === 'postgresql') {
                            const result = await schemaConnection.query(
                                `SELECT column_name as "COLUMN_NAME", data_type as "DATA_TYPE", is_nullable as "IS_NULLABLE", column_default as "COLUMN_DEFAULT", '' as "COLUMN_COMMENT"
                             FROM information_schema.columns 
                             WHERE table_schema = 'public' AND table_name = $1 
                             ORDER BY ordinal_position`,
                                [tableName]
                            );
                            columnInfo = result.rows;
                        }

                        tableSchemaData[tableName] = Array.isArray(columnInfo) ? columnInfo : [];
                        console.log(`✅ Got schema for table ${tableName}: ${tableSchemaData[tableName].length} columns`);
                    } catch (schemaError) {
                        console.warn(`⚠️ Could not get schema for table ${tableName}:`, schemaError);
                        tableSchemaData[tableName] = [];
                    }
                }
            } finally {
                // Close the shared schema connection
                if (schemaConnection) {
                    try {
                        if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                            await schemaConnection.end();
                        } else if (databaseType.toLowerCase() === 'postgresql') {
                            await schemaConnection.end();
                        }
                        console.log('🔌 Closed shared schema connection');
                    } catch (closeError) {
                        console.warn('⚠️ Error closing shared schema connection:', closeError);
                    }
                }
            }

            // Get sample data (first 3 records) for each table using Promise.all for parallel execution
            console.log(`🔄 Fetching sample data for ${allTables.length} tables in parallel...`);

            // Create array of sample data fetch promises
            const sampleDataPromises = allTables.map(async (tableName) => {
                try {
                    let sampleRecords: any[] = [];
                    let tableConnection: any = null;

                    try {
                        // Create individual connection for this table (for parallel execution)
                        if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                            tableConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                            const [rows] = await tableConnection.execute(
                                `SELECT * FROM \`${tableName}\` LIMIT 3`
                            );
                            sampleRecords = rows as any[];
                        } else if (databaseType.toLowerCase() === 'postgresql') {
                            tableConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                            const result = await tableConnection.query(
                                `SELECT * FROM "${tableName}" LIMIT 3`
                            );
                            sampleRecords = result.rows;
                        }

                        globalTableSampleData[tableName] = Array.isArray(sampleRecords) ? sampleRecords : [];
                        console.log(`✅ Got sample data for table ${tableName}: ${globalTableSampleData[tableName].length} records`);

                        return { tableName, success: true };
                    } finally {
                        // Clean up individual connection
                        if (tableConnection) {
                            try {
                                if (databaseType.toLowerCase() === 'mysql' || databaseType.toLowerCase() === 'mariadb') {
                                    await tableConnection.end();
                                } else if (databaseType.toLowerCase() === 'postgresql') {
                                    await tableConnection.end();
                                }
                            } catch (closeError) {
                                console.warn(`⚠️ Error closing connection for table ${tableName}:`, closeError);
                            }
                        }
                    }
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

User Query: "${query}"

Database Tables with Schema and Sample Data:
${schemaDescription}

Based on the user's specific query "${query}", analyze each table's schema AND sample data to provide targeted descriptions that help the SQL agent understand which tables are most relevant for this specific query. 

Focus on:
1. Which tables likely contain the data needed for this specific query (analyze both column names and sample data values)
2. Which tables should be prioritized for this type of question based on the actual data content
3. Which tables might be confused with each other and clarify the differences using sample data examples
4. What patterns you see in the sample data that indicate the table's purpose
5. How the sample data values relate to the user's query requirements

Provide descriptions in this format:
**Table: table_name** - Relevance to query "${query}": [High/Medium/Low] - Brief description focusing on why this table is/isn't suitable for this specific query, mentioning key columns and sample data insights that support your assessment.

Keep descriptions concise but informative (2-3 sentences) and focus on helping the SQL agent choose the RIGHT tables for this specific user query using both schema structure and actual data content.`;

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

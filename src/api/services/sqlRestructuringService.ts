import databaseService from "../../services/databaseService";
// import { generateBarChartAnalysis } from "../prompts/queryPropmt";

/**
 * SQL Restructuring and Analysis Service
 * Handles SQL restructuring with Azure OpenAI and bar chart analysis
 */

interface SqlRestructuringParams {
    isAzureOpenAIAvailable: boolean;
    rows: any[];
    finalSQL: string;
    query: string;
    organizationId: string;
    mySQLVersionString: string;
    mysqlVersionInfo: any;
    sqlAgent: any;
    globalTableSampleData: any;
    dbConfig: any;
    connection: any;
    response: any;
    parseRows: (rows: any[]) => any[];
    groupAndCleanData: (data: any[]) => any;
    generateRestructuredSQL: any;
    extractColumnErrorDetails: (message: string) => any;
}

interface SqlRestructuringResult {
    success: boolean;
    connection: any;
    response: any;
    errorMessage?: string;
}

/**
 * Handles SQL restructuring with Azure OpenAI and bar chart analysis
 * @param params SQL restructuring parameters
 * @returns SQL restructuring result
 */
export async function handleSqlRestructuringAndAnalysis(
    params: SqlRestructuringParams
): Promise<SqlRestructuringResult> {
    const {
        isAzureOpenAIAvailable,
        rows,
        finalSQL,
        query,
        organizationId,
        mySQLVersionString,
        mysqlVersionInfo,
        sqlAgent,
        globalTableSampleData,
        dbConfig,
        connection,
        response,
        parseRows,
        groupAndCleanData,
        generateRestructuredSQL,
        extractColumnErrorDetails
    } = params;

    let workingConnection = connection;

    // ========== STEP: GENERATE RESTRUCTURED SQL WITH AZURE OPENAI ==========
    console.log('🤖 Step: Generating restructured SQL with Azure OpenAI for better data organization...');

    let restructuredResults = null;
    let restructuredRetryCount = 0;
    const maxRestructuredRetries = 2;

    while (restructuredRetryCount < maxRestructuredRetries) {
        try {
            restructuredRetryCount++;
            if (restructuredRetryCount > 1) {
                console.log(`🔄 Restructured SQL retry attempt ${restructuredRetryCount} of ${maxRestructuredRetries} (will keep trying until successful)...`);
            } else {
                console.log(`🔄 Restructured SQL first attempt (1 of ${maxRestructuredRetries})...`);
            }

            // Check if Azure OpenAI is available
            if (!isAzureOpenAIAvailable) {
                console.log('⚠️ Azure OpenAI API key not available, skipping restructuring');
                (response.sql_results as any).restructure_info = {
                    success: false,
                    message: 'Azure OpenAI API key not configured',
                    skipped: true
                };
                break;
            }
            // Only restructure if we have actual data and it's an array with records
            else if (Array.isArray(rows) && rows.length > 0) {
                console.log(`🔄 Generating restructured SQL query for ${rows.length} records using Azure OpenAI...`);

                // Prepare comprehensive version information for Azure OpenAI
                let detailedVersionInfo = mySQLVersionString || 'unknown';
                if (mysqlVersionInfo) {
                    detailedVersionInfo = `${mysqlVersionInfo.full} (${mysqlVersionInfo.major}.${mysqlVersionInfo.minor}.${mysqlVersionInfo.patch}) - JSON:${mysqlVersionInfo.supportsJSON}, CTE:${mysqlVersionInfo.supportsCTE}, Windows:${mysqlVersionInfo.supportsWindowFunctions}`;
                }

                restructuredResults = await generateRestructuredSQL(
                    finalSQL, // originalSQL
                    rows, // sqlResults  
                    query, // userPrompt
                    dbConfig.type.toLocaleLowerCase(), // dbType
                    detailedVersionInfo, // dbVersion - Enhanced version information with feature support
                    3, // sampleSize - Sample size for OpenAI analysis
                    sqlAgent, // sqlAgent
                    organizationId, // organizationId
                    globalTableSampleData // tableSampleData - Pre-fetched sample data
                );

                console.log('✅ SQL restructuring completed');

                // If we successfully generated a restructured SQL, execute it
                if (restructuredResults && restructuredResults.restructure_success && restructuredResults.restructured_sql) {
                    try {
                        console.log('🔄 Executing restructured SQL query...');
                        console.log('🔧 Restructured SQL:', restructuredResults.restructured_sql);

                        // Check if connection is still valid, create new one if needed
                        if (!workingConnection ||
                            (workingConnection.state && workingConnection.state === 'disconnected') ||
                            (workingConnection.destroyed !== undefined && workingConnection.destroyed) ||
                            (workingConnection._fatalError !== undefined)) {
                            console.log('🔄 Recreating database connection for restructured SQL...');
                            if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                                workingConnection = await databaseService.createOrganizationMySQLConnection(organizationId);
                            } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                                workingConnection = await databaseService.createOrganizationPostgreSQLConnection(organizationId);
                            }
                            console.log('✅ Database connection recreated successfully');
                        } else {
                            console.log('✅ Using existing database connection for restructured SQL');
                        }

                        let restructuredRows: any[] = [];
                        let restructuredFields: any = null;

                        // Execute the restructured SQL query
                        if (dbConfig.type.toLocaleLowerCase() === 'mysql') {
                            const [mysqlRows, mysqlFields] = await workingConnection.execute(restructuredResults.restructured_sql);
                            restructuredRows = mysqlRows;
                            restructuredFields = mysqlFields;
                        } else if (dbConfig.type.toLocaleLowerCase() === 'postgresql') {
                            const result = await workingConnection.query(restructuredResults.restructured_sql);
                            restructuredRows = result.rows;
                            restructuredFields = result.fields;
                        }

                        console.log(`✅ Restructured query executed successfully, returned ${Array.isArray(restructuredRows) ? restructuredRows.length : 0} structured rows`);

                        // Add restructured data to sql_results
                        (response.sql_results as any).sql_final = groupAndCleanData(parseRows(restructuredRows));
                        (response.sql_results as any).restructure_info = {
                            success: true,
                            message: "Successfully executed restructured SQL query",
                            restructured_sql: restructuredResults.restructured_sql,
                            explanation: restructuredResults.explanation,
                            grouping_logic: restructuredResults.grouping_logic,
                            expected_structure: restructuredResults.expected_structure,
                            main_entity: restructuredResults.main_entity,
                            original_record_count: rows.length,
                            restructured_record_count: Array.isArray(restructuredRows) ? restructuredRows.length : 0,
                            sample_size_used: 3,
                            database_type: dbConfig.type.toLocaleLowerCase(),
                            retry_count: restructuredRetryCount - 1
                        };
                        console.log('✅ Enhanced response with restructured SQL results');

                    } catch (restructuredSQLError: any) {
                        console.error('❌ Error executing restructured SQL:', restructuredSQLError.message);

                        // Check if this is a column-related error
                        const isColumnError = restructuredSQLError.message.toLowerCase().includes('unknown column') ||
                            (restructuredSQLError.message.toLowerCase().includes('column') && restructuredSQLError.message.toLowerCase().includes('doesn\'t exist')) ||
                            restructuredSQLError.message.toLowerCase().includes('no such column') ||
                            restructuredSQLError.message.toLowerCase().includes('invalid column name') ||
                            restructuredSQLError.message.toLowerCase().includes('field list');

                        const maxAttemptsForThisError = maxRestructuredRetries;

                        if (restructuredRetryCount >= maxAttemptsForThisError) {
                            console.log(`❌ Final attempt failed after ${maxAttemptsForThisError} attempts for restructured SQL execution (${isColumnError ? 'COLUMN ERROR' : 'GENERAL ERROR'})`);

                            (response.sql_results as any).restructure_info = {
                                success: false,
                                message: `Restructured SQL execution failed after ${maxAttemptsForThisError} attempts: ${restructuredSQLError.message}`,
                                restructured_sql: restructuredResults.restructured_sql,
                                explanation: restructuredResults.explanation,
                                sql_error: restructuredSQLError.message,
                                database_type: dbConfig.type.toLocaleLowerCase(),
                                retry_count: restructuredRetryCount - 1,
                                retry_exhausted: true,
                                error_type: isColumnError ? 'column_error' : 'general_error',
                                column_error_details: isColumnError ? extractColumnErrorDetails(restructuredSQLError.message) : undefined
                            };
                            console.log('⚠️ Restructured SQL execution failed after retries, keeping original data');
                            break;
                        } else {
                            console.log(`⚠️ Restructured SQL execution failed on attempt ${restructuredRetryCount} (${isColumnError ? 'COLUMN ERROR - will regenerate entire query' : 'SQL ERROR - will regenerate entire query'}), retrying whole flow...`);

                            if (isColumnError) {
                                const columnErrorDetails = extractColumnErrorDetails(restructuredSQLError.message);
                                console.log(`🔍 Column Error Details:`, columnErrorDetails);
                                console.log('📋 Will regenerate entire restructured query with stricter column validation...');

                                const availableTables = Object.keys(globalTableSampleData);
                                console.log(`📊 Available sample data tables: ${availableTables.join(', ')}`);

                                if (columnErrorDetails.column_name) {
                                    console.log(`❌ Problematic column: ${columnErrorDetails.column_name}`);
                                    if (columnErrorDetails.table_alias) {
                                        console.log(`❌ Used table alias: ${columnErrorDetails.table_alias}`);
                                    }
                                }
                            }

                            console.log('⏳ Waiting 5 seconds before retry...');
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            continue;
                        }
                    }
                    break;
                } else {
                    console.log(`⚠️ Restructured SQL generation failed on attempt ${restructuredRetryCount}`);

                    if (restructuredRetryCount >= maxRestructuredRetries) {
                        console.log('❌ Final attempt failed, no more retries for restructured SQL generation');

                        (response.sql_results as any).restructure_info = {
                            success: false,
                            message: `Restructured SQL generation failed after ${maxRestructuredRetries} attempts: ${restructuredResults?.restructure_message || 'Unknown error'}`,
                            error_details: restructuredResults?.error_details,
                            explanation: restructuredResults?.explanation,
                            database_type: dbConfig.type.toLocaleLowerCase(),
                            retry_count: restructuredRetryCount - 1,
                            retry_exhausted: true
                        };
                        console.log('⚠️ Restructured SQL generation failed after retries, keeping original data');
                        break;
                    } else {
                        console.log(`⚠️ Restructured SQL generation failed on attempt ${restructuredRetryCount}, retrying whole generation flow...`);
                        console.log('⏳ Waiting 5 seconds before retry...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }
                }
            } else {
                (response.sql_results as any).restructure_info = {
                    success: false,
                    message: 'No data available for restructuring',
                    skipped: true,
                    database_type: dbConfig.type.toLocaleLowerCase()
                };
                console.log('⚠️ Skipping restructuring - no data available');
                break;
            }
            break;

        } catch (restructureError: any) {
            console.error(`❌ Error during SQL results restructuring (attempt ${restructuredRetryCount}):`, restructureError.message);

            if (restructuredRetryCount >= maxRestructuredRetries) {
                console.log(`❌ Final attempt failed after ${maxRestructuredRetries} attempts for restructuring process`);

                (response.sql_results as any).restructure_info = {
                    success: false,
                    message: `Restructuring process failed after ${maxRestructuredRetries} attempts: ${restructureError.message}`,
                    error_details: restructureError.message,
                    database_type: dbConfig.type.toLocaleLowerCase(),
                    retry_count: restructuredRetryCount - 1,
                    retry_exhausted: true
                };
                break;
            } else {
                console.log(`⚠️ Restructuring process failed on attempt ${restructuredRetryCount}, retrying entire restructure flow...`);
                console.log('⏳ Waiting 5 seconds before retry...');
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
        }
    }

    // ========== BAR CHART ANALYSIS LAYER ==========
    console.log('📊 Step 5: Adding bar chart analysis layer...');


    return {
        success: true,
        connection: workingConnection,
        response
    };
}

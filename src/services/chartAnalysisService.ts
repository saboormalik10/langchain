import { getAzureOpenAIClient } from '../config/azure';

/**
 * Generate bar chart analysis using Azure OpenAI
 * 
 * This function takes the structured query and user prompt to analyze data for bar chart creation.
 * It provides comprehensive parameters needed for creating meaningful bar charts.
 * 
 * @param structuredQuery - The SQL query that was executed
 * @param userPrompt - The original user query/prompt
 * @param sqlResults - The results from SQL execution for analysis
 * @param organizationId - The organization identifier
 * @returns Promise with bar chart analysis and parameters
 */
export async function generateBarChartAnalysis(
    structuredQuery: string,
    userPrompt: string,
    sqlResults: any[],
    organizationId: string
): Promise<any> {
    try {
        console.log('📊 Starting Azure OpenAI bar chart analysis...');

        const azureClient = getAzureOpenAIClient();
        if (!azureClient) {
            console.log('⚠️ Azure OpenAI not available, skipping bar chart analysis');
            return {
                bar_chart_success: false,
                message: "Azure OpenAI not available",
                timestamp: new Date().toISOString()
            };
        }

        // Sample the results for analysis (first 5 rows)
        const sampleResults = sqlResults.slice(0, 5);
        const resultColumns = sampleResults.length > 0 ? Object.keys(sampleResults[0]) : [];

        const analysisPrompt = `You are an expert data visualization analyst specializing in medical data. Analyze the provided SQL query, user prompt, and sample data to generate comprehensive parameters for creating a BAR CHART visualization.

CRITICAL INSTRUCTIONS:
1. You MUST return a valid JSON object with all required parameters
2. Focus specifically on BAR CHART creation and analysis
3. Provide actionable parameters that can be directly used for chart creation
4. Consider medical data context and best practices
5. Ensure all parameters are practical and implementable

USER QUERY/PROMPT:
"${userPrompt}"

EXECUTED SQL QUERY:
${structuredQuery}

SAMPLE DATA RESULTS (first 5 rows):
${JSON.stringify(sampleResults, null, 2)}

AVAILABLE COLUMNS:
${resultColumns.join(', ')}

ANALYSIS REQUIREMENTS:
Please provide a comprehensive JSON response with the following structure:

{
    "bar_chart_success": true,
    "analysis": {
        "chart_type": "BAR_CHART",
        "recommended_chart_subtype": "vertical_bar|horizontal_bar|grouped_bar|stacked_bar",
        "data_interpretation": "Brief explanation of what the data represents",
        "visualization_rationale": "Why bar chart is suitable for this data"
    },
    "chart_parameters": {
        "title": "Meaningful chart title based on user query",
        "subtitle": "Additional context or time frame",
        "description": "What the chart shows and key insights",
        "x_axis": {
            "field": "column_name_for_x_axis",
            "label": "Human readable X-axis label",
            "data_type": "categorical|numeric|datetime",
            "format": "formatting_suggestion"
        },
        "y_axis": {
            "field": "column_name_for_y_axis", 
            "label": "Human readable Y-axis label",
            "data_type": "numeric|count",
            "aggregation": "sum|count|avg|max|min|none",
            "format": "number|currency|percentage"
        },
        "grouping": {
            "enabled": true|false,
            "field": "column_for_grouping_if_applicable",
            "label": "Group by label"
        },
        "filtering": {
            "recommended_filters": [
                {
                    "field": "column_name",
                    "label": "Filter label",
                    "type": "dropdown|range|search",
                    "default_value": "suggested default"
                }
            ]
        },
        "colors": {
            "scheme": "medical|professional|category|gradient",
            "primary_color": "#hex_color",
            "secondary_colors": ["#hex1", "#hex2", "#hex3"]
        },
        "sorting": {
            "field": "field_to_sort_by",
            "direction": "asc|desc",
            "rationale": "why this sorting makes sense"
        }
    },
    "insights": {
        "key_findings": [
            "Primary insight from the data",
            "Secondary insight or pattern",
            "Notable trends or outliers"
        ],
        "medical_context": "Medical significance of the visualization",
        "actionable_insights": [
            "What healthcare professionals can do with this information",
            "Decision support recommendations"
        ]
    },
    "interaction_features": {
        "drill_down": {
            "enabled": true|false,
            "target_fields": ["field1", "field2"],
            "description": "What drilling down reveals"
        },
        "tooltips": {
            "fields": ["field1", "field2", "field3"],
            "format": "what information to show on hover"
        },
        "export_options": ["png", "pdf", "csv", "excel"]
    },
    "performance_considerations": {
        "data_size": "small|medium|large",
        "rendering_strategy": "client_side|server_side|hybrid",
        "optimization_notes": "performance recommendations"
    },
    "accessibility": {
        "color_blind_friendly": true|false,
        "alt_text": "Alternative text description for screen readers",
        "keyboard_navigation": true|false
    }
}

IMPORTANT NOTES:
- Choose the most appropriate column for X and Y axes based on the user query intent
- Consider medical data privacy and sensitivity
- Ensure the visualization answers the user's original question
- Provide practical, implementable parameters
- Focus on clarity and actionability for healthcare professionals

Return ONLY the JSON object, no additional text or formatting.`;

        console.log('🤖 Sending bar chart analysis request to Azure OpenAI...');

        const completion = await azureClient.chat.completions.create({
            model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are a medical data visualization expert. Always respond with valid JSON only."
                },
                {
                    role: "user",
                    content: analysisPrompt
                }
            ],
            max_tokens: 2000,
            temperature: 0.3,
            response_format: { type: "json_object" }
        });

        const response = completion.choices[0]?.message?.content;
        if (!response) {
            throw new Error('No response from Azure OpenAI');
        }

        console.log('✅ Received response from Azure OpenAI for bar chart analysis');
        console.log('📄 Raw response length:', response.length);

        // Parse the JSON response
        let analysisResult;
        try {
            analysisResult = JSON.parse(response);
        } catch (parseError) {
            console.error('❌ Failed to parse Azure OpenAI response as JSON:', parseError);
            console.error('❌ Raw response:', response.substring(0, 500) + '...');

            return {
                bar_chart_success: false,
                message: "Failed to parse bar chart analysis response",
                error_details: parseError,
                raw_response: response.substring(0, 500) + '...',
                timestamp: new Date().toISOString()
            };
        }

        // Validate the response structure
        if (!analysisResult || typeof analysisResult !== 'object') {
            throw new Error('Invalid response structure from Azure OpenAI');
        }

        // Add metadata to the response
        analysisResult.metadata = {
            analyzed_at: new Date().toISOString(),
            organization_id: organizationId,
            data_sample_size: sampleResults.length,
            total_columns: resultColumns.length,
            query_complexity: structuredQuery.length > 200 ? 'complex' : 'simple',
            ai_model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4"
        };

        console.log('✅ Bar chart analysis completed successfully');

        return analysisResult;

    } catch (error: any) {
        console.error('❌ Error generating bar chart analysis with Azure OpenAI:', error.message);

        return {
            bar_chart_success: false,
            message: `Bar chart analysis failed: ${error.message}`,
            error_details: error.message,
            fallback_parameters: {
                chart_type: "BAR_CHART",
                title: "Data Visualization",
                x_axis: sqlResults.length > 0 ? Object.keys(sqlResults[0])[0] : "category",
                y_axis: sqlResults.length > 0 ? Object.keys(sqlResults[0])[1] : "value",
                basic_config: true
            },
            timestamp: new Date().toISOString()
        };
    }
}

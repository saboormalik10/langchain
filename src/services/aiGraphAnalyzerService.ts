import { GraphType, MedicalDataCategory } from '../types/graph';
import { GraphConfig } from '../interfaces/medical';

export class AIGraphAnalyzer {
    /**
     * Use OpenAI to analyze data structure and determine optimal graph configuration
     */
    static async analyzeDataWithAI(data: any[], llm: any): Promise<{ type: GraphType; config: GraphConfig; category: MedicalDataCategory }> {
        console.log("🤖 AI analyzing data with AI", data);
        if (!data || data.length === 0) {
            return {
                type: GraphType.BAR_CHART,
                config: { type: GraphType.BAR_CHART, title: 'No Data Available' },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        }

        try {
            // Take a sample of data for analysis (max 10 rows to avoid token limits)
            const sampleData = data.slice(0, Math.min(10, data.length));
            const columns = Object.keys(sampleData[0] || {});

            console.log(`🤖 AI analyzing ${sampleData.length} sample rows with ${columns.length} columns`);
            console.log(`🤖 Sample data:`, JSON.stringify(sampleData.slice(0, 3), null, 2));

            // Create analysis prompt for OpenAI
            const analysisPrompt = this.createAnalysisPrompt(sampleData, columns);
            console.log(`🤖 Analysis prompt (first 500 chars):`, analysisPrompt.substring(0, 500) + '...');

            // Get AI analysis
            const aiResponse = await llm.invoke(analysisPrompt);
            console.log(`🤖 AI Response:`, aiResponse);
            console.log(`🤖 AI Response length:`, aiResponse.length);

            // Parse AI response to extract graph configuration
            const graphConfig = this.parseAIResponse(aiResponse, columns, data.length);

            console.log(`🎯 AI determined: ${graphConfig.type} for ${graphConfig.category}`);
            console.log(`🎯 AI config:`, JSON.stringify(graphConfig.config, null, 2));

            return graphConfig;
        } catch (error: any) {
            console.error('❌ AI analysis failed:', error.message);
            console.error('❌ Full error:', error);
            // Fallback to basic analysis
            return this.fallbackAnalysis(data);
        }
    }

    /**
     * Analyze data types dynamically
     */
    private static analyzeDataTypes(data: any[], columns: string[]): { numeric: string[], categorical: string[], date: string[] } {
        const numeric: string[] = [];
        const categorical: string[] = [];
        const date: string[] = [];

        for (const column of columns) {
            const values = data.map(row => row[column]).filter(v => v !== null && v !== undefined);
            if (values.length === 0) continue;

            // Check if column contains dates
            const datePattern = /^\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}/;
            const isDate = values.some(v => datePattern.test(String(v)));
            if (isDate) {
                date.push(column);
                continue;
            }

            // Check if column contains numeric values
            const numericPattern = /^-?\d+(\.\d+)?$/;
            const isNumeric = values.every(v => numericPattern.test(String(v)));
            if (isNumeric) {
                numeric.push(column);
                continue;
            }

            // Check for numeric values with units (like "19MG", "100mg", "5.5kg")
            const unitPattern = /^\d+(\.\d+)?[a-zA-Z]+$/;
            const hasNumericWithUnits = values.some(v => unitPattern.test(String(v)));
            if (hasNumericWithUnits) {
                numeric.push(column);
                continue;
            }

            // Default to categorical
            categorical.push(column);
        }

        return { numeric, categorical, date };
    }

    /**
     * Create analysis prompt for OpenAI
     */
    private static createAnalysisPrompt(sampleData: any[], columns: string[]): string {
        const dataPreview = sampleData.map((row, index) => {
            const preview = Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(', ');
            return `Row ${index + 1}: {${preview}}`;
        }).join('\n');

        // Analyze data types dynamically
        const dataTypes = this.analyzeDataTypes(sampleData, columns);
        const numericColumns = dataTypes.numeric;
        const categoricalColumns = dataTypes.categorical;
        const dateColumns = dataTypes.date;

        return `You are a medical data visualization expert. Analyze the following sample data and determine the optimal graph configuration.

SAMPLE DATA (First 3 records):
${dataPreview}

COLUMNS: ${columns.join(', ')}

DATA TYPE ANALYSIS:
- Numeric columns: ${numericColumns.join(', ') || 'None'}
- Categorical columns: ${categoricalColumns.join(', ') || 'None'}
- Date columns: ${dateColumns.join(', ') || 'None'}

ANALYSIS REQUIREMENTS:
1. Determine the medical data category based on column names and data content
2. Identify the best graph type based on data structure and relationships
3. Determine appropriate axis mappings (xAxis, yAxis, colorBy) based on data types
4. Generate meaningful title and description that explains the visualization

DYNAMIC ANALYSIS GUIDELINES:
- Analyze the actual data structure and content to determine the most appropriate visualization
- Consider the relationships between fields and what insights would be most valuable
- For numeric values with units (like "19MG", "100mg", "5.5kg"), the system will automatically extract numeric parts
- Choose graph types that best represent the data relationships and patterns
- Consider aggregation if there are multiple records per category
- Use categorical columns for x-axis, numeric columns for y-axis
- Use date columns for time-series visualizations
- Consider color coding for additional dimensions
- The system automatically combines data with the same labels to prevent duplicates (e.g., multiple records for "Aspirin" will be summed/averaged)
- For charts with categorical data, consider whether you want to show individual records or aggregated values
- Aggregation options: "sum" (default), "avg" (average), "count" (count of records), "max" (maximum value), "min" (minimum value)

AVAILABLE GRAPH TYPES:
- bar_chart: For categorical comparisons and distributions
- line_chart: For time series, trends, and continuous data
- pie_chart: For proportional data and percentages
- scatter_plot: For correlation analysis between two numeric variables
- histogram: For distribution analysis of single numeric variable
- box_plot: For statistical distribution and outlier detection
- heatmap: For matrix data and correlation matrices
- timeline: For chronological events and time-based data
- stacked_bar: For grouped categorical data with multiple series
- grouped_bar: For multiple series comparison
- multi_line: For multiple time series on same chart
- area_chart: For cumulative data and filled areas
- bubble_chart: For 3-dimensional data (x, y, size)
- donut_chart: For proportional data with center space
- waterfall: For cumulative impact analysis

MEDICAL CATEGORIES:
- patient_demographics: Age, gender, location, ethnicity data
- laboratory_results: Test results, lab values, measurements
- medications: Drug names, dosages, prescriptions
- vital_signs: Blood pressure, heart rate, temperature, etc.
- diagnoses: Medical conditions, diseases, diagnoses
- treatments: Procedures, therapies, interventions
- genetic_data: DNA, genetic markers, genomic data
- pharmacogenomics: Drug-gene interactions, genetic drug responses

RESPONSE FORMAT (JSON only):
{
  "type": "graph_type",
  "category": "medical_category",
  "config": {
    "xAxis": "column_name",
    "yAxis": "column_name",
    "colorBy": "column_name",
    "aggregation": "sum|avg|count|max|min",
    "title": "Graph Title",
    "subtitle": "Graph Subtitle",
    "description": "Graph Description"
  }
}

Analyze the data structure, content, and relationships to determine the optimal visualization configuration. Respond with JSON format only.`;
    }

    /**
     * Parse AI response to extract graph configuration
     */
    private static parseAIResponse(aiResponse: any, columns: string[], totalRecords: number): { type: GraphType; config: GraphConfig; category: MedicalDataCategory } {
        try {
            console.log(`🔍 Parsing AI response...`);

            // Handle both string and AIMessage objects
            let responseContent: string;
            if (typeof aiResponse === 'string') {
                responseContent = aiResponse;
            } else if (aiResponse && typeof aiResponse === 'object' && aiResponse.content) {
                responseContent = aiResponse.content;
            } else {
                console.error('❌ Invalid AI response format:', aiResponse);
                throw new Error('Invalid AI response format');
            }

            console.log(`🔍 AI Response content:`, responseContent);

            // Extract JSON from AI response
            const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error('❌ No JSON found in AI response');
                throw new Error('No JSON found in AI response');
            }

            const jsonStr = jsonMatch[0];
            console.log(`🔍 Extracted JSON:`, jsonStr);

            const parsed = JSON.parse(jsonStr);
            console.log(`🔍 Parsed config:`, parsed);

            // Validate and map the response
            const graphType = this.validateGraphType(parsed.type);
            const category = this.validateMedicalCategory(parsed.category);

            console.log(`🔍 Validated: type=${graphType}, category=${category}`);

            const config: GraphConfig = {
                type: graphType,
                category,
                xAxis: parsed.config?.xAxis,
                yAxis: parsed.config?.yAxis,
                colorBy: parsed.config?.colorBy,
                title: parsed.config?.title || 'AI-Generated Analysis',
                subtitle: parsed.config?.subtitle || `Auto-generated from ${totalRecords} records`,
                description: parsed.config?.description || `AI-determined ${graphType} visualization for ${category} data`
            };

            console.log(`🔍 Final config:`, config);
            return { type: graphType, config, category };
        } catch (error: any) {
            console.error('❌ Failed to parse AI response:', error.message);
            console.error('❌ AI Response was:', aiResponse);
            return this.fallbackAnalysis([]);
        }
    }

    /**
     * Validate and map graph type
     */
    private static validateGraphType(type: string): GraphType {
        const validTypes = Object.values(GraphType);
        const normalizedType = type.toLowerCase().replace(/[^a-z]/g, '_');

        if (validTypes.includes(normalizedType as GraphType)) {
            return normalizedType as GraphType;
        }

        // Map common variations
        const typeMapping: Record<string, GraphType> = {
            'bar': GraphType.BAR_CHART,
            'line': GraphType.LINE_CHART,
            'pie': GraphType.PIE_CHART,
            'scatter': GraphType.SCATTER_PLOT,
            'histogram': GraphType.HISTOGRAM,
            'box': GraphType.BOX_PLOT,
            'heatmap': GraphType.HEATMAP,
            'timeline': GraphType.TIMELINE,
            'stacked': GraphType.STACKED_BAR,
            'grouped': GraphType.GROUPED_BAR,
            'multi_line': GraphType.MULTI_LINE,
            'area': GraphType.AREA_CHART,
            'bubble': GraphType.BUBBLE_CHART,
            'donut': GraphType.DONUT_CHART,
            'waterfall': GraphType.WATERFALL
        };

        for (const [key, value] of Object.entries(typeMapping)) {
            if (normalizedType.includes(key)) {
                return value;
            }
        }

        return GraphType.BAR_CHART; // Default fallback
    }

    /**
     * Validate and map medical category
     */
    private static validateMedicalCategory(category: string): MedicalDataCategory {
        const validCategories = Object.values(MedicalDataCategory);
        const normalizedCategory = category.toLowerCase().replace(/[^a-z]/g, '_');

        if (validCategories.includes(normalizedCategory as MedicalDataCategory)) {
            return normalizedCategory as MedicalDataCategory;
        }

        // Map common variations
        const categoryMapping: Record<string, MedicalDataCategory> = {
            'patient': MedicalDataCategory.PATIENT_DEMOGRAPHICS,
            'demographics': MedicalDataCategory.PATIENT_DEMOGRAPHICS,
            'lab': MedicalDataCategory.LABORATORY_RESULTS,
            'laboratory': MedicalDataCategory.LABORATORY_RESULTS,
            'medication': MedicalDataCategory.MEDICATIONS,
            'drug': MedicalDataCategory.MEDICATIONS,
            'vital': MedicalDataCategory.VITAL_SIGNS,
            'diagnosis': MedicalDataCategory.DIAGNOSES,
            'treatment': MedicalDataCategory.TREATMENTS,
            'genetic': MedicalDataCategory.GENETIC_DATA,
            'pharmacogenomic': MedicalDataCategory.PHARMACOGENOMICS,
            'pgx': MedicalDataCategory.PHARMACOGENOMICS
        };

        for (const [key, value] of Object.entries(categoryMapping)) {
            if (normalizedCategory.includes(key)) {
                return value;
            }
        }

        return MedicalDataCategory.PATIENT_DEMOGRAPHICS; // Default fallback
    }

    /**
     * Fallback analysis when AI fails - Dynamic approach
     */
    private static fallbackAnalysis(data: any[]): { type: GraphType; config: GraphConfig; category: MedicalDataCategory } {
        if (data.length === 0) {
            return {
                type: GraphType.BAR_CHART,
                config: {
                    type: GraphType.BAR_CHART,
                    title: 'No Data Available',
                    subtitle: 'Fallback analysis',
                    description: 'No data to visualize'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        }

        const sampleRow = data[0];
        const columns = Object.keys(sampleRow);

        console.log(`🔍 Dynamic fallback analysis - Columns:`, columns);
        console.log(`🔍 Dynamic fallback analysis - Sample row:`, sampleRow);

        // Dynamic analysis based on data structure
        const numericColumns = columns.filter(col => {
            const sampleValue = sampleRow[col];
            return typeof sampleValue === 'number' ||
                (typeof sampleValue === 'string' && /^\d+/.test(sampleValue));
        });

        const categoricalColumns = columns.filter(col => {
            const sampleValue = sampleRow[col];
            return typeof sampleValue === 'string' && !numericColumns.includes(col);
        });

        console.log(`🔍 Dynamic analysis - Numeric columns:`, numericColumns);
        console.log(`🔍 Dynamic analysis - Categorical columns:`, categoricalColumns);

        // Choose best visualization based on data structure
        if (numericColumns.length >= 2) {
            // Multiple numeric columns - good for scatter plot or correlation
            return {
                type: GraphType.SCATTER_PLOT,
                config: {
                    type: GraphType.SCATTER_PLOT,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: numericColumns[0],
                    yAxis: numericColumns[1],
                    title: 'Data Correlation Analysis',
                    subtitle: 'Dynamic correlation analysis',
                    description: 'Analysis of relationships between numeric fields'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        } else if (categoricalColumns.length > 0 && numericColumns.length > 0) {
            // Categorical vs numeric - good for bar chart
            return {
                type: GraphType.BAR_CHART,
                config: {
                    type: GraphType.BAR_CHART,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: categoricalColumns[0],
                    yAxis: numericColumns[0],
                    title: 'Data Distribution Analysis',
                    subtitle: 'Dynamic distribution analysis',
                    description: 'Analysis of categorical vs numeric data'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        } else {
            // Generic fallback
            return {
                type: GraphType.BAR_CHART,
                config: {
                    type: GraphType.BAR_CHART,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: columns[0],
                    yAxis: columns[1],
                    title: 'Data Analysis',
                    subtitle: 'Dynamic fallback analysis',
                    description: 'Dynamic chart visualization'
                },
                category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
            };
        }
    }
}

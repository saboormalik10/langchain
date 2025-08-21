import { GraphType, MedicalDataCategory, GraphConfig } from "../types/promptTypes";
import { AIGraphAnalyzer } from "../prompts/graphAnalyzerClass";

/**
 * Graph Processing Service
 * Handles graph data processing and visualization configuration
 */

interface GraphProcessingParams {
    generateGraph: boolean;
    graphType?: GraphType;
    graphCategory?: MedicalDataCategory;
    graphConfig?: any;
    rows: any[];
    langchainApp: any;
    GraphProcessor: any; // Pass GraphProcessor class as parameter
}

interface GraphProcessingResult {
    success: boolean;
    graphData: any;
    detectedGraphType: GraphType;
    detectedCategory: MedicalDataCategory;
    hasExplicitGraphConfig: boolean;
    shouldGenerateGraph: boolean;
    errorMessage?: string;
}

/**
 * Processes graph data with AI analysis and explicit configuration support
 * @param params Graph processing parameters
 * @returns Graph processing result
 */
export async function processGraphData(
    params: GraphProcessingParams
): Promise<GraphProcessingResult> {
    const { generateGraph, graphType, graphCategory, graphConfig, rows, langchainApp, GraphProcessor } = params;

    // Process graph data if requested
    let graphData = null;
    const hasExplicitGraphConfig = graphType && graphConfig && Object.keys(graphConfig).length > 0;
    const shouldGenerateGraph = generateGraph || hasExplicitGraphConfig;
    let detectedGraphType: GraphType = GraphType.BAR_CHART;
    let detectedCategory: MedicalDataCategory = MedicalDataCategory.PATIENT_DEMOGRAPHICS;

    console.log(`🔍 Graph processing check: generateGraph=${generateGraph}, hasExplicitConfig=${hasExplicitGraphConfig}, shouldGenerate=${shouldGenerateGraph}`);
    console.log(`🔍 Rows data: ${Array.isArray(rows) ? rows.length : 'not array'} rows`);

    if (shouldGenerateGraph && Array.isArray(rows) && rows.length > 0) {
        try {
            let fullGraphConfig: GraphConfig;

            if (hasExplicitGraphConfig) {
                // Use explicit configuration
                console.log(`📊 Using explicit graph configuration`);
                fullGraphConfig = {
                    type: graphType,
                    category: graphCategory || MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    xAxis: graphConfig.xAxis,
                    yAxis: graphConfig.yAxis,
                    colorBy: graphConfig.colorBy,
                    aggregation: graphConfig.aggregation,
                    title: graphConfig.title || 'Graph Analysis',
                    subtitle: graphConfig.subtitle || '',
                    description: graphConfig.description || ''
                };
                detectedGraphType = graphType;
                detectedCategory = graphCategory || MedicalDataCategory.PATIENT_DEMOGRAPHICS;
            } else {
                // Use AI to analyze data structure
                console.log(`🤖 Using AI to analyze data structure for graph generation`);
                const analysis = await AIGraphAnalyzer.analyzeDataWithAI(rows, langchainApp.getLLM());
                fullGraphConfig = analysis.config;
                detectedGraphType = analysis.type;
                detectedCategory = analysis.category;
            }

            // Process the graph data
            console.log(`📊 Processing ${rows.length} rows with config:`, JSON.stringify(fullGraphConfig, null, 2));
            graphData = GraphProcessor.processGraphData(rows, fullGraphConfig);
            console.log(`✅ Graph data processed successfully: ${graphData.data.length} data points`);
            console.log(`📊 Sample graph data:`, JSON.stringify(graphData.data.slice(0, 3), null, 2));
        } catch (graphError: any) {
            console.error('❌ Graph processing failed:', graphError.message);
            graphData = {
                type: graphType || GraphType.BAR_CHART,
                data: [],
                config: { type: graphType || GraphType.BAR_CHART },
                metadata: {
                    totalRecords: 0,
                    processedAt: new Date().toISOString(),
                    dataQuality: { completeness: 0, accuracy: 0, consistency: 0 },
                    insights: ['Graph processing failed'],
                    recommendations: ['Check data format and graph configuration']
                }
            };
        }
    }

    // Always include graph data structure if graph parameters are present, even if processing failed
    if (shouldGenerateGraph && !graphData) {
        console.log(`⚠️ Graph processing was requested but failed or no data available`);

        let fallbackType = GraphType.BAR_CHART;
        let fallbackCategory = MedicalDataCategory.PATIENT_DEMOGRAPHICS;
        let fallbackConfig: GraphConfig;

        if (hasExplicitGraphConfig) {
            fallbackType = graphType;
            fallbackCategory = graphCategory || MedicalDataCategory.PATIENT_DEMOGRAPHICS;
            fallbackConfig = {
                type: graphType,
                category: graphCategory || MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                xAxis: graphConfig?.xAxis,
                yAxis: graphConfig?.yAxis,
                colorBy: graphConfig?.colorBy,
                title: graphConfig?.title || 'Graph Analysis',
                subtitle: graphConfig?.subtitle || '',
                description: graphConfig?.description || ''
            };
        } else {
            // Use AI for fallback analysis
            try {
                // Ensure rows is defined and is an array before analysis
                const rowsForAnalysis = Array.isArray(rows) ? rows : [];
                const analysis = await AIGraphAnalyzer.analyzeDataWithAI(rowsForAnalysis, langchainApp.getLLM());
                fallbackType = analysis.type;
                fallbackCategory = analysis.category;
                fallbackConfig = analysis.config;
            } catch (error) {
                console.error('❌ AI fallback analysis failed:', error);
                fallbackType = GraphType.BAR_CHART;
                fallbackCategory = MedicalDataCategory.PATIENT_DEMOGRAPHICS;
                fallbackConfig = {
                    type: GraphType.BAR_CHART,
                    category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
                    title: 'Data Analysis',
                    subtitle: '',
                    description: ''
                };
            }
        }

        graphData = {
            type: fallbackType,
            data: [],
            config: fallbackConfig,
            metadata: {
                totalRecords: 0,
                processedAt: new Date().toISOString(),
                dataQuality: { completeness: 0, accuracy: 0, consistency: 0 },
                insights: ['No data available for graph processing'],
                recommendations: ['Check if the query returned data and graph configuration is correct']
            }
        };
    }

    return {
        success: true,
        graphData,
        detectedGraphType,
        detectedCategory,
        hasExplicitGraphConfig,
        shouldGenerateGraph
    };
}

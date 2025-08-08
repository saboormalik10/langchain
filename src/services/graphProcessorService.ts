import { GraphType, MedicalDataCategory } from '../types/graph';
import { GraphConfig, GraphData } from '../interfaces/medical';

export class GraphProcessor {
    /**
     * Convert SQL results to graph data based on configuration
     */
    static processGraphData(sqlResults: any[], graphConfig: GraphConfig): GraphData {
        console.log(`📊 Processing graph data for type: ${graphConfig.type}`);

        let processedData = this.transformData(sqlResults, graphConfig);
        let insights = this.generateInsights(processedData, graphConfig);
        let recommendations = this.generateRecommendations(processedData, graphConfig);

        return {
            type: graphConfig.type,
            data: processedData,
            config: graphConfig,
            metadata: {
                totalRecords: sqlResults.length,
                processedAt: new Date().toISOString(),
                dataQuality: this.assessDataQuality(sqlResults),
                insights,
                recommendations
            }
        };
    }

    /**
     * Transform SQL results into graph-specific format
     */
    private static transformData(data: any[], config: GraphConfig): any[] {
        if (!data || data.length === 0) return [];

        switch (config.type) {
            case GraphType.BAR_CHART:
                return this.transformForBarChart(data, config);
            case GraphType.LINE_CHART:
                return this.transformForLineChart(data, config);
            case GraphType.PIE_CHART:
                return this.transformForPieChart(data, config);
            case GraphType.SCATTER_PLOT:
                return this.transformForScatterPlot(data, config);
            case GraphType.HISTOGRAM:
                return this.transformForHistogram(data, config);
            case GraphType.BOX_PLOT:
                return this.transformForBoxPlot(data, config);
            case GraphType.HEATMAP:
                return this.transformForHeatmap(data, config);
            case GraphType.TIMELINE:
                return this.transformForTimeline(data, config);
            case GraphType.STACKED_BAR:
                return this.transformForStackedBar(data, config);
            case GraphType.GROUPED_BAR:
                return this.transformForGroupedBar(data, config);
            case GraphType.MULTI_LINE:
                return this.transformForMultiLine(data, config);
            case GraphType.AREA_CHART:
                return this.transformForAreaChart(data, config);
            case GraphType.BUBBLE_CHART:
                return this.transformForBubbleChart(data, config);
            case GraphType.DONUT_CHART:
                return this.transformForDonutChart(data, config);
            case GraphType.WATERFALL:
                return this.transformForWaterfall(data, config);
            default:
                return this.transformForGenericChart(data, config);
        }
    }

    /**
     * Combine data with same labels to prevent duplicates
     */
    private static combineDataByLabel(data: any[], labelKey: string = 'label', valueKey: string = 'y', aggregation: string = 'sum'): any[] {
        const grouped = new Map<string, any>();

        data.forEach(item => {
            const label = item[labelKey];
            if (!label) return;

            if (!grouped.has(label)) {
                grouped.set(label, { ...item });
            } else {
                const existing = grouped.get(label);
                const existingValue = this.parseNumericValue(existing[valueKey]);
                const newValue = this.parseNumericValue(item[valueKey]);

                let combinedValue: number;
                switch (aggregation) {
                    case 'sum':
                        combinedValue = existingValue + newValue;
                        break;
                    case 'avg':
                        // For average, we need to track count and sum
                        const count = existing.count || 1;
                        const sum = existing.sum || existingValue;
                        combinedValue = (sum + newValue) / (count + 1);
                        existing.count = count + 1;
                        existing.sum = sum + newValue;
                        break;
                    case 'max':
                        combinedValue = Math.max(existingValue, newValue);
                        break;
                    case 'min':
                        combinedValue = Math.min(existingValue, newValue);
                        break;
                    default:
                        combinedValue = existingValue + newValue;
                }

                existing[valueKey] = combinedValue;

                // Merge additional properties if they exist
                if (item.color && !existing.color) {
                    existing.color = item.color;
                }
                if (item.group && !existing.group) {
                    existing.group = item.group;
                }
            }
        });

        return Array.from(grouped.values());
    }

    /**
     * Transform data for bar charts
     */
    private static transformForBarChart(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        console.log(`📊 Bar chart transformation: xAxis=${xAxis}, yAxis=${yAxis}`);

        if (config.aggregation) {
            return this.aggregateData(data, xAxis, yAxis, config.aggregation);
        }

        // Transform data first
        const transformedData = data.map(item => ({
            x: item[xAxis],
            y: this.parseNumericValue(item[yAxis]),
            label: item[xAxis],
            color: config.colorBy ? item[config.colorBy] : undefined
        }));

        // Combine data with same labels to prevent duplicates
        return this.combineDataByLabel(transformedData, 'label', 'y', config.aggregation || 'sum');
    }

    /**
     * Transform data for line charts
     */
    private static transformForLineChart(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map(item => ({
            x: this.parseDateValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            label: item[xAxis],
            group: config.colorBy ? item[config.colorBy] : undefined
        })).sort((a, b) => a.x - b.x);
    }

    /**
     * Transform data for pie charts
     */
    private static transformForPieChart(data: any[], config: GraphConfig): any[] {
        const labelField = config.xAxis || Object.keys(data[0] || {})[0];
        const valueField = config.yAxis || Object.keys(data[0] || {})[1];

        if (config.aggregation) {
            return this.aggregateData(data, labelField, valueField, config.aggregation);
        }

        // Transform data first
        const transformedData = data.map(item => ({
            label: item[labelField],
            value: this.parseNumericValue(item[valueField]),
            color: config.colorBy ? item[config.colorBy] : undefined
        }));

        // Combine data with same labels to prevent duplicates
        return this.combineDataByLabel(transformedData, 'label', 'value', config.aggregation || 'sum');
    }

    /**
     * Transform data for scatter plots
     */
    private static transformForScatterPlot(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map(item => ({
            x: this.parseNumericValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            size: config.sizeBy ? this.parseNumericValue(item[config.sizeBy]) : 10,
            color: config.colorBy ? item[config.colorBy] : undefined,
            label: item[xAxis]
        }));
    }

    /**
     * Transform data for histograms
     */
    private static transformForHistogram(data: any[], config: GraphConfig): any[] {
        const valueField = config.xAxis || Object.keys(data[0] || {})[0];
        const values = data.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));

        if (values.length === 0) return [];

        const min = Math.min(...values);
        const max = Math.max(...values);
        const binCount = Math.min(10, Math.ceil(Math.sqrt(values.length)));
        const binSize = (max - min) / binCount;

        const bins = Array(binCount).fill(0).map((_, i) => ({
            start: min + i * binSize,
            end: min + (i + 1) * binSize,
            count: 0
        }));

        values.forEach(value => {
            const binIndex = Math.min(Math.floor((value - min) / binSize), binCount - 1);
            bins[binIndex].count++;
        });

        return bins.map(bin => ({
            x: `${bin.start.toFixed(2)}-${bin.end.toFixed(2)}`,
            y: bin.count,
            start: bin.start,
            end: bin.end
        }));
    }

    /**
     * Transform data for box plots
     */
    private static transformForBoxPlot(data: any[], config: GraphConfig): any[] {
        const valueField = config.xAxis || Object.keys(data[0] || {})[0];
        const groupField = config.groupBy || config.colorBy;

        if (groupField) {
            const groups = this.groupData(data, groupField);
            return Object.entries(groups).map(([group, groupData]) => {
                const values = groupData.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));
                return this.calculateBoxPlotStats(values, group);
            });
        } else {
            const values = data.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));
            return [this.calculateBoxPlotStats(values, 'all')];
        }
    }

    /**
     * Transform data for heatmaps
     */
    private static transformForHeatmap(data: any[], config: GraphConfig): any[] {
        const xField = config.xAxis || Object.keys(data[0] || {})[0];
        const yField = config.yAxis || Object.keys(data[0] || {})[1];
        const valueField = config.sizeBy || Object.keys(data[0] || {})[2];

        return data.map(item => ({
            x: item[xField],
            y: item[yField],
            value: this.parseNumericValue(item[valueField]),
            color: this.getHeatmapColor(this.parseNumericValue(item[valueField]))
        }));
    }

    /**
     * Transform data for timelines
     */
    private static transformForTimeline(data: any[], config: GraphConfig): any[] {
        const timeField = config.xAxis || Object.keys(data[0] || {})[0];
        const eventField = config.yAxis || Object.keys(data[0] || {})[1];

        return data.map(item => ({
            time: this.parseDateValue(item[timeField]),
            event: item[eventField],
            description: config.colorBy ? item[config.colorBy] : undefined,
            category: config.groupBy ? item[config.groupBy] : undefined
        })).sort((a, b) => a.time - b.time);
    }

    /**
     * Transform data for stacked bar charts
     */
    private static transformForStackedBar(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const stackBy = config.groupBy || config.colorBy;

        if (!stackBy) return this.transformForBarChart(data, config);

        const groups = this.groupData(data, xAxis);
        return Object.entries(groups).map(([xValue, groupData]) => {
            const stacks = this.groupData(groupData, stackBy);
            return {
                x: xValue,
                stacks: Object.entries(stacks).map(([stackName, stackData]) => ({
                    name: stackName,
                    value: stackData.reduce((sum, item) => sum + this.parseNumericValue(item[yAxis]), 0)
                }))
            };
        });
    }

    /**
     * Transform data for grouped bar charts
     */
    private static transformForGroupedBar(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const groupBy = config.groupBy || config.colorBy;

        if (!groupBy) return this.transformForBarChart(data, config);

        const groups = this.groupData(data, groupBy);
        return Object.entries(groups).map(([groupName, groupData]) => ({
            group: groupName,
            bars: groupData.map(item => ({
                x: item[xAxis],
                y: this.parseNumericValue(item[yAxis]),
                label: item[xAxis]
            }))
        }));
    }

    /**
     * Transform data for multi-line charts
     */
    private static transformForMultiLine(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const lineBy = config.groupBy || config.colorBy;

        if (!lineBy) return this.transformForLineChart(data, config);

        const lines = this.groupData(data, lineBy);
        return Object.entries(lines).map(([lineName, lineData]) => ({
            name: lineName,
            data: lineData.map(item => ({
                x: this.parseDateValue(item[xAxis]),
                y: this.parseNumericValue(item[yAxis])
            })).sort((a, b) => a.x - b.x)
        }));
    }

    /**
     * Transform data for area charts
     */
    private static transformForAreaChart(data: any[], config: GraphConfig): any[] {
        const result = this.transformForLineChart(data, config);
        return result.map(item => ({
            ...item,
            area: true
        }));
    }

    /**
     * Transform data for bubble charts
     */
    private static transformForBubbleChart(data: any[], config: GraphConfig): any[] {
        const xAxis = config.xAxis || Object.keys(data[0] || {})[0];
        const yAxis = config.yAxis || Object.keys(data[0] || {})[1];
        const sizeField = config.sizeBy || Object.keys(data[0] || {})[2];

        return data.map(item => ({
            x: this.parseNumericValue(item[xAxis]),
            y: this.parseNumericValue(item[yAxis]),
            size: this.parseNumericValue(item[sizeField]),
            color: config.colorBy ? item[config.colorBy] : undefined,
            label: item[xAxis]
        }));
    }

    /**
     * Transform data for donut charts
     */
    private static transformForDonutChart(data: any[], config: GraphConfig): any[] {
        return this.transformForPieChart(data, config);
    }

    /**
     * Transform data for waterfall charts
     */
    private static transformForWaterfall(data: any[], config: GraphConfig): any[] {
        const labelField = config.xAxis || Object.keys(data[0] || {})[0];
        const valueField = config.yAxis || Object.keys(data[0] || {})[1];

        let runningTotal = 0;
        return data.map(item => {
            const value = this.parseNumericValue(item[valueField]);
            const start = runningTotal;
            runningTotal += value;
            return {
                label: item[labelField],
                value: value,
                start: start,
                end: runningTotal,
                color: value >= 0 ? 'positive' : 'negative'
            };
        });
    }

    /**
     * Generic chart transformation
     */
    private static transformForGenericChart(data: any[], config: GraphConfig): any[] {
        return data.map(item => ({
            ...item,
            processed: true
        }));
    }

    /**
     * Aggregate data based on specified function
     */
    private static aggregateData(data: any[], groupBy: string, valueField: string, aggregation: string): any[] {
        const groups = this.groupData(data, groupBy);

        return Object.entries(groups).map(([group, groupData]) => {
            const values = groupData.map(item => this.parseNumericValue(item[valueField])).filter(v => !isNaN(v));
            let aggregatedValue = 0;

            switch (aggregation) {
                case 'count':
                    aggregatedValue = groupData.length;
                    break;
                case 'sum':
                    aggregatedValue = values.reduce((sum, val) => sum + val, 0);
                    break;
                case 'avg':
                    aggregatedValue = values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
                    break;
                case 'min':
                    aggregatedValue = values.length > 0 ? Math.min(...values) : 0;
                    break;
                case 'max':
                    aggregatedValue = values.length > 0 ? Math.max(...values) : 0;
                    break;
                case 'median':
                    aggregatedValue = this.calculateMedian(values);
                    break;
                default:
                    aggregatedValue = values.reduce((sum, val) => sum + val, 0);
            }

            return {
                label: group,
                value: aggregatedValue,
                count: groupData.length
            };
        });
    }

    /**
     * Group data by a specific field
     */
    private static groupData(data: any[], groupBy: string): Record<string, any[]> {
        return data.reduce((groups, item) => {
            const key = item[groupBy] || 'Unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
            return groups;
        }, {} as Record<string, any[]>);
    }

    /**
     * Calculate box plot statistics
     */
    private static calculateBoxPlotStats(values: number[], group: string): any {
        if (values.length === 0) return { group, min: 0, q1: 0, median: 0, q3: 0, max: 0 };

        values.sort((a, b) => a - b);
        const min = values[0];
        const max = values[values.length - 1];
        const q1 = this.calculatePercentile(values, 25);
        const median = this.calculatePercentile(values, 50);
        const q3 = this.calculatePercentile(values, 75);

        return { group, min, q1, median, q3, max };
    }

    /**
     * Calculate percentile
     */
    private static calculatePercentile(values: number[], percentile: number): number {
        const index = (percentile / 100) * (values.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;

        if (upper === lower) return values[lower];
        return values[lower] * (1 - weight) + values[upper] * weight;
    }

    /**
     * Calculate median
     */
    private static calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        values.sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
    }

    /**
     * Parse numeric value safely
     */
    private static parseNumericValue(value: any): number {
        if (value === null || value === undefined) return 0;
        const parsed = parseFloat(value);
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Parse date value safely
     */
    private static parseDateValue(value: any): number {
        if (value === null || value === undefined) return 0;
        const date = new Date(value);
        return isNaN(date.getTime()) ? 0 : date.getTime();
    }

    /**
     * Get heatmap color based on value
     */
    private static getHeatmapColor(value: number): string {
        // Simple color scale from blue (low) to red (high)
        const normalized = Math.max(0, Math.min(1, value / 100));
        const r = Math.round(255 * normalized);
        const b = Math.round(255 * (1 - normalized));
        return `rgb(${r}, 0, ${b})`;
    }

    /**
     * Assess data quality
     */
    private static assessDataQuality(data: any[]): { completeness: number; accuracy: number; consistency: number } {
        if (data.length === 0) return { completeness: 0, accuracy: 0, consistency: 0 };

        const totalFields = Object.keys(data[0] || {}).length;
        let totalNulls = 0;
        let totalValues = 0;

        data.forEach(item => {
            Object.values(item).forEach(value => {
                totalValues++;
                if (value === null || value === undefined || value === '') {
                    totalNulls++;
                }
            });
        });

        const completeness = ((totalValues - totalNulls) / totalValues) * 100;
        const accuracy = Math.min(100, Math.max(0, 100 - (totalNulls / data.length) * 10));
        const consistency = Math.min(100, Math.max(0, 100 - (totalNulls / totalValues) * 20));

        return { completeness, accuracy, consistency };
    }

    /**
     * Generate insights from data
     */
    private static generateInsights(data: any[], config: GraphConfig): string[] {
        const insights: string[] = [];

        if (data.length === 0) {
            insights.push('No data available for visualization');
            return insights;
        }

        // Basic insights based on data type
        switch (config.type) {
            case GraphType.BAR_CHART:
            case GraphType.PIE_CHART:
                const maxValue = Math.max(...data.map(d => d.value || d.y || 0));
                const minValue = Math.min(...data.map(d => d.value || d.y || 0));
                insights.push(`Highest value: ${maxValue}`);
                insights.push(`Lowest value: ${minValue}`);
                insights.push(`Data range: ${maxValue - minValue}`);
                break;
            case GraphType.LINE_CHART:
            case GraphType.TIMELINE:
                insights.push(`Time span: ${data.length} data points`);
                if (data.length > 1) {
                    const trend = data[data.length - 1].y > data[0].y ? 'increasing' : 'decreasing';
                    insights.push(`Overall trend: ${trend}`);
                }
                break;
            case GraphType.SCATTER_PLOT:
                insights.push(`Correlation analysis available`);
                insights.push(`Outlier detection possible`);
                break;
        }

        // Medical-specific insights
        if (config.category) {
            switch (config.category) {
                case MedicalDataCategory.PATIENT_DEMOGRAPHICS:
                    insights.push('Demographic distribution analysis');
                    break;
                case MedicalDataCategory.LABORATORY_RESULTS:
                    insights.push('Lab result trends and ranges');
                    break;
                case MedicalDataCategory.MEDICATIONS:
                    insights.push('Medication usage patterns');
                    break;
                case MedicalDataCategory.VITAL_SIGNS:
                    insights.push('Vital sign monitoring trends');
                    break;
            }
        }

        return insights;
    }

    /**
     * Generate recommendations based on data and graph type
     */
    private static generateRecommendations(data: any[], config: GraphConfig): string[] {
        const recommendations: string[] = [];

        if (data.length === 0) {
            recommendations.push('Consider expanding the data query to include more records');
            return recommendations;
        }

        // Recommendations based on data quality
        const quality = this.assessDataQuality(data);
        if (quality.completeness < 80) {
            recommendations.push('Data completeness is low - consider data cleaning');
        }
        if (quality.accuracy < 90) {
            recommendations.push('Data accuracy could be improved - verify data sources');
        }

        // Recommendations based on graph type
        switch (config.type) {
            case GraphType.BAR_CHART:
                if (data.length > 20) {
                    recommendations.push('Consider grouping categories for better readability');
                }
                break;
            case GraphType.LINE_CHART:
                if (data.length < 5) {
                    recommendations.push('More data points recommended for trend analysis');
                }
                break;
            case GraphType.PIE_CHART:
                if (data.length > 8) {
                    recommendations.push('Consider combining smaller segments into "Other" category');
                }
                break;
            case GraphType.SCATTER_PLOT:
                recommendations.push('Consider adding trend lines for pattern analysis');
                break;
        }

        // Medical-specific recommendations
        if (config.category) {
            switch (config.category) {
                case MedicalDataCategory.LABORATORY_RESULTS:
                    recommendations.push('Consider adding normal range indicators');
                    break;
                case MedicalDataCategory.MEDICATIONS:
                    recommendations.push('Consider drug interaction analysis');
                    break;
                case MedicalDataCategory.VITAL_SIGNS:
                    recommendations.push('Consider adding alert thresholds');
                    break;
            }
        }

        return recommendations;
    }
}

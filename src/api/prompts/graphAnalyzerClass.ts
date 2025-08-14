import { DataAnalysisResult, DataTypeAnalysis, GraphConfig, GraphType, MedicalDataCategory } from "../types/promptTypes";

export class AIGraphAnalyzer {
  /**
   * Main analysis method that coordinates the process
   */
  static async analyzeDataWithAI(
    data: any[],
    llm: any
  ): Promise<DataAnalysisResult> {
    console.log("🤖 AI analyzing data with AI", data);
    if (!data || data.length === 0) {
      return this.getDefaultEmptyResult();
    }

    try {
      const sampleData = this.getSampleData(data);
      const columns = Object.keys(sampleData[0] || {});
      
      console.log(`🤖 AI analyzing ${sampleData.length} sample rows with ${columns.length} columns`);
      console.log(`🤖 Sample data:`, JSON.stringify(sampleData.slice(0, 3), null, 2));

      const analysisPrompt = this.createAnalysisPrompt(sampleData, columns);
      console.log(`🤖 Analysis prompt (first 500 chars):`, analysisPrompt.substring(0, 500) + "...");

      const aiResponse = await llm.invoke(analysisPrompt);
      console.log(`🤖 AI Response:`, aiResponse);
      console.log(`🤖 AI Response length:`, aiResponse.length);

      return this.parseAIResponse(aiResponse, columns, data.length);
    } catch (error: any) {
      console.error("❌ AI analysis failed:", error.message);
      console.error("❌ Full error:", error);
      return this.fallbackAnalysis(data);
    }
  }

  /**
   * Get sample data (max 10 rows)
   */
  private static getSampleData(data: any[]): any[] {
    return data.slice(0, Math.min(10, data.length));
  }

  /**
   * Get default result when no data is available
   */
  private static getDefaultEmptyResult(): DataAnalysisResult {
    return {
      type: GraphType.BAR_CHART,
      config: { 
        type: GraphType.BAR_CHART, 
        title: "No Data Available",
        subtitle: "",
        description: "",
        category: MedicalDataCategory.PATIENT_DEMOGRAPHICS
      },
      category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
    };
  }

  /**
   * Analyze data types dynamically
   */
  static analyzeDataTypes(data: any[], columns: string[]): DataTypeAnalysis {
    const numeric: string[] = [];
    const categorical: string[] = [];
    const date: string[] = [];

    for (const column of columns) {
      const values = data
        .map((row) => row[column])
        .filter((v) => v !== null && v !== undefined);
      if (values.length === 0) continue;

      if (this.isDateColumn(values)) {
        date.push(column);
        continue;
      }

      if (this.isNumericColumn(values)) {
        numeric.push(column);
        continue;
      }

      if (this.isNumericWithUnitsColumn(values)) {
        numeric.push(column);
        continue;
      }

      categorical.push(column);
    }

    return { numeric, categorical, date };
  }

  private static isDateColumn(values: any[]): boolean {
    const datePattern = /^\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}/;
    return values.some((v) => datePattern.test(String(v)));
  }

  private static isNumericColumn(values: any[]): boolean {
    const numericPattern = /^-?\d+(\.\d+)?$/;
    return values.every((v) => numericPattern.test(String(v)));
  }

  private static isNumericWithUnitsColumn(values: any[]): boolean {
    const unitPattern = /^\d+(\.\d+)?[a-zA-Z]+$/;
    return values.some((v) => unitPattern.test(String(v)));
  }

  /**
   * Create analysis prompt for OpenAI
   */
  private static createAnalysisPrompt(sampleData: any[], columns: string[]): string {
    const dataPreview = this.formatDataPreview(sampleData);
    const dataTypes = this.analyzeDataTypes(sampleData, columns);

    return `You are a medical data visualization expert. Analyze the following sample data and determine the optimal graph configuration.

SAMPLE DATA (First 3 records):
${dataPreview}

COLUMNS: ${columns.join(", ")}

DATA TYPE ANALYSIS:
- Numeric columns: ${dataTypes.numeric.join(", ") || "None"}
- Categorical columns: ${dataTypes.categorical.join(", ") || "None"}
- Date columns: ${dataTypes.date.join(", ") || "None"}

[Rest of the prompt remains the same...]`;
  }

  private static formatDataPreview(sampleData: any[]): string {
    return sampleData
      .map((row, index) => {
        const preview = Object.entries(row)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");
        return `Row ${index + 1}: {${preview}}`;
      })
      .join("\n");
  }

  /**
   * Parse AI response to extract graph configuration
   */
  private static parseAIResponse(
    aiResponse: any,
    columns: string[],
    totalRecords: number
  ): DataAnalysisResult {
    try {
      console.log(`🔍 Parsing AI response...`);
      const responseContent = this.extractResponseContent(aiResponse);
      const jsonStr = this.extractJsonFromResponse(responseContent);
      const parsed = JSON.parse(jsonStr);

      const graphType = this.validateGraphType(parsed.type);
      const category = this.validateMedicalCategory(parsed.category);

      console.log(`🔍 Validated: type=${graphType}, category=${category}`);

      const config: GraphConfig = {
        type: graphType,
        category,
        xAxis: parsed.config?.xAxis,
        yAxis: parsed.config?.yAxis,
        colorBy: parsed.config?.colorBy,
        title: parsed.config?.title || "AI-Generated Analysis",
        subtitle: parsed.config?.subtitle || `Auto-generated from ${totalRecords} records`,
        description: parsed.config?.description || `AI-determined ${graphType} visualization for ${category} data`,
      };

      console.log(`🔍 Final config:`, config);
      return { type: graphType, config, category };
    } catch (error: any) {
      console.error("❌ Failed to parse AI response:", error.message);
      console.error("❌ AI Response was:", aiResponse);
      return this.fallbackAnalysis([]);
    }
  }

  private static extractResponseContent(aiResponse: any): string {
    if (typeof aiResponse === "string") {
      return aiResponse;
    } else if (aiResponse?.content) {
      return aiResponse.content;
    }
    throw new Error("Invalid AI response format");
  }

  private static extractJsonFromResponse(responseContent: string): string {
    const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in AI response");
    }
    return jsonMatch[0];
  }

  /**
   * Validate and map graph type
   */
  private static validateGraphType(type: string): GraphType {
    const typeMapping: Record<string, GraphType> = {
      bar: GraphType.BAR_CHART,
      line: GraphType.LINE_CHART,
      pie: GraphType.PIE_CHART,
      scatter: GraphType.SCATTER_PLOT,
      histogram: GraphType.HISTOGRAM,
      box: GraphType.BOX_PLOT,
      heatmap: GraphType.HEATMAP,
      timeline: GraphType.TIMELINE,
      stacked: GraphType.STACKED_BAR,
      grouped: GraphType.GROUPED_BAR,
      multi_line: GraphType.MULTI_LINE,
      area: GraphType.AREA_CHART,
      bubble: GraphType.BUBBLE_CHART,
      donut: GraphType.DONUT_CHART,
      waterfall: GraphType.WATERFALL,
    };

    const normalizedType = type.toLowerCase().replace(/[^a-z]/g, "_");
    
    // Check if exact match exists
    if (Object.values(GraphType).includes(normalizedType as GraphType)) {
      return normalizedType as GraphType;
    }

    // Check for partial matches
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
    const categoryMapping: Record<string, MedicalDataCategory> = {
      patient: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
      demographics: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
      lab: MedicalDataCategory.LABORATORY_RESULTS,
      laboratory: MedicalDataCategory.LABORATORY_RESULTS,
      medication: MedicalDataCategory.MEDICATIONS,
      drug: MedicalDataCategory.MEDICATIONS,
      vital: MedicalDataCategory.VITAL_SIGNS,
      diagnosis: MedicalDataCategory.DIAGNOSES,
      treatment: MedicalDataCategory.TREATMENTS,
      genetic: MedicalDataCategory.GENETIC_DATA,
      pharmacogenomic: MedicalDataCategory.PHARMACOGENOMICS,
      pgx: MedicalDataCategory.PHARMACOGENOMICS,
    };

    const normalizedCategory = category.toLowerCase().replace(/[^a-z]/g, "_");
    
    // Check if exact match exists
    if (Object.values(MedicalDataCategory).includes(normalizedCategory as MedicalDataCategory)) {
      return normalizedCategory as MedicalDataCategory;
    }

    // Check for partial matches
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
  private static fallbackAnalysis(data: any[]): DataAnalysisResult {
    if (data.length === 0) {
      return this.getDefaultEmptyResult();
    }

    const sampleRow = data[0];
    const columns = Object.keys(sampleRow);
    const numericColumns = this.detectNumericColumns(sampleRow, columns);
    const categoricalColumns = this.detectCategoricalColumns(sampleRow, columns, numericColumns);

    if (numericColumns.length >= 2) {
      return this.createScatterPlotResult(numericColumns);
    } else if (categoricalColumns.length > 0 && numericColumns.length > 0) {
      return this.createBarChartResult(categoricalColumns, numericColumns);
    } else {
      return this.createGenericFallbackResult(columns);
    }
  }

  private static detectNumericColumns(sampleRow: any, columns: string[]): string[] {
    return columns.filter((col) => {
      const sampleValue = sampleRow[col];
      return (
        typeof sampleValue === "number" ||
        (typeof sampleValue === "string" && /^\d+/.test(sampleValue))
      );
    });
  }

  private static detectCategoricalColumns(
    sampleRow: any,
    columns: string[],
    numericColumns: string[]
  ): string[] {
    return columns.filter((col) => {
      const sampleValue = sampleRow[col];
      return typeof sampleValue === "string" && !numericColumns.includes(col);
    });
  }

  private static createScatterPlotResult(numericColumns: string[]): DataAnalysisResult {
    return {
      type: GraphType.SCATTER_PLOT,
      config: {
        type: GraphType.SCATTER_PLOT,
        category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
        xAxis: numericColumns[0],
        yAxis: numericColumns[1],
        title: "Data Correlation Analysis",
        subtitle: "Dynamic correlation analysis",
        description: "Analysis of relationships between numeric fields",
      },
      category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
    };
  }

  private static createBarChartResult(
    categoricalColumns: string[],
    numericColumns: string[]
  ): DataAnalysisResult {
    return {
      type: GraphType.BAR_CHART,
      config: {
        type: GraphType.BAR_CHART,
        category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
        xAxis: categoricalColumns[0],
        yAxis: numericColumns[0],
        title: "Data Distribution Analysis",
        subtitle: "Dynamic distribution analysis",
        description: "Analysis of categorical vs numeric data",
      },
      category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
    };
  }

  private static createGenericFallbackResult(columns: string[]): DataAnalysisResult {
    return {
      type: GraphType.BAR_CHART,
      config: {
        type: GraphType.BAR_CHART,
        category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
        xAxis: columns[0],
        yAxis: columns[1],
        title: "Data Analysis",
        subtitle: "Dynamic fallback analysis",
        description: "Dynamic chart visualization",
      },
      category: MedicalDataCategory.PATIENT_DEMOGRAPHICS,
    };
  }
}
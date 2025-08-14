// types.ts
export interface ComprehensiveQueryParams {
  query: string;
  databaseSchemaInfo?: string;
  mysqlVersionInfo?: {
    full: string;
    major: number;
    minor: number;
    patch: number;
    supportsJSON: boolean;
    supportsWindowFunctions: boolean;
    supportsRegex?: boolean;
    hasOnlyFullGroupBy?: boolean;
    supportsCTE: boolean;
  } | null;
}

export interface RestructuringPromptParams {
  userPrompt: string;
  originalSQL: string;
  sampleSize: number;
  sampleResults: any[]; // could be more specific depending on your query results shape
  dbType: string;
  dbVersion: string;
  sqlResults: any[]; // could type this better if you know the result structure
  tablesInfo?: string;
  validatedTables: string[];
  validatedColumns: Record<string, string[]>; // tableName -> columnNames[]
  jsonFunctions: {
    createObject: string;
    createArray: string;
    description: string;
    examples: string;
    considerations: string;
    finalReminder: string;
  };
  dbSyntaxRules: {
    general: string;
    aliasRules: string;
    orderByRules: string;
    correctExamples: string;
    incorrectExamples: string;
    criticalRequirements: string;
    finalReminder: string;
  };
}

export interface ComprehensiveQueryParams {
  query: string;
  databaseType?: string;
  databaseVersionString?: string;
  organizationId?: string;
  versionSpecificInstructions?: string;
  databaseVersionInfo?: {
    full: string;
    major: number;
    minor: number;
    patch: number;
    supportsJSON: boolean;
    supportsWindowFunctions: boolean;
    supportsRegex?: boolean;
    hasOnlyFullGroupBy?: boolean;
    supportsCTE: boolean;
  } | null;
  tableDescriptions?: string;
  conversationalContext?: string; // Optional context for the conversation
}

export interface TableRelevancePromptParams {
  query: string;
  schemaDescription: string;
}

export interface DatabaseVersionInfo {
  full: string;
  major: number;
  minor: number;
  patch: number;
  supportsJSON: boolean;
  supportsWindowFunctions: boolean;
  supportsCTE: boolean;
  hasOnlyFullGroupBy?: boolean;
}

export interface VersionSpecificInstructionsParams {
  databaseType: string;
  databaseVersionInfo?: DatabaseVersionInfo | null;
}

export interface QueryDescriptionParams {
  finalSQL: string;
  query: string;
}

export interface ResultExplanationParams {
  query: string;
  finalSQL: string;
  rows: any[];
  resultSample: any;
}

export interface ErrorDescriptionParams {
  query: string;
  finalSQL: string;
  sqlError: { message: string };
  errorDetails?: { error_type?: string };
}


export enum GraphType {
  BAR_CHART = "bar_chart",
  LINE_CHART = "line_chart",
  PIE_CHART = "pie_chart",
  SCATTER_PLOT = "scatter_plot",
  HISTOGRAM = "histogram",
  BOX_PLOT = "box_plot",
  HEATMAP = "heatmap",
  TIMELINE = "timeline",
  STACKED_BAR = "stacked_bar",
  GROUPED_BAR = "grouped_bar",
  MULTI_LINE = "multi_line",
  AREA_CHART = "area_chart",
  BUBBLE_CHART = "bubble_chart",
  DONUT_CHART = "donut_chart",
  WATERFALL = "waterfall"
}

export enum MedicalDataCategory {
  PATIENT_DEMOGRAPHICS = "patient_demographics",
  LABORATORY_RESULTS = "laboratory_results",
  MEDICATIONS = "medications",
  VITAL_SIGNS = "vital_signs",
  DIAGNOSES = "diagnoses",
  TREATMENTS = "treatments",
  GENETIC_DATA = "genetic_data",
  PHARMACOGENOMICS = "pharmacogenomics"
}

export interface GraphConfig {
  type: GraphType;
  category: MedicalDataCategory;
  xAxis?: string;
  yAxis?: string;
  colorBy?: string;
  aggregation?: "sum" | "avg" | "count" | "max" | "min";
  title: string;
  subtitle: string;
  description: string;
}

export interface DataAnalysisResult {
  type: GraphType;
  config: GraphConfig;
  category: MedicalDataCategory;
}

export interface DataTypeAnalysis {
  numeric: string[];
  categorical: string[];
  date: string[];
}


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
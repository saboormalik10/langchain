# Medical Data Graph Functionality

## Overview

The medical data API now includes comprehensive graph functionality that allows researchers to visualize their medical data in various chart types. The backend automatically converts SQL query results into appropriate graph data structures based on the specified configuration.

## Features

### Supported Graph Types

1. **Bar Chart** (`bar_chart`) - For categorical data comparison
2. **Line Chart** (`line_chart`) - For time series and trends
3. **Pie Chart** (`pie_chart`) - For proportional data
4. **Scatter Plot** (`scatter_plot`) - For correlation analysis
5. **Histogram** (`histogram`) - For distribution analysis
6. **Box Plot** (`box_plot`) - For statistical distribution
7. **Heatmap** (`heatmap`) - For matrix data visualization
8. **Timeline** (`timeline`) - For chronological events
9. **Stacked Bar** (`stacked_bar`) - For grouped categorical data
10. **Grouped Bar** (`grouped_bar`) - For multiple series comparison
11. **Multi-Line** (`multi_line`) - For multiple time series
12. **Area Chart** (`area_chart`) - For cumulative data
13. **Bubble Chart** (`bubble_chart`) - For 3-dimensional data
14. **Donut Chart** (`donut_chart`) - For proportional data with center
15. **Waterfall** (`waterfall`) - For cumulative impact analysis

### Medical Data Categories

1. **Patient Demographics** (`patient_demographics`)
2. **Laboratory Results** (`laboratory_results`)
3. **Medications** (`medications`)
4. **Vital Signs** (`vital_signs`)
5. **Diagnoses** (`diagnoses`)
6. **Treatments** (`treatments`)
7. **Procedures** (`procedures`)
8. **Genetic Data** (`genetic_data`)
9. **Pharmacogenomics** (`pharmacogenomics`)
10. **Clinical Trials** (`clinical_trials`)
11. **Epidemiology** (`epidemiology`)
12. **Outcomes** (`outcomes`)
13. **Cost Analysis** (`cost_analysis`)
14. **Quality Metrics** (`quality_metrics`)
15. **Patient Flow** (`patient_flow`)

## API Usage

### AI-Powered Graph Generation (Recommended)

The system now uses OpenAI to intelligently analyze your data and determine the optimal graph configuration automatically. You can simply request graph generation without specifying any chart types or configurations.

**Simple Graph Request (AI-powered):**
```json
{
  "organizationId": "your-org-id",
  "query": "SELECT age, gender, COUNT(*) as count FROM patients GROUP BY age, gender",
  "generateGraph": true
}
```

**With Natural Language Query:**
```json
{
  "organizationId": "your-org-id",
  "query": "Give me patients with medications as well",
  "generateGraph": true
}
```

### Manual Graph Configuration (Optional)

If you prefer to specify the graph configuration manually:

```json
{
  "organizationId": "your-org-id",
  "query": "SELECT age, gender, COUNT(*) as count FROM patients GROUP BY age, gender",
  "generateGraph": true,
  "graphType": "bar_chart",
  "graphCategory": "patient_demographics",
  "graphConfig": {
    "xAxis": "age",
    "yAxis": "count",
    "colorBy": "gender",
    "title": "Patient Age Distribution by Gender",
    "subtitle": "Analysis of patient demographics",
    "description": "Shows the distribution of patients by age and gender"
  }
}
```

### Advanced Graph Configuration

```json
{
  "organizationId": "your-org-id",
  "query": "SELECT test_date, test_value, test_type FROM lab_results WHERE test_date >= '2023-01-01'",
  "generateGraph": true,
  "graphType": "line_chart",
  "graphCategory": "laboratory_results",
  "graphConfig": {
    "xAxis": "test_date",
    "yAxis": "test_value",
    "colorBy": "test_type",
    "showTrends": true,
    "showOutliers": true,
    "aggregation": "avg",
    "timeFormat": "YYYY-MM-DD",
    "title": "Laboratory Test Trends",
    "subtitle": "Test values over time",
    "description": "Shows trends in laboratory test results over time"
  }
}
```

### Medical Preset Examples

#### Patient Demographics
```json
{
  "generateGraph": true,
  "graphType": "histogram",
  "graphCategory": "patient_demographics",
  "graphConfig": {
    "xAxis": "age",
    "title": "Patient Age Distribution"
  }
}
```

#### Laboratory Results
```json
{
  "generateGraph": true,
  "graphType": "box_plot",
  "graphCategory": "laboratory_results",
  "graphConfig": {
    "xAxis": "test_type",
    "yAxis": "test_value",
    "title": "Laboratory Test Value Distribution"
  }
}
```

#### Medications
```json
{
  "generateGraph": true,
  "graphType": "bar_chart",
  "graphCategory": "medications",
  "graphConfig": {
    "xAxis": "medication_name",
    "yAxis": "prescription_count",
    "aggregation": "count",
    "title": "Medication Usage Patterns"
  }
}
```

## Response Structure

When `generateGraph` is set to `true`, the response includes AI-generated graph data in the `sql_results` object:

```json
{
  "success": true,
  "query_processed": "SELECT age, gender, COUNT(*) as count FROM patients GROUP BY age, gender",
  "sql_results": {
    "resultExplanation": "Query explanation...",
    "sql_final": [...],
    "processing_time": "150.25ms",
    "graph_data": {
      "type": "bar_chart",
      "data": [
        {
          "x": "25-30",
          "y": 45,
          "label": "25-30",
          "color": "Male"
        }
      ],
      "config": {
        "type": "bar_chart",
        "category": "patient_demographics",
        "xAxis": "age",
        "yAxis": "count",
        "title": "Patient Age Distribution by Gender",
        "subtitle": "AI-generated analysis",
        "description": "AI-determined bar_chart visualization for patient_demographics data"
      },
      "metadata": {
        "totalRecords": 100,
        "processedAt": "2024-01-15T10:30:00.000Z",
        "dataQuality": {
          "completeness": 95.5,
          "accuracy": 98.2,
          "consistency": 92.1
        },
        "insights": [
          "Highest value: 45",
          "Lowest value: 12",
          "Data range: 33"
        ],
        "recommendations": [
          "Consider grouping categories for better readability"
        ]
      }
    }
  },
  "graph_processing": {
    "requested": true,
    "type": "bar_chart",
    "category": "patient_demographics",
    "success": true,
    "data_points": 8,
    "auto_detected": true,
    "auto_analyzed": true,
    "debug_info": {
      "should_generate": true,
      "has_explicit_config": false,
      "rows_count": 100,
      "analysis_method": "auto_analysis"
    }
  }
}
```

## Graph Configuration Options

### Basic Configuration
- `xAxis`: Field name for X-axis data
- `yAxis`: Field name for Y-axis data
- `colorBy`: Field name for color coding
- `sizeBy`: Field name for bubble size (bubble charts)
- `groupBy`: Field name for grouping data
- `sortBy`: Field name for sorting data

### Advanced Configuration
- `limit`: Maximum number of data points (1-1000)
- `aggregation`: Data aggregation function (`count`, `sum`, `avg`, `min`, `max`, `median`)
- `timeFormat`: Date/time format for time series
- `showTrends`: Enable trend line display
- `showOutliers`: Highlight outlier data points
- `includeNulls`: Include null/empty values
- `customColors`: Array of custom color codes

### Metadata
- `title`: Graph title
- `subtitle`: Graph subtitle
- `description`: Detailed description

## Data Quality Assessment

The system automatically assesses data quality and provides:
- **Completeness**: Percentage of non-null values
- **Accuracy**: Data validation score
- **Consistency**: Data format consistency
- **Insights**: Automatic data insights
- **Recommendations**: Improvement suggestions

## Error Handling

If graph processing fails, the system returns:
```json
{
  "graph_data": {
    "type": "bar_chart",
    "data": [],
    "config": { "type": "bar_chart" },
    "metadata": {
      "totalRecords": 0,
      "processedAt": "2024-01-15T10:30:00.000Z",
      "dataQuality": { "completeness": 0, "accuracy": 0, "consistency": 0 },
      "insights": ["Graph processing failed"],
      "recommendations": ["Check data format and graph configuration"]
    }
  }
}
```

## Best Practices

1. **Choose Appropriate Chart Types**:
   - Use bar charts for categorical comparisons
   - Use line charts for time series
   - Use scatter plots for correlations
   - Use histograms for distributions

2. **Data Preparation**:
   - Ensure numeric fields for Y-axis
   - Use date fields for time series
   - Clean data before visualization

3. **Performance**:
   - Limit data points for large datasets
   - Use aggregation for summary views
   - Consider data sampling for very large datasets

4. **Medical Context**:
   - Use appropriate medical categories
   - Follow HIPAA compliance guidelines
   - Consider patient privacy in visualizations

## Examples by Medical Domain

### Patient Demographics
- Age distribution (histogram)
- Gender breakdown (pie chart)
- Geographic distribution (bar chart)

### Laboratory Results
- Test trends over time (line chart)
- Value distributions (box plot)
- Abnormal result frequency (bar chart)

### Medications
- Prescription patterns (bar chart)
- Dosage analysis (scatter plot)
- Drug interactions (heatmap)

### Vital Signs
- Multi-vital trends (multi-line)
- Value distributions (histogram)
- Vital correlations (scatter plot)

### Genetic Data
- Gene expression patterns (heatmap)
- Variant frequencies (bar chart)
- Genotype distributions (pie chart)

This implementation provides researchers with powerful, medical-specific data visualization capabilities while maintaining the existing API functionality. 
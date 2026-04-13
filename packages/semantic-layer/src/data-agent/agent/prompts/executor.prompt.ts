export function buildExecutorRepairPrompt(
  stepDescription: string,
  failedSql: string,
  errorMessage: string,
  databaseType: string,
): string {
  return `You are fixing a SQL error. Return ONLY the corrected SQL — no explanation, no markdown fences.

Database: ${databaseType}
Step: ${stepDescription}
Error: ${errorMessage}

Failed SQL:
${failedSql}`;
}

export function buildPythonGenerationPrompt(
  stepDescription: string,
  strategy: string,
  sqlData: string,
  priorContext: string,
  datasetSchemas: string,
): string {
  return `You are the executor of a data analytics agent. Write Python code to complete the following step.

## Step
${stepDescription}
Strategy: ${strategy}

## SQL result data (pipe-delimited)
${sqlData || '(no SQL data for this step)'}

## Prior step outputs
${priorContext || '(none)'}

## Dataset schemas
${datasetSchemas || '(not available)'}

## Instructions
- Available libraries: pandas, numpy, matplotlib, seaborn, scipy, json, datetime
- Read the SQL data using: \`import io; df = pd.read_csv(io.StringIO(data), sep='|')\`
- Print your final result as JSON to stdout
- For charts: use matplotlib, save to buffer as base64, print as \`{"chart": "<base64>"}\`
- Do not print intermediate debug output — only the final result
- Handle edge cases: empty data, nulls, division by zero

Return only the Python code, no explanation.`;
}

export function buildChartSpecPrompt(
  stepDescription: string,
  chartType: string,
  sqlData: string,
  priorContext: string,
): string {
  return `You are generating a chart specification from query results.

## Step
${stepDescription}
Requested chart type: ${chartType}

## Data (pipe-delimited)
${sqlData || '(no data)'}

## Prior context
${priorContext || '(none)'}

## Output
Return a JSON chart spec:
{
  "type": "${chartType}",
  "title": "<descriptive title>",
  "xKey": "<column name for x-axis>",
  "yKey": "<column name for y-axis>",
  "xLabel": "<x-axis label>",
  "yLabel": "<y-axis label>",
  "data": [<array of row objects from the data above>]
}

Rules:
- xKey and yKey must be actual column names from the data
- data must be the actual rows from the SQL result (max 100 rows)
- title should describe what the chart shows`;
}

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';

export type AgentTask =
  | 'labeling'           // pipeline: label map generation (Azure gpt-5-mini preferred)
  | 'narration'          // plain-English answer formatting
  | 'judging'            // result comparison, judge agent
  | 'sql_generation'     // CoT-guided SQL, path 2
  | 'sql_template'       // few-shot template adaptation, path 3
  | 'reasoning'          // query decomposition, CoT plan generation
  | 'classification'     // pipeline: deprecated alias → use semantic_inference
  | 'semantic_inference' // pipeline agents 05 & 07: business rules + concept classifier
  | 'correction';        // error classification, correction plan

let _ollamaClient: ReturnType<typeof createOpenAICompatible> | null = null;
function getOllamaClient(): ReturnType<typeof createOpenAICompatible> {
  if (!_ollamaClient) {
    _ollamaClient = createOpenAICompatible({
      name: 'ollama',
      baseURL: process.env['OLLAMA_BASE_URL'] ?? 'https://ollama.com/v1',
      apiKey: process.env['OLLAMA_API_KEY'] ?? '',
    });
  }
  return _ollamaClient;
}

let _azureClient: ReturnType<typeof createAzure> | null = null;
function getAzureClient(): ReturnType<typeof createAzure> | null {
  const apiKey = process.env['AZURE_API_KEY'];
  const resourceName = process.env['AZURE_RESOURCE_NAME'];
  if (!apiKey || !resourceName) return null;
  if (!_azureClient) {
    _azureClient = createAzure({
      resourceName,
      apiKey,
    });
  }
  return _azureClient;
}

/** Returns the Azure gpt-5-mini model when Azure is configured, null otherwise. */
function azurePipelineModel(): LanguageModel | null {
  const azure = getAzureClient();
  if (!azure) return null;
  const deployment = process.env['AZURE_OPENAI_DEPLOYMENT'] ?? 'gpt-5-mini';
  return azure.chat(deployment);
}

export function routeModel(task: AgentTask): LanguageModel {
  const ollama = getOllamaClient();

  switch (task) {
    case 'labeling':
      // Azure gpt-5-mini preferred; falls back to small Ollama model
      return azurePipelineModel() ?? ollama.languageModel(process.env['OLLAMA_REASONING_SMALL'] ?? 'nemotron-3-nano:30b-cloud');

    case 'classification':
      // Legacy alias — same routing as semantic_inference
      return ollama.languageModel(process.env['OLLAMA_PIPELINE_MODEL'] ?? 'deepseek-v4-flash:cloud');

    case 'semantic_inference':
      // Pipeline agents 05 & 07: thinking + JSON reliability at 1M context
      return ollama.languageModel(process.env['OLLAMA_PIPELINE_MODEL'] ?? 'deepseek-v4-flash:cloud');

    case 'narration':
      // Fast structured output for answer formatting
      return ollama.languageModel(process.env['OLLAMA_REASONING_SMALL'] ?? 'nemotron-3-nano:30b-cloud');

    case 'judging':
    case 'reasoning':
    case 'correction':
      // Thinking mode, 1M context, SOTA agentic coding
      return ollama.languageModel(process.env['OLLAMA_REASONING_MODEL'] ?? 'deepseek-v4-flash:cloud');

    case 'sql_generation':
    case 'sql_template':
      // Purpose-built for code and SQL generation
      return ollama.languageModel(process.env['OLLAMA_SQL_MODEL'] ?? 'qwen3-coder-next:cloud');

    default:
      return ollama.languageModel(process.env['OLLAMA_REASONING_MODEL'] ?? 'deepseek-v4-flash:cloud');
  }
}

// DeepSeek-R1 wraps thinking in <think>...</think> tags.
// Strip them for downstream parsing but log them for debugging.
export function extractR1Response(raw: string): {
  thinking: string | null;
  answer: string;
} {
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
  const thinking = thinkMatch?.[1]?.trim() ?? null;
  const answer = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { thinking, answer };
}

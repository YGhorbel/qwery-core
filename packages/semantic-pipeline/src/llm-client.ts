import OpenAI from 'openai';
import { generateText, type LanguageModel } from 'ai';

let _client: OpenAI | null = null;

export function getLlmClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env['AZURE_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'];
    const azureResource = process.env['AZURE_RESOURCE_NAME'];
    const azureDeployment = process.env['AZURE_OPENAI_DEPLOYMENT'];

    if (azureResource && azureDeployment && process.env['AZURE_API_KEY']) {
      _client = new OpenAI({
        apiKey: process.env['AZURE_API_KEY'],
        baseURL: `https://${azureResource}.openai.azure.com/openai/deployments/${azureDeployment}`,
        defaultHeaders: { 'api-key': process.env['AZURE_API_KEY'] },
      });
    } else {
      _client = new OpenAI({ apiKey });
    }
  }
  return _client;
}

export async function chatComplete(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options?: { maxTokens?: number },
  model?: LanguageModel,
): Promise<string> {
  // When a routed model is provided, use AI SDK directly
  if (model) {
    const { text } = await generateText({
      model,
      messages,
      maxOutputTokens: options?.maxTokens ?? 2048,
    });
    return text;
  }

  // Fallback: existing OpenAI SDK path (Azure or OpenAI)
  const client = getLlmClient();
  const modelId = process.env['AZURE_OPENAI_DEPLOYMENT'] ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini';
  const response = await client.chat.completions.create({
    model: modelId,
    messages,
    max_completion_tokens: options?.maxTokens ?? 2048,
  });
  return response.choices[0]?.message?.content ?? '';
}

import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';

export type ChatModel = AzureChatOpenAI | ChatOpenAI | ChatAnthropic;

export function getChatModel(temperature = 1): ChatModel {
  const azureApiKey =
    process.env['AZURE_API_KEY'] ?? process.env['AZURE_OPENAI_API_KEY'];
  const azureEndpoint =
    process.env['AZURE_RESOURCE_NAME'] ?? process.env['AZURE_OPENAI_ENDPOINT'];
  const azureDeployment = process.env['AZURE_OPENAI_DEPLOYMENT'];
  const azureApiVersion =
    process.env['AZURE_OPENAI_API_VERSION'] ?? '2024-08-01-preview';
  const azureAvailable = !!(azureApiKey && azureEndpoint && azureDeployment);

  // Explicit provider wins; otherwise auto-detect from available credentials
  const provider =
    process.env['LLM_DEFAULT_PROVIDER'] ??
    (azureAvailable ? 'azure' : 'openai');

  if (provider === 'anthropic') {
    return new ChatAnthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'],
      model: process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-6',
      temperature,
    });
  }

  if (provider === 'azure' && azureAvailable) {
    return new AzureChatOpenAI({
      azureOpenAIApiKey: azureApiKey,
      azureOpenAIApiInstanceName: azureEndpoint,
      azureOpenAIApiDeploymentName: azureDeployment,
      azureOpenAIApiVersion: azureApiVersion,
      temperature,
    });
  }

  return new ChatOpenAI({
    apiKey: process.env['OPENAI_API_KEY'],
    model: process.env['OPENAI_MODEL'] ?? 'gpt-4o',
    temperature,
  });
}

export function extractJsonFromText(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    return JSON.parse(fenceMatch[1].trim());
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error('No JSON found in LLM response');
}

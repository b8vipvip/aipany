import {
  createLegacyLlmProviderPool,
  LlmProviderPool,
  parseLlmProviderPool,
  type ChatMessage as ProviderPoolChatMessage,
  type LlmProviderPoolConfig,
} from "./llm-provider-pool.js";

export type ChatMessage = ProviderPoolChatMessage;

export interface OpenAiCompatibleLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export class OpenAiCompatibleLlm {
  private readonly pool: LlmProviderPool;

  constructor(private readonly config: OpenAiCompatibleLlmConfig) {
    this.pool = new LlmProviderPool(readProviderPool(config));
  }

  async streamChat(options: {
    messages: ChatMessage[];
    signal: AbortSignal;
    onDelta: (delta: string) => Promise<void> | void;
  }): Promise<void> {
    await this.pool.streamChat(options);
  }
}

function readProviderPool(config: OpenAiCompatibleLlmConfig): LlmProviderPoolConfig {
  const runtime = process.env.LLM_PROVIDER_POOL_JSON?.trim();
  if (!runtime) {
    return createLegacyLlmProviderPool({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  try {
    return parseLlmProviderPool(JSON.parse(runtime));
  } catch (error) {
    throw new Error(`LLM Provider Pool 运行时配置无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

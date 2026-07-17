import { createHash } from "node:crypto";

import { VoiceSessionError } from "../errors.js";
import type {
  ProviderSessionBootstrap,
  ProviderSessionRequest,
  RealtimeProvider,
  TurnDetectionEagerness,
} from "../types.js";

interface OpenAIRealtimeProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  eagerness?: TurnDetectionEagerness;
  fetchImpl?: typeof fetch;
}

interface OpenAIClientSecretResponse {
  value?: unknown;
  expires_at?: unknown;
}

/**
 * OpenAI Realtime 适配器只处理供应商协议转换。
 * 业务层永远不应该直接依赖 OpenAI 原生响应结构。
 */
export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly name = "openai" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly eagerness: TurnDetectionEagerness;

  constructor(private readonly options: OpenAIRealtimeProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.eagerness = options.eagerness ?? "low";
  }

  async createSession(input: ProviderSessionRequest): Promise<ProviderSessionBootstrap> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        // 使用不可逆摘要作为稳定的安全标识，不向供应商暴露内部用户 ID。
        "OpenAI-Safety-Identifier": this.createSafetyIdentifier(input.userId),
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: this.options.model,
          audio: {
            input: {
              turn_detection: {
                type: "semantic_vad",
                eagerness: this.eagerness,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              voice: this.options.voice,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new VoiceSessionError(
        "PROVIDER_REJECTED",
        "实时语音供应商拒绝创建会话",
        502,
        {
          provider: this.name,
          providerStatus: response.status,
          providerRequestId: response.headers.get("x-request-id") ?? undefined,
        },
      );
    }

    const data = (await response.json()) as OpenAIClientSecretResponse;

    if (typeof data.value !== "string" || typeof data.expires_at !== "number") {
      throw new VoiceSessionError(
        "PROVIDER_UNAVAILABLE",
        "实时语音供应商返回了无法识别的会话凭证",
        502,
        { provider: this.name },
      );
    }

    return {
      provider: this.name,
      transport: "webrtc",
      clientSecret: data.value,
      expiresAt: new Date(data.expires_at * 1000).toISOString(),
      endpoint: `${this.options.baseUrl}/realtime/calls`,
      model: this.options.model,
      voice: this.options.voice,
      turnDetection: {
        type: "semantic_vad",
        eagerness: this.eagerness,
        createResponse: true,
        interruptResponse: true,
      },
    };
  }

  private createSafetyIdentifier(userId: string): string {
    return createHash("sha256").update(userId).digest("hex");
  }
}
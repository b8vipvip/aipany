import type {
  AudioFormatDescriptor,
  SpeakerEmbeddingProvider,
  SpeakerEmbeddingResult,
  SpeakerIntelligenceCapabilities,
} from "../types.js";

export interface HttpSpeakerIntelligenceProviderOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

/**
 * 通过内部 HTTP 服务调用 Speaker Intelligence。
 * Gateway 只依赖统一协议，底层可以替换成 SpeechBrain、NeMo、云 API 或自研模型。
 */
export class HttpSpeakerIntelligenceProvider implements SpeakerEmbeddingProvider {
  readonly name = "http-speaker-intelligence";
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: HttpSpeakerIntelligenceProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 2500;
  }

  async getCapabilities(): Promise<SpeakerIntelligenceCapabilities> {
    const response = await this.request("/v1/capabilities", { method: "GET" });
    const payload = await response.json() as Partial<SpeakerIntelligenceCapabilities>;
    return {
      embeddings: Boolean(payload.embeddings),
      verification: Boolean(payload.verification),
      diarization: Boolean(payload.diarization),
      streamingDiarization: Boolean(payload.streamingDiarization),
      targetSpeakerExtraction: Boolean(payload.targetSpeakerExtraction),
    };
  }

  async extractEmbedding(audio: Buffer, format: AudioFormatDescriptor): Promise<SpeakerEmbeddingResult> {
    if (audio.length === 0) throw new Error("Speaker Intelligence 收到空音频");

    const query = new URLSearchParams({
      encoding: format.encoding,
      sample_rate: String(format.sampleRate),
      channels: String(format.channels),
    });
    const response = await this.request(`/v1/embedding?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: audio,
    });

    const payload = await response.json() as {
      embedding?: unknown;
      quality?: unknown;
      duration_ms?: unknown;
      model?: unknown;
      dimensions?: unknown;
    };

    if (!Array.isArray(payload.embedding) || payload.embedding.length < 2) {
      throw new Error("Speaker Intelligence 返回了无效声纹向量");
    }
    const embedding = payload.embedding.map((value) => Number(value));
    if (embedding.some((value) => !Number.isFinite(value))) {
      throw new Error("Speaker Intelligence 声纹向量包含非法数值");
    }

    return {
      embedding,
      quality: clamp(Number(payload.quality ?? 0.8), 0, 1),
      durationMs: Math.max(0, Number(payload.duration_ms ?? estimateDurationMs(audio, format))),
      model: typeof payload.model === "string" ? payload.model : undefined,
      dimensions: Number.isFinite(Number(payload.dimensions)) ? Number(payload.dimensions) : embedding.length,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.request("/health", { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Speaker Intelligence HTTP ${response.status}：${body.slice(0, 500)}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

function estimateDurationMs(audio: Buffer, format: AudioFormatDescriptor): number {
  const bytesPerSample = format.encoding === "pcm_f32le" ? 4 : format.encoding === "pcm_s16le" ? 2 : 0;
  if (bytesPerSample === 0) return 0;
  return audio.length / bytesPerSample / Math.max(1, format.channels) / Math.max(1, format.sampleRate) * 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

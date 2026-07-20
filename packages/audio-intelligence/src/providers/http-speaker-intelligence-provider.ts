import type {
  AudioFormatDescriptor,
  EnvironmentContext,
  SpeakerDiarizationSegment,
  SpeakerEmbeddingProvider,
  SpeakerEmbeddingResult,
  SpeakerIntelligenceCapabilities,
  SpeakerProximity,
  TargetSpeakerExtractionResult,
  UtteranceAudioAnalysis,
  UtteranceAudioAnalysisOptions,
  UtteranceAudioAnalysisProvider,
} from "../types.js";

export interface HttpSpeakerIntelligenceProviderOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  analysisTimeoutMs?: number;
}

/**
 * 通过内部 HTTP 服务调用 Aipany Audio/Speaker Intelligence。
 * Gateway 只依赖统一协议，底层可以替换成 SpeechBrain、NeMo、云 API 或自研模型。
 */
export class HttpSpeakerIntelligenceProvider implements SpeakerEmbeddingProvider, UtteranceAudioAnalysisProvider {
  readonly name = "http-speaker-intelligence";
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly analysisTimeoutMs: number;

  constructor(options: HttpSpeakerIntelligenceProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 2500;
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? Math.max(this.timeoutMs, 15000);
  }

  async getCapabilities(): Promise<SpeakerIntelligenceCapabilities> {
    const response = await this.request("/v1/capabilities", { method: "GET" });
    const payload = await response.json() as Partial<Record<keyof SpeakerIntelligenceCapabilities, unknown>>;
    return {
      embeddings: Boolean(payload.embeddings),
      verification: Boolean(payload.verification),
      diarization: Boolean(payload.diarization),
      streamingDiarization: Boolean(payload.streamingDiarization),
      overlapDetection: Boolean(payload.overlapDetection),
      speechSeparation: Boolean(payload.speechSeparation),
      targetSpeakerExtraction: Boolean(payload.targetSpeakerExtraction),
      environmentAnalysis: Boolean(payload.environmentAnalysis),
      segmentTranscription: Boolean(payload.segmentTranscription),
    };
  }

  async extractEmbedding(audio: Buffer, format: AudioFormatDescriptor): Promise<SpeakerEmbeddingResult> {
    if (audio.length === 0) throw new Error("Speaker Intelligence 收到空音频");

    const response = await this.request(`/v1/embedding?${formatQuery(format)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: Uint8Array.from(audio),
    });

    const payload = await response.json() as Record<string, unknown>;
    return parseEmbeddingPayload(payload, audio, format);
  }

  async analyzeUtterance(
    audio: Buffer,
    format: AudioFormatDescriptor,
    options: UtteranceAudioAnalysisOptions = {},
  ): Promise<UtteranceAudioAnalysis> {
    if (audio.length === 0) throw new Error("Audio Intelligence 收到空音频");

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (options.sessionId) headers["X-Aipany-Session-Id"] = options.sessionId;
    if (options.mode) headers["X-Aipany-Mode"] = options.mode;
    if (options.language) headers["X-Aipany-Language"] = options.language;
    if (options.includeTranscript !== undefined) {
      headers["X-Aipany-Include-Transcript"] = String(options.includeTranscript);
    }
    if (options.enableSeparation !== undefined) {
      headers["X-Aipany-Enable-Separation"] = String(options.enableSeparation);
    }
    if (options.enableEnvironment !== undefined) {
      headers["X-Aipany-Enable-Environment"] = String(options.enableEnvironment);
    }
    if (options.ownerEmbedding?.length) {
      headers["X-Aipany-Owner-Embedding"] = Buffer.from(JSON.stringify(options.ownerEmbedding), "utf8").toString("base64url");
    }

    const response = await this.request(`/v1/analyze?${formatQuery(format)}`, {
      method: "POST",
      headers,
      body: Uint8Array.from(audio),
    }, this.analysisTimeoutMs);
    const payload = await response.json() as Record<string, unknown>;
    const embedding = parseEmbeddingPayload(payload, audio, format);

    return {
      ...embedding,
      proximity: parseProximity(payload.proximity),
      diarization: parseDiarization(payload.diarization),
      overlapDetected: Boolean(payload.overlap_detected),
      environment: parseEnvironment(payload.environment),
      targetSpeaker: parseTargetSpeaker(payload.target_speaker),
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

  private async request(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        throw new Error(`Audio Intelligence HTTP ${response.status}：${body.slice(0, 500)}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

function formatQuery(format: AudioFormatDescriptor): string {
  return new URLSearchParams({
    encoding: format.encoding,
    sample_rate: String(format.sampleRate),
    channels: String(format.channels),
  }).toString();
}

function parseEmbeddingPayload(
  payload: Record<string, unknown>,
  audio: Buffer,
  format: AudioFormatDescriptor,
): SpeakerEmbeddingResult {
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

function parseDiarization(value: unknown): SpeakerDiarizationSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: SpeakerDiarizationSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const speakerId = typeof raw.speaker_id === "string" ? raw.speaker_id : undefined;
    const startMs = Number(raw.start_ms);
    const endMs = Number(raw.end_ms);
    const confidence = Number(raw.confidence ?? 0);
    if (!speakerId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const embedding = Array.isArray(raw.embedding)
      ? raw.embedding.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      : undefined;
    segments.push({
      speakerId,
      startMs: Math.max(0, startMs),
      endMs: Math.max(startMs, endMs),
      confidence: clamp(Number.isFinite(confidence) ? confidence : 0, 0, 1),
      overlap: Boolean(raw.overlap),
      embedding: embedding && embedding.length >= 2 ? embedding : undefined,
      transcript: typeof raw.transcript === "string" && raw.transcript.trim() ? raw.transcript.trim() : undefined,
    });
  }
  return segments;
}

function parseEnvironment(value: unknown): EnvironmentContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const events = Array.isArray(raw.events)
    ? raw.events.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const event = item as Record<string, unknown>;
        if (typeof event.type !== "string") return [];
        const confidence = Number(event.confidence ?? 0);
        return [{ type: event.type, confidence: clamp(Number.isFinite(confidence) ? confidence : 0, 0, 1) }];
      })
    : [];
  const noiseLevel = ["quiet", "low", "medium", "high", "very_high"].includes(String(raw.noise_level))
    ? raw.noise_level as EnvironmentContext["noiseLevel"]
    : undefined;
  const sceneConfidence = Number(raw.scene_confidence);
  return {
    scene: typeof raw.scene === "string" ? raw.scene : undefined,
    sceneConfidence: Number.isFinite(sceneConfidence) ? clamp(sceneConfidence, 0, 1) : undefined,
    noiseLevel,
    events,
    capturedAt: Number.isFinite(Number(raw.captured_at)) ? Number(raw.captured_at) : Date.now(),
  };
}

function parseTargetSpeaker(value: unknown): TargetSpeakerExtractionResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const similarity = Number(raw.similarity ?? 0);
  const confidence = Number(raw.confidence ?? 0);
  let audio: Buffer | undefined;
  if (typeof raw.audio_base64 === "string" && raw.audio_base64) {
    try {
      audio = Buffer.from(raw.audio_base64, "base64");
    } catch {
      audio = undefined;
    }
  }
  return {
    matched: Boolean(raw.matched),
    similarity: clamp(Number.isFinite(similarity) ? similarity : 0, -1, 1),
    confidence: clamp(Number.isFinite(confidence) ? confidence : 0, 0, 1),
    transcript: typeof raw.transcript === "string" && raw.transcript.trim() ? raw.transcript.trim() : undefined,
    audio,
  };
}

function parseProximity(value: unknown): SpeakerProximity | undefined {
  const normalized = String(value ?? "");
  return ["very_near", "near", "medium", "far", "background", "unknown"].includes(normalized)
    ? normalized as SpeakerProximity
    : undefined;
}

function estimateDurationMs(audio: Buffer, format: AudioFormatDescriptor): number {
  const bytesPerSample = format.encoding === "pcm_f32le" ? 4 : format.encoding === "pcm_s16le" ? 2 : 0;
  if (bytesPerSample === 0) return 0;
  return audio.length / bytesPerSample / Math.max(1, format.channels) / Math.max(1, format.sampleRate) * 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

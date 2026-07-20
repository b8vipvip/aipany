import type { AudioFormatDescriptor, EnvironmentContext, SpeakerDiarizationSegment } from "../types.js";
import type { CloudAudioAnalysis, CloudAudioAnalysisOptions, CloudAudioAnalysisProvider } from "./hybrid-audio-intelligence-provider.js";

export interface QwenOmniCloudAudioProviderOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class QwenOmniCloudAudioProvider implements CloudAudioAnalysisProvider {
  readonly name = "qwen-omni-cloud-audio";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: QwenOmniCloudAudioProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model ?? "qwen3.5-omni-flash";
    this.timeoutMs = options.timeoutMs ?? 20000;
  }

  async analyzeCloudAudio(audio: Buffer, format: AudioFormatDescriptor, options: CloudAudioAnalysisOptions = {}): Promise<CloudAudioAnalysis> {
    if (audio.length === 0) throw new Error("Qwen Omni 收到空音频");
    const wav = encodeWav(audio, format);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: [
            { type: "input_audio", input_audio: { data: `data:;base64,${wav.toString("base64")}`, format: "wav" } },
            { type: "text", text: buildPrompt(options) },
          ] }],
          modalities: ["text"],
          stream: true,
          stream_options: { include_usage: true },
          enable_thinking: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Qwen Omni HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return parseAnalysis(parseJson(collectSseText(await response.text())), options, this.name);
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildPrompt(options: CloudAudioAnalysisOptions): string {
  return [
    "分析这段短音频，只返回合法 JSON，不要 Markdown 或解释。",
    `语言提示：${options.language || "auto"}。`,
    options.includeEnvironment ? "分析场景、噪声等级和显著非语音事件。" : "environment 返回 null。",
    options.includeDiarization ? "区分说话人并逐段转写，时间单位毫秒。" : "segments 返回空数组。",
    "noiseLevel 只能为 quiet、low、medium、high、very_high。",
    'JSON结构：{"environment":{"scene":"string","sceneConfidence":0.8,"noiseLevel":"low","events":[{"type":"event","confidence":0.8}]},"segments":[{"speakerId":"speaker_1","startMs":0,"endMs":1000,"confidence":0.9,"overlap":false,"transcript":"text"}]}',
  ].join("\n");
}

function encodeWav(audio: Buffer, format: AudioFormatDescriptor): Buffer {
  if (format.encoding === "opus") throw new Error("Cloud Audio Provider 需要 PCM 输入");
  const bits = format.encoding === "pcm_f32le" ? 32 : 16;
  const wavFormat = format.encoding === "pcm_f32le" ? 3 : 1;
  const align = format.channels * bits / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + audio.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(wavFormat, 20);
  header.writeUInt16LE(format.channels, 22); header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * align, 28); header.writeUInt16LE(align, 32); header.writeUInt16LE(bits, 34);
  header.write("data", 36); header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

function collectSseText(input: string): string {
  let output = "";
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.delta?.content;
      if (typeof content === "string") output += content;
    } catch { /* ignore malformed chunks */ }
  }
  if (!output.trim()) throw new Error("Qwen Omni 未返回文本分析结果");
  return output;
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Qwen Omni 返回内容不包含 JSON");
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Qwen Omni JSON 结构无效");
  return value as Record<string, unknown>;
}

function parseAnalysis(payload: Record<string, unknown>, options: CloudAudioAnalysisOptions, provider: string): CloudAudioAnalysis {
  return {
    provider,
    environment: options.includeEnvironment ? parseEnvironment(payload.environment) : undefined,
    diarization: options.includeDiarization ? parseSegments(payload.segments) : [],
  };
}

function parseEnvironment(value: unknown): EnvironmentContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const noise = String(raw.noiseLevel ?? raw.noise_level ?? "");
  const noiseLevel = ["quiet", "low", "medium", "high", "very_high"].includes(noise) ? noise as EnvironmentContext["noiseLevel"] : undefined;
  const confidence = Number(raw.sceneConfidence ?? raw.scene_confidence);
  const events = Array.isArray(raw.events) ? raw.events.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const event = item as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type.trim() : "";
    return type ? [{ type, confidence: clamp(Number(event.confidence ?? 0), 0, 1) }] : [];
  }) : [];
  return { scene: typeof raw.scene === "string" ? raw.scene : undefined, sceneConfidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : undefined, noiseLevel, events, capturedAt: Date.now() };
}

function parseSegments(value: unknown): SpeakerDiarizationSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const speakerId = String(raw.speakerId ?? raw.speaker_id ?? "").trim();
    const startMs = Number(raw.startMs ?? raw.start_ms); const endMs = Number(raw.endMs ?? raw.end_ms);
    if (!speakerId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    return [{ speakerId, startMs: Math.max(0, startMs), endMs, confidence: clamp(Number(raw.confidence ?? 0.8), 0, 1), overlap: Boolean(raw.overlap), transcript: typeof raw.transcript === "string" && raw.transcript.trim() ? raw.transcript.trim() : undefined }];
  });
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

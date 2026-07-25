import { loadConfig } from "../config.js";
import {
  defaultVoiceForModel,
  getClientVoiceOptions,
} from "./client-capabilities.js";
import { SUPPORTED_NATIVE_REALTIME_MODELS } from "./realtime-experience.js";
import { QwenOmniRealtimeClient, type QwenOmniRealtimeConfig } from "../providers/qwen-omni-realtime.js";
import { QwenTtsRealtimeClient, type QwenTtsConfig } from "../providers/qwen-tts.js";

const PREVIEW_TEXT = "你好，我是小派。很高兴认识你，我们来轻松聊聊天吧。";
const PREVIEW_TIMEOUT_MS = 20_000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60 * 1000;

const ECONOMY_PREVIEW_INSTRUCTION = [
  "这是音色试听。",
  "请用自然、温暖、有真实交流感的中文口语朗读。",
  "语速舒缓但不拖沓，句间有轻微呼吸感，不要播音腔，不要扩展内容。",
].join("");

type RealtimeClientFactory = (config: QwenOmniRealtimeConfig) => QwenOmniRealtimeClient;
type EconomyClientFactory = (config: QwenTtsConfig, instructions: string) => QwenTtsRealtimeClient;

interface CachedPreview {
  createdAt: number;
  audio: Buffer;
}

/**
 * Renders the actual upstream model voice selected by the Android client.
 *
 * The historical class name is retained to avoid changing the HTTP wiring, but
 * the service now supports both Native Live and Economy Live TTS previews.
 */
export class NativeVoicePreviewService {
  private readonly cache = new Map<string, CachedPreview>();
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly nativeFactory: RealtimeClientFactory = (config) => new QwenOmniRealtimeClient(config),
    private readonly economyFactory: EconomyClientFactory = (config, instructions) => new QwenTtsRealtimeClient(config, instructions),
  ) {}

  async render(input: {
    apiKey: string;
    workspaceId?: string;
    baseUrl: string;
    model: string;
    voice: string;
  }): Promise<Buffer> {
    const runtimeConfig = loadConfig();
    const mode = validatePreviewSelection(input.model, input.voice, runtimeConfig.qwen.ttsModel, runtimeConfig.qwen.ttsVoice);
    if (mode === "native" && !input.apiKey.trim()) throw new Error("Native Live API Key 未配置");
    if (mode === "economy" && !runtimeConfig.qwen.apiKey.trim()) throw new Error("Economy Live DashScope API Key 未配置");

    const key = `${mode}|${input.model}|${input.voice}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return Buffer.from(cached.audio);
    const pending = this.inflight.get(key);
    if (pending) return Buffer.from(await pending);

    const promise = (mode === "native"
      ? this.generateNative(input)
      : this.generateEconomy({
          apiKey: runtimeConfig.qwen.apiKey,
          workspaceId: runtimeConfig.qwen.workspaceId,
          baseUrl: runtimeConfig.qwen.ttsBaseUrl,
          model: input.model,
          voice: input.voice,
          language: runtimeConfig.qwen.ttsLanguage,
          sampleRate: runtimeConfig.qwen.ttsSampleRate,
          optimizeInstructions: runtimeConfig.qwen.optimizeInstructions,
        }))
      .then((audio) => {
        this.cache.set(key, { createdAt: Date.now(), audio: Buffer.from(audio) });
        return audio;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return Buffer.from(await promise);
  }

  private async generateNative(input: {
    apiKey: string;
    workspaceId?: string;
    baseUrl: string;
    model: string;
    voice: string;
  }): Promise<Buffer> {
    const client = this.nativeFactory({
      apiKey: input.apiKey,
      workspaceId: input.workspaceId,
      baseUrl: input.baseUrl,
      model: input.model,
      voice: input.voice,
      instructions: "你正在进行音色试听。只自然朗读用户提供的一句话，不扩展、不解释、不添加其他内容。",
      turnDetection: "server_vad",
      vadThreshold: 0.2,
      silenceMs: 500,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    return await new Promise<Buffer>(async (resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.close();
        if (error) reject(error);
        else if (!bytes) reject(new Error("音色试听没有返回音频"));
        else resolve(Buffer.concat(chunks, bytes));
      };
      const timer = setTimeout(() => finish(new Error("音色试听生成超时")), PREVIEW_TIMEOUT_MS);
      timer.unref?.();

      client.on("audio", (_responseId, audio) => collectAudio(audio, chunks, () => bytes, (value) => { bytes = value; }, finish));
      client.on("responseDone", () => finish());
      client.on("error", (error) => finish(error));
      client.on("close", (code, reason) => {
        if (!settled) finish(new Error(`音色试听连接关闭：${code} ${reason}`.trim()));
      });

      try {
        await client.connect();
        if (!client.requestTextResponse(PREVIEW_TEXT)) {
          finish(new Error("音色试听请求发送失败"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async generateEconomy(input: QwenTtsConfig): Promise<Buffer> {
    const client = this.economyFactory(input, ECONOMY_PREVIEW_INSTRUCTION);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    return await new Promise<Buffer>(async (resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.cancel();
        if (error) reject(error);
        else if (!bytes) reject(new Error("Economy 音色试听没有返回音频"));
        else resolve(Buffer.concat(chunks, bytes));
      };
      const timer = setTimeout(() => finish(new Error("Economy 音色试听生成超时")), PREVIEW_TIMEOUT_MS);
      timer.unref?.();

      client.on("audio", (audio) => collectAudio(audio, chunks, () => bytes, (value) => { bytes = value; }, finish));
      client.on("finished", () => finish());
      client.on("error", (error) => finish(error));

      try {
        await client.connect();
        client.appendText(PREVIEW_TEXT);
        void client.finish().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export function validatePreviewSelection(
  model: string,
  voice: string,
  configuredEconomyModel = "",
  configuredEconomyVoice = "",
): "native" | "economy" {
  if ((SUPPORTED_NATIVE_REALTIME_MODELS as readonly string[]).includes(model)) {
    const allowed = getClientVoiceOptions(model, defaultVoiceForModel(model));
    if (!allowed.some((item) => item.id === voice && item.previewable !== false)) {
      throw new Error("当前 Native Live 模型不支持该试听音色");
    }
    return "native";
  }

  if (!configuredEconomyModel || model !== configuredEconomyModel) {
    throw new Error("当前 Economy Live 模型与服务器配置不一致");
  }
  const allowed = getClientVoiceOptions(model, configuredEconomyVoice || defaultVoiceForModel(model));
  if (!allowed.some((item) => item.id === voice && item.previewable !== false)) {
    throw new Error("当前 Economy Live 模型不支持该试听音色");
  }
  return "economy";
}

function collectAudio(
  audio: Buffer,
  chunks: Buffer[],
  getBytes: () => number,
  setBytes: (value: number) => void,
  finish: (error?: Error) => void,
): void {
  if (audio.length === 0) return;
  const nextBytes = getBytes() + audio.length;
  if (nextBytes > MAX_PREVIEW_BYTES) {
    finish(new Error("音色试听音频超过大小限制"));
    return;
  }
  chunks.push(Buffer.from(audio));
  setBytes(nextBytes);
}

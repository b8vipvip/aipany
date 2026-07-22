import {
  defaultVoiceForModel,
  getClientVoiceOptions,
} from "./client-capabilities.js";
import { SUPPORTED_NATIVE_REALTIME_MODELS } from "./realtime-experience.js";
import { QwenOmniRealtimeClient, type QwenOmniRealtimeConfig } from "../providers/qwen-omni-realtime.js";

const PREVIEW_TEXT = "你好，我是小派。很高兴认识你，我们来轻松聊聊天吧。";
const PREVIEW_TIMEOUT_MS = 20_000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60 * 1000;

type RealtimeClientFactory = (config: QwenOmniRealtimeConfig) => QwenOmniRealtimeClient;

interface CachedPreview {
  createdAt: number;
  audio: Buffer;
}

export class NativeVoicePreviewService {
  private readonly cache = new Map<string, CachedPreview>();
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor(private readonly factory: RealtimeClientFactory = (config) => new QwenOmniRealtimeClient(config)) {}

  async render(input: {
    apiKey: string;
    workspaceId?: string;
    baseUrl: string;
    model: string;
    voice: string;
  }): Promise<Buffer> {
    validatePreviewSelection(input.model, input.voice);
    if (!input.apiKey.trim()) throw new Error("Native Live API Key 未配置");

    const key = `${input.model}|${input.voice}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return Buffer.from(cached.audio);
    const pending = this.inflight.get(key);
    if (pending) return Buffer.from(await pending);

    const promise = this.generate(input)
      .then((audio) => {
        this.cache.set(key, { createdAt: Date.now(), audio: Buffer.from(audio) });
        return audio;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return Buffer.from(await promise);
  }

  private async generate(input: {
    apiKey: string;
    workspaceId?: string;
    baseUrl: string;
    model: string;
    voice: string;
  }): Promise<Buffer> {
    const client = this.factory({
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

      client.on("audio", (_responseId, audio) => {
        if (settled || audio.length === 0) return;
        if (bytes + audio.length > MAX_PREVIEW_BYTES) {
          finish(new Error("音色试听音频超过大小限制"));
          return;
        }
        chunks.push(Buffer.from(audio));
        bytes += audio.length;
      });
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
}

export function validatePreviewSelection(model: string, voice: string): void {
  if (!(SUPPORTED_NATIVE_REALTIME_MODELS as readonly string[]).includes(model)) {
    throw new Error("不支持的 Native Live 模型");
  }
  const allowed = getClientVoiceOptions(model, defaultVoiceForModel(model));
  if (!allowed.some((item) => item.id === voice && item.previewable !== false)) {
    throw new Error("当前模型不支持该试听音色");
  }
}

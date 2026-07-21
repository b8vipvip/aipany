import WebSocket from "ws";
import { loadConfig } from "../config.js";
import {
  createLegacyLlmProviderPool,
  getLlmRoutingSnapshot,
  parseLlmProviderPool,
  type LlmProviderPoolConfig,
  type LlmRequestTrace,
} from "../providers/llm-provider-pool.js";
import { QwenTtsRealtimeClient } from "../providers/qwen-tts.js";

export interface AdminE2eTestResult {
  ok: boolean;
  inputTtsBytes: number;
  transcript: string;
  answerText: string;
  responseAudioBytes: number;
  llmRouteTrace?: LlmRequestTrace;
  timings: {
    inputTtsMs: number;
    sessionReadyMs: number;
    asrFinalMs?: number;
    llmFirstTokenMs?: number;
    totalMs: number;
  };
}

interface RealtimeRoundTripResult {
  transcript: string;
  answerText: string;
  responseAudioBytes: number;
  sessionReadyMs: number;
  asrFinalMs?: number;
  llmFirstTokenMs?: number;
  responseCreatedAt?: number;
}

export async function runAdminE2eTest(): Promise<AdminE2eTestResult> {
  const startedAt = Date.now();
  const config = loadConfig();
  if (!config.qwen.apiKey) throw new Error("DASHSCOPE_API_KEY 未配置");
  const gatewayToken = config.server.token;
  if (!gatewayToken) throw new Error("完整 E2E 自检需要配置 AIPANY_GATEWAY_TOKEN");

  const inputTtsStartedAt = Date.now();
  const inputAudio24k = await synthesizeTestSpeech(config);
  const inputTtsMs = Date.now() - inputTtsStartedAt;
  if (!inputAudio24k.length) throw new Error("测试输入 TTS 没有生成音频");

  const pcm16k = downsample24kTo16k(inputAudio24k);
  const trailingSilence = Buffer.alloc(Math.floor(16000 * 2 * 1.5));
  const testAudio = Buffer.concat([pcm16k, trailingSilence]);
  const result = await runRealtimeRoundTrip({
    token: gatewayToken,
    port: config.server.port,
    audio: testAudio,
    startedAt,
  });

  const routing = getLlmRoutingSnapshot(readCurrentProviderPool(config), 50);
  const traceBoundary = result.responseCreatedAt ?? startedAt;
  const llmRouteTrace = routing.recentRequests
    .filter((trace) => trace.startedAt >= traceBoundary - 500)
    .sort((a, b) => Math.abs(a.startedAt - traceBoundary) - Math.abs(b.startedAt - traceBoundary))[0];

  return {
    ok: Boolean(result.transcript && result.answerText && result.responseAudioBytes > 0),
    inputTtsBytes: inputAudio24k.length,
    transcript: result.transcript,
    answerText: result.answerText,
    responseAudioBytes: result.responseAudioBytes,
    llmRouteTrace,
    timings: {
      inputTtsMs,
      sessionReadyMs: result.sessionReadyMs,
      asrFinalMs: result.asrFinalMs,
      llmFirstTokenMs: result.llmFirstTokenMs,
      totalMs: Date.now() - startedAt,
    },
  };
}

async function synthesizeTestSpeech(config: ReturnType<typeof loadConfig>): Promise<Buffer> {
  return await withTimeout(async () => {
    const tts = new QwenTtsRealtimeClient({
      apiKey: config.qwen.apiKey,
      workspaceId: config.qwen.workspaceId,
      baseUrl: config.qwen.ttsBaseUrl,
      model: config.qwen.ttsModel,
      voice: config.qwen.ttsVoice,
      language: config.qwen.ttsLanguage,
      sampleRate: 24000,
      optimizeInstructions: false,
    }, "自然、清晰地朗读");
    const chunks: Buffer[] = [];
    let ttsError: Error | undefined;
    tts.on("audio", (chunk) => chunks.push(chunk));
    tts.on("error", (error) => { ttsError = error; });
    await tts.connect();
    tts.appendText("你好小派，请简单介绍一下你自己。");
    await tts.finish();
    if (ttsError) throw ttsError;
    return Buffer.concat(chunks);
  }, 45000, "生成 E2E 测试语音超时");
}

async function runRealtimeRoundTrip(input: {
  token: string;
  port: number;
  audio: Buffer;
  startedAt: number;
}): Promise<RealtimeRoundTripResult> {
  return await withTimeout(async () => await new Promise<RealtimeRoundTripResult>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${input.port}/v1/realtime?token=${encodeURIComponent(input.token)}`);
    let transcript = "";
    let answerText = "";
    let responseAudioBytes = 0;
    let sessionReadyMs = 0;
    let asrFinalMs: number | undefined;
    let llmStartedAt = 0;
    let llmFirstTokenMs: number | undefined;
    let responseCreatedAt: number | undefined;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve({ transcript, answerText, responseAudioBytes, sessionReadyMs, asrFinalMs, llmFirstTokenMs, responseCreatedAt });
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.start",
        session: {
          tenantId: "deployment-test",
          userId: "deployment-test-user",
          agentId: "default-agent",
          locale: "zh-CN",
          assistantAliases: ["Aipany", "小派"],
          interactionMode: "auto",
          socialProactivity: 0.45,
          inputAudio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
          device: {
            deviceId: "admin-e2e-test",
            productId: "aipany-admin-e2e",
            deviceType: "unknown",
            platform: "server",
          },
        },
      }));
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        responseAudioBytes += Buffer.from(raw as Buffer).length;
        return;
      }
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw.toString()) as Record<string, unknown>; }
      catch { return; }
      const type = event.type;

      if (type === "session.ready") {
        sessionReadyMs = Date.now() - input.startedAt;
        void streamAudio(ws, input.audio).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (type === "transcript.final") {
        transcript = typeof event.text === "string" ? event.text : "";
        asrFinalMs = Date.now() - input.startedAt;
        llmStartedAt = Date.now();
        return;
      }
      if (type === "response.created") {
        responseCreatedAt = Date.now();
        return;
      }
      if (type === "response.text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta && llmFirstTokenMs === undefined && llmStartedAt) llmFirstTokenMs = Date.now() - llmStartedAt;
        answerText += delta;
        return;
      }
      if (type === "error") {
        const code = typeof event.code === "string" ? event.code : "UNKNOWN";
        const message = typeof event.message === "string" ? event.message : "未知错误";
        const retryable = event.retryable === true;
        if (!retryable || code === "PIPELINE_ERROR" || code === "TTS_ERROR" || code === "ASR_ERROR") {
          finish(new Error(`${code}: ${message}`));
        }
        return;
      }
      if (type === "response.done") finish();
    });

    ws.on("error", (error) => finish(error));
    ws.on("close", () => {
      if (!settled && (!transcript || !answerText || responseAudioBytes <= 0)) {
        finish(new Error("Gateway WebSocket 在 E2E 测试完成前关闭"));
      }
    });
  }), 120000, "E2E 测试 120 秒超时");
}

function readCurrentProviderPool(config: ReturnType<typeof loadConfig>): LlmProviderPoolConfig {
  const runtime = process.env.LLM_PROVIDER_POOL_JSON?.trim();
  if (runtime) return parseLlmProviderPool(JSON.parse(runtime));
  return createLegacyLlmProviderPool({
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
  });
}

async function streamAudio(ws: WebSocket, audio: Buffer): Promise<void> {
  const frameBytes = Math.floor(16000 * 2 * 0.02);
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("发送测试音频时 WebSocket 已关闭");
    ws.send(audio.subarray(offset, Math.min(offset + frameBytes, audio.length)));
    await sleep(20);
  }
}

export function downsample24kTo16k(buffer: Buffer): Buffer {
  const inputSamples = Math.floor(buffer.length / 2);
  const outputSamples = Math.floor(inputSamples * 16000 / 24000);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const sourceIndex = i * 24000 / 16000;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, inputSamples - 1);
    const fraction = sourceIndex - left;
    const leftSample = buffer.readInt16LE(left * 2);
    const rightSample = buffer.readInt16LE(right * 2);
    const sample = Math.round(leftSample * (1 - fraction) + rightSample * fraction);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      factory(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

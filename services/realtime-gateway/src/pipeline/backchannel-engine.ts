import type { InteractionMode, UserEmotion } from "@aipany/protocol";
import { QwenTtsRealtimeClient, type QwenTtsConfig } from "../providers/qwen-tts.js";

export interface BackchannelObservation {
  text: string;
  emotion: UserEmotion;
  interactionMode: InteractionMode;
  activeResponse: boolean;
  now?: number;
}

export interface BackchannelDecision {
  cue: string;
  reason: string;
}

/**
 * Conservative mid-turn acknowledgement policy. A cue is allowed at most once
 * per continuous speech segment and is heavily suppressed for sensitive content,
 * short turns, group mode, or when the assistant is already answering.
 */
export class BackchannelEngine {
  private speechStartedAt = 0;
  private lastCueAt = 0;
  private cueSentThisTurn = false;
  private speechActive = false;

  constructor(
    private readonly minimumSpeechMs = 3_800,
    private readonly cooldownMs = 12_000,
  ) {}

  beginSpeech(now = Date.now()): void {
    this.speechStartedAt = now;
    this.cueSentThisTurn = false;
    this.speechActive = true;
  }

  endSpeech(): void {
    this.speechActive = false;
  }

  observe(input: BackchannelObservation): BackchannelDecision | undefined {
    const now = input.now ?? Date.now();
    const text = input.text.trim();
    const compact = text.replace(/\s+/g, "");
    if (!this.speechActive || this.cueSentThisTurn || input.activeResponse) return undefined;
    if (input.interactionMode === "group") return undefined;
    if (now - this.speechStartedAt < this.minimumSpeechMs || now - this.lastCueAt < this.cooldownMs) return undefined;
    if (compact.length < 24 || /[。！？!?]$/u.test(compact)) return undefined;
    if (isSensitive(compact, input.emotion)) return undefined;
    if (!hasNarrativeContinuation(compact)) return undefined;

    this.cueSentThisTurn = true;
    this.lastCueAt = now;
    return {
      cue: /(?:哈哈|笑死|太逗|好好笑)/u.test(compact) ? "哈哈，我在听。" : "嗯，我在听。",
      reason: "long_continuous_narrative",
    };
  }
}

export interface BackchannelAudioConfig extends QwenTtsConfig {}

const audioCache = new Map<string, Promise<Buffer>>();

export async function getBackchannelAudio(
  cue: string,
  config: BackchannelAudioConfig,
  timeoutMs = 4_000,
): Promise<Buffer> {
  const key = [config.baseUrl, config.model, config.voice, config.language, config.sampleRate, cue].join("|");
  const existing = audioCache.get(key);
  if (existing) return existing;
  const promise = synthesize(cue, config, timeoutMs).catch((error) => {
    audioCache.delete(key);
    throw error;
  });
  audioCache.set(key, promise);
  return promise;
}

function synthesize(cue: string, config: BackchannelAudioConfig, timeoutMs: number): Promise<Buffer> {
  const client = new QwenTtsRealtimeClient(config, "用很轻、很短、自然的熟人接话语气说，不要郑重，不要拖长，不要播音腔。");
  const chunks: Buffer[] = [];
  let settled = false;

  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Backchannel TTS timeout")), timeoutMs);
    timer.unref?.();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        client.cancel();
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    client.on("audio", (audio) => chunks.push(audio));
    client.on("error", (error) => finish(error));

    void (async () => {
      try {
        await client.connect();
        client.appendText(cue);
        await client.finish();
        if (chunks.length === 0) throw new Error("Backchannel TTS returned no audio");
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

function hasNarrativeContinuation(text: string): boolean {
  return /(?:然后|后来|结果|其实|就是|所以|而且|接着|你知道|我跟你说|反正|总之|当时|最后|再后来)/u.test(text)
    || /[,，、:：…]$/u.test(text);
}

function isSensitive(text: string, emotion: UserEmotion): boolean {
  if (["sad", "fearful", "angry", "disgusted"].includes(emotion)) return true;
  return /(?:自杀|不想活|伤害自己|救命|报警|急救|医院|死亡|去世|分手|离婚|崩溃|焦虑|害怕|痛苦|生病|被骗|诈骗|密码|验证码)/u.test(text);
}

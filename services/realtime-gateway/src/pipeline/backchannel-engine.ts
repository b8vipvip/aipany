import type { InteractionMode, UserEmotion } from "@aipany/protocol";
import { QwenTtsRealtimeClient, type QwenTtsConfig } from "../providers/qwen-tts.js";
import { ConversationPresenceEngine, type PresenceCueStyle } from "./conversation-presence.js";

export interface BackchannelObservation {
  text: string;
  emotion: UserEmotion;
  interactionMode: InteractionMode;
  activeResponse: boolean;
  now?: number;
}

export interface BackchannelDecision {
  cue: string;
  cueId: string;
  style: PresenceCueStyle;
  reason: string;
}

/**
 * Conservative mid-turn acknowledgement policy. A cue is allowed at most once
 * per continuous speech segment and is heavily suppressed for sensitive content,
 * short turns, group mode, or when the assistant is already answering.
 *
 * The actual wording is selected by ConversationPresenceEngine, which excludes
 * recently used phrases and never uses the fixed “我在呢 / 你慢慢说 / 我在听”
 * scripts that make a long conversation sound like an IVR system.
 */
export class BackchannelEngine {
  private speechStartedAt = 0;
  private lastCueAt?: number;
  private cueSentThisTurn = false;
  private speechActive = false;
  private readonly presence = new ConversationPresenceEngine();

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
    if (now - this.speechStartedAt < this.minimumSpeechMs) return undefined;
    if (this.lastCueAt !== undefined && now - this.lastCueAt < this.cooldownMs) return undefined;
    if (compact.length < 24 || /[。！？!?]$/u.test(compact)) return undefined;
    if (isSensitive(compact, input.emotion)) return undefined;
    if (!hasNarrativeContinuation(compact)) return undefined;

    this.cueSentThisTurn = true;
    this.lastCueAt = now;
    const plan = this.presence.selectMidTurn({ text: compact, emotion: input.emotion });
    return {
      cue: plan.cue,
      cueId: plan.cueId,
      style: plan.style,
      reason: plan.reason,
    };
  }
}

export interface BackchannelAudioConfig extends QwenTtsConfig {}

const audioCache = new Map<string, Promise<Buffer>>();

export async function getBackchannelAudio(
  cue: string,
  config: BackchannelAudioConfig,
  timeoutMs = 4_000,
  style: PresenceCueStyle = "natural",
): Promise<Buffer> {
  const instruction = presenceTtsInstruction(style);
  const key = [config.baseUrl, config.model, config.voice, config.language, config.sampleRate, cue, style].join("|");
  const existing = audioCache.get(key);
  if (existing) return existing;
  const promise = synthesize(cue, config, timeoutMs, instruction).catch((error) => {
    audioCache.delete(key);
    throw error;
  });
  audioCache.set(key, promise);
  return promise;
}

function synthesize(
  cue: string,
  config: BackchannelAudioConfig,
  timeoutMs: number,
  instruction: string,
): Promise<Buffer> {
  const client = new QwenTtsRealtimeClient(config, instruction);
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

function presenceTtsInstruction(style: PresenceCueStyle): string {
  if (style === "playful") return "像熟人自然轻笑或接话，短促真实，不要把笑声逐字朗读。";
  if (style === "supportive") return "语气柔和真诚，轻轻接住对方，不要客服腔，不要拖长。";
  if (style === "thoughtful") return "像真人边想边自然说出一句短话，轻、松、有呼吸感。";
  if (style === "surprised") return "自然地表现一点好奇或惊讶，短促真实，不要夸张表演。";
  return "用很轻、很短、自然的熟人接话语气说，不要郑重，不要拖长，不要播音腔。";
}

function hasNarrativeContinuation(text: string): boolean {
  return /(?:然后|后来|结果|其实|就是|所以|而且|接着|你知道|我跟你说|反正|总之|当时|最后|再后来)/u.test(text)
    || /[,，、:：…]$/u.test(text);
}

function isSensitive(text: string, emotion: UserEmotion): boolean {
  if (["sad", "fearful", "angry", "disgusted"].includes(emotion)) return true;
  return /(?:自杀|不想活|伤害自己|救命|报警|急救|医院|死亡|去世|分手|离婚|崩溃|焦虑|害怕|痛苦|生病|被骗|诈骗|密码|验证码)/u.test(text);
}

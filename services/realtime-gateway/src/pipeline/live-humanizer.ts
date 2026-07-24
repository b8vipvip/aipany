import type { InteractionMode, UserEmotion } from "@aipany/protocol";
import type { AcousticProsodySnapshot } from "./acoustic-prosody-analyzer.js";

export type SpeechPace = "slow" | "relaxed" | "natural" | "brisk";
export type PauseStyle = "soft" | "balanced" | "compact";
export type BackchannelStyle = "none" | "light" | "responsive";

export interface LiveHumanizerContext {
  userEmotion: UserEmotion;
  userText: string;
  interactionMode: InteractionMode;
  socialAction: "respond" | "stay_silent" | "intervene";
  proactivity: number;
  secondsSinceAiSpoke: number;
}

export interface LiveHumanizerDirection {
  profileId: string;
  emotion: string;
  tone: string;
  pace: SpeechPace;
  energy: number;
  pauseStyle: PauseStyle;
  backchannelStyle: BackchannelStyle;
  responseInstruction: string;
  ttsInstructions: string;
  acousticBasis?: {
    energy: AcousticProsodySnapshot["energy"];
    tempoHint: AcousticProsodySnapshot["tempoHint"];
    silenceRatio: number;
    pitchVariation: number;
    confidence: number;
  };
  chunking: {
    minChars: number;
    maxChars: number;
    firstChunkMinChars: number;
    firstChunkMaxChars: number;
  };
}

/**
 * Deterministic conversation/prosody director for Economy Live.
 *
 * V2 combines text/ASR emotion with lightweight acoustic descriptors. Acoustic
 * cues only shape the assistant's delivery; they are never treated as a factual
 * diagnosis of the user's feelings or mental state.
 */
export class LiveHumanizer {
  private previousProfileId = "natural";
  private previousProfileStrength = 0;
  private consecutiveShortTurns = 0;
  private pendingAcoustic?: AcousticProsodySnapshot;

  setAcousticContext(snapshot: AcousticProsodySnapshot | undefined): void {
    this.pendingAcoustic = snapshot;
  }

  direct(context: LiveHumanizerContext): LiveHumanizerDirection {
    const acoustic = this.pendingAcoustic;
    this.pendingAcoustic = undefined;
    const text = context.userText.trim();
    const compactText = text.replace(/\s+/g, "");
    const shortTurn = compactText.length <= 10;
    const acknowledgement = isAcknowledgement(compactText);
    const laughter = /(?:哈{2,}|嘿嘿|呵呵|笑死|好好笑|太逗)/u.test(compactText);
    const urgent = /(?:救命|马上|赶紧|快点|很急|急死|怎么办|来不及)/u.test(compactText);
    const vulnerable = /(?:难过|伤心|崩溃|压力|焦虑|害怕|失眠|孤独|好累|撑不住)/u.test(compactText);
    const question = /[?？]$/u.test(compactText) || /^(?:为什么|怎么|如何|能不能|可以吗|是不是|要不要|怎么办)/u.test(compactText);
    const acousticSignals = readAcousticSignals(acoustic, compactText.length);

    this.consecutiveShortTurns = shortTurn ? Math.min(4, this.consecutiveShortTurns + 1) : 0;

    const profile = selectProfile({
      emotion: context.userEmotion,
      laughter,
      urgent,
      vulnerable,
      acknowledgement,
      lowArousal: acousticSignals.lowArousal,
      highArousal: acousticSignals.highArousal,
      expressive: acousticSignals.expressive,
    });
    const smoothed = smoothProfile(
      profile,
      this.previousProfileId,
      this.previousProfileStrength,
      context.userEmotion,
      acousticSignals,
    );
    this.previousProfileId = smoothed.profileId;
    this.previousProfileStrength = profileStrength(smoothed.profileId);

    const backchannelStyle: BackchannelStyle = acknowledgement || this.consecutiveShortTurns >= 2
      ? "responsive"
      : shortTurn || laughter
        ? "light"
        : "none";
    const proactivity = clamp01(context.proactivity);
    const modeGuidance = context.interactionMode === "group"
      ? "多人聊天里少抢话，只回应当前真正相关的内容；不要把每句话都变成长回答。"
      : context.interactionMode === "owner_focus"
        ? "像熟悉的长期伙伴一样直接接住对方，不要使用客服式开场和总结。"
        : "根据上下文自然决定回答长度，避免固定的一问一答模板。";
    const backchannelGuidance = backchannelStyle === "responsive"
      ? "如果用户只是“嗯、哦、对、好、哈哈”这类承接，可以只给一句很短的自然反馈；不要强行展开新话题，也不要复述用户原话。"
      : backchannelStyle === "light"
        ? "可以在确实自然时用一个很短的口语反应承接，但不要每轮都加“嗯、好的、当然”。"
        : "直接进入有信息量的回答，不要固定使用寒暄前缀。";
    const lengthGuidance = question
      ? "先直接回答问题核心，再按需要补充；第一句话尽量短，让语音尽快自然开口。"
      : compactText.length > 60
        ? "先回应用户最核心的观点或明确表达，再分成短句继续，不要一次输出大段书面文字。"
        : "优先短句和自然口语，能一句说清就不要说三句。";
    const initiativeGuidance = proactivity >= 0.72 && context.secondsSinceAiSpoke > 12
      ? "在回答完整后，可以自然带出一个紧贴当前上下文的小问题，但不要像问卷一样连续追问。"
      : "除非上下文真的需要，不要为了延长对话机械地在句尾追加问题。";
    const acousticGuidance = acoustic
      ? buildAcousticResponseGuidance(acousticSignals)
      : "没有可靠声学提示时，只依据用户明确说出的内容和对话上下文决定表达方式。";

    const responseInstruction = [
      "你正在实时语音通话。只输出真正要说出口的话，不要输出舞台说明、括号情绪标签、Markdown 或“语气：”之类元信息。",
      modeGuidance,
      backchannelGuidance,
      lengthGuidance,
      initiativeGuidance,
      acousticGuidance,
      "声学特征只用于调整你自己的说话节奏和语气，绝不能据此断言用户的情绪、性格、健康状况或心理状态。",
      `本轮表达基调：${smoothed.tone}；节奏${paceLabel(smoothed.pace)}；情绪强度保持自然，不表演、不播音。`,
    ].join("\n");

    const pauseInstruction = smoothed.pauseStyle === "soft"
      ? "句间允许柔和、自然的短停顿，重要内容前后略留空间，不要拖长。"
      : smoothed.pauseStyle === "compact"
        ? "停顿简短利落，保持连续交流感，不要逐字播报。"
        : "停顿像日常聊天一样自然，逗号处轻停，句号处稍停。";
    const ttsInstructions = [
      `用${smoothed.tone}的方式说话。`,
      `整体语速${paceTtsLabel(smoothed.pace)}，能量感约 ${Math.round(smoothed.energy * 100)}%，保持真实的人类起伏，不要夸张。`,
      pauseInstruction,
      acoustic ? acousticTtsGuidance(acousticSignals) : "保持自然的语调起伏，不要每句都使用相同重音和相同句尾。",
      backchannelStyle === "responsive"
        ? "短回应要轻、快、像自然接话，不要把简单的“嗯”“对”读得郑重。"
        : "句尾自然收住，避免客服播报腔和固定上扬语调。",
    ].join(" ");

    return {
      ...smoothed,
      backchannelStyle,
      responseInstruction,
      ttsInstructions,
      acousticBasis: acoustic ? {
        energy: acoustic.energy,
        tempoHint: acoustic.tempoHint,
        silenceRatio: acoustic.silenceRatio,
        pitchVariation: acoustic.pitchVariation,
        confidence: acoustic.confidence,
      } : undefined,
      chunking: chunkingFor(smoothed.pace, backchannelStyle, acousticSignals),
    };
  }
}

interface BaseProfile {
  profileId: string;
  emotion: string;
  tone: string;
  pace: SpeechPace;
  energy: number;
  pauseStyle: PauseStyle;
}

interface AcousticSignals {
  available: boolean;
  lowArousal: boolean;
  highArousal: boolean;
  expressive: boolean;
  longPauses: boolean;
  fastTextRate: boolean;
  slowTextRate: boolean;
  confidence: number;
}

function selectProfile(input: {
  emotion: UserEmotion;
  laughter: boolean;
  urgent: boolean;
  vulnerable: boolean;
  acknowledgement: boolean;
  lowArousal: boolean;
  highArousal: boolean;
  expressive: boolean;
}): BaseProfile {
  if (input.urgent) {
    return profile("focused_urgent", "focused", "清晰、可靠、专注，不制造紧张感", "brisk", 0.66, "compact");
  }
  if (input.vulnerable || input.emotion === "sad") {
    return profile("warm_support", "warm_gentle", "温暖、轻柔、真诚、有陪伴感", "relaxed", 0.34, "soft");
  }
  if (input.emotion === "fearful") {
    return profile("reassuring", "reassuring", "稳定、安心、柔和，让人有安全感", "relaxed", 0.38, "soft");
  }
  if (input.emotion === "angry" || input.emotion === "disgusted") {
    return profile("grounded_calm", "calm", "冷静、克制、尊重，不与对方对抗", "relaxed", 0.35, "soft");
  }
  if (input.laughter || input.emotion === "happy") {
    return profile("bright_playful", "cheerful", "自然开心、轻快、带一点真实笑意", "brisk", 0.76, "compact");
  }
  if (input.emotion === "surprised") {
    return profile("curious_surprised", "curious_surprised", "自然惊喜、好奇、灵动", "brisk", 0.7, "balanced");
  }
  if (input.acknowledgement) {
    return profile("micro_ack", "natural", "轻松、随意、像熟人自然接话", "brisk", 0.5, "compact");
  }
  if (input.lowArousal) {
    return profile("reflective_soft", "reflective", "平和、柔和、留有呼吸感，不急着压过对方", "relaxed", 0.42, "soft");
  }
  if (input.highArousal || input.expressive) {
    return profile("engaged_lively", "engaged", "有参与感、灵活、自然有精神，但不抢话", "brisk", 0.66, "compact");
  }
  return profile("natural", "natural", "自然、亲切、口语化、像熟人聊天", "natural", 0.52, "balanced");
}

function smoothProfile(
  next: BaseProfile,
  previousProfileId: string,
  previousStrength: number,
  emotion: UserEmotion,
  acoustic: AcousticSignals,
): BaseProfile {
  if (next.profileId !== "natural" || previousProfileId === "natural" || emotion !== "unknown" || previousStrength < 0.55) return next;
  if (["warm_support", "reassuring", "reflective_soft", "warm_continuity"].includes(previousProfileId)) {
    return profile("warm_continuity", "warm_gentle", "温和、自然、有延续性的陪伴感", "relaxed", 0.4, "soft");
  }
  if (["bright_playful", "engaged_lively", "bright_continuity"].includes(previousProfileId) && acoustic.expressive) {
    return profile("bright_continuity", "cheerful", "轻松、有参与感、保持上一轮自然活力", "brisk", 0.64, "compact");
  }
  return next;
}

function readAcousticSignals(snapshot: AcousticProsodySnapshot | undefined, textChars: number): AcousticSignals {
  if (!snapshot || snapshot.confidence < 0.3) {
    return {
      available: false,
      lowArousal: false,
      highArousal: false,
      expressive: false,
      longPauses: false,
      fastTextRate: false,
      slowTextRate: false,
      confidence: 0,
    };
  }
  const seconds = Math.max(0.2, snapshot.durationMs / 1_000);
  const charsPerSecond = textChars / seconds;
  const longPauses = snapshot.silenceRatio >= 0.24;
  const fastTextRate = charsPerSecond >= 6.5 || snapshot.tempoHint === "fast";
  const slowTextRate = charsPerSecond <= 2.2 || snapshot.tempoHint === "slow";
  return {
    available: true,
    lowArousal: snapshot.energy === "low" && (longPauses || slowTextRate),
    highArousal: snapshot.energy === "high" && fastTextRate,
    expressive: snapshot.pitchVariation >= 0.16 || snapshot.dynamicRangeDb >= 15,
    longPauses,
    fastTextRate,
    slowTextRate,
    confidence: snapshot.confidence,
  };
}

function buildAcousticResponseGuidance(signals: AcousticSignals): string {
  if (!signals.available) return "声学信息置信度不足，不据此改变内容判断。";
  if (signals.lowArousal) return "对方本轮声音整体偏低能量或留白较多；你自己的回应稍微放松节奏、减少抢话感，但不要猜测或点名对方情绪。";
  if (signals.highArousal) return "对方本轮声音节奏和能量较高；你可以提高自己的响应活力并更快进入重点，但不要跟着变得急躁。";
  if (signals.expressive) return "对方本轮声音起伏较丰富；你的表达可以更有自然变化和参与感，但保持克制。";
  return "对方本轮声学节奏较平稳；保持自然日常交流，不刻意改变风格。";
}

function acousticTtsGuidance(signals: AcousticSignals): string {
  if (signals.lowArousal) return "整体稍微柔和一点，留出更自然的短停顿，不要催促感。";
  if (signals.highArousal) return "开头更利落，重音有变化，但不要连续高能量输出。";
  if (signals.expressive) return "允许更自然的轻重和音高变化，不要机械地保持同一条语调线。";
  return "保持稳定但有细微起伏的日常口语节奏。";
}

function chunkingFor(pace: SpeechPace, backchannel: BackchannelStyle, acoustic: AcousticSignals) {
  if (backchannel === "responsive") {
    return { minChars: 4, maxChars: 22, firstChunkMinChars: 2, firstChunkMaxChars: 10 };
  }
  if (pace === "brisk" || acoustic.fastTextRate) {
    return { minChars: 6, maxChars: 28, firstChunkMinChars: 3, firstChunkMaxChars: 14 };
  }
  if (pace === "relaxed" || pace === "slow" || acoustic.longPauses) {
    return { minChars: 10, maxChars: 38, firstChunkMinChars: 4, firstChunkMaxChars: 18 };
  }
  return { minChars: 8, maxChars: 32, firstChunkMinChars: 4, firstChunkMaxChars: 18 };
}

function profileStrength(profileId: string): number {
  if (["warm_support", "reassuring", "grounded_calm", "focused_urgent"].includes(profileId)) return 1;
  if (["bright_playful", "curious_surprised", "engaged_lively", "reflective_soft"].includes(profileId)) return 0.75;
  if (profileId.includes("continuity")) return 0.6;
  return 0.25;
}

function isAcknowledgement(text: string): boolean {
  if (!text || text.length > 10) return false;
  return /^(?:嗯+|哦+|噢+|好+|好的|行|可以|对+|是的|知道了|明白了|哈哈+|嘿嘿+|没错|确实|然后呢|继续)$/u.test(text);
}

function profile(
  profileId: string,
  emotion: string,
  tone: string,
  pace: SpeechPace,
  energy: number,
  pauseStyle: PauseStyle,
): BaseProfile {
  return { profileId, emotion, tone, pace, energy, pauseStyle };
}

function paceLabel(pace: SpeechPace): string {
  if (pace === "slow") return "偏慢";
  if (pace === "relaxed") return "舒缓";
  if (pace === "brisk") return "轻快";
  return "自然";
}

function paceTtsLabel(pace: SpeechPace): string {
  if (pace === "slow") return "稍慢";
  if (pace === "relaxed") return "比日常稍慢一点，但保持流畅";
  if (pace === "brisk") return "比日常稍快一点，轻快但不要赶";
  return "接近日常聊天";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

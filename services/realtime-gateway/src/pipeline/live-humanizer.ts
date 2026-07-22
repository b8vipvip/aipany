import type { InteractionMode, UserEmotion } from "@aipany/protocol";

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
 * This module intentionally does not call another LLM. It turns already-known
 * realtime signals into structured response and TTS guidance in microseconds,
 * keeping the low-cost cascaded path responsive while restoring some of the
 * emotional/prosodic information normally lost when speech becomes text.
 */
export class LiveHumanizer {
  private previousProfileId = "natural";
  private consecutiveShortTurns = 0;

  direct(context: LiveHumanizerContext): LiveHumanizerDirection {
    const text = context.userText.trim();
    const compactText = text.replace(/\s+/g, "");
    const shortTurn = compactText.length <= 10;
    const acknowledgement = isAcknowledgement(compactText);
    const laughter = /(?:哈{2,}|嘿嘿|呵呵|笑死|好好笑|太逗)/u.test(compactText);
    const urgent = /(?:救命|马上|赶紧|快点|很急|急死|怎么办|来不及)/u.test(compactText);
    const vulnerable = /(?:难过|伤心|崩溃|压力|焦虑|害怕|失眠|孤独|好累|撑不住)/u.test(compactText);
    const question = /[?？]$/u.test(compactText) || /^(?:为什么|怎么|如何|能不能|可以吗|是不是|要不要|怎么办)/u.test(compactText);

    this.consecutiveShortTurns = shortTurn ? Math.min(4, this.consecutiveShortTurns + 1) : 0;

    const profile = selectProfile({
      emotion: context.userEmotion,
      laughter,
      urgent,
      vulnerable,
      acknowledgement,
    });
    const smoothed = smoothProfile(profile, this.previousProfileId, context.userEmotion);
    this.previousProfileId = smoothed.profileId;

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
        ? "先回应用户最核心的情绪或观点，再分成短句继续，不要一次输出大段书面文字。"
        : "优先短句和自然口语，能一句说清就不要说三句。";
    const initiativeGuidance = proactivity >= 0.72 && context.secondsSinceAiSpoke > 12
      ? "在回答完整后，可以自然带出一个紧贴当前上下文的小问题，但不要像问卷一样连续追问。"
      : "除非上下文真的需要，不要为了延长对话机械地在句尾追加问题。";

    const responseInstruction = [
      "你正在实时语音通话。只输出真正要说出口的话，不要输出舞台说明、括号情绪标签、Markdown 或“语气：”之类元信息。",
      modeGuidance,
      backchannelGuidance,
      lengthGuidance,
      initiativeGuidance,
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
      backchannelStyle === "responsive"
        ? "短回应要轻、快、像自然接话，不要把简单的“嗯”“对”读得郑重。"
        : "句尾自然收住，避免客服播报腔和固定上扬语调。",
    ].join(" ");

    return {
      ...smoothed,
      backchannelStyle,
      responseInstruction,
      ttsInstructions,
      chunking: chunkingFor(smoothed.pace, backchannelStyle),
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

function selectProfile(input: {
  emotion: UserEmotion;
  laughter: boolean;
  urgent: boolean;
  vulnerable: boolean;
  acknowledgement: boolean;
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
  return profile("natural", "natural", "自然、亲切、口语化、像熟人聊天", "natural", 0.52, "balanced");
}

function smoothProfile(next: BaseProfile, previousProfileId: string, emotion: UserEmotion): BaseProfile {
  if (next.profileId !== "natural" || previousProfileId === "natural" || emotion !== "unknown") return next;
  if (previousProfileId === "warm_support" || previousProfileId === "reassuring") {
    return profile("warm_continuity", "warm_gentle", "温和、自然、有延续性的陪伴感", "relaxed", 0.4, "soft");
  }
  return next;
}

function chunkingFor(pace: SpeechPace, backchannel: BackchannelStyle) {
  if (backchannel === "responsive") {
    return { minChars: 4, maxChars: 22, firstChunkMinChars: 2, firstChunkMaxChars: 10 };
  }
  if (pace === "brisk") {
    return { minChars: 6, maxChars: 28, firstChunkMinChars: 3, firstChunkMaxChars: 14 };
  }
  if (pace === "relaxed" || pace === "slow") {
    return { minChars: 10, maxChars: 38, firstChunkMinChars: 4, firstChunkMaxChars: 18 };
  }
  return { minChars: 8, maxChars: 32, firstChunkMinChars: 4, firstChunkMaxChars: 18 };
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

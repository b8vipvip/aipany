import { createHash } from "node:crypto";
import type { UserEmotion } from "@aipany/protocol";

export type PresenceCueStyle =
  | "natural"
  | "thoughtful"
  | "playful"
  | "supportive"
  | "surprised";

export interface PresenceCuePlan {
  cue: string;
  cueId: string;
  style: PresenceCueStyle;
  reason: string;
  delayMs: number;
}

interface PresenceInput {
  text: string;
  emotion: UserEmotion;
}

const MID_TURN_GENERAL = [
  cue("mid_natural_1", "嗯。", "natural"),
  cue("mid_natural_2", "哦，这样啊。", "natural"),
  cue("mid_natural_3", "原来是这样。", "natural"),
  cue("mid_natural_4", "明白。", "natural"),
  cue("mid_natural_5", "是这么回事。", "natural"),
];

const MID_TURN_PLAYFUL = [
  cue("mid_playful_1", "哈哈。", "playful"),
  cue("mid_playful_2", "还真是。", "playful"),
  cue("mid_playful_3", "哎，这个有意思。", "playful"),
];

const MID_TURN_SURPRISED = [
  cue("mid_surprised_1", "哦？", "surprised"),
  cue("mid_surprised_2", "真的？", "surprised"),
  cue("mid_surprised_3", "还有这回事。", "surprised"),
];

const BRIDGE_ACKNOWLEDGEMENT = [
  cue("bridge_ack_1", "是啊。", "natural"),
  cue("bridge_ack_2", "对。", "natural"),
  cue("bridge_ack_3", "确实。", "natural"),
  cue("bridge_ack_4", "没错。", "natural"),
];

const BRIDGE_THOUGHTFUL = [
  cue("bridge_think_1", "这个我想一下。", "thoughtful"),
  cue("bridge_think_2", "我捋一下。", "thoughtful"),
  cue("bridge_think_3", "这个得想一想。", "thoughtful"),
  cue("bridge_think_4", "让我想想。", "thoughtful"),
];

const BRIDGE_EXPLANATION = [
  cue("bridge_explain_1", "哦，原来是这样。", "natural"),
  cue("bridge_explain_2", "这样就说得通了。", "natural"),
  cue("bridge_explain_3", "难怪。", "natural"),
  cue("bridge_explain_4", "这我接上了。", "natural"),
];

const BRIDGE_PLAYFUL = [
  cue("bridge_playful_1", "哈哈，这个有意思。", "playful"),
  cue("bridge_playful_2", "还真挺逗。", "playful"),
  cue("bridge_playful_3", "这下我懂了。", "playful"),
];

const BRIDGE_SUPPORTIVE = [
  cue("bridge_support_1", "这听着确实不太轻松。", "supportive"),
  cue("bridge_support_2", "嗯，这种感觉挺磨人的。", "supportive"),
  cue("bridge_support_3", "这确实会让人不舒服。", "supportive"),
];

const BRIDGE_DEFAULT = [
  cue("bridge_default_1", "哦，原来是这样。", "natural"),
  cue("bridge_default_2", "这我明白了。", "natural"),
  cue("bridge_default_3", "好，我想想。", "thoughtful"),
  cue("bridge_default_4", "嗯，接上了。", "natural"),
];

/**
 * Produces short, context-aware spoken presence without relying on another LLM
 * request. It intentionally avoids the repeated assistant-like phrases
 * “我在呢 / 你慢慢说 / 我在听”. Recent cues are excluded so long sessions do
 * not sound like a fixed IVR script.
 */
export class ConversationPresenceEngine {
  private recentCueIds: string[] = [];
  private sequence = 0;

  selectMidTurn(input: PresenceInput): PresenceCuePlan {
    const compact = normalize(input.text);
    const pool = /(?:哈哈|笑死|太逗|好好笑|嘿嘿)/u.test(compact)
      ? MID_TURN_PLAYFUL
      : /(?:居然|竟然|没想到|真的假的|吓一跳)/u.test(compact)
        ? MID_TURN_SURPRISED
        : MID_TURN_GENERAL;
    return this.select(pool, compact, "long_continuous_narrative", 0);
  }

  selectLatencyBridge(input: PresenceInput): PresenceCuePlan | undefined {
    const compact = normalize(input.text);
    if (!compact) return undefined;

    const acknowledgement = compact.length <= 8
      && /^(?:嗯+|哦+|噢+|好+|好的|行|可以|对+|是的|没错|确实|知道了|明白了|哈哈+|嘿嘿+)$/u.test(compact);
    const laughter = /(?:哈哈|笑死|太逗|好好笑|嘿嘿)/u.test(compact) || input.emotion === "happy";
    const vulnerable = /(?:难过|伤心|崩溃|压力|焦虑|害怕|失眠|孤独|好累|不舒服|疼|生病)/u.test(compact)
      || ["sad", "fearful"].includes(input.emotion);
    const explanation = /(?:因为|所以|刚刚|刚才|后来|原来|才发现|难怪|结果)/u.test(compact);
    const question = /[?？]$/u.test(compact)
      || /^(?:为什么|怎么|如何|能不能|可以吗|是不是|要不要|怎么办|什么|哪里|谁|几)/u.test(compact);

    if (acknowledgement) return this.select(BRIDGE_ACKNOWLEDGEMENT, compact, "slow_acknowledgement_response", 620);
    if (laughter) return this.select(BRIDGE_PLAYFUL, compact, "slow_playful_response", 650);
    if (vulnerable) return this.select(BRIDGE_SUPPORTIVE, compact, "slow_supportive_response", 680);
    if (explanation) return this.select(BRIDGE_EXPLANATION, compact, "slow_explanation_response", 650);
    if (question) return this.select(BRIDGE_THOUGHTFUL, compact, "slow_question_response", 720);
    return this.select(BRIDGE_DEFAULT, compact, "slow_default_response", 680);
  }

  private select(
    pool: PresenceCuePlan[],
    seed: string,
    reason: string,
    delayMs: number,
  ): PresenceCuePlan {
    const available = pool.filter((item) => !this.recentCueIds.includes(item.cueId));
    const choices = available.length > 0 ? available : pool;
    const hash = createHash("sha256").update(`${seed}|${this.sequence}`).digest();
    this.sequence += 1;
    const selected = choices[(hash[0] ?? 0) % choices.length] ?? choices[0]!;
    this.recentCueIds.push(selected.cueId);
    if (this.recentCueIds.length > 4) this.recentCueIds.shift();
    return { ...selected, reason, delayMs };
  }
}

function cue(cueId: string, text: string, style: PresenceCueStyle): PresenceCuePlan {
  return { cueId, cue: text, style, reason: "", delayMs: 0 };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

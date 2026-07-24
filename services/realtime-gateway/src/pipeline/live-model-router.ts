import { createHash } from "node:crypto";
import type { ChatMessage } from "../providers/llm-provider-pool.js";

export type LiveRouteClass = "quick_chat" | "simple_answer" | "reasoning" | "coding" | "long_context";
export type LiveRoutingExperimentVariant = "latency_first" | "balanced";

export interface LiveRoutingDecision {
  routeClass: LiveRouteClass;
  experimentVariant: LiveRoutingExperimentVariant;
  confidence: number;
  reason: string;
}

/** Local deterministic classifier: no extra LLM call and no user-facing tier semantics. */
export class LiveModelRouter {
  decide(messages: ChatMessage[], experimentSeed: string): LiveRoutingDecision {
    const userText = lastUserText(messages);
    const totalContextChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    const experimentVariant = assignLiveRoutingVariant(experimentSeed);

    if (looksLikeCoding(userText)) {
      return decision("coding", experimentVariant, 0.94, "coding_markers");
    }
    if (totalContextChars >= 12_000 || userText.length >= 2_500) {
      return decision("long_context", experimentVariant, 0.9, "large_context");
    }
    if (looksLikeReasoning(userText)) {
      return decision("reasoning", experimentVariant, 0.86, "reasoning_markers");
    }
    if (looksLikeQuickChat(userText)) {
      return decision("quick_chat", experimentVariant, 0.92, "short_conversational_turn");
    }
    return decision("simple_answer", experimentVariant, 0.7, "default_conversation");
  }
}

export function assignLiveRoutingVariant(seed: string): LiveRoutingExperimentVariant {
  const digest = createHash("sha256").update(seed || "aipany-default").digest();
  return (digest[0] ?? 0) % 2 === 0 ? "latency_first" : "balanced";
}

function lastUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index]?.content.trim() ?? "";
  }
  return "";
}

function looksLikeQuickChat(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length <= 18 && /^(?:你好|嗨|哈喽|在吗|谢谢|好的|好吧|嗯+|哦+|对+|哈哈+|再见|晚安|早安|继续|然后呢|真的吗|是吗|行|可以)$/u.test(compact)) return true;
  if (compact.length <= 28 && /(?:谢谢|辛苦了|明白了|知道了|没问题|好呀|哈哈|晚安|早安)$/u.test(compact)) return true;
  return false;
}

function looksLikeCoding(text: string): boolean {
  return /(?:代码|编程|程序|函数|class\b|function\b|def\b|import\b|npm\b|gradle\b|typescript|javascript|python|kotlin|java\b|sql\b|docker|github|api\b|报错|bug\b|debug|正则|数据库|git\b|服务器|websocket|json\b|yaml\b)/iu.test(text);
}

function looksLikeReasoning(text: string): boolean {
  if (text.length >= 500) return true;
  return /(?:深入分析|详细分析|推理|论证|比较一下|权衡|利弊|为什么会|根本原因|制定方案|架构设计|商业计划|策略|数学证明|证明一下|一步一步|复杂|长期规划|风险分析|可行性)/u.test(text);
}

function decision(
  routeClass: LiveRouteClass,
  experimentVariant: LiveRoutingExperimentVariant,
  confidence: number,
  reason: string,
): LiveRoutingDecision {
  return { routeClass, experimentVariant, confidence, reason };
}

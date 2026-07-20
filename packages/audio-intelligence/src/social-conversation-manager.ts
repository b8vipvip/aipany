import type { SocialDecision, SocialTurnContext } from "./types.js";

/**
 * 决定 AI 在多人场景中应该回答、保持安静还是主动插话。
 * 规则层只负责可解释的实时门控，Conversation Brain 仍负责最终生成内容。
 */
export class SocialConversationManager {
  decide(context: SocialTurnContext): SocialDecision {
    if (context.mode === "owner_focus") {
      if (!context.isOwner && !context.addressedToAssistant && !context.explicitWakeWord) {
        return { action: "stay_silent", score: 0, reason: "owner_focus_non_owner" };
      }
      return {
        action: "respond",
        score: 1,
        reason: context.addressedToAssistant || context.explicitWakeWord ? "explicitly_addressed" : "owner_turn",
      };
    }

    if (context.addressedToAssistant || context.explicitWakeWord || context.directQuestionToAssistant) {
      return { action: "respond", score: 1, reason: "explicitly_addressed" };
    }

    // 高置信度安全风险允许 AI 在较短自然停顿后主动提醒。
    // 即使前一刻存在多人重叠，也不会在大家同时讲话时抢话，而是等待最小停顿窗口。
    if (context.urgencyScore >= 0.82 && !context.humanOverlap && context.naturalPauseMs >= 320) {
      return {
        action: "intervene",
        score: clamp(context.urgencyScore * 0.9 + context.helpfulnessScore * 0.1, 0, 1),
        reason: "urgent_intervention",
      };
    }

    if (context.humanOverlap) {
      return { action: "stay_silent", score: 0, reason: "human_overlap" };
    }

    const pauseScore = clamp(context.naturalPauseMs / 1800, 0, 1);
    const recencyScore = clamp(context.secondsSinceAiSpoke / 45, 0, 1);
    const interventionPenalty = clamp(context.recentAiInterventions / 3, 0, 1);
    const proactivity = clamp(context.proactivity, 0, 1);

    const score = clamp(
      context.helpfulnessScore * 0.34 +
        context.urgencyScore * 0.2 +
        context.noveltyScore * 0.14 +
        pauseScore * 0.12 +
        recencyScore * 0.08 +
        proactivity * 0.12 -
        interventionPenalty * 0.32,
      0,
      1,
    );

    const threshold = 0.72 - proactivity * 0.12;
    if (score >= threshold && context.naturalPauseMs >= 650) {
      return { action: "intervene", score, reason: "proactive_opportunity" };
    }

    return { action: "stay_silent", score, reason: "insufficient_value" };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

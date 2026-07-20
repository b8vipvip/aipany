import assert from "node:assert/strict";
import test from "node:test";
import { buildEnvironmentInstruction, evaluateSocialTurn } from "../src/social/social-turn-evaluator.js";

test("明确叫到 Aipany 会被识别为面向助手的提问", () => {
  const result = evaluateSocialTurn({
    text: "Aipany，你觉得我们明天几点出发比较好？",
    assistantAliases: ["Aipany", "小派"],
    recentHumanTurns: [],
  });
  assert.equal(result.explicitWakeWord, true);
  assert.equal(result.addressedToAssistant, true);
  assert.equal(result.directQuestionToAssistant, true);
  assert.ok(result.helpfulnessScore >= 0.72);
});

test("重复的人类话题会降低 novelty", () => {
  const fresh = evaluateSocialTurn({
    text: "明天高速施工，我们可能要早点走",
    assistantAliases: ["Aipany"],
    recentHumanTurns: ["今晚去哪里吃饭"],
  });
  const repeated = evaluateSocialTurn({
    text: "明天高速施工，我们可能要早点走",
    assistantAliases: ["Aipany"],
    recentHumanTurns: ["明天高速施工，我们可能要早点走"],
  });
  assert.ok(fresh.noveltyScore > repeated.noveltyScore);
});

test("高置信度警报环境会提高 urgency 并生成环境提示", () => {
  const environment = {
    scene: "traffic",
    sceneConfidence: 0.91,
    noiseLevel: "high" as const,
    events: [{ type: "Siren", confidence: 0.93 }],
    capturedAt: Date.now(),
  };
  const result = evaluateSocialTurn({
    text: "我们继续走吧",
    assistantAliases: ["Aipany"],
    recentHumanTurns: [],
    environment,
  });
  assert.ok(result.urgencyScore >= 0.9);
  assert.match(buildEnvironmentInstruction(environment) ?? "", /Siren/);
});

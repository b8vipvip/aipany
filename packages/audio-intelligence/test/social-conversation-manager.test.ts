import assert from "node:assert/strict";
import test from "node:test";
import { SocialConversationManager } from "../src/social-conversation-manager.js";

const manager = new SocialConversationManager();

test("多人模式下明确叫到 AI 时立即回答", () => {
  const decision = manager.decide({
    mode: "group",
    speakerId: "speaker-b",
    speakerName: "小王",
    isOwner: false,
    text: "Aipany，你怎么看？",
    addressedToAssistant: true,
    explicitWakeWord: true,
    directQuestionToAssistant: true,
    naturalPauseMs: 100,
    humanOverlap: false,
    helpfulnessScore: 0.2,
    urgencyScore: 0,
    noveltyScore: 0.1,
    recentAiInterventions: 2,
    secondsSinceAiSpoke: 3,
    proactivity: 0.3,
  });

  assert.equal(decision.action, "respond");
});

test("多人模式下有价值且存在自然停顿时可以主动插话", () => {
  const decision = manager.decide({
    mode: "group",
    speakerId: "speaker-owner",
    isOwner: true,
    text: "明天八点出发应该来得及吧",
    addressedToAssistant: false,
    explicitWakeWord: false,
    directQuestionToAssistant: false,
    naturalPauseMs: 1800,
    humanOverlap: false,
    helpfulnessScore: 1,
    urgencyScore: 0.9,
    noveltyScore: 0.9,
    recentAiInterventions: 0,
    secondsSinceAiSpoke: 90,
    proactivity: 0.8,
  });

  assert.equal(decision.action, "intervene");
});

test("专注模式下陌生人闲聊不会触发回答", () => {
  const decision = manager.decide({
    mode: "owner_focus",
    speakerId: "speaker-other",
    isOwner: false,
    text: "今天晚上吃什么",
    addressedToAssistant: false,
    explicitWakeWord: false,
    directQuestionToAssistant: false,
    naturalPauseMs: 2000,
    humanOverlap: false,
    helpfulnessScore: 1,
    urgencyScore: 1,
    noveltyScore: 1,
    recentAiInterventions: 0,
    secondsSinceAiSpoke: 100,
    proactivity: 1,
  });

  assert.equal(decision.action, "stay_silent");
  assert.equal(decision.reason, "owner_focus_non_owner");
});

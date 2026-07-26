import assert from "node:assert/strict";
import test from "node:test";
import { ConversationPresenceEngine } from "../src/pipeline/conversation-presence.js";

test("presence engine avoids repeated scripted listening phrases", () => {
  const engine = new ConversationPresenceEngine();
  const cues = Array.from({ length: 4 }, () => engine.selectMidTurn({
    text: "我当时先去了那边，然后后来又发生了一件事情，然后",
    emotion: "neutral",
  }));

  assert.equal(new Set(cues.map((item) => item.cueId)).size, 4);
  for (const item of cues) {
    assert.doesNotMatch(item.cue, /我在呢|你慢慢说|我在听/u);
  }
});

test("latency bridge reacts to an explanation instead of using empty presence", () => {
  const engine = new ConversationPresenceEngine();
  const plan = engine.selectLatencyBridge({
    text: "因为刚刚吃完饭了，才发现喉咙有点不舒服",
    emotion: "neutral",
  });

  assert.ok(plan);
  assert.equal(plan?.reason, "slow_explanation_response");
  assert.ok((plan?.delayMs ?? 9999) <= 700);
  assert.doesNotMatch(plan?.cue ?? "", /我在呢|你慢慢说|我在听/u);
});

test("latency bridge gives thoughtful presence to questions", () => {
  const engine = new ConversationPresenceEngine();
  const plan = engine.selectLatencyBridge({
    text: "这个问题到底应该怎么处理？",
    emotion: "unknown",
  });

  assert.ok(plan);
  assert.equal(plan?.style, "thoughtful");
  assert.equal(plan?.reason, "slow_question_response");
  assert.ok((plan?.delayMs ?? 9999) <= 750);
});

test("supportive bridge stays gentle without asserting a diagnosis", () => {
  const engine = new ConversationPresenceEngine();
  const plan = engine.selectLatencyBridge({
    text: "最近压力很大，晚上总是睡不好",
    emotion: "sad",
  });

  assert.equal(plan?.style, "supportive");
  assert.doesNotMatch(plan?.cue ?? "", /抑郁|焦虑症|你就是/u);
});

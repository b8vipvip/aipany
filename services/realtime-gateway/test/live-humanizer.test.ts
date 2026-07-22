import assert from "node:assert/strict";
import test from "node:test";
import { LiveHumanizer } from "../src/pipeline/live-humanizer.js";

function context(overrides: Partial<Parameters<LiveHumanizer["direct"]>[0]> = {}) {
  return {
    userEmotion: "unknown" as const,
    userText: "今天想随便聊聊天",
    interactionMode: "auto" as const,
    socialAction: "respond" as const,
    proactivity: 0.45,
    secondsSinceAiSpoke: 20,
    ...overrides,
  };
}

test("humanizer creates warm slower prosody for vulnerable turns", () => {
  const director = new LiveHumanizer();
  const result = director.direct(context({ userEmotion: "sad", userText: "最近压力真的很大，我有点撑不住了" }));

  assert.equal(result.profileId, "warm_support");
  assert.equal(result.pace, "relaxed");
  assert.equal(result.pauseStyle, "soft");
  assert.ok(result.energy < 0.5);
  assert.match(result.ttsInstructions, /温暖|轻柔|陪伴/);
  assert.match(result.responseInstruction, /短句|自然/);
});

test("humanizer keeps acknowledgements short and lowers first chunk threshold", () => {
  const director = new LiveHumanizer();
  const result = director.direct(context({ userText: "嗯嗯", userEmotion: "neutral" }));

  assert.equal(result.profileId, "micro_ack");
  assert.equal(result.backchannelStyle, "responsive");
  assert.equal(result.chunking.firstChunkMinChars, 2);
  assert.ok(result.chunking.firstChunkMaxChars <= 10);
  assert.match(result.responseInstruction, /很短的自然反馈/);
});

test("humanizer uses brisk focused delivery for urgent requests without panic", () => {
  const director = new LiveHumanizer();
  const result = director.direct(context({ userText: "我马上要迟到了，快点告诉我怎么办" }));

  assert.equal(result.profileId, "focused_urgent");
  assert.equal(result.pace, "brisk");
  assert.match(result.ttsInstructions, /专注|不要夸张|轻快|快/);
});

test("humanizer preserves warm continuity across a following unknown-emotion turn", () => {
  const director = new LiveHumanizer();
  director.direct(context({ userEmotion: "sad", userText: "我今天真的挺难过" }));
  const next = director.direct(context({ userEmotion: "unknown", userText: "其实也不知道该怎么说" }));

  assert.equal(next.profileId, "warm_continuity");
  assert.equal(next.pauseStyle, "soft");
});

test("humanizer adds context-aware initiative only at high proactivity", () => {
  const director = new LiveHumanizer();
  const active = director.direct(context({ proactivity: 0.9, secondsSinceAiSpoke: 30 }));
  const quiet = director.direct(context({ proactivity: 0.2, secondsSinceAiSpoke: 30 }));

  assert.match(active.responseInstruction, /小问题/);
  assert.match(quiet.responseInstruction, /不要为了延长对话机械地/);
});

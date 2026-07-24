import assert from "node:assert/strict";
import test from "node:test";
import type { AcousticProsodySnapshot } from "../src/pipeline/acoustic-prosody-analyzer.js";
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

function acoustic(overrides: Partial<AcousticProsodySnapshot> = {}): AcousticProsodySnapshot {
  return {
    durationMs: 3200,
    rmsDbfs: -25,
    peakDbfs: -10,
    dynamicRangeDb: 10,
    silenceRatio: 0.12,
    zeroCrossingRate: 0.09,
    pitchHz: 180,
    pitchVariation: 0.08,
    energy: "medium",
    tempoHint: "normal",
    confidence: 0.8,
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

test("humanizer uses low-arousal acoustic context only to soften its own delivery", () => {
  const director = new LiveHumanizer();
  director.setAcousticContext(acoustic({
    energy: "low",
    tempoHint: "slow",
    silenceRatio: 0.36,
    rmsDbfs: -35,
  }));
  const result = director.direct(context({ userText: "我今天回家比较晚", userEmotion: "unknown" }));

  assert.equal(result.profileId, "reflective_soft");
  assert.equal(result.pace, "relaxed");
  assert.equal(result.acousticBasis?.energy, "low");
  assert.match(result.responseInstruction, /绝不能据此断言/);
  assert.doesNotMatch(result.responseInstruction, /你很悲伤|你很难过|你有抑郁/u);
});

test("explicit urgent language overrides a calm acoustic pattern", () => {
  const director = new LiveHumanizer();
  director.setAcousticContext(acoustic({
    energy: "low",
    tempoHint: "slow",
    silenceRatio: 0.4,
  }));
  const result = director.direct(context({ userText: "快点，我马上要迟到了怎么办" }));

  assert.equal(result.profileId, "focused_urgent");
  assert.equal(result.pace, "brisk");
});

test("acoustic context is consumed per turn instead of leaking forever", () => {
  const director = new LiveHumanizer();
  director.setAcousticContext(acoustic({ energy: "high", tempoHint: "fast", rmsDbfs: -12 }));
  const first = director.direct(context({ userText: "今天我们聊点新的东西吧" }));
  const second = director.direct(context({ userText: "好，那开始吧" }));

  assert.ok(first.acousticBasis);
  assert.equal(second.acousticBasis, undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { BackchannelEngine } from "../src/pipeline/backchannel-engine.js";
import { InterruptionMemory } from "../src/pipeline/interruption-memory.js";
import { SemanticTurnManager } from "../src/pipeline/semantic-turn-manager.js";

test("semantic turn manager commits explicit completions quickly", () => {
  const manager = new SemanticTurnManager();
  const complete = manager.decide("好的，就这样。 ");
  assert.equal(complete.completion, "complete");
  assert.ok(complete.commitDelayMs <= 100);

  const question = manager.decide("明天几点出发呢");
  assert.equal(question.completion, "likely_complete");
  assert.ok(question.commitDelayMs <= 150);
});

test("semantic turn manager protects thinking pauses and continuations", () => {
  const manager = new SemanticTurnManager();
  const continuation = manager.decide("我觉得这个事情其实");
  assert.equal(continuation.completion, "incomplete");
  assert.ok(continuation.commitDelayMs >= 500);

  const softPause = manager.decide("然后我当时就在想……");
  assert.equal(softPause.completion, "incomplete");
  assert.ok(softPause.commitDelayMs >= 500);
});

test("backchannel engine is conservative and one-shot per speech segment", () => {
  const engine = new BackchannelEngine(3_000, 10_000);
  engine.beginSpeech(1_000);
  assert.equal(engine.observe({
    text: "我当时先去了那边，然后又遇到一个朋友，后来我们就继续往前走",
    emotion: "neutral",
    interactionMode: "owner_focus",
    activeResponse: false,
    now: 2_000,
  }), undefined);

  const cue = engine.observe({
    text: "我当时先去了那边，然后又遇到一个朋友，后来我们就继续往前走，然后",
    emotion: "neutral",
    interactionMode: "owner_focus",
    activeResponse: false,
    now: 4_500,
  });
  assert.equal(cue?.cue, "嗯，我在听。");

  const duplicate = engine.observe({
    text: "后面还有很多事情，然后我又想起来一些细节",
    emotion: "neutral",
    interactionMode: "owner_focus",
    activeResponse: false,
    now: 5_000,
  });
  assert.equal(duplicate, undefined);
});

test("backchannel engine suppresses sensitive and group conversations", () => {
  const sensitive = new BackchannelEngine(0, 0);
  sensitive.beginSpeech(0);
  assert.equal(sensitive.observe({
    text: "我最近真的很崩溃，然后也不知道应该怎么办，后来越来越焦虑",
    emotion: "sad",
    interactionMode: "owner_focus",
    activeResponse: false,
    now: 10_000,
  }), undefined);

  const group = new BackchannelEngine(0, 0);
  group.beginSpeech(0);
  assert.equal(group.observe({
    text: "我们几个人当时一直聊这个事情，然后后来又说到了另外一个方案",
    emotion: "neutral",
    interactionMode: "group",
    activeResponse: false,
    now: 10_000,
  }), undefined);
});

test("interruption memory is consumed exactly once", () => {
  const memory = new InterruptionMemory();
  memory.remember({
    generatedText: "这个问题主要有三个方面。第一是延迟，第二是成本，第三是稳定性。",
    likelySpokenText: "这个问题主要有三个方面。第一是延迟。",
    reason: "barge_in",
  });

  const instruction = memory.consumeInstruction();
  assert.ok(instruction?.includes("不要从头重复"));
  assert.ok(instruction?.includes("第一是延迟"));
  assert.equal(memory.consumeInstruction(), undefined);
});

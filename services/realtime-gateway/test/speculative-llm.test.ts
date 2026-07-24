import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSpeculativeMessages,
  SpeculativeLlmCoordinator,
  StablePartialTracker,
  textSimilarity,
  type StreamChatFunction,
} from "../src/pipeline/speculative-llm.js";

const history = [
  { role: "system" as const, content: "你是小派。" },
  { role: "user" as const, content: "你好" },
  { role: "assistant" as const, content: "你好呀" },
];

test("stable partial tracker starts when content stays stable and punctuation completes the turn", () => {
  const tracker = new StablePartialTracker();
  tracker.observe("我想查一下天气");
  assert.equal(tracker.shouldStartEarly(), false);
  tracker.observe("我想查一下天气。");
  assert.equal(tracker.shouldStartEarly(), true);
  tracker.reset();
  tracker.observe("我想查一下天气。");
  assert.equal(tracker.shouldStartEarly(), false);
});

test("text similarity accepts final punctuation and small ASR corrections", () => {
  assert.ok(textSimilarity("帮我看看明天的天气", "帮我看看明天天气。") >= 0.86);
  assert.ok(textSimilarity("我想去广州", "完全不相关的问题") < 0.86);
});

test("speculative stream is adopted and buffered deltas are replayed", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const original: StreamChatFunction = async ({ onDelta, signal }) => {
    calls += 1;
    await onDelta("当然");
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    await onDelta("可以");
  };
  const coordinator = new SpeculativeLlmCoordinator(original);
  assert.equal(coordinator.start("帮我看看明天天气", buildSpeculativeMessages(history, "帮我看看明天天气")), true);

  const output: string[] = [];
  const adopted = coordinator.streamOrAdopt({
    messages: [...history, { role: "user", content: "帮我看看明天的天气。" }],
    signal: new AbortController().signal,
    onDelta: (delta) => { output.push(delta); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  await adopted;

  assert.equal(calls, 1);
  assert.deepEqual(output, ["当然", "可以"]);
  assert.equal(coordinator.stats.adopted, 1);
});

test("mismatched final transcript cancels speculation and runs normal request", async () => {
  const calls: string[] = [];
  const original: StreamChatFunction = async ({ messages, onDelta, signal }) => {
    const user = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    calls.push(user);
    if (user.includes("广州")) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    await onDelta("新的答案");
  };
  const coordinator = new SpeculativeLlmCoordinator(original);
  coordinator.start("我想去广州", buildSpeculativeMessages(history, "我想去广州"));
  const output: string[] = [];
  await coordinator.streamOrAdopt({
    messages: [...history, { role: "user", content: "帮我写一段代码" }],
    signal: new AbortController().signal,
    onDelta: (delta) => { output.push(delta); },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(output, ["新的答案"]);
  assert.equal(coordinator.stats.rejected, 1);
});

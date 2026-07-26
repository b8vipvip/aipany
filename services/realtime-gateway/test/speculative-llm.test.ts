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

test("stable natural partial can start speculation before final punctuation", () => {
  const tracker = new StablePartialTracker();
  tracker.observe("因为刚刚吃完饭才发现有点不舒服");
  assert.equal(tracker.shouldStartEarly(), false);
  tracker.observe("因为刚刚吃完饭才发现有点不舒服");
  assert.equal(tracker.shouldStartEarly(), true);

  tracker.reset();
  tracker.observe("这个问题我想请你仔细帮我分析一下");
  tracker.observe("这个问题我想请你仔细帮我分析一下");
  tracker.observe("这个问题我想请你仔细帮我分析一下");
  assert.equal(tracker.shouldStartEarly(), true);
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

test("adopted speculation cancelled before its first token falls back to a normal response", async () => {
  let calls = 0;
  const original: StreamChatFunction = async ({ onDelta, traceId }) => {
    calls += 1;
    if (traceId?.startsWith("speculative-")) {
      throw new DOMException("aborted", "AbortError");
    }
    await onDelta("这次正常回答");
  };
  const coordinator = new SpeculativeLlmCoordinator(original);
  coordinator.start("你还记得刚刚的话吗", buildSpeculativeMessages(history, "你还记得刚刚的话吗"));

  const output: string[] = [];
  await coordinator.streamOrAdopt({
    messages: [...history, { role: "user", content: "你还记得刚刚的话吗？" }],
    signal: new AbortController().signal,
    onDelta: (delta) => { output.push(delta); },
  });

  assert.equal(calls, 2);
  assert.deepEqual(output, ["这次正常回答"]);
  assert.equal(coordinator.stats.emptyRetries, 1);
});

test("a normal provider response with zero tokens is retried once", async () => {
  let calls = 0;
  const original: StreamChatFunction = async ({ onDelta }) => {
    calls += 1;
    if (calls === 2) await onDelta("重试后有回答");
  };
  const coordinator = new SpeculativeLlmCoordinator(original);
  const output: string[] = [];

  await coordinator.streamOrAdopt({
    messages: [...history, { role: "user", content: "请回答我" }],
    signal: new AbortController().signal,
    onDelta: (delta) => { output.push(delta); },
  });

  assert.equal(calls, 2);
  assert.deepEqual(output, ["重试后有回答"]);
  assert.equal(coordinator.stats.emptyRetries, 1);
});

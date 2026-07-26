import assert from "node:assert/strict";
import test from "node:test";
import { SpeculativeLlmCoordinator, type StreamChatFunction } from "../src/pipeline/speculative-llm.js";

test("a turn cannot finish silently after an upstream zero-token completion", async () => {
  let calls = 0;
  const stream: StreamChatFunction = async ({ onDelta }) => {
    calls += 1;
    if (calls === 2) await onDelta("我听到了，继续说吧。");
  };
  const coordinator = new SpeculativeLlmCoordinator(stream);
  const output: string[] = [];

  await coordinator.streamOrAdopt({
    messages: [
      { role: "system", content: "你是小派。" },
      { role: "user", content: "刚刚为什么没有回复？" },
    ],
    signal: new AbortController().signal,
    onDelta: (delta) => output.push(delta),
  });

  assert.equal(calls, 2);
  assert.equal(output.join(""), "我听到了，继续说吧。");
});

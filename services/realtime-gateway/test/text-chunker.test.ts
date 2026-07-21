import assert from "node:assert/strict";
import test from "node:test";
import { StreamingTextChunker } from "../src/pipeline/text-chunker.js";

test("按完整句子尽早切分", () => {
  const chunker = new StreamingTextChunker(4, 20);
  assert.deepEqual(chunker.push("嗯，今天挺不错的。"), ["嗯，今天挺不错的。"]);
  assert.equal(chunker.flush(), "");
});

test("首段遇到短停顿符会更早送入 TTS", () => {
  const chunker = new StreamingTextChunker();
  assert.deepEqual(chunker.push("你好呀，我是"), ["你好呀，"]);
  assert.equal(chunker.flush(), "我是");
});

test("首段无标点时达到低延迟上限会强制输出", () => {
  const chunker = new StreamingTextChunker();
  const result = chunker.push("这是一个没有任何标点需要尽快开始播报的长文本");
  assert.equal(result[0], "这是一个没有任何标点需要尽快开始播报");
});

test("过长文本会强制切分", () => {
  const chunker = new StreamingTextChunker(4, 8);
  const result = chunker.push("1234567890");
  assert.equal(result[0], "12345678");
  assert.equal(chunker.flush(), "90");
});

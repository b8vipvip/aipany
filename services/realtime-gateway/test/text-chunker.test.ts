import assert from "node:assert/strict";
import test from "node:test";
import { StreamingTextChunker } from "../src/pipeline/text-chunker.js";

test("按完整句子尽早切分", () => {
  const chunker = new StreamingTextChunker(4, 20);
  assert.deepEqual(chunker.push("嗯，今天挺不错的。"), ["嗯，今天挺不错的。"]);
  assert.equal(chunker.flush(), "");
});

test("过长文本会强制切分", () => {
  const chunker = new StreamingTextChunker(4, 8);
  const result = chunker.push("1234567890");
  assert.equal(result[0], "12345678");
  assert.equal(chunker.flush(), "90");
});

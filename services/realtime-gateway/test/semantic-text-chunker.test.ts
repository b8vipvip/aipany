import assert from "node:assert/strict";
import test from "node:test";
import { StreamingTextChunker } from "../src/pipeline/text-chunker.js";

test("semantic chunker prefers a natural first spoken phrase", () => {
  const chunker = new StreamingTextChunker(6, 30, 3, 18);
  const input = "当然可以，我先告诉你最重要的一点，然后我们再慢慢看其他情况。";
  const chunks = [...chunker.push(input), chunker.flush()].filter(Boolean);

  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(""), input);
  assert.match(chunks[0] ?? "", /[，。！？!?；;]$/u);
  assert.ok((chunks[0]?.length ?? 99) <= 18);
});

test("semantic chunker can split before a discourse transition even without punctuation", () => {
  const chunker = new StreamingTextChunker(5, 24, 4, 18);
  const input = "我先把核心问题讲清楚然后我们再看后面的细节";
  const chunks = [...chunker.push(input), chunker.flush()].filter(Boolean);

  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(""), input);
  assert.equal(chunks[0], "我先把核心问题讲清楚");
  assert.match(chunks[1] ?? "", /^然后/u);
});

test("semantic chunker waits for a quote to close instead of cutting inside it", () => {
  const chunker = new StreamingTextChunker(4, 12, 4, 12);
  const first = chunker.push("他说“这个方案，其实还可以");
  assert.deepEqual(first, []);

  const inputTail = "，不过还需要测试”，然后再决定。";
  const chunks = [...chunker.push(inputTail), chunker.flush()].filter(Boolean);
  const reconstructed = `他说“这个方案，其实还可以${inputTail}`;

  assert.equal(chunks.join(""), reconstructed);
  assert.ok(chunks.some((chunk) => chunk.includes("”")));
  for (const chunk of chunks.slice(0, -1)) {
    const opens = (chunk.match(/“/gu) ?? []).length;
    const closes = (chunk.match(/”/gu) ?? []).length;
    assert.ok(closes >= opens || opens === 0, `chunk should not end inside an open quote: ${chunk}`);
  }
});

test("semantic chunker still applies a hard ceiling to malformed never-closed structures", () => {
  const chunker = new StreamingTextChunker(4, 10, 4, 10);
  const chunks = chunker.push("他说“这是一段一直没有关闭引号而且特别特别长的模型输出内容");
  assert.ok(chunks.length >= 1);
  assert.ok((chunks[0]?.length ?? 0) <= 10);
});

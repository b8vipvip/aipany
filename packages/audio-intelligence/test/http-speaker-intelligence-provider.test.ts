import assert from "node:assert/strict";
import test from "node:test";
import { HttpSpeakerIntelligenceProvider } from "../src/providers/http-speaker-intelligence-provider.js";

test("解析 Speaker Intelligence embedding 响应", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    embedding: [0.1, 0.2, 0.3],
    quality: 0.91,
    duration_ms: 1200,
    model: "test-model",
    dimensions: 3,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const provider = new HttpSpeakerIntelligenceProvider({ baseUrl: "http://speaker.local" });
    const result = await provider.extractEmbedding(Buffer.alloc(32000), {
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });

    assert.deepEqual(result.embedding, [0.1, 0.2, 0.3]);
    assert.equal(result.quality, 0.91);
    assert.equal(result.durationMs, 1200);
    assert.equal(result.model, "test-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("非法 embedding 响应会失败", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ embedding: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const provider = new HttpSpeakerIntelligenceProvider({ baseUrl: "http://speaker.local" });
    await assert.rejects(() => provider.extractEmbedding(Buffer.alloc(32000), {
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    }), /无效声纹向量/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

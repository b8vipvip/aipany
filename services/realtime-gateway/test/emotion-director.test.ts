import assert from "node:assert/strict";
import test from "node:test";
import { EmotionDirector } from "../src/pipeline/emotion-director.js";

test("悲伤用户得到温柔的语音指导", () => {
  const result = new EmotionDirector().direct("sad");
  assert.equal(result.emotion, "warm_gentle");
  assert.match(result.instructions, /温暖|轻柔/);
});

test("未知情绪回退到自然语气", () => {
  const result = new EmotionDirector().direct("unknown");
  assert.equal(result.emotion, "natural");
});

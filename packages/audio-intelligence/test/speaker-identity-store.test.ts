import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySpeakerIdentityStore } from "../src/speaker-identity-store.js";

test("多次一致声纹样本会把人物从 learning 提升为 confirmed", () => {
  const store = new InMemorySpeakerIdentityStore({
    confirmSampleCount: 3,
    confirmConfidence: 0.8,
    matchThreshold: 0.8,
  });
  const person = store.createPerson({ name: "小王" });

  const samples = [
    [1, 0, 0.02],
    [0.99, 0.01, 0],
    [1, 0.02, 0.01],
  ];

  let status = "";
  for (const embedding of samples) {
    status = store.addVoiceSample({ personId: person.id, embedding, quality: 0.95 }).status;
  }

  assert.equal(status, "confirmed");
  const match = store.identify([0.995, 0.01, 0.01]);
  assert.equal(match.person?.name, "小王");
  assert.equal(match.confident, true);
});

test("相似度不足时不会强行确认人物身份", () => {
  const store = new InMemorySpeakerIdentityStore({ confirmSampleCount: 2, confirmConfidence: 0.7, matchThreshold: 0.85 });
  const person = store.createPerson({ name: "主人", isOwner: true });
  store.addVoiceSample({ personId: person.id, embedding: [1, 0, 0], quality: 1 });
  store.addVoiceSample({ personId: person.id, embedding: [0.99, 0.01, 0], quality: 1 });

  const match = store.identify([0, 1, 0]);
  assert.equal(match.confident, false);
});

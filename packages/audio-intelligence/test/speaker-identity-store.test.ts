import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySpeakerIdentityStore } from "../src/speaker-identity-store.js";

const scope = { tenantId: "tenant-a", userId: "user-a" };

test("多次一致声纹样本会把人物从 learning 提升为 confirmed", () => {
  const store = new InMemorySpeakerIdentityStore({
    confirmSampleCount: 3,
    confirmConfidence: 0.8,
    matchThreshold: 0.8,
  });
  const person = store.createPerson(scope, { name: "小王" });

  const samples = [
    [1, 0, 0.02],
    [0.99, 0.01, 0],
    [1, 0.02, 0.01],
  ];

  let status = "";
  for (const embedding of samples) {
    status = store.addVoiceSample(scope, { personId: person.id, embedding, quality: 0.95 }).status;
  }

  assert.equal(status, "confirmed");
  const match = store.identify(scope, [0.995, 0.01, 0.01]);
  assert.equal(match.person?.name, "小王");
  assert.equal(match.confident, true);
});

test("相似度不足时不会强行确认人物身份", () => {
  const store = new InMemorySpeakerIdentityStore({ confirmSampleCount: 2, confirmConfidence: 0.7, matchThreshold: 0.85 });
  const person = store.createPerson(scope, { name: "主人", isOwner: true });
  store.addVoiceSample(scope, { personId: person.id, embedding: [1, 0, 0], quality: 1 });
  store.addVoiceSample(scope, { personId: person.id, embedding: [0.99, 0.01, 0], quality: 1 });

  const match = store.identify(scope, [0, 1, 0]);
  assert.equal(match.confident, false);
});

test("不同 tenant/user 作用域之间不会串用人物声纹", () => {
  const store = new InMemorySpeakerIdentityStore({ confirmSampleCount: 2, confirmConfidence: 0.7, matchThreshold: 0.8 });
  const person = store.createPerson(scope, { name: "主人", isOwner: true });
  store.addVoiceSample(scope, { personId: person.id, embedding: [1, 0, 0], quality: 1 });
  store.addVoiceSample(scope, { personId: person.id, embedding: [0.99, 0.01, 0], quality: 1 });

  const otherScopeMatch = store.identify({ tenantId: "tenant-b", userId: "user-a" }, [1, 0, 0]);
  assert.equal(otherScopeMatch.person, undefined);
  assert.equal(otherScopeMatch.confident, false);
});

test("删除人物会同时移除其 Voice Profile", () => {
  const store = new InMemorySpeakerIdentityStore();
  const person = store.createPerson(scope, { name: "临时人物" });
  store.addVoiceSample(scope, { personId: person.id, embedding: [1, 0, 0], quality: 1 });
  assert.equal(store.deletePerson(scope, person.id), true);
  assert.equal(store.getPerson(scope, person.id), undefined);
  assert.equal(store.getProfileByPerson(scope, person.id), undefined);
});

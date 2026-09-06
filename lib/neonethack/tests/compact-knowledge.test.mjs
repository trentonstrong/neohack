import test from "node:test";
import assert from "node:assert/strict";
import { CompactResponses, CompactObservationReader } from "../dist/mcp/compact.js";

// knowledge carries observedTurn, which advances every ordinary turn; a delta
// must not re-send the whole block when only that marker moved.
const knowledge = (observedTurn, kills) => ({
  observedTurn,
  skills: [
    { id: "skill-1", name: "dagger", level: "Basic", advancement: "practice" },
    { id: "skill-17", name: "spear", level: "Basic", advancement: "practice" },
    { id: "skill-28", name: "attack spells", level: "Unskilled", advancement: "practice" },
  ],
  conduct: { kills, weaponHits: kills, food: 0, wishes: 0, pets: 1 },
  spells: [],
  levels: [{ branch: "The Dungeons of Doom", depth: 1, id: "level-0-1", freshness: "remembered", features: {} }],
  achievements: [],
});

const frame = (revision, turn, k) => ({
  version: 1, sessionId: "a", revision,
  observation: {
    location: { id: "level-0-1" },
    turn,
    you: { x: 5, y: 5 },
    vitals: { turn, health: 16 },
    knowledge: k,
    perception: { version: 2, inventory: "current", here: "current", equipment: "current", knowledge: k ? "current" : "unknown" },
    world: [{ x: 5, y: 5, terrain: { type: "floor" } }],
  },
});

test("ordinary deltas omit knowledge when only its observedTurn advanced", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  reader.apply(compact.project(frame(1, 1, knowledge(1, 1)), "session.create"));
  const next = compact.project(frame(2, 2, knowledge(2, 1)), "game.move");
  assert.equal(next.update.kind, "delta");
  assert.equal(next.observation.knowledge, undefined, "static knowledge must not ride along the delta");
  assert.equal(next.update.knowledgeObservedTurn, 2);
  const materialized = reader.apply(next);
  assert.deepEqual(materialized, frame(2, 2, knowledge(2, 1)));
});

test("deltas still disclose knowledge when its content changes", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  reader.apply(compact.project(frame(1, 1, knowledge(1, 1)), "session.create"));
  const next = compact.project(frame(2, 2, knowledge(2, 2)), "game.move");
  assert.equal(next.update.kind, "delta");
  assert.deepEqual(next.observation.knowledge, knowledge(2, 2));
  assert.equal(next.update.knowledgeObservedTurn, undefined);
  const materialized = reader.apply(next);
  assert.equal(materialized.observation.knowledge.observedTurn, 2);
  assert.equal(materialized.observation.knowledge.conduct.kills, 2);
});

test("content changes after an omission are still disclosed and replace the baseline", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  reader.apply(compact.project(frame(1, 1, knowledge(1, 1)), "session.create"));
  reader.apply(compact.project(frame(2, 2, knowledge(2, 1)), "game.move"));
  const next = compact.project(frame(3, 3, knowledge(3, 4)), "game.move");
  assert.deepEqual(next.observation.knowledge, knowledge(3, 4), "changed content must be emitted");
  const materialized = reader.apply(next);
  assert.equal(materialized.observation.knowledge.observedTurn, 3);
  assert.equal(materialized.observation.knowledge.conduct.kills, 4);
});

test("timestamp deltas reconstruct current and last-known observations exactly", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  for (const [revision, turn, observedTurn, freshness] of [
    [1, 1, 1, "current"], [2, 2, 2, "current"], [3, 3, 3, "current"],
    [4, 4, 3, "lastKnown"], [5, 5, 5, "current"],
  ]) {
    const input = frame(revision, turn, knowledge(observedTurn, 1));
    input.observation.perception.knowledge = freshness;
    const projected = compact.project(input, "game.wait");
    assert.deepEqual(reader.apply(projected), input);
    assert.equal(input.observation.knowledge.observedTurn, observedTurn, "projection does not mutate input");
    const retry = compact.project(input, "game.wait");
    assert.equal(retry.update.knowledgeObservedTurn, undefined);
    assert.deepEqual(reader.apply(retry), input);
  }
});

test("knowledge removal, restoration, and snapshots retain full replacement semantics", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  const initial = frame(1, 1, knowledge(1, 1));
  reader.apply(compact.project(initial, "session.create"));
  const removed = frame(2, 2, undefined);
  delete removed.observation.knowledge;
  const delta = compact.project(removed, "game.wait");
  assert.ok(delta.update.remove.includes("knowledge"));
  assert.deepEqual(reader.apply(delta), removed);
  const restored = frame(3, 3, knowledge(3, 1));
  const replacement = compact.project(restored, "game.wait");
  assert.deepEqual(replacement.observation.knowledge, restored.observation.knowledge);
  assert.equal(replacement.update.knowledgeObservedTurn, undefined);
  assert.deepEqual(reader.apply(replacement), restored);
  for (const [input, method] of [[restored, "session.observe"], [restored, "session.resume"], [initial, "game.wait"]]) {
    const snapshot = compact.project(input, method);
    assert.equal(snapshot.update.kind, "snapshot");
    assert.equal(snapshot.update.knowledgeObservedTurn, undefined);
    assert.deepEqual(reader.apply(snapshot), input);
  }
});

test("timestamp updates require an unchanged knowledge baseline", () => {
  for (const mode of ["missing", "removed", "replaced"]) {
    const reader = new CompactObservationReader();
    const baseline = frame(1, 1, knowledge(1, 1));
    if (mode === "missing") delete baseline.observation.knowledge;
    reader.apply({ ...baseline, update: { kind: "snapshot", id: 1 } });
    const delta = { version: 1, sessionId: "a", observation: {},
      update: { kind: "delta", id: 2, base: 1, knowledgeObservedTurn: 2 } };
    if (mode === "removed") delta.update.remove = ["knowledge"];
    if (mode === "replaced") delta.observation.knowledge = knowledge(2, 1);
    assert.throws(() => reader.apply(delta), /Invalid knowledge timestamp update/);
  }
});

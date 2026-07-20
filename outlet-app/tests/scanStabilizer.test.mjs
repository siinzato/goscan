import test from "node:test";
import assert from "node:assert/strict";
import { Stabilizer, stabilityKeyFor } from "../src/client/scanStabilizer.ts";

test("stabilityKeyFor returns null for no_result", () => {
  assert.equal(stabilityKeyFor({ status: "no_result", requires_capacity_selection: false, visual_family: null, variant: null, candidates: [] }), null);
});

test("stabilityKeyFor uses family+variant when capacity selection is required", () => {
  const key = stabilityKeyFor({
    status: "ambiguous",
    requires_capacity_selection: true,
    visual_family: "copo-life",
    variant: "pink",
    candidates: [{ product_id: "p1" }],
  });
  assert.equal(key, "family:copo-life:pink");
});

test("stabilityKeyFor uses top candidate product_id when matched", () => {
  const key = stabilityKeyFor({
    status: "matched",
    requires_capacity_selection: false,
    visual_family: "copo-life",
    variant: "pink",
    candidates: [{ product_id: "p1" }, { product_id: "p2" }],
  });
  assert.equal(key, "p1");
});

test("Stabilizer only reports stable after N consecutive identical keys", () => {
  const s = new Stabilizer(3, 6);
  assert.equal(s.push("p1").isStable, false);
  assert.equal(s.push("p1").isStable, false);
  const third = s.push("p1");
  assert.equal(third.isStable, true);
  assert.equal(third.stableKey, "p1");
});

test("Stabilizer resets the streak when the key changes", () => {
  const s = new Stabilizer(2, 6);
  assert.equal(s.push("p1").isStable, false);
  assert.equal(s.push("p1").isStable, true);
  assert.equal(s.push("p2").isStable, false); // mudou — precisa de 2 de novo
  assert.equal(s.push("p2").isStable, true);
});

test("Stabilizer never stabilizes on null (no_result) keys", () => {
  const s = new Stabilizer(2, 6);
  s.push(null);
  const result = s.push(null);
  assert.equal(result.isStable, false);
  assert.equal(result.stableKey, null);
});

test("Stabilizer.reset clears the history", () => {
  const s = new Stabilizer(2, 6);
  s.push("p1");
  s.push("p1");
  s.reset();
  assert.equal(s.push("p1").isStable, false);
});

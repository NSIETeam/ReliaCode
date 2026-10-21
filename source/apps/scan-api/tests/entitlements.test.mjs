import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISIONS,
  PLAN_IDS,
  PLANS,
  REASON_CODES,
  createUsageSnapshot,
  evaluateEntitlements,
  getPlan,
} from "../src/entitlements.mjs";

test("exposes immutable free and team plan limits", () => {
  assert.deepEqual(getPlan(PLAN_IDS.FREE), { id: "free", memberLimit: 3, monthlyScanLimit: 100, monthlyCodeLimit: 1000 });
  assert.deepEqual(getPlan(PLAN_IDS.TEAM), { id: "team", memberLimit: 25, monthlyScanLimit: 5000, monthlyCodeLimit: 50000 });
  assert.throws(() => { PLANS.free.memberLimit = 99; }, TypeError);
  assert.throws(() => { REASON_CODES.OK = "EVIL"; }, TypeError);
});

test("creates a normalized immutable usage snapshot", () => {
  const snapshot = createUsageSnapshot({ members: 2, monthlyScans: 8 });
  assert.deepEqual(snapshot, { members: 2, monthlyScans: 8, monthlyCodes: 0 });
  assert.throws(() => { snapshot.members = 9; }, TypeError);
  assert.throws(() => createUsageSnapshot({ monthlyScans: -1 }), /non-negative/);
});

test("allows within limits and warns at the threshold", () => {
  const allowed = evaluateEntitlements({ plan: "free", usage: { members: 1, monthlyScans: 20, monthlyCodes: 100 } });
  assert.equal(allowed.decision, DECISIONS.ALLOW);
  assert.equal(allowed.reasonCode, REASON_CODES.OK);
  const warning = evaluateEntitlements({ plan: "free", usage: { members: 2, monthlyScans: 0, monthlyCodes: 0 }, increment: { members: 1 } });
  assert.equal(warning.decision, DECISIONS.WARN);
  assert.equal(warning.reasonCode, REASON_CODES.NEAR_MEMBER_LIMIT);
});

test("blocks a projected member, scan, or code overage with canonical reason codes", () => {
  for (const [increment, code] of [
    [{ members: 1 }, REASON_CODES.MEMBER_LIMIT_EXCEEDED],
    [{ monthlyScans: 1 }, REASON_CODES.MONTHLY_SCAN_LIMIT_EXCEEDED],
    [{ monthlyCodes: 1 }, REASON_CODES.MONTHLY_CODE_LIMIT_EXCEEDED],
  ]) {
    const usage = code === REASON_CODES.MEMBER_LIMIT_EXCEEDED ? { members: 3 } : code === REASON_CODES.MONTHLY_SCAN_LIMIT_EXCEEDED ? { monthlyScans: 100 } : { monthlyCodes: 1000 };
    const verdict = evaluateEntitlements({ plan: "free", usage, increment });
    assert.equal(verdict.decision, DECISIONS.BLOCK);
    assert.equal(verdict.reasonCode, code);
  }
});

test("rejects unknown plans and malformed increments", () => {
  assert.throws(() => evaluateEntitlements({ plan: "enterprise" }), /unknown plan/);
  assert.throws(() => evaluateEntitlements({ increment: { members: 1.5 } }), /safe integer/);
});

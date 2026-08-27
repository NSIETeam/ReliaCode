/**
 * Pure SaaS entitlement primitives.
 *
 * Keep this module independent from HTTP and persistence so quota decisions can
 * be reused by API handlers, jobs and operator tooling without divergent rules.
 */

export const PLAN_IDS = Object.freeze({ FREE: "free", TEAM: "team" });

const PLAN_DEFINITIONS = {
  [PLAN_IDS.FREE]: {
    id: PLAN_IDS.FREE,
    memberLimit: 3,
    monthlyScanLimit: 100,
    monthlyCodeLimit: 1_000,
  },
  [PLAN_IDS.TEAM]: {
    id: PLAN_IDS.TEAM,
    memberLimit: 25,
    monthlyScanLimit: 5_000,
    monthlyCodeLimit: 50_000,
  },
};

export const PLANS = Object.freeze(Object.fromEntries(
  Object.entries(PLAN_DEFINITIONS).map(([id, plan]) => [id, Object.freeze({ ...plan })]),
));

export const DECISIONS = Object.freeze({ ALLOW: "allow", WARN: "warn", BLOCK: "block" });

// Callers receive these stable values, but cannot add or replace one.
export const REASON_CODES = Object.freeze({
  OK: "OK",
  NEAR_MEMBER_LIMIT: "NEAR_MEMBER_LIMIT",
  NEAR_MONTHLY_SCAN_LIMIT: "NEAR_MONTHLY_SCAN_LIMIT",
  NEAR_MONTHLY_CODE_LIMIT: "NEAR_MONTHLY_CODE_LIMIT",
  MEMBER_LIMIT_EXCEEDED: "MEMBER_LIMIT_EXCEEDED",
  MONTHLY_SCAN_LIMIT_EXCEEDED: "MONTHLY_SCAN_LIMIT_EXCEEDED",
  MONTHLY_CODE_LIMIT_EXCEEDED: "MONTHLY_CODE_LIMIT_EXCEEDED",
});

const WARN_AT = 0.8;
const USAGE_FIELDS = Object.freeze(["members", "monthlyScans", "monthlyCodes"]);

function finiteNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function freezeUsage(value) {
  return Object.freeze({
    members: finiteNonNegativeInteger(value?.members ?? 0, "members"),
    monthlyScans: finiteNonNegativeInteger(value?.monthlyScans ?? 0, "monthlyScans"),
    monthlyCodes: finiteNonNegativeInteger(value?.monthlyCodes ?? 0, "monthlyCodes"),
  });
}

function freezePlan(plan) {
  return Object.freeze({ ...plan });
}

export function getPlan(planId = PLAN_IDS.FREE) {
  const plan = PLANS[planId];
  if (!plan) throw new RangeError(`unknown plan: ${String(planId)}`);
  return plan;
}

export function createUsageSnapshot(usage = {}) {
  return freezeUsage(usage);
}

function incrementSnapshot(usage, increment) {
  return freezeUsage({
    members: usage.members + finiteNonNegativeInteger(increment?.members ?? 0, "members increment"),
    monthlyScans: usage.monthlyScans + finiteNonNegativeInteger(increment?.monthlyScans ?? 0, "monthlyScans increment"),
    monthlyCodes: usage.monthlyCodes + finiteNonNegativeInteger(increment?.monthlyCodes ?? 0, "monthlyCodes increment"),
  });
}

function result(decision, reasonCode, plan, usage, projected) {
  return Object.freeze({
    decision,
    reasonCode,
    plan: freezePlan(plan),
    usage,
    projectedUsage: projected,
    remaining: Object.freeze({
      members: Math.max(0, plan.memberLimit - projected.members),
      monthlyScans: Math.max(0, plan.monthlyScanLimit - projected.monthlyScans),
      monthlyCodes: Math.max(0, plan.monthlyCodeLimit - projected.monthlyCodes),
    }),
  });
}

/**
 * Evaluate current usage plus an optional atomic reservation increment.
 * Exceeding any limit always blocks; reaching 80% warns using a stable reason.
 */
export function evaluateEntitlements({ plan: planId = PLAN_IDS.FREE, usage = {}, increment = {} } = {}) {
  const plan = getPlan(planId);
  const snapshot = createUsageSnapshot(usage);
  const projected = incrementSnapshot(snapshot, increment);

  if (projected.members > plan.memberLimit) {
    return result(DECISIONS.BLOCK, REASON_CODES.MEMBER_LIMIT_EXCEEDED, plan, snapshot, projected);
  }
  if (projected.monthlyScans > plan.monthlyScanLimit) {
    return result(DECISIONS.BLOCK, REASON_CODES.MONTHLY_SCAN_LIMIT_EXCEEDED, plan, snapshot, projected);
  }
  if (projected.monthlyCodes > plan.monthlyCodeLimit) {
    return result(DECISIONS.BLOCK, REASON_CODES.MONTHLY_CODE_LIMIT_EXCEEDED, plan, snapshot, projected);
  }
  if (projected.members / plan.memberLimit >= WARN_AT) {
    return result(DECISIONS.WARN, REASON_CODES.NEAR_MEMBER_LIMIT, plan, snapshot, projected);
  }
  if (projected.monthlyScans / plan.monthlyScanLimit >= WARN_AT) {
    return result(DECISIONS.WARN, REASON_CODES.NEAR_MONTHLY_SCAN_LIMIT, plan, snapshot, projected);
  }
  if (projected.monthlyCodes / plan.monthlyCodeLimit >= WARN_AT) {
    return result(DECISIONS.WARN, REASON_CODES.NEAR_MONTHLY_CODE_LIMIT, plan, snapshot, projected);
  }
  return result(DECISIONS.ALLOW, REASON_CODES.OK, plan, snapshot, projected);
}

// Kept exportable for consumers that need to validate an independently stored
// snapshot while preserving one canonical implementation.
export const usageFields = USAGE_FIELDS;

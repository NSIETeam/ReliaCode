import assert from "node:assert/strict";
import test from "node:test";
import { nextObjectStatus, verificationForEvent } from "../src/domain.mjs";

test("receiving transitions only from in transit", () => {
  assert.equal(nextObjectStatus("RECEIVING_STORE", "CASE", "IN_TRANSIT"), "RECEIVED");
  assert.throws(() => nextObjectStatus("RECEIVING_STORE", "CASE", "COMMISSIONED"), { code:"INVALID_STATE_TRANSITION" });
});

test("verification never changes object status", () => {
  assert.equal(nextObjectStatus("VERIFY", "ITEM", "SOLD"), "SOLD");
});

test("cross organization receiving is rejected", () => {
  const result = verificationForEvent({
    eventType:"RECEIVING_STORE",
    shipment:{ to_organization_id:"store-a", expected_object:true },
    object:{},
    principal:{ organizationId:"store-b" }
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.risk.type, "ORGANIZATION_MISMATCH");
});

test("object absent from shipment goes to review", () => {
  const result = verificationForEvent({
    eventType:"RECEIVING_DISTRIBUTOR",
    shipment:{ to_organization_id:"dc-a", expected_object:false },
    object:{},
    principal:{ organizationId:"dc-a" }
  });
  assert.equal(result.status, "PENDING_REVIEW");
  assert.equal(result.risk.type, "OBJECT_NOT_IN_SHIPMENT");
});

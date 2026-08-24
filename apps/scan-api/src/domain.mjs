export const eventCapability = {
  PACKING: "events:write:packing",
  RECEIVING_DISTRIBUTOR: "events:write:distributor_receiving",
  RECEIVING_STORE: "events:write:store_receiving"
};

const transitions = {
  PACKING: { ITEM: { COMMISSIONED: "PACKED" } },
  SHIPPING: {
    ITEM: { COMMISSIONED: "IN_TRANSIT", PACKED: "IN_TRANSIT", RECEIVED: "IN_TRANSIT" },
    CASE: { COMMISSIONED: "IN_TRANSIT", PACKED: "IN_TRANSIT", RECEIVED: "IN_TRANSIT" },
    PALLET: { COMMISSIONED: "IN_TRANSIT", PACKED: "IN_TRANSIT", RECEIVED: "IN_TRANSIT" }
  },
  RECEIVING_DISTRIBUTOR: {
    ITEM: { IN_TRANSIT: "RECEIVED" }, CASE: { IN_TRANSIT: "RECEIVED" }, PALLET: { IN_TRANSIT: "RECEIVED" }
  },
  RECEIVING_STORE: {
    ITEM: { IN_TRANSIT: "RECEIVED" }, CASE: { IN_TRANSIT: "RECEIVED" }, PALLET: { IN_TRANSIT: "RECEIVED" }
  },
  RETURNING: {
    ITEM: { RECEIVED: "RETURNED", SOLD: "RETURNED" }, CASE: { RECEIVED: "RETURNED" }, PALLET: { RECEIVED: "RETURNED" }
  },
  SELLING: { ITEM: { RECEIVED: "SOLD" } },
  VERIFY: {}
};

export function nextObjectStatus(eventType, level, currentStatus) {
  if (eventType === "VERIFY" || eventType === "UNPACKING") return currentStatus;
  const next = transitions[eventType]?.[level]?.[currentStatus];
  if (!next) {
    const error = new Error(`Event ${eventType} is not valid for ${level} in status ${currentStatus}`);
    error.statusCode = 409;
    error.code = "INVALID_STATE_TRANSITION";
    throw error;
  }
  return next;
}

export function verificationForEvent({ eventType, shipment, object, principal }) {
  if (eventType === "VERIFY") return { status: "VERIFIED", risk: null };
  if (eventType.startsWith("RECEIVING_")) {
    if (!shipment) return { status: "REJECTED", risk: { type: "SHIPMENT_REQUIRED", severity: "HIGH" } };
    if (shipment.to_organization_id !== principal.organizationId) {
      return { status: "REJECTED", risk: { type: "ORGANIZATION_MISMATCH", severity: "CRITICAL" } };
    }
    if (!shipment.expected_object) {
      return { status: "PENDING_REVIEW", risk: { type: "OBJECT_NOT_IN_SHIPMENT", severity: "HIGH" } };
    }
  }
  if (object.current_organization_id && eventType === "PACKING" && object.current_organization_id !== principal.organizationId) {
    return { status: "REJECTED", risk: { type: "CUSTODY_MISMATCH", severity: "CRITICAL" } };
  }
  return { status: "VERIFIED", risk: null };
}

export function canReward(verificationStatus) {
  return verificationStatus === "VERIFIED";
}

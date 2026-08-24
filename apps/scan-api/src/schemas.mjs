import { z } from "zod";

export const codeBatchSchema = z.object({
  productId: z.string().uuid(),
  level: z.enum(["ITEM", "CASE", "PALLET"]),
  quantity: z.number().int().min(1).max(1_000_000),
  serialRule: z.enum(["RANDOM", "SEQUENTIAL"]).default("RANDOM")
});

export const traceEventSchema = z.object({
  eventType: z.enum(["PACKING", "RECEIVING_DISTRIBUTOR", "RECEIVING_STORE", "UNPACKING", "SHIPPING", "RETURNING", "SELLING", "VERIFY"]),
  objectCode: z.string().trim().min(6).max(200).transform((value) => value.toUpperCase()),
  shipmentId: z.string().uuid().optional(),
  readPoint: z.string().trim().min(1).max(200),
  eventTime: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const riskDecisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "HOLD"]),
  reason: z.string().trim().min(10).max(1000)
});

export function parseIdempotencyKey(request) {
  const value = request.headers["idempotency-key"];
  if (!value || typeof value !== "string" || value.length < 16 || value.length > 200) {
    const error = new Error("A 16-200 character Idempotency-Key header is required");
    error.statusCode = 400;
    error.code = "INVALID_IDEMPOTENCY_KEY";
    throw error;
  }
  return value;
}

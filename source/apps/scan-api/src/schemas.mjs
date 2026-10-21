import { z } from "zod";

export const codeBatchSchema = z.object({
  productId: z.string().uuid(),
  level: z.enum(["ITEM", "CASE", "PALLET"]),
  quantity: z.number().int().min(1).max(1_000_000),
  serialRule: z.enum(["RANDOM", "SEQUENTIAL"]).default("RANDOM")
});

export const traceEventSchema = z.object({
  eventType: z.enum(["PACKING", "RECEIVING_DISTRIBUTOR", "RECEIVING_STORE", "UNPACKING", "REPACKING", "SHIPPING", "RETURNING", "SELLING", "DESTROYING", "VERIFY"]),
  objectCode: z.string().trim().min(6).max(200).transform((value) => value.toUpperCase()),
  shipmentId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  parentObjectCode: z.string().trim().min(6).max(200).transform((value) => value.toUpperCase()).optional(),
  readPoint: z.string().trim().min(1).max(200),
  eventTime: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).default({})
}).superRefine((value,ctx)=>{
  if(value.eventType!=="VERIFY"&&!value.documentId)ctx.addIssue({code:"custom",path:["documentId"],message:"A business document is required for state-changing events"});
  if(["PACKING","REPACKING"].includes(value.eventType)&&!value.parentObjectCode)ctx.addIssue({code:"custom",path:["parentObjectCode"],message:"A new parent object is required for packing or repacking"});
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

import { createHash } from "node:crypto";

export function requestHash(operation, body) {
  return createHash("sha256").update(JSON.stringify({ operation, body })).digest("hex");
}

export async function lockIdempotencyKey(client, tenantId, key) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${tenantId}:${key}`]);
}

export async function getIdempotentResponse(client, tenantId, key, hash) {
  const result = await client.query(
    "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2 AND expires_at>now()",
    [tenantId, key]
  );
  if (!result.rowCount) return null;
  if (result.rows[0].request_hash !== hash) {
    const error = new Error("Idempotency key was already used with a different request");
    error.statusCode = 409;
    error.code = "IDEMPOTENCY_CONFLICT";
    throw error;
  }
  return { status: result.rows[0].response_status, body: result.rows[0].response_body };
}

export async function saveIdempotentResponse(client, { tenantId, key, operation, hash, status, body }) {
  await client.query(
    `INSERT INTO idempotency_records(tenant_id,idempotency_key,operation,request_hash,response_status,response_body,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')`,
    [tenantId, key, operation, hash, status, body]
  );
}

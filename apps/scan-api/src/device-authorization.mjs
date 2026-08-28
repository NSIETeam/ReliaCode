import { hashToken } from "./auth.mjs";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code,message,statusCode){const error=new Error(message);error.code=code;error.statusCode=statusCode;throw error;}

export async function authorizeOperationalDevice(client,config,request,eventType,{fallbackReadPoint}={}){
  if(!config.REQUIRE_DEVICE_AUTHORIZATION)return{deviceId:null,locationId:null,readPoint:fallbackReadPoint};
  const deviceId=String(request.headers["x-reliacode-device-id"]||""),token=String(request.headers["x-reliacode-device-token"]||"");
  if(!uuid.test(deviceId)||token.length<32||token.length>200)fail("DEVICE_AUTH_REQUIRED","An active registered device credential is required",401);
  const result=await client.query(`SELECT d.id,d.location_id,l.gln FROM devices d JOIN locations l ON l.id=d.location_id AND l.tenant_id=d.tenant_id
    WHERE d.id=$1 AND d.tenant_id=$2 AND d.organization_id=$3 AND d.status='ACTIVE' AND d.credential_hash=$4
      AND $5=ANY(d.allowed_event_types) AND l.status='ACTIVE'`,[deviceId,request.principal.tenantId,request.principal.organizationId,hashToken(token),eventType]);
  if(!result.rowCount)fail("DEVICE_NOT_AUTHORIZED","Device is not authorized for this operation",404);
  if(!result.rows[0].gln)fail("DEVICE_LOCATION_GLN_REQUIRED","The device location must have a GLN before production use",409);
  await client.query("UPDATE devices SET last_seen_at=now() WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,deviceId]);
  return{deviceId,locationId:result.rows[0].location_id,readPoint:`https://id.gs1.org/414/${result.rows[0].gln}`};
}

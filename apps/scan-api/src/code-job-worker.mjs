import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";
import { pathToFileURL } from "node:url";
import { gtinForDigitalLink,isValidGtin } from "./gs1.mjs";

export async function processCodeJobChunk(db,config) {
  return db.transaction(async(client)=>{
    const selected=await client.query(
      `SELECT j.*,p.gtin FROM code_generation_jobs j JOIN products p ON p.id=j.product_id AND p.tenant_id=j.tenant_id
       WHERE j.status IN ('QUEUED','RUNNING') ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`
    );
    if(!selected.rowCount)return false;
    const job=selected.rows[0];
    const failure=job.identifier_scheme==="LEGACY_NONCONFORMING"?"Legacy nonconforming pallet jobs cannot generate production identifiers":job.identifier_scheme==="SSCC"&&(!job.gs1_company_prefix_snapshot||job.sscc_start_reference===null||job.sscc_start_reference===undefined)?"SSCC allocation snapshot is missing":job.identifier_scheme!=="SSCC"&&!isValidGtin(job.gtin)?"Product requires a valid GS1 GTIN before production code generation":null;
    if(failure){
      await client.query("UPDATE code_generation_jobs SET status='FAILED',last_error=$2,completed_at=now() WHERE id=$1",[job.id,failure]);
      const release=Math.max(0,Number(job.quantity)-Number(job.generated_count));
      if(release)await client.query("UPDATE tenant_usage_monthly SET code_count=GREATEST(0,code_count-$1),updated_at=now() WHERE tenant_id=$2 AND usage_month=date_trunc('month',now())::date",[release,job.tenant_id]);
      return true;
    }
    let batchId=job.code_batch_id;
    if(!batchId){
      const batch=await client.query(
        `INSERT INTO code_batches(tenant_id,product_id,level,quantity,serial_rule,status,created_by)
         VALUES($1,$2,$3,$4,$5,'GENERATED',$6) RETURNING id`,
        [job.tenant_id,job.product_id,job.level,job.quantity,job.serial_rule,job.requested_by]
      );
      batchId=batch.rows[0].id;
      await client.query("UPDATE code_generation_jobs SET status='RUNNING',started_at=now(),code_batch_id=$2 WHERE id=$1",[job.id,batchId]);
    }
    const remaining=job.quantity-job.generated_count;
    const count=Math.min(remaining,10_000);
    const base=config.GS1_DIGITAL_LINK_BASE_URL.replace(/\/$/,"");
    const inserted=job.identifier_scheme==="SSCC"?await client.query(
      `INSERT INTO serialized_objects(tenant_id,product_id,code_batch_id,code,level,lot,status)
       SELECT $1,$2,$3,$4||'/00/'||gs1_sscc($5,$6,$7::bigint+$8+g-1),$9,$10,'COMMISSIONED' FROM generate_series(1,$11) g
       ON CONFLICT (tenant_id,code) DO NOTHING RETURNING id`,
      [job.tenant_id,job.product_id,batchId,base,job.gs1_company_prefix_snapshot,job.sscc_extension_digit,job.sscc_start_reference,job.generated_count,job.level,job.lot,count]
    ):await client.query(
      `INSERT INTO serialized_objects(tenant_id,product_id,code_batch_id,code,level,lot,status)
       SELECT $1,$2,$3,$4||'/01/'||$5||'/21/'||
         CASE WHEN $6='SEQUENTIAL' THEN lpad(($7+g)::text,12,'0')
              ELSE upper(substr(encode(digest($8::text||':'||($7+g)::text,'sha256'),'hex'),1,20)) END,
         $9,$10,'COMMISSIONED' FROM generate_series(1,$11) g
       ON CONFLICT (tenant_id,code) DO NOTHING RETURNING id`,
      [job.tenant_id,job.product_id,batchId,base,gtinForDigitalLink(job.gtin),job.serial_rule,job.generated_count,job.id,job.level,job.lot,count]
    );
    const generated=job.generated_count+inserted.rowCount;
    await client.query(
      `UPDATE code_generation_jobs SET generated_count=$2,status=CASE WHEN $2>=quantity THEN 'COMPLETED' ELSE 'RUNNING' END,
       completed_at=CASE WHEN $2>=quantity THEN now() ELSE NULL END,
       export_status=CASE WHEN $2>=quantity THEN 'PENDING' ELSE export_status END,
       export_available_at=CASE WHEN $2>=quantity THEN now() ELSE export_available_at END,last_error=NULL WHERE id=$1`,[job.id,generated]
    );
    return true;
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=loadConfig();
  if(!config.GS1_DIGITAL_LINK_BASE_URL || config.GS1_DIGITAL_LINK_BASE_URL.includes(".example")) throw new Error("GS1_DIGITAL_LINK_BASE_URL must use the production verification domain");
  const db=createDatabase(config);let stopping=false;
  process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});
  try {while(!stopping){if(!(await processCodeJobChunk(db,config)))await new Promise(resolve=>setTimeout(resolve,1000));}}finally{await db.close();}
}

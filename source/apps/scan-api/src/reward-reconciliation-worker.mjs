import { Upload } from "@aws-sdk/lib-storage";
import { createHash } from "node:crypto";
import { Readable,Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { csvCell } from "./code-export-worker.mjs";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";
import { createObjectStorage,rewardReconciliationObjectKey } from "./object-storage.mjs";

export async function claimRewardReconciliationExport(db){return db.transaction(async client=>{const selected=await client.query(`SELECT * FROM reward_reconciliation_exports
 WHERE attempts<10 AND ((status IN ('PENDING','FAILED') AND available_at<=now()) OR
   (status='EXPORTING' AND locked_at<now()-interval '15 minutes'))
 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);if(!selected.rowCount)return null;const row=selected.rows[0];await client.query("UPDATE reward_reconciliation_exports SET status='EXPORTING',locked_at=now() WHERE id=$1",[row.id]);return row;});}

async function* reconciliationCsv(db,row,counter){yield "\uFEFFledger_entry_id,claim_id,campaign_code,campaign_version,beneficiary_organization_id,beneficiary_name,entry_type,amount_points,claim_status,event_time\r\n";let afterTime=null,afterId=null;for(;;){const result=await db.query(`SELECT le.id,le.claim_id,c.code campaign_code,cv.version campaign_version,le.beneficiary_organization_id,o.name beneficiary_name,le.entry_type,le.amount_points,rc.status claim_status,le.created_at
 FROM ledger_entries le JOIN reward_claims rc ON rc.tenant_id=le.tenant_id AND rc.id=le.claim_id
 JOIN campaign_versions cv ON cv.id=rc.campaign_version_id JOIN campaigns c ON c.id=cv.campaign_id
 JOIN organizations o ON o.tenant_id=le.tenant_id AND o.id=le.beneficiary_organization_id
 WHERE le.tenant_id=$1 AND le.created_at>=$2 AND le.created_at<$3 AND le.created_at<=$4
   AND ($5::uuid IS NULL OR le.beneficiary_organization_id=$5)
   AND ($6::timestamptz IS NULL OR (le.created_at,le.id)>($6,$7::uuid))
 ORDER BY le.created_at,le.id LIMIT 5000`,[row.tenant_id,row.period_start,row.period_end,row.snapshot_at,row.beneficiary_organization_id||null,afterTime,afterId]);if(!result.rowCount)break;for(const item of result.rows){counter.count++;yield[item.id,item.claim_id,item.campaign_code,item.campaign_version,item.beneficiary_organization_id,item.beneficiary_name,item.entry_type,item.amount_points,item.claim_status,new Date(item.created_at).toISOString()].map(csvCell).join(",")+"\r\n";}const last=result.rows.at(-1);afterTime=last.created_at;afterId=last.id;if(result.rowCount<5000)break;}}

export async function processRewardReconciliationExport(db,config,row,{storage=createObjectStorage(config),UploadClass=Upload}={}){const key=rewardReconciliationObjectKey(row.tenant_id,row.id),hash=createHash("sha256"),counter={count:0};let size=0;const meter=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);size+=chunk.length;callback(null,chunk);}});try{const body=Readable.from(reconciliationCsv(db,row,counter)).pipe(meter),upload=new UploadClass({client:storage,params:{Bucket:config.OBJECT_STORAGE_BUCKET,Key:key,Body:body,ContentType:"text/csv; charset=utf-8",ContentDisposition:'attachment; filename="reliacode-reward-reconciliation.csv"',ServerSideEncryption:"AES256",ChecksumAlgorithm:"SHA256"},queueSize:2,partSize:8*1024*1024,leavePartsOnError:false});await upload.done();await db.query(`UPDATE reward_reconciliation_exports SET status='COMPLETED',output_object_key=$2,output_size_bytes=$3,output_sha256=$4,row_count=$5,completed_at=now(),locked_at=NULL,last_error=NULL WHERE tenant_id=$6 AND id=$1 AND status='EXPORTING'`,[row.id,key,size,hash.digest("hex"),counter.count,row.tenant_id]);return true;}catch(error){await db.query(`UPDATE reward_reconciliation_exports SET attempts=attempts+1,locked_at=NULL,last_error=$2,status=CASE WHEN attempts+1>=10 THEN 'DEAD_LETTER' ELSE 'FAILED' END,available_at=now()+(LEAST(3600,power(2,LEAST(attempts+1,11)))::text||' seconds')::interval WHERE tenant_id=$3 AND id=$1 AND status='EXPORTING'`,[row.id,String(error.message).slice(0,1000),row.tenant_id]);return false;}}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const config=loadConfig();if(!config.objectStorageConfigured)throw new Error("Object storage configuration is required for the reward reconciliation worker");const db=createDatabase(config),storage=createObjectStorage(config);let stopping=false;process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});try{while(!stopping){const row=await claimRewardReconciliationExport(db);if(row)await processRewardReconciliationExport(db,config,row,{storage});else await new Promise(resolve=>setTimeout(resolve,1000));}}finally{storage.destroy();await db.close();}}

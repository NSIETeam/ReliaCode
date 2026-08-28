import { Upload } from "@aws-sdk/lib-storage";
import { createHash } from "node:crypto";
import { Readable,Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";
import { codeExportObjectKey,createObjectStorage } from "./object-storage.mjs";

export function csvCell(value){let text=value==null?"":String(value);if(/^[=+\-@]/.test(text))text="'"+text;return/[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}

export async function claimCodeExport(db){return db.transaction(async client=>{const selected=await client.query(`SELECT * FROM code_generation_jobs
 WHERE status='COMPLETED' AND export_attempts<10 AND
   ((export_status IN ('PENDING','FAILED') AND export_available_at<=now()) OR
    (export_status='EXPORTING' AND export_locked_at<now()-interval '15 minutes'))
 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);if(!selected.rowCount)return null;const row=selected.rows[0];await client.query("UPDATE code_generation_jobs SET export_status='EXPORTING',export_locked_at=now() WHERE id=$1",[row.id]);return row;});}

async function* csvChunks(db,row){yield "\uFEFFcode,level,lot,product_id,created_at\r\n";let after=null;for(;;){const result=await db.query(`SELECT id,code,level,lot,product_id,created_at FROM serialized_objects
 WHERE tenant_id=$1 AND code_batch_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 5000`,[row.tenant_id,row.code_batch_id,after]);if(!result.rowCount)break;for(const item of result.rows)yield[item.code,item.level,item.lot,item.product_id,new Date(item.created_at).toISOString()].map(csvCell).join(",")+"\r\n";after=result.rows.at(-1).id;if(result.rowCount<5000)break;}}

export async function processCodeExport(db,config,row,{storage=createObjectStorage(config),UploadClass=Upload}={}){const key=codeExportObjectKey(row.tenant_id,row.id),hash=createHash("sha256");let size=0;const meter=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);size+=chunk.length;callback(null,chunk);}});try{const body=Readable.from(csvChunks(db,row)).pipe(meter),upload=new UploadClass({client:storage,params:{Bucket:config.OBJECT_STORAGE_BUCKET,Key:key,Body:body,ContentType:"text/csv; charset=utf-8",ContentDisposition:'attachment; filename="reliacode-codes.csv"',ServerSideEncryption:"AES256",ChecksumAlgorithm:"SHA256"},queueSize:2,partSize:8*1024*1024,leavePartsOnError:false});await upload.done();await db.query(`UPDATE code_generation_jobs SET export_status='COMPLETED',output_object_key=$2,output_size_bytes=$3,output_sha256=$4,
 export_completed_at=now(),export_locked_at=NULL,export_last_error=NULL WHERE tenant_id=$5 AND id=$1`,[row.id,key,size,hash.digest("hex"),row.tenant_id]);return true;}catch(error){await db.query(`UPDATE code_generation_jobs SET export_attempts=export_attempts+1,export_locked_at=NULL,export_last_error=$2,
 export_status=CASE WHEN export_attempts+1>=10 THEN 'DEAD_LETTER' ELSE 'FAILED' END,
 export_available_at=now()+(LEAST(3600,power(2,LEAST(export_attempts+1,11)))::text||' seconds')::interval WHERE tenant_id=$3 AND id=$1`,[row.id,String(error.message).slice(0,1000),row.tenant_id]);return false;}}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const config=loadConfig();if(!config.objectStorageConfigured)throw new Error("Object storage configuration is required for the code export worker");const db=createDatabase(config),storage=createObjectStorage(config);let stopping=false;process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});try{while(!stopping){const row=await claimCodeExport(db);if(row)await processCodeExport(db,config,row,{storage});else await new Promise(resolve=>setTimeout(resolve,1000));}}finally{storage.destroy();await db.close();}}

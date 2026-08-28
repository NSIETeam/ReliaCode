import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";
import { toEpcisDocument } from "./epcis.mjs";
import { captureEpcisDocument } from "./epcis-client.mjs";
import { pathToFileURL } from "node:url";

export async function claimOutboxEvent(db) {
  return db.transaction(async (client) => {
    const selected = await client.query(
      `SELECT * FROM event_outbox WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND available_at<=now()
       AND (locked_at IS NULL OR locked_at<now()-interval '5 minutes') ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!selected.rowCount) return null;
    await client.query("UPDATE event_outbox SET locked_at=now() WHERE id=$1", [selected.rows[0].id]);
    return selected.rows[0];
  });
}

export async function processOutboxEvent(db,config,row,{fetchImpl=fetch}={}) {
  const document = toEpcisDocument(row.payload,{baseUrl:config.GS1_DIGITAL_LINK_BASE_URL});
  if (!document) {
    await db.query("UPDATE event_outbox SET processed_at=now(),locked_at=NULL WHERE id=$1", [row.id]);
    return;
  }
  try {
    await captureEpcisDocument(config.OPEN_EPCIS_BASE_URL,document,{outboxId:row.id,bearerToken:config.OPEN_EPCIS_BEARER_TOKEN,fetchImpl});
    await db.query("UPDATE event_outbox SET processed_at=now(),locked_at=NULL,last_error=NULL WHERE id=$1", [row.id]);
  } catch (error) {
    await db.query(
      `UPDATE event_outbox SET attempts=attempts+1,locked_at=NULL,last_error=$2,
       dead_lettered_at=CASE WHEN attempts+1>=10 THEN now() ELSE NULL END,
       available_at=now()+(LEAST(3600,power(2,LEAST(attempts+1,11)))::text||' seconds')::interval WHERE id=$1`,
      [row.id,String(error.message).slice(0,1000)]
    );
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=loadConfig();if(!config.OPEN_EPCIS_BASE_URL||!config.GS1_DIGITAL_LINK_BASE_URL)throw new Error("OPEN_EPCIS_BASE_URL and GS1_DIGITAL_LINK_BASE_URL are required for the outbox worker");const db=createDatabase(config);let stopping=false;
  process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});
  try{while(!stopping){const row=await claimOutboxEvent(db);if(row)await processOutboxEvent(db,config,row);else await new Promise(resolve=>setTimeout(resolve,1000));}}finally{await db.close();}
  }

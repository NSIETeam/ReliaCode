import { AsyncLocalStorage } from "node:async_hooks";

const storage=new AsyncLocalStorage();
export function runWithDatabaseContext(callback){return storage.run({mode:"system",tenantId:null},callback);}
export function useTenantDatabaseContext(tenantId){const context=storage.getStore();if(!context)throw new Error("Database request context is unavailable");context.mode="tenant";context.tenantId=String(tenantId);}
export function useSystemDatabaseContext(){const context=storage.getStore();if(context){context.mode="system";context.tenantId=null;}}
export function currentDatabaseContext(){return storage.getStore()||{mode:"system",tenantId:null};}

export async function configureDatabaseClient(client){const context=currentDatabaseContext();if(context.mode==="tenant")await client.query("SELECT set_config('reliacode.system_access','off',true),set_config('reliacode.tenant_id',$1,true)",[context.tenantId]);else await client.query("SELECT set_config('reliacode.tenant_id','',true),set_config('reliacode.system_access','on',true)");}

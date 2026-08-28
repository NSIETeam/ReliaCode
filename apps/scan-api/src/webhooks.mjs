export async function enqueueWebhookDeliveries(client,tenantId,eventType,payload){await client.query(`INSERT INTO webhook_deliveries(tenant_id,endpoint_id,event_type,payload)
 SELECT tenant_id,id,$2,$3 FROM webhook_endpoints WHERE tenant_id=$1 AND status='ACTIVE' AND $2=ANY(event_types)`,[tenantId,eventType,payload]);}

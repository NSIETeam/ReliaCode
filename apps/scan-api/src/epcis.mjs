const bizSteps = {
  PACKING:"packing", SHIPPING:"shipping", RECEIVING_DISTRIBUTOR:"receiving", RECEIVING_STORE:"receiving",
  UNPACKING:"unpacking", RETURNING:"returning", SELLING:"retail_selling", DESTROYING:"destroying"
};

function epc(code,baseUrl) {
  return /^(?:urn:|https?:\/\/)/i.test(code) ? code : `${baseUrl}/8004/${encodeURIComponent(code)}`;
}

export function toEpcisDocument(outboxPayload,{baseUrl}={}) {
  const { event, object,aggregation } = outboxPayload;
  if (event.event_type === "VERIFY") return null;
  if(!baseUrl)throw new Error("A GS1 Digital Link base URL is required for EPCIS serialization");
  const normalizedBase=String(baseUrl).replace(/\/$/,"");
  const offset = String(event.event_time).match(/([+-]\d\d:\d\d|Z)$/)?.[1] || "+00:00";
  const base = aggregation ? {
    type:"AggregationEvent",
    eventID:`urn:uuid:${event.id}`,
    eventTime:event.event_time,
    eventTimeZoneOffset:offset === "Z" ? "+00:00" : offset,
    action:aggregation.action,
    bizStep:`https://ref.gs1.org/cbv/BizStep-${bizSteps[event.event_type]}`,
    readPoint:{ id:event.read_point },
    bizLocation:{ id:`${normalizedBase}/locations/${encodeURIComponent(event.organization_id)}` },
    parentID:epc(aggregation.parent.code,normalizedBase),
    childEPCs:[epc(aggregation.child.code,normalizedBase)]
  } : {
    type:"ObjectEvent",
    eventID:`urn:uuid:${event.id}`,
    eventTime:event.event_time,
    eventTimeZoneOffset:offset === "Z" ? "+00:00" : offset,
    action:"OBSERVE",
    bizStep:`https://ref.gs1.org/cbv/BizStep-${bizSteps[event.event_type] || event.event_type.toLowerCase()}`,
    readPoint:{ id:event.read_point },
    bizLocation:{ id:`${normalizedBase}/locations/${encodeURIComponent(event.organization_id)}` },
    epcList:[epc(object.code,normalizedBase)]
  };
  return {
    "@context":["https://ref.gs1.org/standards/epcis/epcis-context.jsonld",{"reliacode":`${normalizedBase}/vocab/`}],
    type:"EPCISDocument",
    schemaVersion:"2.0",
    creationDate:new Date().toISOString(),
    epcisBody:{ eventList:[base] }
  };
}

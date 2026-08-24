const bizSteps = {
  PACKING:"packing", SHIPPING:"shipping", RECEIVING_DISTRIBUTOR:"receiving", RECEIVING_STORE:"receiving",
  UNPACKING:"unpacking", RETURNING:"returning", SELLING:"retail_selling"
};

function epc(code) {
  return code.startsWith("urn:") ? code : `urn:reliacode:object:${encodeURIComponent(code)}`;
}

export function toEpcisDocument(outboxPayload) {
  const { event, object } = outboxPayload;
  if (event.event_type === "VERIFY") return null;
  const offset = String(event.event_time).match(/([+-]\d\d:\d\d|Z)$/)?.[1] || "+00:00";
  const base = {
    type:"ObjectEvent",
    eventID:`urn:uuid:${event.id}`,
    eventTime:event.event_time,
    eventTimeZoneOffset:offset === "Z" ? "+00:00" : offset,
    action:"OBSERVE",
    bizStep:`https://ref.gs1.org/cbv/BizStep-${bizSteps[event.event_type] || event.event_type.toLowerCase()}`,
    readPoint:{ id:event.read_point },
    bizLocation:{ id:`urn:reliacode:organization:${event.organization_id}` },
    epcList:[epc(object.code)]
  };
  return {
    "@context":["https://ref.gs1.org/standards/epcis/epcis-context.jsonld",{"reliacode":"https://reliacode.example/vocab/"}],
    type:"EPCISDocument",
    schemaVersion:"2.0",
    creationDate:new Date().toISOString(),
    epcisBody:{ eventList:[base] }
  };
}

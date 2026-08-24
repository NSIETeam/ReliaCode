import assert from "node:assert/strict";
import test from "node:test";
import { toEpcisDocument } from "../src/epcis.mjs";

test("verification queries are not emitted as custody events", () => {
  assert.equal(toEpcisDocument({ event:{ event_type:"VERIFY" }, object:{} }), null);
});

test("receiving event maps to an EPCIS 2.0 ObjectEvent", () => {
  const document = toEpcisDocument({
    event:{ id:"00000000-0000-4000-8000-000000000001",event_type:"RECEIVING_STORE",event_time:"2026-08-24T10:00:00+08:00",read_point:"urn:epc:id:sgln:0614141.07346.1234",organization_id:"org-1" },
    object:{ code:"RC-CTN-1" }
  });
  const event = document.epcisBody.eventList[0];
  assert.equal(document.schemaVersion, "2.0");
  assert.equal(event.type, "ObjectEvent");
  assert.equal(event.action, "OBSERVE");
  assert.match(event.bizStep, /receiving$/);
  assert.deepEqual(event.epcList, ["urn:reliacode:object:RC-CTN-1"]);
});

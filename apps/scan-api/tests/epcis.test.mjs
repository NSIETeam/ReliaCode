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
  },{baseUrl:"https://id.reliacode.cn"});
  const event = document.epcisBody.eventList[0];
  assert.equal(document.schemaVersion, "2.0");
  assert.equal(event.type, "ObjectEvent");
  assert.equal(event.action, "OBSERVE");
  assert.match(event.bizStep, /receiving$/);
  assert.deepEqual(event.epcList, ["https://id.reliacode.cn/8004/RC-CTN-1"]);
  assert.equal(event.bizLocation.id,"https://id.reliacode.cn/locations/org-1");
  assert.equal(JSON.stringify(document).includes(".example"),false);
});

test("packing and unpacking map to EPCIS AggregationEvent ADD and DELETE",()=>{
  for(const [eventType,action] of [["PACKING","ADD"],["UNPACKING","DELETE"]]){
    const document=toEpcisDocument({event:{id:`00000000-0000-4000-8000-00000000000${action==="ADD"?2:3}`,event_type:eventType,event_time:"2026-08-28T10:00:00+08:00",read_point:"https://id.gs1.org/414/6901234567892",organization_id:"org-1"},object:{code:"CHILD-1"},aggregation:{parent:{code:"PARENT-1"},child:{code:"CHILD-1"},action}},{baseUrl:"https://id.reliacode.cn"});
    const event=document.epcisBody.eventList[0];
    assert.equal(event.type,"AggregationEvent");assert.equal(event.action,action);assert.deepEqual(event.childEPCs,["https://id.reliacode.cn/8004/CHILD-1"]);assert.equal(event.parentID,"https://id.reliacode.cn/8004/PARENT-1");assert.equal(event.epcList,undefined);
  }
});

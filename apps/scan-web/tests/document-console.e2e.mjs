import assert from "node:assert/strict";
import { chromium } from "playwright";
import { testBaseUrl } from "./helpers.mjs";

const ids={tenant:"11111111-1111-4111-8111-111111111111",organization:"22222222-2222-4222-8222-222222222222",user:"44444444-4444-4444-8444-444444444444",document:"99999999-9999-4999-8999-999999999999",object:"77777777-7777-4777-8777-777777777777"};
let document={id:ids.document,reference:"PACK-ADMIN-001",document_type:"PACKING_ORDER",status:"DRAFT",version:0,from_organization_id:ids.organization,to_organization_id:null},lines=[],lineCommand=null,transitionCommand=null;
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
await page.route("**/runtime-config.js",route=>route.fulfill({contentType:"application/javascript",body:"window.RELIACODE_CONFIG=Object.freeze({apiBaseUrl:'',persistentWorkspace:false,domainApi:true});"}));
await page.route("**/api/**",async route=>{const request=route.request(),path=new URL(request.url()).pathname,json=body=>route.fulfill({status:200,contentType:"application/json",headers:{"x-csrf-token":"csrf-admin-test"},body:JSON.stringify(body)});
  if(path==="/api/auth/session")return json({csrfToken:"csrf-admin-test",user:{id:ids.user,name:"Brand Admin",tenantId:ids.tenant,organizationId:ids.organization,organizationName:"Brand 01",role:"BRAND_ADMIN",capabilities:["objects:read","events:read","documents:write"]}});
  if(path==="/api/v1/products"||path==="/api/v1/devices"||path==="/api/v1/trace-events")return json({items:[],nextCursor:null});
  if(path==="/api/v1/organizations")return json({items:[{id:ids.organization,name:"Brand 01",type:"BRAND",status:"ACTIVE"}]});
  if(path==="/api/v1/documents"&&request.method()==="GET")return json({items:[document]});
  if(path===`/api/v1/documents/${ids.document}/objects`&&request.method()==="GET")return json({items:lines});
  if(path===`/api/v1/documents/${ids.document}/objects`&&request.method()==="POST"){lineCommand={headers:request.headers(),body:request.postDataJSON()};lines=[{object_id:ids.object,expected:true,line_role:lineCommand.body.lineRole,fulfilled_event_id:null,object_snapshot:{code:lineCommand.body.objectCode}}];return json(lines[0]);}
  if(path===`/api/v1/documents/${ids.document}/transition`&&request.method()==="POST"){transitionCommand={headers:request.headers(),body:request.postDataJSON()};document={...document,status:transitionCommand.body.status,version:1};return json(document);}
  return route.fulfill({status:404,contentType:"application/json",body:JSON.stringify({message:`Unhandled ${request.method()} ${path}`})});
});
await page.goto(testBaseUrl,{waitUntil:"networkidle"});await page.locator('[data-view="documents"]').click();
assert.match(await page.locator("#documents").innerText(),/单据与动作对象/);assert.match(await page.locator(".sidebar-note").innerText(),/生产领域 API/);
await page.locator('[data-document-open]').click();await page.locator('#document-line-form [name="objectCode"]').fill("OBJECT-ADMIN-0001");await page.locator('#document-line-form [name="lineRole"]').selectOption("ACTION");await page.locator('#document-line-form [name="auditReason"]').fill("add controlled action line");await page.locator('#document-line-form button').click();
await page.waitForFunction(()=>document.querySelector('#document-lines')?.textContent.includes('OBJECT-ADMIN-0001'));
assert.equal(lineCommand.body.lineRole,"ACTION");assert.equal(lineCommand.headers["x-csrf-token"],"csrf-admin-test");assert.ok(lineCommand.headers["idempotency-key"]);
page.once("dialog",dialog=>dialog.accept("approve governed packing document"));await page.locator('[data-document-transition="APPROVED"]').click();await page.waitForFunction(()=>document.querySelector('#documents')?.textContent.includes('APPROVED'));
assert.deepEqual(transitionCommand.body,{expectedVersion:0,status:"APPROVED",auditReason:"approve governed packing document"});assert.ok(transitionCommand.headers["idempotency-key"]);
await browser.close();console.log("DOCUMENT CONSOLE E2E PASS: tenant organizations, action lines, audit reasons, idempotency, and approval");

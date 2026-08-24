import assert from "node:assert/strict";
import { addProduct, initialize, openApp } from "./helpers.mjs";

const {browser,page}=await openApp();
assert.equal(await page.locator("#onboarding").isVisible(),true);
assert.equal(await page.locator("body").innerText().then((text)=>/RC-(ITM|CTN)-\d/.test(text)),false,"first run must not expose built-in codes");
await initialize(page);
let stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("reliacode-workspace-v1")));
assert.equal(stored.products.length,0);
assert.equal(Object.keys(stored.objects).length,0);
assert.equal(stored.events.length,0);

await addProduct(page);
await page.locator('#batch-form [name="quantity"]').fill("3");
await page.getByRole("button",{name:"生成唯一可靠码"}).click();
stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("reliacode-workspace-v1")));
assert.equal(stored.products.length,1);
assert.equal(Object.keys(stored.objects).length,3);
assert.equal(new Set(Object.keys(stored.objects)).size,3);
const firstCode=Object.keys(stored.objects)[0];

await page.locator('[data-view="verify"]').click();
await page.locator("#verify-code").fill(firstCode);
await page.getByRole("button",{name:"验证产品"}).click();
assert.match(await page.locator("#verify-result").innerText(),/产品身份有效/);

await page.locator('[data-view="receive"]').click();
await page.locator('#account-form [name="name"]').fill("Operator");
await page.locator('#account-form [name="org"]').fill("Destination");
await page.locator('#account-form [name="eventType"]').selectOption("SHIPPING");
await page.locator('#account-form [name="deviceId"]').fill("DEVICE-001");
await page.locator('#account-form [name="location"]').fill("Dock-01");
await page.getByRole("button",{name:"创建作业账号"}).click();
await page.locator("#field-code").fill(firstCode);
await page.getByRole("button",{name:"核验作业"}).click();
assert.match(await page.locator("#field-result").innerText(),/核验通过/);
await page.locator("#confirm-field").click();
stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("reliacode-workspace-v1")));
assert.equal(stored.objects[firstCode].status,"IN_TRANSIT");
assert.ok(stored.events.some((event)=>event.action==="SHIPPING"));
await page.reload({waitUntil:"networkidle"});
stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("reliacode-workspace-v1")));
assert.equal(stored.objects[firstCode].status,"IN_TRANSIT");
assert.equal(await page.locator("#onboarding").isVisible(),false);
await browser.close();
console.log("E2E PASS: empty onboarding, real user input, unique code generation, verification and field event");

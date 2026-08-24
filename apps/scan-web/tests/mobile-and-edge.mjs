import assert from "node:assert/strict";
import { addProduct, initialize, openApp } from "./helpers.mjs";

const {browser,page}=await openApp({width:375,height:812});
let overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
assert.ok(overflow<=1,`375px layout overflows by ${overflow}px`);
await initialize(page);
await addProduct(page);
await page.setViewportSize({width:320,height:568});
overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
assert.ok(overflow<=1,`320px layout overflows by ${overflow}px`);
await page.locator('[data-view="verify"]').click();
await page.locator("#verify-code").fill("<script>alert(1)</script>");
await page.getByRole("button",{name:"验证产品"}).click();
assert.match(await page.locator("#verify-result").innerText(),/未识别可靠码/);
assert.equal(await page.locator("script").count(),1);
await browser.close();
console.log("MOBILE/EDGE PASS: first-run onboarding, 375/320 layout and hostile input escaping");

import assert from "node:assert/strict";
import { chromium } from "playwright";

const u = (text) => text.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const receive = u("\\u6536\\u8d27\\u626b\\u7801");
const validate = u("\\u9a8c\\u8bc1\\u53ef\\u9760\\u7801");
const confirm = u("\\u786e\\u8ba4\\u6536\\u8d27");
const success = u("\\u6536\\u8d27\\u786e\\u8ba4\\u6210\\u529f");
const risk = u("\\u98ce\\u9669\\u5904\\u7f6e");

await page.addInitScript(() => localStorage.removeItem("reliacode-mvp"));
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
assert.match(await page.title(), /ReliaCode/);

await page.getByRole("button", { name: receive, exact: true }).click();
await page.getByRole("button", { name: validate, exact: true }).click();
assert.match(await page.locator("#scan-result").innerText(), /可靠码验证通过/);
assert.equal(await page.locator("#scan-result").getByText(success).count(), 0);
await page.getByRole("button", { name: new RegExp(confirm) }).click();
await page.getByText(success).waitFor();
assert.match(await page.locator("#scan-result").innerText(), /\+500 积分/);

await page.getByRole("button", { name: validate, exact: true }).click();
assert.match(await page.locator("#scan-result").innerText(), /首次有效收货/);

await page.locator("#scan-code").fill("RC-CTN-202608-00092");
await page.getByRole("button", { name: validate, exact: true }).click();
assert.match(await page.locator("#scan-result").innerText(), /暂不计奖/);

await page.getByRole("button", { name: new RegExp(risk) }).click();
const initialPending = await page.locator("[data-action]").count();
await page.locator('[data-action="hold"]').first().click();
assert.equal(await page.locator("[data-action]").count(), initialPending, "hold keeps the risk in the unresolved queue");
await page.locator('[data-action="approve"]').first().click();
assert.match(await page.locator("#risk").innerText(), /仅完成异常处置，待重新验证收货/);

await page.getByRole("button", { name: receive, exact: true }).click();
for (const code of ["RC-CTN-202608-00102", "RC-CTN-202608-00103"]) {
  await page.locator("#scan-code").fill(code);
  await page.getByRole("button", { name: validate, exact: true }).click();
  await page.getByRole("button", { name: new RegExp(confirm) }).click();
}
assert.deepEqual(await page.evaluate(() => { const data = JSON.parse(localStorage.getItem("reliacode-mvp")); return [data.shipment.received, data.shipment.expected, data.shipment.status]; }), [3, 3, "已收货"]);

await context.close();
await browser.close();
console.log("E2E PASS: two-step receipt, reward eligibility, unresolved risk, risk approval, complete shipment");

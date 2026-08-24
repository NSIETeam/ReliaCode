import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
await page.addInitScript(() => localStorage.removeItem("reliacode-mvp"));
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

await page.getByRole("button", { name: "收货扫码", exact: true }).click();
await page.locator("#scan-code").fill(" rc-ctn-202608-00101 ");
await page.getByRole("button", { name: "验证可靠码" }).click();
await page.getByRole("button", { name: /确认收货/ }).click();
assert.match(await page.locator("#scan-result").innerText(), /收货确认成功/);

await page.locator("#scan-code").fill("<script>alert(1)</script>");
await page.getByRole("button", { name: "验证可靠码" }).click();
assert.match(await page.locator("#scan-result").innerText(), /不在发货单/);

await page.setViewportSize({ width: 320, height: 568 });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
await context.close();
await browser.close();
console.log("MOBILE/EDGE PASS: two-step receipt, normalized code, hostile input, 375px/320px layout");

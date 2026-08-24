import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.addInitScript(() => localStorage.removeItem("reliacode-mvp"));
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
assert.match(await page.title(), /ReliaCode/);
assert.equal(await page.locator("h1").textContent(), "工作台");

await page.getByRole("button", { name: "收货扫码", exact: true }).click();
await page.getByRole("button", { name: "验证并确认收货" }).click();
await assert.doesNotReject(() => page.getByText("收货确认成功").waitFor());
assert.match(await page.locator("#scan-result").innerText(), /\+500 积分/);

await page.getByRole("button", { name: "验证并确认收货" }).click();
await assert.doesNotReject(() => page.getByText("该箱已完成首次有效收货").waitFor());

await page.locator("#scan-code").fill("RC-CTN-202608-00092");
await page.getByRole("button", { name: "验证并确认收货" }).click();
await assert.doesNotReject(() => page.getByText("已记录核验，暂不计奖").waitFor());

await page.getByRole("button", { name: /奖励活动/ }).click();
await page.locator("#campaign-name").fill("专家评审试点活动");
await page.locator("#campaign-reward").fill("680");
await page.locator("#campaign-cap").fill("6800");
await page.getByRole("button", { name: "保存完整草稿" }).click();
await assert.doesNotReject(() => page.getByText("专家评审试点活动").waitFor());
assert.match(await page.locator("#campaigns").innerText(), /680 积分\/箱/);

await page.getByRole("button", { name: /风险处置/ }).click();
assert.ok(await page.locator("[data-risk]").count() >= 3);
await page.locator('[data-action="hold"]').first().click();
assert.match(await page.locator("#risk").innerText(), /风险队列/);

await page.getByRole("button", { name: "重置本地数据" }).click();
await page.getByRole("button", { name: "奖励活动" }).click();
assert.equal(await page.getByText("专家评审试点活动").count(), 0);

await context.close();
await browser.close();
console.log("E2E PASS: navigation, receive, duplicate guard, risk, campaign draft, reset");

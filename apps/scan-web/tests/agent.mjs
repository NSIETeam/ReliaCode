import assert from "node:assert/strict";
import { addProduct, initialize, openApp } from "./helpers.mjs";

const {browser,page}=await openApp();
await initialize(page);
await addProduct(page,"agent");
await page.locator("#agent-toggle").click();
await page.locator("#agent-command").fill("打开产品动向");
await page.locator("#agent-form").evaluate((form)=>form.requestSubmit());
assert.equal(await page.locator("#movement").evaluate((node)=>node.classList.contains("active")),true);
await page.locator("#agent-command").fill("生成 2 个 SKU-agent 单品码");
page.once("dialog",(dialog)=>dialog.accept());
await page.locator("#agent-form").evaluate((form)=>form.requestSubmit());
const state=await page.evaluate(()=>JSON.parse(localStorage.getItem("reliacode-workspace-v1")));
assert.equal(Object.keys(state.objects).length,2);
assert.ok(state.agentRuns.some((run)=>/生码任务已执行/.test(run.result)));
await browser.close();
console.log("AGENT PASS: navigation and confirmed write use user-created product data");

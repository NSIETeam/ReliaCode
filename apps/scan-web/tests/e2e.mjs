import assert from "node:assert/strict";
import jsQR from "jsqr";
import { addProduct, initialize, openApp } from "./helpers.mjs";

function decodeMatrix(matrix) {
  const quiet=4,scale=8,modules=matrix.length+quiet*2,size=modules*scale,pixels=new Uint8ClampedArray(size*size*4).fill(255);
  for(let row=0;row<matrix.length;row++)for(let column=0;column<matrix.length;column++)if(matrix[row][column])for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){
    const offset=(((row+quiet)*scale+y)*size+(column+quiet)*scale+x)*4;
    pixels[offset]=pixels[offset+1]=pixels[offset+2]=0;
  }
  return jsQR(pixels,size,size,{inversionAttempts:"dontInvert"});
}

const {browser,page}=await openApp();
assert.equal(await page.locator("#onboarding").isVisible(),true);
assert.deepEqual(await page.evaluate(()=>({encoder:typeof qrcode,decoder:typeof jsQR})),{encoder:"function",decoder:"function"});
assert.equal(await page.evaluate(()=>csvCell("=HYPERLINK(1)")),"\"'=HYPERLINK(1)\"");
assert.deepEqual(await page.evaluate(()=>[validGtin("06912345678902"),validGtin("06912345678901")]),[true,false]);
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
const firstObject=stored.objects[firstCode];
const expectedVerificationUrl=`http://localhost:4173/?verify=${firstObject.publicId}`;
const matrix=await page.evaluate((code)=>qrMatrix(verificationUrl(object(code))),firstCode);
assert.equal(decodeMatrix(matrix)?.data,expectedVerificationUrl,"exported QR matrix must decode to the public verification URL");
const publicContext=await browser.newContext();
const publicPage=await publicContext.newPage();
await publicPage.goto(expectedVerificationUrl,{waitUntil:"networkidle"});
assert.match(await publicPage.locator("#public-verification-result").innerText(),/尚未连接生产验证服务/);
await publicContext.close();
const downloadPromise=page.waitForEvent("download");
await page.locator(`[data-labels="${stored.codeBatches[0].id}"]`).click();
const labelDownload=await downloadPromise;
assert.match(labelDownload.suggestedFilename(),/^reliacode-labels-.*\.html$/);
const labelStream=await labelDownload.createReadStream();
let labelHtml="";for await(const chunk of labelStream)labelHtml+=chunk.toString("utf8");
assert.equal((labelHtml.match(/class="label"/g)||[]).length,3);
assert.match(labelHtml,/<svg class="qr"/);
assert.ok(labelHtml.includes(firstCode));
assert.ok(labelHtml.includes(`?verify=${firstObject.publicId}`));

await page.goto(expectedVerificationUrl,{waitUntil:"networkidle"});
assert.equal(await page.locator("#verify").evaluate((node)=>node.classList.contains("active")),true);
assert.match(await page.locator("#verify-result").innerText(),/产品身份有效/);
assert.equal(await page.locator('[data-camera-target="verify-code"]').isVisible(),true);

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

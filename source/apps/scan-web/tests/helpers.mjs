import { chromium } from "playwright";

export const testBaseUrl=(process.env.RELIACODE_TEST_BASE_URL || "http://localhost:4173").replace(/\/$/,"");

export async function openApp(viewport={width:1280,height:900}) {
  const executablePath=process.env.PLAYWRIGHT_CHROME_PATH || (process.platform==="win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
  const browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true});
  const context=await browser.newContext({viewport,acceptDownloads:true});
  const page=await context.newPage();
  await page.goto(testBaseUrl,{waitUntil:"networkidle"});
  return {browser,context,page};
}

export async function initialize(page, suffix=Date.now().toString(36)) {
  await page.locator('[name="brandName"]').fill(`Workspace-${suffix}`);
  await page.locator('[name="adminName"]').fill(`Admin-${suffix}`);
  await page.locator('[name="deviceName"]').fill(`Device-${suffix}`);
  await page.locator('[name="confirm"]').check();
  await page.getByRole("button",{name:"创建空白工作区"}).click();
}

export async function addProduct(page, suffix=Date.now().toString(36)) {
  await page.locator('[data-view="codes"]').click();
  await page.locator('#product-form [name="name"]').fill(`Product-${suffix}`);
  await page.locator('#product-form [name="sku"]').fill(`SKU-${suffix}`);
  await page.locator('#product-form [name="gtin"]').fill("06912345678902");
  await page.getByRole("button",{name:"保存产品"}).click();
}

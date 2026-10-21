import assert from "node:assert/strict";
import { chromium } from "playwright";
import { testBaseUrl } from "./helpers.mjs";

const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
await page.route("**/runtime-config.js",route=>route.fulfill({contentType:"application/javascript",body:"window.RELIACODE_CONFIG=Object.freeze({apiBaseUrl:'',persistentWorkspace:false,domainApi:true});"}));
await page.route("**/api/**",route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({code:"UNAUTHORIZED",message:"Authentication required"})}));

function assertCompanyPalette(palette,label){
  const allowedBackgrounds=new Set(["rgba(0, 0, 0, 0)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(38, 48, 42)"]);
  const allowedText=new Set(["rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(38, 48, 42)","rgb(47, 107, 79)"]);
  assert.deepEqual(palette.backgrounds.filter(value=>!allowedBackgrounds.has(value)),[],`${label} has colors outside the restrained company palette`);
  assert.deepEqual(palette.colors.filter(value=>!allowedText.has(value)),[],`${label} has text outside the restrained company palette`);
  assert.equal(palette.overflow,0,`${label} overflows horizontally`);
}

async function palette(){return page.evaluate(()=>{const root=document.querySelector('.onboarding'),visible=[root,...root.querySelectorAll('*')].filter(element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0;});return{backgrounds:[...new Set(visible.map(element=>getComputedStyle(element).backgroundColor))],colors:[...new Set(visible.map(element=>getComputedStyle(element).color))],overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};});}
async function whiteShare(){return page.evaluate(()=>{const root=document.querySelector('.onboarding');let white=0,black=0;for(const element of [root,...root.querySelectorAll('*')]){const style=getComputedStyle(element),rect=element.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden')continue;const width=Math.max(0,Math.min(innerWidth,rect.right)-Math.max(0,rect.left)),height=Math.max(0,Math.min(innerHeight,rect.bottom)-Math.max(0,rect.top)),area=width*height;if(style.backgroundColor==='rgb(255, 255, 255)')white+=area;if(style.backgroundColor==='rgb(0, 0, 0)')black+=area;}return white/(white+black||1);});}

try{
  await page.goto(testBaseUrl,{waitUntil:"networkidle"});
  await page.locator('#server-auth').waitFor();
  assert.equal(await page.locator('[name="username"]').getAttribute('autocomplete'),"username webauthn");
  assert.equal(await page.locator('[name="password"]').getAttribute('autocomplete'),"current-password");
  assertCompanyPalette(await palette(),"login");
  assert.ok(await whiteShare()>=.85,"login must be at least 85% white by painted element area");
  await page.getByRole('button',{name:'注册'}).click();
  assertCompanyPalette(await palette(),"tenant application");
  assert.ok(await whiteShare()>=.85,"tenant application must be at least 85% white by painted element area");
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'忘记密码'}).click();
  assertCompanyPalette(await palette(),"account recovery");
  assert.ok(await whiteShare()>=.85,"account recovery must be at least 85% white by painted element area");
  console.log("SERVER AUTH COMPANY PALETTE PASS: login, tenant application, recovery, password-manager metadata and computed palette");
}finally{await browser.close();}

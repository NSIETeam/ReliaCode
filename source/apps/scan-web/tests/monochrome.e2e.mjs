import assert from "node:assert/strict";
import { openApp,initialize } from "./helpers.mjs";

const {browser,page}=await openApp({width:1440,height:1000});
const whiteShare=()=>page.evaluate(()=>{let white=0,black=0;for(const element of document.querySelectorAll('body *')){const style=getComputedStyle(element),rect=element.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden')continue;const width=Math.max(0,Math.min(innerWidth,rect.right)-Math.max(0,rect.left)),height=Math.max(0,Math.min(innerHeight,rect.bottom)-Math.max(0,rect.top)),area=width*height;if(style.backgroundColor==='rgb(255, 255, 255)')white+=area;if(style.backgroundColor==='rgb(0, 0, 0)')black+=area;}return white/(white+black||1);});
try{
  const auth=await page.evaluate(()=>({body:getComputedStyle(document.body).backgroundColor,overlay:getComputedStyle(document.querySelector('.onboarding')).backgroundColor,card:getComputedStyle(document.querySelector('.onboarding-card')).backgroundColor,drawerVisibility:getComputedStyle(document.querySelector('.agent-drawer')).visibility,drawerPointerEvents:getComputedStyle(document.querySelector('.agent-drawer')).pointerEvents}));
  assert.deepEqual(auth,{body:"rgb(255, 255, 255)",overlay:"rgb(255, 255, 255)",card:"rgb(255, 255, 255)",drawerVisibility:"hidden",drawerPointerEvents:"none"});
  assert.ok(await whiteShare()>=.85,"authentication must be at least 85% white by painted element area");
  await initialize(page,"mono");
  for(const view of ["dashboard","codes","movement","verify","campaigns","ledger","risk"]){
    const nav=page.locator(`[data-view="${view}"]`);if(!await nav.isVisible())continue;
    await nav.click();
    const colors=await page.evaluate(()=>({body:getComputedStyle(document.body).backgroundColor,main:getComputedStyle(document.querySelector('main')).backgroundColor,sidebar:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,activeBg:getComputedStyle(document.querySelector('.nav-link.active')).backgroundColor,activeText:getComputedStyle(document.querySelector('.nav-link.active')).color,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}));
    assert.deepEqual(colors,{body:"rgb(255, 255, 255)",main:"rgb(255, 255, 255)",sidebar:"rgb(255, 255, 255)",activeBg:"rgb(255, 255, 255)",activeText:"rgb(0, 0, 0)",overflow:0},`monochrome contract failed on ${view}`);
    assert.ok(await whiteShare()>=.85,`${view} must be at least 85% white by painted element area`);
  }
  console.log("MONOCHROME E2E PASS: authentication, public shell and application views use unified white/black surfaces");
}finally{await browser.close();}

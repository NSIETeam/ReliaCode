import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root=new URL("../",import.meta.url);
const read=(name)=>readFile(new URL(name,root),"utf8");

test("production company theme is loaded last and defines the global visual contract",async()=>{
  const [html,css]=await Promise.all([read("index.html"),read("monochrome.css")]);
  const links=[...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match=>match[1]);
  assert.match(links.at(-1),/^monochrome\.css\?/);
  assert.match(css,/--bg:\s*#fff/);
  assert.match(css,/--ink:\s*#000/);
  assert.match(css,/--company-ink:\s*#26302a/);
  assert.match(css,/--company-canvas:\s*#f5f6f3/);
  assert.match(css,/\.sidebar[\s\S]*background:\s*#fff/);
  assert.match(css,/\.nav-link\.active[\s\S]*background:\s*#000/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/forced-colors/);
});

test("application-owned interface source has no emoji icons",async()=>{
  const sources=await Promise.all(["index.html","app.js","styles.css","design.css","figma-redesign.css","brand-console.css","monochrome.css"].map(read));
  const emoji=/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for(const [index,source] of sources.entries())assert.equal(emoji.test(source),false,`emoji found in interface source ${index}`);
});

test("interface icons are local monochrome SVG and favicon is black and white",async()=>{
  const [app,favicon]=await Promise.all([read("app.js"),read("favicon.svg")]);
  assert.match(app,/const svgPaths = \{/);
  assert.match(app,/stroke="currentColor"/);
  assert.doesNotMatch(app,/https?:\/\/[^'"`]*\.(?:svg|png|ico)/i);
  assert.match(favicon,/fill="#000"/);
  assert.match(favicon,/fill="#fff"/);
  assert.doesNotMatch(favicon,/#[0-9a-f]{6}/i);
});

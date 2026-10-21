import assert from "node:assert/strict";
import test from "node:test";
import { buildSscc,encodeGs1PathComponent,gs1DigitalLink,gtinForDigitalLink,isValidGln,isValidGs1Mod10,isValidGs1X,isValidGtin,isValidSscc,ssccCapacity } from "../src/gs1.mjs";

test("GS1 Mod-10 validates supported GTIN and GLN keys",()=>{
  assert.equal(isValidGtin("12345670"),true);
  assert.equal(isValidGtin("012345678905"),true);
  assert.equal(isValidGtin("4006381333931"),true);
  assert.equal(isValidGtin("06912345678902"),true);
  assert.equal(isValidGln("6901234567892"),true);
  assert.equal(isValidGs1Mod10("6901234567892",[13]),true);
});

test("GS1 Mod-10 rejects wrong checksums, unsupported lengths, and non-digits",()=>{
  assert.equal(isValidGtin("06912345678901"),false);
  assert.equal(isValidGln("6901234567891"),false);
  assert.equal(isValidGtin("1234567890"),false);
  assert.equal(isValidGtin("0691234567890X"),false);
});

test("new Digital Link values use numeric AIs and canonical 14-digit GTIN",()=>{
  assert.equal(gtinForDigitalLink("12345670"),"00000012345670");
  assert.equal(gs1DigitalLink("https://id.gs1.org/","414","6901234567892"),"https://id.gs1.org/414/6901234567892");
  assert.throws(()=>gtinForDigitalLink("12345671"),/valid GTIN/);
});

test("SSCC allocation produces an 18-digit AI (00) key with a valid check digit",()=>{
  const sscc=buildSscc("0614141",0,12345n);
  assert.equal(sscc,"006141410000123452");
  assert.equal(isValidSscc(sscc),true);
  assert.equal(ssccCapacity("0614141"),1_000_000_000n);
  assert.throws(()=>buildSscc("0614141",0,1_000_000_000n),/Invalid SSCC/);
});

test("GS1 X batch values enforce 20 characters and percent-encode reserved path symbols",()=>{
  assert.equal(isValidGs1X("Lot/a+b?c"),true);
  assert.equal(encodeGs1PathComponent("Lot/a+b?c"),"Lot%2Fa%2Bb%3Fc");
  assert.equal(encodeGs1PathComponent("A!'()*"),"A%21%27%28%29%2A");
  assert.equal(isValidGs1X("批次一"),false);
  assert.equal(isValidGs1X("A".repeat(21)),false);
});

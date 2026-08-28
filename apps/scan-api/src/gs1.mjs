export function isValidGs1Mod10(value,allowedLengths) {
  const text=String(value||"");
  if(!allowedLengths.includes(text.length)||!/^\d+$/.test(text))return false;
  const digits=[...text].map(Number),check=digits.pop();
  const sum=digits.reverse().reduce((total,digit,index)=>total+digit*(index%2===0?3:1),0);
  return (10-sum%10)%10===check;
}

export const isValidGtin=value=>isValidGs1Mod10(value,[8,12,13,14]);
export const isValidGln=value=>isValidGs1Mod10(value,[13]);

export function gtinForDigitalLink(value) {
  if(!isValidGtin(value))throw new Error("A valid GTIN is required for a GS1 Digital Link");
  return String(value).padStart(14,"0");
}

export function gs1DigitalLink(baseUrl,ai,key) {
  const base=String(baseUrl||"").replace(/\/$/,"");
  if(!base)throw new Error("GS1 Digital Link base URL is required");
  return `${base}/${ai}/${key}`;
}

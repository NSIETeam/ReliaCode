export function isValidGs1Mod10(value,allowedLengths) {
  const text=String(value||"");
  if(!allowedLengths.includes(text.length)||!/^\d+$/.test(text))return false;
  const digits=[...text].map(Number),check=digits.pop();
  const sum=digits.reverse().reduce((total,digit,index)=>total+digit*(index%2===0?3:1),0);
  return (10-sum%10)%10===check;
}

export const isValidGtin=value=>isValidGs1Mod10(value,[8,12,13,14]);
export const isValidGln=value=>isValidGs1Mod10(value,[13]);
export const isValidSscc=value=>isValidGs1Mod10(value,[18]);

export function ssccCapacity(companyPrefix) {
  const prefix=String(companyPrefix||"");
  if(!/^\d{4,12}$/.test(prefix))throw new Error("GS1 Company Prefix must contain 4 to 12 digits");
  return 10n**BigInt(16-prefix.length);
}

export function buildSscc(companyPrefix,extensionDigit,serialReference) {
  const prefix=String(companyPrefix||""),extension=Number(extensionDigit),reference=BigInt(serialReference);
  const capacity=ssccCapacity(prefix);
  if(!Number.isInteger(extension)||extension<0||extension>9||reference<0n||reference>=capacity)throw new Error("Invalid SSCC allocation input");
  const body=`${extension}${prefix}${reference.toString().padStart(16-prefix.length,"0")}`;
  const digits=[...body].map(Number);
  const sum=digits.reverse().reduce((total,digit,index)=>total+digit*(index%2===0?3:1),0);
  return `${body}${(10-sum%10)%10}`;
}

export function gtinForDigitalLink(value) {
  if(!isValidGtin(value))throw new Error("A valid GTIN is required for a GS1 Digital Link");
  return String(value).padStart(14,"0");
}

export function gs1DigitalLink(baseUrl,ai,key) {
  const base=String(baseUrl||"").replace(/\/$/,"");
  if(!base)throw new Error("GS1 Digital Link base URL is required");
  return `${base}/${ai}/${key}`;
}

const gs1XSymbols=new Set([...`"-._!%&+,/()*';:<=>?`]);
export function isValidGs1X(value,maxLength=20) {
  const text=String(value||"");
  return text.length>=1&&text.length<=maxLength&&[...text].every(character=>/[0-9A-Za-z]/.test(character)||gs1XSymbols.has(character));
}

export function encodeGs1PathComponent(value) {
  if(!isValidGs1X(value))throw new Error("GS1 path value must use the X character set and contain at most 20 characters");
  return encodeURIComponent(String(value)).replace(/[!'()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

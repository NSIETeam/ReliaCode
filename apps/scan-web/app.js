const STORAGE_KEY = "reliacode-workspace-v1";
const PENDING_STATE_KEY = "reliacode-workspace-pending-v1";
localStorage.removeItem("reliacode-mvp");
const EMPTY_STATE = Object.freeze({
  schemaVersion: 1, initialized: false, workspace: null, accounts: [], currentAccountId: null,
  products: [], codeBatches: [], objects: {}, events: [], campaigns: [], ledger: [], risks: [], agentRuns: []
});
const svgPaths = {
  logo:'<path d="M7 4.5h5.4a4.1 4.1 0 0 1 0 8.2H7m4.6 0L17 19.5M7 4.5v15"/>',
  dashboard:'<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  codes:'<path d="M4 5v14M8 5v14M12 5v14M16 5v14M20 5v14"/>',
  movement:'<path d="M4 18V9m0 9 4-4m-4 4-3-3M20 6v9m0-9-4 4m4-4 3 3M8 6h8M8 18h8"/>',
  verify:'<path d="m9 12 2 2 4-5"/><circle cx="12" cy="12" r="9"/><path d="M19 19l3 3"/>',
  scan:'<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10"/>',
  campaign:'<path d="M4 7h16v12H4zM8 7V4h8v3M8 12h8M8 16h5"/>',
  ledger:'<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h4"/>',
  risk:'<path d="M12 3 2.7 20h18.6L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  reset:'<path d="M4 4v6h6M5.5 15a8 8 0 1 0 .5-7L4 10"/>',
  package:'<path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/>',
  route:'<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h4a4 4 0 0 0 4-4v-4a4 4 0 0 1 4-4"/>',
  device:'<path d="M5 2h14v20H5zM9 5h6M11 18h2"/>', user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>', download:'<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', check:'<path d="m5 12 4 4L19 6"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  agent:'<path d="M12 3v3M7 4.5 8.5 7M17 4.5 15.5 7"/><path d="M4 8h16v12H4z"/><circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/><path d="M9 17h6"/>',
  send:'<path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="m11 13 5-5"/>', close:'<path d="M6 6l12 12M18 6 6 18"/>',
  lock:'<path d="M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3"/>'
};
const icon = (name, className="ui-icon") => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPaths[name] || svgPaths.package}</svg>`;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const uuid = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const localTime = (value=timestamp()) => new Date(value).toLocaleString("zh-CN", { hour12:false });
const cloneEmpty = () => structuredClone(EMPTY_STATE);
function readState() { try { const value=JSON.parse(localStorage.getItem(STORAGE_KEY));if(value?.schemaVersion!==1)return cloneEmpty();for(const item of Object.values(value.objects||{}))if(!item.publicId)item.publicId=uuid();return value; } catch { return cloneEmpty(); } }
let state = readState();
// A workspace account is a projection of the authenticated server session. It is
// intentionally not a demo-account switcher: production role changes must come
// from the identity provider/member service.
const ROLE_CAPABILITIES = Object.freeze({
  BRAND_ADMIN: ["codes:write", "objects:read", "events:read", "campaigns:write", "risks:review", "ledger:read"],
  BRAND_AUDITOR: ["objects:read", "events:read", "risks:review", "ledger:read"],
  FACTORY_OPERATOR: ["objects:read", "events:write:packing"],
  DISTRIBUTOR_RECEIVER: ["objects:read", "events:write:distributor_receiving"],
  STORE_RECEIVER: ["objects:read", "events:write:store_receiving", "ledger:read:self"],
  FINANCE: ["ledger:read", "settlements:write"]
});
const ROLE_LABELS = Object.freeze({
  BRAND_ADMIN: "品牌管理员", BRAND_AUDITOR: "品牌稽核", FACTORY_OPERATOR: "工厂操作员",
  DISTRIBUTOR_RECEIVER: "经销商收货员", STORE_RECEIVER: "门店收货员", FINANCE: "财务"
});
const ROLE_DEFAULT_VIEW = Object.freeze({
  BRAND_ADMIN: "dashboard", BRAND_AUDITOR: "movement", FACTORY_OPERATOR: "receive",
  DISTRIBUTOR_RECEIVER: "receive", STORE_RECEIVER: "receive", FINANCE: "ledger"
});
let sessionUser = null;
let lastRenderedRole = null;
let pendingFieldEvent = null;
let agentReturnFocus = null;
let cameraStream = null;
let cameraFrame = 0;
let cameraBusy = false;
let pendingDeepLink = new URL(location.href).searchParams.get("verify");
let publicLoadStarted = false;
let publicLoadToken = 0;
const apiBaseUrl = String(window.RELIACODE_CONFIG?.apiBaseUrl||"").replace(/\/$/,"");
const persistentWorkspace = Boolean(window.RELIACODE_CONFIG?.persistentWorkspace);
const domainApi = Boolean(window.RELIACODE_CONFIG?.domainApi);
const hostedApi = domainApi || persistentWorkspace;
const sameOriginApiAvailable = hostedApi || Boolean(apiBaseUrl);
let serverVersion = 0;
let csrfToken = "";
let serverReady = !hostedApi;
let saveTimer = null;
let saveInFlight = false;
let saveDirty = false;
let saveConflict = null;
let saveRevision = 0;
let saveRetryAttempt = 0;
let saveOnline = navigator.onLine !== false;
let saveNextRetryAt = 0;
let persistenceQueue = null;
let persistenceTick = null;
const apiUrl = (path) => apiBaseUrl + path;
async function serverRequest(path, options={}) {
  const response = await fetch(apiUrl(path), { credentials:"include", ...options, headers:{ Accept:"application/json", ...(options.body?{"Content-Type":"application/json"}:{}), ...(options.headers||{}) } });
  const body = await response.json().catch(()=>({}));
  if (!response.ok) { const error = new Error(body.message || ("Request failed (" + response.status + ")")); error.status=response.status; error.body=body; throw error; }
  return body;
}
const bytesFromBase64url=value=>Uint8Array.from(atob(String(value).replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(String(value).length/4)*4,'=')),char=>char.charCodeAt(0));
const base64urlFromBytes=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function registrationOptions(value){return{...value,challenge:bytesFromBase64url(value.challenge),user:{...value.user,id:bytesFromBase64url(value.user.id)},excludeCredentials:(value.excludeCredentials||[]).map(item=>({...item,id:bytesFromBase64url(item.id)}))};}
function authenticationOptions(value){return{...value,challenge:bytesFromBase64url(value.challenge),allowCredentials:(value.allowCredentials||[]).map(item=>({...item,id:bytesFromBase64url(item.id)}))};}
function credentialJson(credential){const response=credential.response,result={id:credential.id,rawId:base64urlFromBytes(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:base64urlFromBytes(response.clientDataJSON)}};if(response.attestationObject){result.response.attestationObject=base64urlFromBytes(response.attestationObject);result.response.transports=response.getTransports?.()||[];}else{result.response.authenticatorData=base64urlFromBytes(response.authenticatorData);result.response.signature=base64urlFromBytes(response.signature);result.response.userHandle=response.userHandle?base64urlFromBytes(response.userHandle):undefined;}return result;}
async function registerPasskey(){if(!window.PublicKeyCredential)return toast('此浏览器不支持 Passkey');try{const options=await serverRequest('/api/auth/passkeys/registration/options',{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:'{}'});const credential=await navigator.credentials.create({publicKey:registrationOptions(options)});if(!credential)throw new Error('Passkey registration was cancelled');await serverRequest('/api/auth/passkeys/registration/verify',{method:'POST',headers:{'X-CSRF-Token':csrfToken},body:JSON.stringify({challenge:options.challenge,name:'Passkey '+new Date().toLocaleDateString('zh-CN'),response:credentialJson(credential)})});const list=await serverRequest('/api/auth/passkeys');toast(`Passkey 已注册（${list.items.length}/2）${list.items.length<2?'，管理员还需再添加一个':''}`);}catch(error){toast(error.message);}}
async function loginWithPasskey(username){if(!window.PublicKeyCredential)throw new Error('此浏览器不支持 Passkey');const options=await serverRequest('/api/auth/passkeys/authentication/options',{method:'POST',body:JSON.stringify({username})});const credential=await navigator.credentials.get({publicKey:authenticationOptions(options)});if(!credential)throw new Error('Passkey login was cancelled');const verified=await serverRequest('/api/auth/passkeys/authentication/verify',{method:'POST',body:JSON.stringify({challenge:options.challenge,response:credentialJson(credential)})});const session=await serverRequest('/api/auth/session');return{...verified,user:session.user,csrfToken:session.csrfToken};}
function workspacePayloadValid(value,{allowUninitialized=false}={}){
  const shape=value&&value.schemaVersion===1&&Array.isArray(value.accounts)&&Array.isArray(value.products)&&Array.isArray(value.codeBatches)&&value.objects&&typeof value.objects==='object'&&!Array.isArray(value.objects)&&Array.isArray(value.events)&&Array.isArray(value.campaigns)&&Array.isArray(value.ledger)&&Array.isArray(value.risks)&&Array.isArray(value.agentRuns);
  if(!shape)return false;
  if(value.initialized===true)return Boolean(value.workspace&&typeof value.workspace==='object');
  return allowUninitialized&&value.initialized===false&&value.workspace&&typeof value.workspace==='object'&&value.accounts.length===0&&value.products.length===0&&value.codeBatches.length===0&&Object.keys(value.objects).length===0&&value.events.length===0&&value.campaigns.length===0&&value.ledger.length===0&&value.risks.length===0&&value.agentRuns.length===0;
}
function parseWorkspaceResponse(body,options={}){if(!body||!Number.isInteger(Number(body.version))||!workspacePayloadValid(body.workspace,options)){const error=new Error('服务器返回的工作区数据无效');error.code='INVALID_WORKSPACE_PAYLOAD';throw error;}return {...body,version:Number(body.version)};}
function exportWorkspaceSnapshot(value=state){downloadFile('reliacode-workspace-local-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(value,null,2),'application/json');}
function showPersistenceStatus(message,actions=[]){let node=$('#persistence-status');if(!node){node=document.createElement('div');node.id='persistence-status';Object.assign(node.style,{position:'fixed',left:'50%',bottom:'20px',transform:'translateX(-50%)',zIndex:'1000',maxWidth:'min(720px,calc(100vw - 32px))',padding:'14px 16px',borderRadius:'12px',background:'#241b12',color:'#fff',boxShadow:'0 10px 30px #0005',fontSize:'14px'});document.body.append(node);}node.innerHTML='';const text=document.createElement('span');text.textContent=message;node.append(text);for(const action of actions){const button=document.createElement('button');button.type='button';button.textContent=action.label;button.onclick=action.onClick;Object.assign(button.style,{marginLeft:'10px',padding:'6px 10px',borderRadius:'7px',border:'1px solid #ffffff66',background:'#ffffff18',color:'inherit',cursor:'pointer'});node.append(button);}node.hidden=false;}
function clearPersistenceStatus(){const node=$('#persistence-status');if(node)node.hidden=true;}
function pendingState(){try{const value=JSON.parse(localStorage.getItem(PENDING_STATE_KEY));return workspacePayloadValid(value)?value:null;}catch{return null;}}
function preservePendingState(){if(!persistentWorkspace||!saveDirty)return;try{localStorage.setItem(PENDING_STATE_KEY,JSON.stringify(state));}catch{}}
function clearPendingState(){try{localStorage.removeItem(PENDING_STATE_KEY);}catch{}}
function clearSavedPendingState(){if(saveDirty||saveConflict||saveInFlight)return toast("仍有未同步数据，保存成功后才能清理");clearPendingState();if(persistenceQueue)persistenceQueue.clear();updatePersistenceStatus();toast("已清理本地同步副本，服务器数据不受影响");}
function retryPersistence(){saveConflict=null;if(persistenceQueue){persistenceQueue.retry();}else{saveRetryAttempt=0;saveNextRetryAt=0;persistNow();}updatePersistenceStatus();}
function updatePersistenceStatus(){let node=$("#persistence-status");if(!persistentWorkspace||(!saveDirty&&!saveConflict&&!saveInFlight)){if(node)node.hidden=true;return;}if(!node){node=document.createElement("div");node.id="persistence-status";node.className="persistence-banner";document.body.append(node);}const blocked=Boolean(saveConflict),offline=!saveOnline;const wait=saveNextRetryAt?Math.max(0,Math.ceil((saveNextRetryAt-Date.now())/1000)):0;node.hidden=false;node.innerHTML=`<span class="persistence-message">${blocked?"工作区存在冲突，未同步数据已保留。":offline?"当前离线，未同步数据已保留。":saveInFlight?"正在同步工作区…":wait?`保存失败，将在 ${wait} 秒后重试。`:"有未同步的工作区变更。"}</span><span class="persistence-actions"><button type="button" data-persistence-retry>${blocked?"重试（先刷新服务器）":"立即重试"}</button><button type="button" data-persistence-export>导出副本</button></span>`;node.querySelector("[data-persistence-retry]").onclick=retryPersistence;node.querySelector("[data-persistence-export]").onclick=()=>exportWorkspaceSnapshot(pendingState()||state);}
function startPersistenceQueue(){if(!persistentWorkspace||persistenceQueue)return;import("./persistence.mjs").then(({createPersistenceQueue,createLocalStorageAdapter})=>{const adapter=createLocalStorageAdapter({key:"reliacode-persistence-queue-v1"});persistenceQueue=createPersistenceQueue({adapter,delay:500,maxDelay:30000,jitter:.2,online:saveOnline,write:()=>persistNow(),onConflict:()=>{saveConflict={status:409};updatePersistenceStatus();},onError:()=>updatePersistenceStatus()});if(persistenceQueue.status.dirty){saveDirty=true;const pending=pendingState();if(pending){state=pending;}}updatePersistenceStatus();persistenceTick=setInterval(updatePersistenceStatus,500);}).catch(()=>updatePersistenceStatus());}
async function persistNow() {
  if (!persistentWorkspace || !serverReady || saveInFlight || saveConflict || !saveDirty) return false;
  clearTimeout(saveTimer); saveTimer=null;
  saveInFlight = true;
  const revision = saveRevision;
  try {
    const result = await serverRequest("/api/v1/workspace", { method:"PUT", headers:{"X-CSRF-Token":csrfToken}, body:JSON.stringify({ version:serverVersion, workspace:state }) });
    parseWorkspaceResponse(result);
    serverVersion = Number(result.version);
    saveRetryAttempt=0;
    if (saveRevision===revision) { saveDirty=false; clearPendingState(); }
    updatePersistenceStatus();
    return true;
  } catch (error) {
    saveDirty=true;
    if (error.status === 409) { saveConflict={status:409}; toast("Workspace changed in another session; reload and retry"); }
    else { saveRetryAttempt=Math.min(saveRetryAttempt+1,10); saveNextRetryAt=Date.now()+Math.min(30000,500*(2**Math.min(saveRetryAttempt,6))); toast("Server save failed; check network"); schedulePersistRetry(); }
    updatePersistenceStatus();
    return false;
  } finally { saveInFlight=false; updatePersistenceStatus(); schedulePersistRetry(); }
}
function schedulePersistRetry() {
  if (persistenceQueue) return;
  if (!persistentWorkspace || !serverReady || !saveOnline || saveInFlight || saveConflict || !saveDirty) return;
  clearTimeout(saveTimer);
  const base=Math.min(30000,500*(2**Math.min(saveRetryAttempt,6)));
  const jitter=Math.round(base*(Math.random()*0.4-0.2));
  saveNextRetryAt=Date.now()+Math.max(250,base+jitter);
  saveTimer=setTimeout(persistNow,Math.max(250,base+jitter));
}
window.addEventListener("offline",()=>{saveOnline=false;clearTimeout(saveTimer);saveTimer=null;saveNextRetryAt=0;if(persistenceQueue)persistenceQueue.setOnline(false);updatePersistenceStatus();});
window.addEventListener("online",()=>{saveOnline=true;saveRetryAttempt=0;saveNextRetryAt=0;if(persistenceQueue)persistenceQueue.setOnline(true);schedulePersistRetry();updatePersistenceStatus();});
const save = () => {
  if(domainApi)return;
  if (!persistentWorkspace) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return; }
  saveDirty=true; saveRevision+=1; saveRetryAttempt=0; preservePendingState();
  if(persistenceQueue){persistenceQueue.markDirty();updatePersistenceStatus();return;}
  clearTimeout(saveTimer); saveTimer=setTimeout(persistNow, 500); updatePersistenceStatus();
};
const account = () => state.accounts.find((item) => item.id===state.currentAccountId) || state.accounts[0] || null;
const currentRole = () => String(sessionUser?.role || account()?.roleCode || (account()?.kind === "FIELD" ? "FACTORY_OPERATOR" : "BRAND_ADMIN")).toUpperCase();
const capabilities = () => {const values=sessionUser?.capabilities || ROLE_CAPABILITIES[currentRole()] || [];if(!domainApi)return new Set(values);const enabled=new Set(["platform:tenants:read","platform:tenants:write","products:write","codes:write","codes:approve","objects:read","events:read","members:read","members:invite","members:manage"]);return new Set(values.filter(value=>enabled.has(value)));};
const can = (capability) => capabilities().has(capability);
const roleLabel = () => ROLE_LABELS[currentRole()] || account()?.role || currentRole();
function ensureSessionAccount(user) {
  if (!user) return;
  const roleAliases = { "品牌管理员":"BRAND_ADMIN", "品牌稽核":"BRAND_AUDITOR", "工厂操作员":"FACTORY_OPERATOR", "经销商收货员":"DISTRIBUTOR_RECEIVER", "门店收货员":"STORE_RECEIVER", "财务":"FINANCE" };
  const rawRole = String(user.roleCode || user.role || "BRAND_ADMIN").toUpperCase();
  const normalizedRole = ROLE_CAPABILITIES[rawRole] ? rawRole : (roleAliases[user.role] || "BRAND_ADMIN");
  sessionUser = { ...user, role: normalizedRole, capabilities: user.capabilities || ROLE_CAPABILITIES[normalizedRole] || [] };
  const existing = state.accounts.find((item) => item.id === user.id) || state.accounts[0] || (state.initialized ? { id:user.id, kind:"BRAND", name:user.name, org:state.workspace?.brandName || "", role:"", deviceId:"", location:"" } : null);
  if (existing && !state.accounts.includes(existing)) state.accounts.push(existing);
  if (existing) {
    existing.id = user.id || existing.id;
    existing.name = user.name || existing.name;
    existing.roleCode = sessionUser.role;
    existing.role = ROLE_LABELS[sessionUser.role] || sessionUser.role;
    existing.kind = sessionUser.role.startsWith("BRAND") || sessionUser.role === "FINANCE" ? "BRAND" : "FIELD";
    state.currentAccountId = existing.id;
  }
}
const product = (id) => state.products.find((item) => item.id===id);
function scannedIdentity(value){const text=String(value||"").trim();try{const url=new URL(text);return url.searchParams.get("verify")||url.pathname.match(/\/p\/([0-9a-f-]{36})/i)?.[1]||text;}catch{return text;}}
const object = (value) => {const identity=scannedIdentity(value),byCode=state.objects[identity.toUpperCase()];return byCode||Object.values(state.objects).find((item)=>item.publicId?.toLowerCase()===identity.toLowerCase())||null;};
function verificationUrl(item){const url=new URL(location.href);url.search="";url.hash="";url.searchParams.set("verify",item.publicId);return url.href;}
function toast(message) { const node=$("#toast"); node.textContent=message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>node.classList.remove("show"),3200); }
function tag(value) { const danger=/拒绝|异常|失败/.test(value), warning=/待|冻结|运输/.test(value), info=/进行|发货/.test(value); return `<span class="tag ${danger?"red":warning?"amber":info?"blue":"green"}">${escapeHtml(value)}</span>`; }
function emptyState(title, description, action="") { return `<div class="true-empty">${icon("package","empty-icon")}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${action}</div>`; }
function appendEvent({ action, code, result, actorId=account()?.id }) {
  const actor=state.accounts.find((item)=>item.id===actorId) || account();
  const event={ id:uuid(),action,code,time:timestamp(),result,accountId:actor?.id||null,actor:actor?.name||"系统",org:actor?.org||state.workspace?.brandName||"",deviceId:actor?.deviceId||"",location:actor?.location||"" };
  state.events.unshift(event); return event;
}

const ONBOARDING_DISMISS_KEY = "reliacode-onboarding-dismissed-v1";
let onboardingGuideOpen = false;
function onboardingStorageKey() { return `${ONBOARDING_DISMISS_KEY}:${state.workspace?.id || "local"}`; }
function onboardingIsDismissed() { try { return localStorage.getItem(onboardingStorageKey()) === "1"; } catch { return false; } }
function dismissOnboarding() { onboardingGuideOpen=false; try { localStorage.setItem(onboardingStorageKey(), "1"); } catch {} const overlay=$("#onboarding"); if(overlay) overlay.hidden=true; renderOnboardingReopen(); }
function reopenOnboarding() { onboardingGuideOpen=true; try { localStorage.removeItem(onboardingStorageKey()); } catch {} renderOnboarding(); }
function onboardingSteps() {
  const objects=Object.values(state.objects||{});
  const hasScan=state.events.some((event)=>["VERIFY","PACKING","SHIPPING","RECEIVING_DISTRIBUTOR","RECEIVING_STORE","SELLING"].includes(event.action));
  return [
    { id:"workspace", title:"创建组织工作区", description:"已建立品牌、管理员和设备上下文。", done:Boolean(state.initialized&&state.workspace&&state.accounts.length), view:"dashboard", action:"查看工作区" },
    { id:"product", title:"添加第一个产品环境", description:"维护产品名称和 SKU，作为可靠码的业务归属。", done:state.products.length>0, view:"codes", action:state.products.length?"查看产品":"添加产品" },
    { id:"code", title:"生成接入代码", description:"为产品批量生成可导出的单品或包装码。", done:state.codeBatches.length>0, view:"codes", action:state.codeBatches.length?"查看代码":"生成代码" },
    { id:"scan", title:"完成一次扫描", description:"验证一个可靠码，确认产品身份和追溯链路。", done:hasScan, view:"verify", action:hasScan?"查看验证":"开始验证" },
    { id:"public", title:"准备公开验证", description:"每个可靠码都带有可分享的公开验证地址。", done:objects.some((item)=>Boolean(item.publicId)), view:"verify", action:"打开公开验证" }
  ];
}
function renderOnboardingReopen() {
  let button=$("#onboarding-reopen");
  if(!state.initialized){ if(button)button.remove(); return; }
  if(!button){button=document.createElement("button");button.id="onboarding-reopen";button.className="onboarding-reopen secondary";button.type="button";button.textContent="查看首次上手引导";document.body.append(button);}
  button.onclick=reopenOnboarding;
}

function renderOnboarding() {
  let overlay=$("#onboarding");
  if (!overlay) { overlay=document.createElement("div"); overlay.id="onboarding"; overlay.className="onboarding"; document.body.append(overlay); }
  if (state.initialized && !onboardingGuideOpen) { overlay.hidden=true; renderOnboardingReopen(); return; }
  overlay.hidden=false;
  if(pendingDeepLink){overlay.innerHTML=`<section class="onboarding-card public-verification-card"><div class="onboarding-brand">${icon("logo")}<div><b>ReliaCode 可靠码</b><small>公开产品验证</small></div></div><div id="public-verification-result">${emptyState("尚未连接生产验证服务","公开验证服务尚未配置。")}</div><button id="enter-local-workspace" class="secondary" type="button">进入本地运营工作区</button></section>`;$("#enter-local-workspace").onclick=()=>{pendingDeepLink=null;publicLoadToken+=1;history.replaceState({},"",location.pathname);renderOnboarding();};if(!publicLoadStarted&&sameOriginApiAvailable){publicLoadStarted=true;const token=++publicLoadToken;loadPublicVerification(pendingDeepLink,$("#public-verification-result"),token);}return;}
  if (state.initialized) {
    const steps=onboardingSteps(), completed=steps.filter((step)=>step.done).length;
    overlay.innerHTML=`<section class="onboarding-card onboarding-guide" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><button id="onboarding-close" class="onboarding-close" type="button" aria-label="关闭首次上手引导">${icon("close")}</button><div class="onboarding-brand">${icon("logo")}<div><b>ReliaCode 可靠码</b><small>五步完成第一次有效追溯</small></div></div><div class="onboarding-guide-head"><div><h1 id="onboarding-title">把第一个产品跑通</h1><p>按顺序完成下面步骤即可验证从组织设置到公开验证的完整链路。</p></div><span class="onboarding-progress">${completed}/5</span></div><div class="onboarding-steps">${steps.map((step,index)=>`<article class="onboarding-step ${step.done?"is-done":""}"><span class="onboarding-step-number">${step.done?icon("check"):index+1}</span><div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p><button class="secondary onboarding-action" type="button" data-onboarding-go="${step.view}">${escapeHtml(step.action)}</button></div></article>`).join("")}</div><button id="onboarding-dismiss" class="link-button onboarding-dismiss" type="button">稍后再看</button></section>`;
    $("#onboarding-close").onclick=dismissOnboarding; $("#onboarding-dismiss").onclick=dismissOnboarding;
    overlay.querySelectorAll("[data-onboarding-go]").forEach((button)=>button.onclick=()=>{dismissOnboarding();go(button.dataset.onboardingGo);});
    return;
  }
  const hosted = hostedApi;
  if(hosted&&sessionUser&&currentRole()!=="BRAND_ADMIN"){
    overlay.innerHTML=`<section class="onboarding-card"><div class="onboarding-brand">${icon("logo")}<div><b>ReliaCode 可靠码</b><small>组织工作区</small></div></div><h1>等待组织工作区</h1><p>当前账号已加入“${escapeHtml(sessionUser.organizationName||"组织")}”，但组织管理员尚未初始化共享工作区。请联系管理员完成设置。</p><button id="auth-logout-empty" class="secondary" type="button">退出登录</button></section>`;
    $("#auth-logout-empty").onclick=async()=>{try{await serverRequest("/api/auth/logout",{method:"POST",headers:{"X-CSRF-Token":csrfToken}});}finally{location.reload();}};
    return;
  }
  overlay.innerHTML=`<form id="workspace-form" class="onboarding-card"><div class="onboarding-brand">${icon("logo")}<div><b>ReliaCode 可靠码</b><small>${hosted?"创建你的品牌组织":"创建空白本地工作区"}</small></div></div><h1>${hosted?"完成品牌组织设置":"开始建立产品追溯"}</h1><p>${hosted?"这是你的组织私有工作区。现场人员、稽核和财务应通过组织邀请加入。":"系统不包含任何示例品牌或业务数据，内容仅保存在当前浏览器。"}</p><label>品牌或企业名称<input name="brandName" required maxlength="80" autocomplete="organization" /></label><label>管理员姓名<input name="adminName" required maxlength="40" autocomplete="name" value="${escapeHtml(sessionUser?.name||"")}" /></label><label>设备名称<input name="deviceName" required maxlength="80" value="当前浏览器" /></label><label class="consent"><input name="confirm" type="checkbox" required />我已了解当前部署的工作区边界和数据保存方式。</label><button class="primary" type="submit">${hosted?"创建品牌组织":"创建空白工作区"}</button></form>`;
  $("#workspace-form").onsubmit=async(event)=>{event.preventDefault();const data=new FormData(event.currentTarget);const brandName=String(data.get("brandName")).trim(),adminName=String(data.get("adminName")).trim(),deviceName=String(data.get("deviceName")).trim();if(!brandName||!adminName||!deviceName)return;const id=sessionUser?.id||uuid();state={...cloneEmpty(),initialized:true,workspace:{id:uuid(),brandName,createdAt:timestamp()},currentAccountId:id,accounts:[{id,kind:"BRAND",name:adminName,org:brandName,roleCode:"BRAND_ADMIN",role:"品牌管理员",deviceId:deviceName,location:"未设置",eventType:"VERIFY",eventLabel:"产品验证",canManageCodes:true}]};ensureSessionAccount(sessionUser||state.accounts[0]);save();if(hosted){const saved=await persistNow();if(!saved||saveDirty)return;}renderAll();toast(hosted?"品牌组织已创建":"空白工作区已创建");};
}


function renderAccountOptions() {
  const current = account();
  const workspaceName = $("#workspace-name");
  const userName = $("#user-name");
  const userRole = $("#user-role");
  const avatar = $("#user-avatar");
  if (workspaceName) workspaceName.textContent = state.workspace?.brandName || current?.org || "未登录";
  if (userName) userName.textContent = sessionUser?.name || current?.name || "未登录";
  if (userRole) userRole.textContent = roleLabel();
  if (avatar) avatar.textContent = (sessionUser?.name || current?.name || "?").slice(0, 1).toUpperCase();
  const context = $("#user-menu-context");
  if (context) context.innerHTML = `<strong>${escapeHtml(state.workspace?.brandName || current?.org || "未登录")}</strong><span>${escapeHtml(sessionUser?.email || "")} · ${escapeHtml(roleLabel())}</span>`;
}
function updateChrome() {
  const current=account();
  const role = currentRole();
  const fieldRole = ["FACTORY_OPERATOR", "DISTRIBUTOR_RECEIVER", "STORE_RECEIVER"].includes(role);
  document.body.dataset.audience=fieldRole?"field":"brand";
  document.body.dataset.shell=fieldRole?"mobile-field":"desktop-management";
  $("#device-summary").innerHTML=current?`${icon("device")} ${escapeHtml(current.deviceId)}`:"";
  $("#updated-at").textContent=new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});
  $("#risk-badge").textContent=state.risks.filter((item)=>item.status==="待处理").length;
  $("#brand-logo").innerHTML=icon("logo"); $("#agent-toggle").innerHTML=icon("agent")+"Agent"; $("#reset").innerHTML=icon("reset");
  document.querySelectorAll(".nav-link").forEach((button)=>{
    if(!button.querySelector(".nav-svg"))button.insertAdjacentHTML("afterbegin",icon(button.dataset.icon||"package","nav-svg"));
    const required = String(button.dataset.capability || "").split(",").filter(Boolean);
    button.hidden = required.length > 0 && !required.some((capability) => can(capability));
  });
  document.querySelectorAll(".nav-group").forEach((group)=>{
    const next=[]; let node=group.nextElementSibling;
    while(node && !node.classList.contains("nav-group")){if(!node.hidden)next.push(node);node=node.nextElementSibling;}
    group.hidden=next.length===0;
  });
  ["codes","campaigns"].forEach((view)=>{const section=$("#"+view);if(section)section.hidden=!document.querySelector(`[data-view="${view}"]`)||document.querySelector(`[data-view="${view}"]`).hidden;});
  document.querySelectorAll("[data-go]").forEach((element)=>{const target=document.querySelector(`[data-view="${element.dataset.go}"]`);if(target?.hidden)element.hidden=true;});
  const userMenu=$("#user-menu"), popover=$("#user-menu-popover"), logout=$("#logout"),addPasskey=$("#add-passkey");
  if(userMenu && popover && !userMenu.dataset.bound){
    userMenu.dataset.bound="1";
    userMenu.onclick=()=>{popover.hidden=!popover.hidden;userMenu.setAttribute("aria-expanded",String(!popover.hidden));};
    document.addEventListener("click",(event)=>{if(!event.target.closest("#user-menu")&&!event.target.closest("#user-menu-popover")){popover.hidden=true;userMenu.setAttribute("aria-expanded","false");}});
  }
  if(logout && !logout.dataset.bound){logout.dataset.bound="1";logout.onclick=async()=>{try{if(hostedApi)await serverRequest("/api/auth/logout",{method:"POST",headers:{"X-CSRF-Token":csrfToken}});}finally{sessionUser=null;state=cloneEmpty();localStorage.removeItem(STORAGE_KEY);location.reload();}};}
  if(addPasskey){addPasskey.hidden=!domainApi;if(!addPasskey.dataset.bound){addPasskey.dataset.bound="1";addPasskey.onclick=registerPasskey;}}
  const note=document.querySelector(".sidebar-note");
  note.innerHTML=`<b>本地工作区</b><p>无内置业务数据；内容仅保存在此浏览器。</p><div class="data-actions"><button id="export-workspace">导出备份</button><label>导入备份<input id="import-workspace" type="file" accept="application/json" /></label></div>`;
  $("#export-workspace").onclick=exportWorkspace; $("#import-workspace").onchange=importWorkspace;
}
function metric(label,value,note,iconName,view) { return `<button class="metric" data-go="${view}"><span>${icon(iconName)}</span><div><small>${label}</small><strong>${value}</strong><p>${note}</p></div></button>`; }
function renderDashboard() {
  if(currentRole()==='PLATFORM_OPERATOR')return renderPlatformDashboard();
  const active=Object.keys(state.objects).length,inTransit=Object.values(state.objects).filter((item)=>item.status==="IN_TRANSIT").length,risks=state.risks.filter((item)=>item.status==="待处理").length;
  $("#dashboard").innerHTML=`<div class="page-heading"><div><span class="section-kicker">品牌控制台</span><h2>产品身份与流转总览</h2><p>所有数字均由当前工作区的真实录入和操作产生。</p></div><button class="primary with-icon" data-go="codes">${icon("plus")}录入产品与生码</button></div><div class="metric-strip">${metric("已生成可靠码",active.toLocaleString(),state.products.length?`覆盖 ${state.products.length} 个产品`:"尚未录入产品","codes","codes")}${metric("运输中产品",inTransit.toLocaleString(),"按序列对象统计","route","movement")}${metric("业务事件",state.events.length.toLocaleString(),"不包含页面浏览","scan","movement")}${metric("待处理异常",risks.toLocaleString(),"由失败作业产生","risk","risk")}</div><div class="brand-grid"><section class="panel"><div class="section-head"><div><h3>最近产品动向</h3><p>当前工作区最近写入的业务事实</p></div></div>${state.events.length?state.events.slice(0,6).map((event)=>`<div class="movement-row"><span>${icon("route")}</span><div><b>${escapeHtml(event.action)}</b><small class="code">${escapeHtml(event.code)}</small></div><time>${escapeHtml(localTime(event.time))}</time></div>`).join(""):emptyState("暂无产品动向","录入产品并生成可靠码后，执行扫码作业即可形成事件。",'<button class="secondary" data-go="codes">录入第一个产品</button>')}</section><section class="panel"><div class="section-head"><div><h3>工作区状态</h3><p>不使用预置统计或随机趋势</p></div></div><dl class="workspace-facts"><div><dt>品牌</dt><dd>${escapeHtml(state.workspace?.brandName)}</dd></div><div><dt>账号</dt><dd>${state.accounts.length}</dd></div><div><dt>产品</dt><dd>${state.products.length}</dd></div><div><dt>最近备份</dt><dd>${escapeHtml(state.workspace?.lastExportAt?localTime(state.workspace.lastExportAt):"尚未导出")}</dd></div></dl></section></div>`;
}
function renderPlatformDashboard(){const applications=state.platformApplications||[];$("#dashboard").innerHTML=`<div class="page-heading"><div><span class="section-kicker">平台控制面</span><h2>租户申请与人工交付</h2><p>审核企业申请、配置套餐，并在审批后人工开通首位租户所有者。</p></div></div><section class="panel"><div class="section-head"><div><h3>租户申请</h3><p>${applications.length} 条最近申请</p></div></div>${applications.length?applications.map(item=>`<div class="movement-row"><span>${icon('user')}</span><div><b>${escapeHtml(item.company_name)}</b><small>${escapeHtml(item.contact_name)} · ${escapeHtml(item.contact_email)} · ${Number(item.expected_monthly_codes||0).toLocaleString()} 码/月</small></div>${tag(item.status)}<div class="batch-actions">${item.status==='PENDING'?`<button class="row-action" data-application-approve="${item.id}">批准</button><button class="row-action" data-application-reject="${item.id}">拒绝</button>`:item.status==='APPROVED'&&item.tenant_id?`<button class="row-action" data-provision-owner="${item.id}" data-tenant="${item.tenant_id}">开通所有者</button>`:''}</div></div>`).join(''):emptyState('暂无租户申请','企业提交申请后会显示在这里。')}</section>`;document.querySelectorAll('[data-application-approve]').forEach(button=>button.onclick=()=>reviewTenantApplication(button.dataset.applicationApprove,'APPROVE'));document.querySelectorAll('[data-application-reject]').forEach(button=>button.onclick=()=>reviewTenantApplication(button.dataset.applicationReject,'REJECT'));document.querySelectorAll('[data-provision-owner]').forEach(button=>button.onclick=()=>provisionTenantOwner(button.dataset.tenant,button.dataset.provisionOwner));}
async function reviewTenantApplication(id,action){const auditReason=prompt(action==='APPROVE'?'请输入批准理由':'请输入拒绝理由');if(!auditReason)return;try{await serverRequest(`/api/v1/platform/tenant-applications/${encodeURIComponent(id)}/decision`,{method:'POST',headers:{'X-CSRF-Token':csrfToken,'Idempotency-Key':uuid()},body:JSON.stringify({action,reason:auditReason,plan:'team'})});await loadDomainState(sessionUser);renderAll();toast(action==='APPROVE'?'租户已批准':'申请已拒绝');}catch(error){toast(error.message);}}
async function provisionTenantOwner(tenantId,applicationId){const username=prompt('租户所有者用户名');if(!username)return;const temporaryPassword=prompt('一次性临时密码（至少 12 位，包含字母和数字）');if(!temporaryPassword)return;const auditReason=prompt('请输入开通理由');if(!auditReason)return;try{await serverRequest(`/api/v1/platform/tenants/${encodeURIComponent(tenantId)}/owner`,{method:'POST',headers:{'X-CSRF-Token':csrfToken,'Idempotency-Key':uuid()},body:JSON.stringify({applicationId,username,temporaryPassword,reason:auditReason})});toast('租户所有者已开通，请通过受控渠道交付临时凭据');}catch(error){toast(error.message);}}

function renderCodes() {
  const productOptions=state.products.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.sku)}</option>`).join("");
  const productRows=state.products.map((item)=>`<div class="product-table"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.sku)}</small></div><span class="code">${escapeHtml(item.gtin||"未设置")}</span><strong>${Object.values(state.objects).filter((obj)=>obj.productId===item.id).length}</strong>${domainApi?'—':`<button class="row-action" data-product-remove="${item.id}">删除</button>`}</div>`).join("");
  const batchRows=state.codeBatches.map((batch)=>`<div class="code-batch-row"><div><b class="code">${escapeHtml(batch.id)}</b><small>${escapeHtml(localTime(batch.createdAt))}</small></div><span>${escapeHtml(product(batch.productId)?.name||"产品已删除")}</span><span>${escapeHtml(batch.level)} / ${batch.quantity.toLocaleString()}${domainApi?`<small>已生成 ${Number(batch.generatedCount||0).toLocaleString()}</small>`:''}</span><span class="code">${escapeHtml(batch.firstCode)}<br/>${escapeHtml(batch.lastCode)}</span>${tag(batch.status)}<div class="batch-actions">${domainApi?(batch.status==='PENDING_APPROVAL'?'<button class="row-action" data-job-approve="'+batch.id+'">审批</button>':'')+(['PENDING_APPROVAL','QUEUED','RUNNING'].includes(batch.status)?'<button class="row-action" data-job-cancel="'+batch.id+'">取消</button>':''):(`<button class="row-action" data-labels="${batch.id}">${icon("scan")}二维码标签</button><button class="row-action" data-download="${batch.id}">${icon("download")}CSV</button>`)}</div></div>`).join("");
  $("#codes").innerHTML=`<div class="page-heading"><div><span class="section-kicker">码资产</span><h2>产品与批量生码</h2><p>${domainApi?'所有数据来自服务端领域 API；生码审批后由后台任务执行。':'先创建产品，再生成可实际导出的唯一序列码。'}</p></div></div><div class="two-column"><section class="panel"><div class="section-head"><div><h3>新增产品</h3><p>字段由当前品牌自行维护</p></div></div><form id="product-form" class="compact-form"><label>产品名称<input name="name" required maxlength="100" /></label><label>内部 SKU<input name="sku" required maxlength="50" /></label><label>GTIN（可选）<input name="gtin" maxlength="20" inputmode="numeric" /></label><button class="secondary" type="submit">保存产品</button></form></section><section class="panel"><div class="section-head"><div><h3>生成可靠码</h3><p>${domainApi?'异步任务单批最多 1,000,000 枚':'浏览器版单批最多 5,000 枚'}</p></div></div>${state.products.length?`<form id="batch-form" class="compact-form"><label>产品<select name="productId">${productOptions}</select></label><label>包装层级<select name="level"><option value="ITEM">单品</option><option value="CASE">箱</option><option value="PALLET">托盘</option></select></label><label>批次/生产批号<input name="lot" maxlength="60" /></label><label>数量<input name="quantity" type="number" min="1" max="${domainApi?1000000:5000}" value="100" required /></label><button class="primary" type="submit">${domainApi?'创建生码任务':'生成唯一可靠码'}</button></form>`:emptyState("请先创建产品","没有产品时不能生成可靠码。")}</section></div><section class="panel"><div class="section-head"><div><h3>产品目录</h3><p>${state.products.length} 个产品</p></div></div>${state.products.length?`<div class="product-table table-head"><span>产品</span><span>GTIN</span><span>码数量</span><span>操作</span></div>${productRows}`:emptyState("暂无产品","使用上方表单创建第一个产品。")}</section><section class="panel"><div class="section-head"><div><h3>生码任务</h3><p>${state.codeBatches.length} 个任务</p></div></div>${state.codeBatches.length?`<div class="code-batch-row table-head"><span>任务</span><span>产品</span><span>层级/数量</span><span>首尾码</span><span>状态</span><span>操作</span></div>${batchRows}`:emptyState("暂无生码任务","创建产品后可生成第一批可靠码。")}</section>`;
  $("#product-form").onsubmit=addProduct;
  if($("#batch-form")) $("#batch-form").onsubmit=generateBatch;
  document.querySelectorAll("[data-download]").forEach((button)=>button.onclick=()=>exportBatch(button.dataset.download));
  document.querySelectorAll("[data-labels]").forEach((button)=>button.onclick=()=>exportQrLabels(button.dataset.labels));
  document.querySelectorAll("[data-product-remove]").forEach((button)=>button.onclick=()=>removeProduct(button.dataset.productRemove));
  document.querySelectorAll("[data-job-approve]").forEach(button=>button.onclick=()=>changeCodeJob(button.dataset.jobApprove,'approve'));
  document.querySelectorAll("[data-job-cancel]").forEach(button=>button.onclick=()=>changeCodeJob(button.dataset.jobCancel,'cancel'));
}
function validGtin(value){if(!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value))return false;const digits=[...value].map(Number),check=digits.pop(),sum=digits.reverse().reduce((total,digit,index)=>total+digit*(index%2===0?3:1),0);return (10-sum%10)%10===check;}
async function addProduct(event) { event.preventDefault();const data=new FormData(event.currentTarget);const sku=String(data.get("sku")).trim(),gtin=String(data.get("gtin")).trim();if(state.products.some((item)=>item.sku.toLowerCase()===sku.toLowerCase()))return toast("SKU 已存在");if(gtin&&!validGtin(gtin))return toast("GTIN 必须是有效的 8、12、13 或 14 位编码（含校验位）");try{if(domainApi){await serverRequest('/api/v1/products',{method:'POST',headers:{'X-CSRF-Token':csrfToken,'Idempotency-Key':uuid()},body:JSON.stringify({name:String(data.get('name')).trim(),sku,gtin:gtin||undefined,auditReason:'管理员通过产品目录创建产品'})});await loadDomainState(sessionUser);}else{state.products.push({id:uuid(),name:String(data.get("name")).trim(),sku,gtin,createdAt:timestamp()});save();}renderAll();go("codes");toast("产品已保存");}catch(error){toast(error.message);} }
function removeProduct(id) { if(Object.values(state.objects).some((item)=>item.productId===id))return toast("该产品已有可靠码，不能删除");if(!confirm("确定删除这个产品？"))return;state.products=state.products.filter((item)=>item.id!==id);save();renderAll();go("codes"); }
function createBatch({productId,level,lot="",quantity}) { if(!Number.isInteger(quantity)||quantity<1||quantity>5000)throw new Error("数量必须为 1–5,000");if(!product(productId))throw new Error("产品不存在");const prefix={ITEM:"RC-ITM",CASE:"RC-CTN",PALLET:"RC-PLT"}[level];if(!prefix)throw new Error("包装层级无效");const codes=[];for(let index=0;index<quantity;index++){const code=`${prefix}-${uuid().replaceAll("-","").toUpperCase()}`;state.objects[code]={code,publicId:uuid(),productId,level,lot,status:"COMMISSIONED",currentOrg:state.workspace.brandName,parent:null,children:[],createdAt:timestamp()};codes.push(code);}const batch={id:uuid(),productId,level,lot,quantity,codes,firstCode:codes[0],lastCode:codes.at(-1),status:"已生成",createdAt:timestamp()};state.codeBatches.unshift(batch);appendEvent({action:"COMMISSIONING",code:batch.id,result:`生成 ${quantity} 枚${level}可靠码`});save();return batch; }
async function generateBatch(event) { event.preventDefault();const data=new FormData(event.currentTarget);try{const quantity=Number(data.get("quantity"));if(domainApi){await serverRequest('/api/v1/code-jobs',{method:'POST',headers:{'X-CSRF-Token':csrfToken,'Idempotency-Key':uuid()},body:JSON.stringify({productId:String(data.get('productId')),level:String(data.get('level')),lot:String(data.get('lot')).trim()||undefined,quantity,serialRule:'RANDOM',auditReason:'管理员创建异步生码任务'})});await loadDomainState(sessionUser);}else createBatch({productId:String(data.get("productId")),level:String(data.get("level")),lot:String(data.get("lot")).trim(),quantity});renderAll();go("codes");toast(domainApi?'生码任务已创建，等待审批':`已生成 ${quantity.toLocaleString()} 枚唯一可靠码`);}catch(error){toast(error.message);} }
async function changeCodeJob(id,action){try{await serverRequest(`/api/v1/code-jobs/${encodeURIComponent(id)}/${action}`,{method:'POST',headers:{'X-CSRF-Token':csrfToken,'Idempotency-Key':uuid()},body:JSON.stringify({auditReason:action==='approve'?'管理员审批生码任务':'管理员取消生码任务'})});await loadDomainState(sessionUser);renderAll();go('codes');toast(action==='approve'?'任务已进入生成队列':'任务已取消');}catch(error){toast(error.message);}}
function exportBatch(id) { const batch=state.codeBatches.find((item)=>item.id===id);if(!batch)return;const rows=[["code","product_sku","product_name","level","lot","created_at"],...batch.codes.map((code)=>[code,product(batch.productId)?.sku||"",product(batch.productId)?.name||"",batch.level,batch.lot,batch.createdAt])];downloadFile(`reliacode-${id}.csv`,`\uFEFF${rows.map((row)=>row.map(csvCell).join(",")).join("\r\n")}`,"text/csv;charset=utf-8");batch.status="已导出";save();renderCodes(); }
const csvCell=(value)=>{let text=String(value??"");if(/^[\t\r ]*[=+\-@]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};
function downloadFile(name,content,type){const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([content],{type}));link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}

function qrMatrix(value){if(typeof qrcode!=="function")throw new Error("二维码组件未加载");const text=String(value),qr=qrcode(0,"M"),mode=/^[0-9A-Z $%*+\-./:]+$/.test(text)?"Alphanumeric":"Byte";qr.addData(text,mode);qr.make();return Array.from({length:qr.getModuleCount()},(_,row)=>Array.from({length:qr.getModuleCount()},(_,column)=>qr.isDark(row,column)));}
function qrSvg(value){const matrix=qrMatrix(value),quiet=4,size=matrix.length+quiet*2;let path="";for(let row=0;row<matrix.length;row++){let start=-1;for(let column=0;column<=matrix.length;column++){const dark=column<matrix.length&&matrix[row][column];if(dark&&start<0)start=column;if(!dark&&start>=0){const width=column-start;path+=`M${start+quiet} ${row+quiet}h${width}v1h-${width}z`;start=-1;}}}return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="可靠码 ${escapeHtml(value)}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;}
function exportQrLabels(id){const batch=state.codeBatches.find((item)=>item.id===id),item=batch&&product(batch.productId);if(!batch||!item)return toast("生码任务或产品不存在");try{const labels=batch.codes.map((code,index)=>{const serialized=object(code);return `<article class="label">${qrSvg(verificationUrl(serialized))}<div class="label-copy"><b>${escapeHtml(item.name)}</b><span>SKU：${escapeHtml(item.sku)}</span><span>层级：${escapeHtml(batch.level)}${batch.lot?` · 批次：${escapeHtml(batch.lot)}`:""}</span><code>${escapeHtml(code)}</code><small>${index+1} / ${batch.quantity}</small></div></article>`;}).join("");const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReliaCode 二维码标签 · ${escapeHtml(item.name)}</title><style>*{box-sizing:border-box}body{margin:0;color:#111;background:#eee;font:12px/1.35 system-ui,"Microsoft YaHei",sans-serif}.instructions{max-width:190mm;margin:8mm auto;padding:5mm;background:#fff;border:1px solid #bbb}.instructions h1{margin:0 0 2mm;font-size:18px}.instructions p{margin:1mm 0}.sheet{width:190mm;margin:0 auto 8mm;display:grid;grid-template-columns:repeat(3,60mm);gap:3mm;background:#fff}.label{width:60mm;height:34mm;padding:3mm;display:grid;grid-template-columns:26mm 1fr;gap:2.5mm;align-items:center;border:0.2mm solid #bbb;break-inside:avoid;page-break-inside:avoid}.qr{width:25mm;height:25mm;display:block}.label-copy{min-width:0;display:grid;gap:1mm}.label-copy b{font-size:11px}.label-copy span,.label-copy small{font-size:8px;color:#333}.label-copy code{font:7px/1.25 ui-monospace,monospace;overflow-wrap:anywhere}@page{size:A4;margin:10mm}@media print{body{background:#fff}.instructions{display:none}.sheet{width:190mm;margin:0;gap:3mm}.label{border-color:#aaa}}</style></head><body><section class="instructions"><h1>ReliaCode 二维码标签</h1><p>${escapeHtml(item.name)} · ${batch.quantity.toLocaleString()} 枚 · 生成于 ${escapeHtml(localTime(batch.createdAt))}</p><p>打印请选择 100% 实际尺寸，不要使用“适合页面”。二维码打开产品验证地址；下方文字用于人工核对。</p><button onclick="window.print()">打印标签</button></section><main class="sheet">${labels}</main></body></html>`;downloadFile(`reliacode-labels-${batch.id}.html`,html,"text/html;charset=utf-8");batch.status="标签已导出";save();renderCodes();toast(`已导出 ${batch.quantity.toLocaleString()} 枚二维码标签`);}catch(error){toast(`标签导出失败：${error.message}`);}}

function renderMovement() { const rows=state.events.map((event)=>`<div class="movement-table"><div><b>${escapeHtml(event.action)}</b><small class="code">${escapeHtml(event.id)}</small></div><span class="code">${escapeHtml(event.code)}</span><span>${escapeHtml(event.org||"不适用")}</span><span>${escapeHtml(event.result)}</span><time>${escapeHtml(localTime(event.time))}</time></div>`).join("");$("#movement").innerHTML=`<div class="page-heading"><div><span class="section-kicker">产品动向</span><h2>追加式业务事件</h2><p>事件由当前工作区的实际操作产生，不预置任何流转记录。</p></div></div><section class="panel">${state.events.length?`<div class="movement-table table-head"><span>事件</span><span>对象</span><span>组织</span><span>结果</span><span>时间</span></div>${rows}`:emptyState("暂无业务事件","生码、扫码和验证操作会在这里形成记录。")}</section>`; }
function renderVerify() { $("#verify").innerHTML=`<div class="page-heading"><div><span class="section-kicker">扫码验证</span><h2>验证产品身份与流转</h2><p>扫描二维码、验证网址或输入可靠码。</p></div></div><section class="verify-shell"><div class="verify-entry panel"><span class="feature-icon">${icon("search")}</span><h3>扫描或输入可靠码</h3><div class="large-scan-input"><input id="verify-code" autocomplete="off" aria-label="待验证可靠码" placeholder="扫描二维码、粘贴验证网址或可靠码"/><button class="secondary camera-trigger" type="button" data-camera-target="verify-code">${icon("scan")}摄像头</button><button id="verify-submit" class="primary with-icon">${icon("verify")}验证产品</button></div></div><div id="verify-result" class="verify-result panel">${emptyState("等待扫码验证","验证不会改变库存归属或包装关系。")}</div></section>`;$("#verify-submit").onclick=()=>verifyCode();bindCameraButtons(); }
function verifyCode(code=$("#verify-code")?.value) { const identity=scannedIdentity(code),found=object(identity),out=$("#verify-result");if(!found){appendEvent({action:"VERIFY_FAILED",code:identity||"未输入",result:"工作区中未找到该可靠码"});save();out.innerHTML=`<div class="result-status danger-status">${icon("risk")}未识别可靠码</div><h3 class="code">${escapeHtml(identity||"未输入")}</h3><p>该码不属于当前工作区；跨设备公开验证需要连接生产验证 API。</p>`;return false;}const history=state.events.filter((item)=>item.code===found.code).slice(0,6);appendEvent({action:"VERIFY",code:found.code,result:"产品身份有效"});save();out.innerHTML=`<div class="result-status success-status">${icon("check")}产品身份有效</div><h3>${escapeHtml(product(found.productId)?.name)}</h3><p class="code">${escapeHtml(found.code)}</p><div class="verify-facts"><div><small>SKU</small><b>${escapeHtml(product(found.productId)?.sku)}</b></div><div><small>状态</small><b>${escapeHtml(found.status)}</b></div><div><small>当前组织</small><b>${escapeHtml(found.currentOrg)}</b></div><div><small>生产批次</small><b>${escapeHtml(found.lot||"未设置")}</b></div></div>${history.length?`<div class="mini-timeline">${history.map((item)=>`<div><span></span><p><b>${escapeHtml(item.action)}</b><small>${escapeHtml(localTime(item.time))} · ${escapeHtml(item.org)}</small></p></div>`).join("")}</div>`:""}`;return true; }

function bindCameraButtons(){document.querySelectorAll("[data-camera-target]").forEach((button)=>button.onclick=()=>openCamera(button.dataset.cameraTarget));}
async function openCamera(targetId){if(!navigator.mediaDevices?.getUserMedia)return toast("当前浏览器无法访问摄像头，请使用扫码枪或手工输入");closeCamera();const modal=$("#camera-modal"),video=$("#camera-video"),status=$("#camera-status");modal.hidden=false;status.textContent="正在申请摄像头权限…";try{cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});video.srcObject=cameraStream;await video.play();let detector=null;if(typeof BarcodeDetector==="function"){const formats=typeof BarcodeDetector.getSupportedFormats==="function"?await BarcodeDetector.getSupportedFormats():["qr_code"];if(formats.includes("qr_code"))detector=new BarcodeDetector({formats:["qr_code"]});}if(!detector&&typeof jsQR!=="function")throw new Error("二维码识别组件不可用");const canvas=document.createElement("canvas"),context=canvas.getContext("2d",{willReadFrequently:true});status.textContent=detector?"请将二维码放入取景框":"兼容识别模式 · 请保持二维码清晰";const detect=async()=>{if(!cameraStream)return;if(!cameraBusy&&video.readyState>=2){cameraBusy=true;try{let value="";if(detector){value=(await detector.detect(video))[0]?.rawValue||"";}else{const scale=Math.min(1,720/video.videoWidth);canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));context.drawImage(video,0,0,canvas.width,canvas.height);const image=context.getImageData(0,0,canvas.width,canvas.height);value=jsQR(image.data,image.width,image.height,{inversionAttempts:"attemptBoth"})?.data||"";}if(value){const input=document.getElementById(targetId);if(input)input.value=value;closeCamera();if(targetId==="verify-code")verifyCode(value);else if(targetId==="field-code")validateField();return;}}catch(error){status.textContent=`识别失败：${error.message}`;}finally{cameraBusy=false;}}cameraFrame=requestAnimationFrame(detect);};cameraFrame=requestAnimationFrame(detect);}catch(error){closeCamera();toast(`无法启动摄像头：${error.message}`);}}
function closeCamera(){cancelAnimationFrame(cameraFrame);cameraFrame=0;cameraBusy=false;if(cameraStream){cameraStream.getTracks().forEach((track)=>track.stop());cameraStream=null;}const video=$("#camera-video");if(video)video.srcObject=null;const modal=$("#camera-modal");if(modal)modal.hidden=true;}

const workTypes={PACKING:["聚合装箱","FACTORY"],SHIPPING:["发货","FIELD"],RECEIVING_DISTRIBUTOR:["渠道收货","FIELD"],RECEIVING_STORE:["门店收货","FIELD"],SELLING:["销售核验","FIELD"]};
function renderReceive() {
  const current=account(), role=currentRole(), fieldCap=["FACTORY_OPERATOR","DISTRIBUTOR_RECEIVER","STORE_RECEIVER"].includes(role);
  const eventType = current?.eventType || ({FACTORY_OPERATOR:"PACKING",DISTRIBUTOR_RECEIVER:"RECEIVING_DISTRIBUTOR",STORE_RECEIVER:"RECEIVING_STORE"}[role] || "VERIFY");
  const eventLabel = current?.eventLabel || workTypes[eventType]?.[0] || "产品核验";
  $("#receive").innerHTML=`<div class="page-heading"><div><span class="section-kicker">现场作业</span><h2>扫码核验与确认</h2><p>先核验对象和上下文，再确认会改变货权、库存或奖励状态的业务事件。</p></div></div><div class="two-column"><section class="panel field-context-panel"><div class="section-head"><div><h3>固定作业上下文</h3><p>上下文来自当前登录用户所属组织和设备，不支持在页面伪造切换。</p></div></div><dl class="scan-context"><div><dt>组织</dt><dd>${escapeHtml(current?.org||state.workspace?.brandName||"未绑定")}</dd></div><div><dt>地点</dt><dd>${escapeHtml(current?.location||"未绑定")}</dd></div><div><dt>设备</dt><dd>${escapeHtml(current?.deviceId||"当前会话设备")}</dd></div><div><dt>业务单据</dt><dd>${escapeHtml(current?.documentId||"由接口提供")}</dd></div><div><dt>事件类型</dt><dd>${escapeHtml(eventLabel)}</dd></div><div><dt>角色</dt><dd>${escapeHtml(ROLE_LABELS[role]||role)}</dd></div></dl></section><section class="panel"><div class="section-head"><div><h3>当前作业</h3><p>${escapeHtml(current?.org||state.workspace?.brandName||"")} · ${escapeHtml(ROLE_LABELS[role]||role)}</p></div></div>${fieldCap?`<label class="field-label">可靠码<input id="field-code" autocomplete="off" placeholder="扫描二维码、粘贴验证网址或可靠码" /></label><button class="secondary camera-trigger" type="button" data-camera-target="field-code">${icon("scan")}摄像头扫码</button>${eventType==="PACKING"?'<label class="field-label">目标箱码<input id="parent-code" autocomplete="off" placeholder="输入已生成的箱码" /></label>':""}<button id="validate-field" class="primary" type="button">1. 核验${escapeHtml(eventLabel)}</button><div id="field-result" class="scan-result empty">${emptyState("等待扫码","核验通过后仍需再次确认。")}</div>`:emptyState("当前角色没有现场写入能力","请使用组织管理员邀请的现场角色登录。")}</section></div>`;
  if($("#validate-field"))$("#validate-field").onclick=validateField;bindCameraButtons();
}
function validateField(){const current=account(),role=currentRole(),eventType=current?.eventType||({FACTORY_OPERATOR:"PACKING",DISTRIBUTOR_RECEIVER:"RECEIVING_DISTRIBUTOR",STORE_RECEIVER:"RECEIVING_STORE"}[role]||""),eventLabel=current?.eventLabel||workTypes[eventType]?.[0]||"现场作业",identity=scannedIdentity($("#field-code").value),found=object(identity),out=$("#field-result");if(!found)return fieldFailure(identity,"工作区中未找到该可靠码");const code=found.code;let nextStatus=found.status,parentCode=null;if(eventType==="PACKING"){const parent=object($("#parent-code").value);parentCode=parent?.code||null;if(found.level!=="ITEM"||found.status!=="COMMISSIONED")return fieldFailure(code,"只有待装箱单品可以执行聚合装箱");if(!parent||parent.level!=="CASE")return fieldFailure(code,"目标箱码不存在或不是箱码");nextStatus="PACKED";}else if(eventType==="SHIPPING"){if(!["COMMISSIONED","PACKED","RECEIVED"].includes(found.status))return fieldFailure(code,"当前状态不允许发货");nextStatus="IN_TRANSIT";}else if(["RECEIVING_DISTRIBUTOR","RECEIVING_STORE"].includes(eventType)){if(found.status!=="IN_TRANSIT")return fieldFailure(code,"只有运输中的产品可以收货");nextStatus="RECEIVED";}else if(eventType==="SELLING"){if(found.level!=="ITEM"||found.status!=="RECEIVED")return fieldFailure(code,"只有已收货单品可以销售核验");nextStatus="SOLD";}pendingFieldEvent={code,parentCode,nextStatus,accountId:current.id,eventType,eventLabel,documentId:current?.documentId||null};out.innerHTML=`<div class="result-status success-status">${icon("check")}核验通过</div><h3 class="code">${escapeHtml(code)}</h3><p>${escapeHtml(product(found.productId)?.name)} · ${escapeHtml(found.status)} → ${escapeHtml(nextStatus)}</p><button id="confirm-field" class="primary" type="button">2. 确认记录${escapeHtml(eventLabel)}</button>`;$("#confirm-field").onclick=confirmField;}
function fieldFailure(code,reason){state.risks.unshift({id:uuid(),code,status:"待处理",level:"中风险",title:"现场作业校验失败",rule:"状态或对象不满足作业规则",evidence:reason,time:timestamp(),decision:"未处置"});appendEvent({action:"FIELD_REJECTED",code:code||"未输入",result:reason});save();$("#field-result").innerHTML=`<div class="result-status danger-status">${icon("risk")}不可确认</div><p>${escapeHtml(reason)}</p>`;renderRiskBadge();}
function confirmField(){if(!pendingFieldEvent)return;const pending=pendingFieldEvent,current=account();if(current?.id!==pending.accountId)return toast("会话上下文已变化，请重新核验");const found=object(pending.code);if(!found)return toast("对象已不存在");if(pending.eventType==="PACKING"){const parent=object(pending.parentCode);if(!parent)return toast("目标箱码不存在");found.parent=parent.code;if(!parent.children.includes(found.code))parent.children.push(found.code);}found.status=pending.nextStatus;found.currentOrg=current.org;const event=appendEvent({action:pending.eventType,code:found.code,result:`${pending.eventLabel}已确认`});event.documentId=pending.documentId;applyReward(event,found,current);pendingFieldEvent=null;save();renderAll();go("receive");toast(`${pending.eventLabel}已记录`);}

function renderCampaigns(){const cards=state.campaigns.map((item)=>`<article class="campaign-card"><div class="campaign-title"><div><span class="code">${escapeHtml(item.id)}</span><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(workTypes[item.trigger]?.[0]||item.trigger)} · ${item.reward} 积分/对象</p></div>${tag(item.status)}</div><div class="campaign-facts"><div><span>开始</span><b>${escapeHtml(item.startsAt)}</b></div><div><span>结束</span><b>${escapeHtml(item.endsAt)}</b></div><div><span>冻结</span><b>${item.holdDays} 天</b></div><div><span>预算</span><b>${item.used.toLocaleString()} / ${item.budget.toLocaleString()}</b></div></div></article>`).join("");$("#campaigns").innerHTML=`<div class="page-heading"><div><span class="section-kicker">激励运营</span><h2>奖励活动</h2><p>活动只奖励当前工作区后续产生的首次有效事件。</p></div></div><section class="panel"><div class="section-head"><div><h3>创建活动</h3><p>不预置奖励金额或适用范围</p></div></div><form id="campaign-form" class="compact-form"><label>活动名称<input name="name" required maxlength="100" /></label><label>触发事件<select name="trigger"><option value="RECEIVING_DISTRIBUTOR">渠道收货</option><option value="RECEIVING_STORE">门店收货</option><option value="SELLING">销售核验</option></select></label><label>每次积分<input name="reward" type="number" min="1" max="1000000" required /></label><label>总预算积分<input name="budget" type="number" min="1" max="1000000000" required /></label><label>冻结天数<input name="holdDays" type="number" min="0" max="365" required /></label><label>开始日期<input name="startsAt" type="date" required /></label><label>结束日期<input name="endsAt" type="date" required /></label><button class="primary" type="submit">创建并启用活动</button></form></section><section class="panel">${cards||emptyState("暂无奖励活动","创建活动后，符合条件的新事件才会产生奖励。")}</section>`;$("#campaign-form").onsubmit=addCampaign;}
function addCampaign(event){event.preventDefault();const data=new FormData(event.currentTarget),startsAt=String(data.get("startsAt")),endsAt=String(data.get("endsAt")),reward=Number(data.get("reward")),budget=Number(data.get("budget"));if(endsAt<startsAt)return toast("结束日期必须晚于开始日期");if(budget<reward)return toast("总预算不能小于单次奖励");state.campaigns.unshift({id:uuid(),name:String(data.get("name")).trim(),trigger:String(data.get("trigger")),reward,budget,used:0,holdDays:Number(data.get("holdDays")),startsAt,endsAt,status:"进行中",createdAt:timestamp()});save();renderAll();go("campaigns");toast("奖励活动已创建");}
function applyReward(event,found,beneficiary){const date=event.time.slice(0,10),matches=state.campaigns.filter((item)=>item.status==="进行中"&&item.trigger===event.action&&date>=item.startsAt&&date<=item.endsAt&&item.used+item.reward<=item.budget);if(matches.length!==1)return;const campaign=matches[0];if(state.ledger.some((item)=>item.campaignId===campaign.id&&item.code===found.code&&item.amount>0))return;campaign.used+=campaign.reward;state.ledger.unshift({id:uuid(),campaignId:campaign.id,campaign:campaign.name,eventId:event.id,code:found.code,org:beneficiary.org,amount:campaign.reward,status:"冻结中",availableAt:new Date(Date.now()+campaign.holdDays*86400000).toISOString(),time:timestamp()});}
function renderLedger(){const total=(status)=>state.ledger.filter((item)=>item.status===status).reduce((sum,item)=>sum+item.amount,0),rows=state.ledger.map((item)=>`<div class="ledger-row"><div><b class="code">${escapeHtml(item.code)}</b><small>${escapeHtml(item.org)}</small></div><div><b>${escapeHtml(item.campaign)}</b><small class="code">${escapeHtml(item.eventId)}</small></div>${tag(item.status)}<strong>${item.amount>0?"+":""}${item.amount} 积分</strong><time>${escapeHtml(localTime(item.time))}</time></div>`).join("");$("#ledger").innerHTML=`<div class="page-heading"><div><span class="section-kicker">激励账务</span><h2>奖励账本</h2><p>只展示实际事件产生的追加式本地分录。</p></div></div><div class="metric-strip">${metric("冻结中",total("冻结中"),"等待释放","clock","ledger")}${metric("可结算",total("可结算"),"尚未接入真实支付","ledger","ledger")}${metric("已冲正",Math.abs(total("已冲正")),"保留反向来源","risk","ledger")}</div><section class="panel">${rows?`<div class="ledger-row table-head"><span>对象</span><span>活动/事件</span><span>状态</span><span>金额</span><span>时间</span></div>${rows}`:emptyState("暂无账本分录","创建奖励活动并完成符合条件的扫码事件后产生。")}</section>`;}
function renderRiskBadge(){const badge=$("#risk-badge");if(badge)badge.textContent=state.risks.filter((item)=>item.status==="待处理").length;}
function renderRisk(){const rows=state.risks.map((item)=>`<article class="risk"><div><div>${tag(item.level)} ${tag(item.status)} <b>${escapeHtml(item.title)}</b></div><p><span class="code">${escapeHtml(item.code)}</span> · ${escapeHtml(item.rule)}</p><p class="muted">${escapeHtml(item.evidence)} · ${escapeHtml(localTime(item.time))}</p></div>${item.status==="待处理"?`<div class="risk-actions"><button class="secondary" data-risk="${item.id}" data-action="已关闭">关闭</button><button class="secondary danger" data-risk="${item.id}" data-action="已拒绝">拒绝本次作业</button></div>`:""}</article>`).join("");$("#risk").innerHTML=`<div class="page-heading"><div><span class="section-kicker">风险治理</span><h2>扫码风险处置</h2><p>风险仅由当前工作区真实失败作业产生。</p></div></div><section class="panel">${rows||emptyState("暂无风险事件","异常或不满足状态的扫码会进入这里。")}</section>`;document.querySelectorAll("[data-risk]").forEach((button)=>button.onclick=()=>{const item=state.risks.find((risk)=>risk.id===button.dataset.risk);if(!item)return;item.status=button.dataset.action;item.decision=`${account().name} · ${localTime()}`;save();renderAll();go("risk");});}

function exportWorkspace(){state.workspace.lastExportAt=timestamp();save();downloadFile(`reliacode-workspace-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(state,null,2),"application/json");toast("工作区备份已导出");}
async function importWorkspace(event){const file=event.target.files?.[0];if(!file)return;try{const value=JSON.parse(await file.text());if(!workspacePayloadValid(value))throw new Error("文件结构不符合 ReliaCode 工作区格式");if(!confirm(`导入“${value.workspace.brandName}”并覆盖当前工作区？`))return;state=value;save();if(!persistentWorkspace){location.reload();return;}const persisted=await persistNow();if(persisted&&!saveDirty){localStorage.removeItem(STORAGE_KEY);location.reload();}else showPersistenceStatus("导入数据尚未保存到服务器，页面未刷新。请检查网络后重试。");}catch(error){toast(`导入失败：${error.message}`);}finally{event.target.value="";}}
function clearWorkspace(){if(!confirm("这会清除当前浏览器中的全部产品、可靠码、事件、活动、账本和账号。请先导出备份。确定继续？"))return;if(!confirm("再次确认：清除后无法撤销。"))return;localStorage.removeItem(STORAGE_KEY);location.reload();}

const titles={dashboard:["运营总览","品牌管理 / 运营总览"],codes:["产品与批量生码","品牌管理 / 产品与批量生码"],movement:["产品动向","品牌管理 / 产品动向"],verify:["扫码验证","产品核验 / 扫码验证"],receive:["业务扫码","现场作业 / 业务扫码"],campaigns:["奖励活动","激励与治理 / 奖励活动"],ledger:["奖励账本","激励与治理 / 奖励账本"],risk:["风险处置","激励与治理 / 风险处置"]};
function go(view){const button=document.querySelector(`[data-view="${view}"]`);if(!button||button.hidden)return;document.querySelectorAll(".nav-link,.view").forEach((node)=>node.classList.remove("active"));button.classList.add("active");$("#"+view).classList.add("active");$("#page-title").textContent=titles[view][0];$("#breadcrumb").textContent=titles[view][1];}
function renderAll(){
  renderOnboarding();
  if(!state.initialized)return;
  const role=currentRole(), previousView=$(".view.active")?.id||$(".nav-link.active")?.dataset.view||null;
  const roleChanged=lastRenderedRole===null||lastRenderedRole!==role;
  renderDashboard();renderCodes();renderMovement();renderVerify();renderReceive();renderCampaigns();renderLedger();renderRisk();renderAccountOptions();updateChrome();renderAgent();
  const preferred=ROLE_DEFAULT_VIEW[role]||"dashboard";
  const currentButton=previousView&&document.querySelector(`[data-view="${previousView}"]`);
  const target=roleChanged||!currentButton||currentButton.hidden?preferred:previousView;
  if(document.querySelector(`[data-view="${target}"]`)?.hidden){
    const firstVisible=[...document.querySelectorAll(".nav-link")].find((button)=>!button.hidden);
    if(firstVisible)go(firstVisible.dataset.view);
  } else go(target);
  lastRenderedRole=role;
  if(pendingDeepLink){const value=pendingDeepLink;pendingDeepLink=null;history.replaceState({},"",location.pathname);go("verify");$("#verify-code").value=value;verifyCode(value);}
}

function openAgent(){agentReturnFocus=document.activeElement;const drawer=$("#agent-drawer");drawer.hidden=false;drawer.inert=false;requestAnimationFrame(()=>drawer.classList.add("open"));$("#agent-backdrop").hidden=false;renderAgent();$("#agent-command").focus();}
function closeAgent(){const drawer=$("#agent-drawer");drawer.classList.remove("open");drawer.inert=true;$("#agent-backdrop").hidden=true;agentReturnFocus?.focus();}
function renderAgent(){const current=account();if(!current)return;$("#agent-mark").innerHTML=icon("agent");$("#agent-close").innerHTML=icon("close");$("#agent-send").innerHTML=icon("send");$("#agent-context").innerHTML=`<span>${icon("user")}${escapeHtml(current.org)} · ${escapeHtml(current.role)}</span><span>${icon("lock")}权限不高于当前账号</span>`;$("#agent-messages").innerHTML=state.agentRuns.slice(0,8).map((run)=>`<div class="agent-message agent"><div>${icon("agent")}</div><p>${escapeHtml(run.result)}<time>${escapeHtml(localTime(run.time))}</time></p></div>`).join("")||`<div class="agent-message agent"><div>${icon("agent")}</div><p>我可以打开页面、验证可靠码、生成码、导出二维码标签或备份，并记录每次执行。涉及写入时会先请求确认。</p></div>`;$("#agent-quick-actions").innerHTML=["打开产品与批量生码","打开扫码验证","导出最新一批二维码标签","导出工作区备份"].map((text)=>`<button type="button">${text}</button>`).join("");$("#agent-quick-actions").querySelectorAll("button").forEach((button)=>button.onclick=()=>executeAgent(button.textContent));}
function executeAgent(command){
  const text=String(command||"").trim(); if(!text)return;
  let result="无法识别该操作。你可以要求打开页面、验证可靠码、生成码或导出备份。";
  const navigation=[[/动向|事件/,"movement"],[/产品|生码/,"codes"],[/验证/,"verify"],[/扫码|收货|装箱|发货|销售/,"receive"],[/活动/,"campaigns"],[/账本/,"ledger"],[/风险/,"risk"]].find(([pattern])=>pattern.test(text));
  const code=text.match(/RC-[A-Z0-9-]{6,}/i)?.[0]?.toUpperCase();
  if(/导出.*(二维码|标签)/.test(text)){const selected=state.products.find((item)=>text.includes(item.sku)||text.includes(item.name)),batch=state.codeBatches.find((item)=>!selected||item.productId===selected.id);if(!batch)result="尚无可导出的生码任务。";else{exportQrLabels(batch.id);result=`已导出 ${batch.quantity.toLocaleString()} 枚二维码标签。`;}}
  else if(/导出.*(工作区|备份|数据)/.test(text)){exportWorkspace();result="工作区备份已导出。";}
  else if(/验证/.test(text)&&code){go("verify");$("#verify-code").value=code;verifyCode(code);result=`已验证 ${code}，结果显示在扫码验证页。`;}
  else if(/生成/.test(text)){
    const quantity=Number(text.match(/(\d+)/)?.[1]||0),selected=state.products.find((item)=>text.includes(item.sku)||text.includes(item.name));
    if(!selected)result="请在指令中写明已存在的产品名称或 SKU。";
    else if(!quantity||quantity>5000)result="数量必须为 1–5,000。";
    else if(confirm(`为 ${selected.name} 生成 ${quantity} 枚单品码？`)){createBatch({productId:selected.id,level:"ITEM",quantity});renderAll();go("codes");result="生码任务已执行。";}
    else result="已取消生码任务。";
  }
  else if(navigation){go(navigation[1]);result=`已打开${titles[navigation[1]][0]}。`;}
  state.agentRuns.unshift({id:uuid(),command:text,result,time:timestamp(),accountId:account().id});save();renderAgent();
}

document.addEventListener("click",(event)=>{const target=event.target.closest("[data-go]");if(target)go(target.dataset.go);});
document.querySelectorAll(".nav-link").forEach((button)=>button.onclick=()=>go(button.dataset.view));
$("#agent-toggle").onclick=openAgent;$("#agent-close").onclick=closeAgent;$("#agent-backdrop").onclick=closeAgent;$("#agent-drawer").inert=true;$("#agent-form").onsubmit=(event)=>{event.preventDefault();executeAgent($("#agent-command").value);$("#agent-command").value="";};$("#reset").onclick=clearWorkspace;$("#camera-close").innerHTML=icon("close");$("#camera-close").onclick=closeCamera;
document.addEventListener("keydown",(event)=>{if(event.key==="Escape"&&!$("#camera-modal").hidden)closeCamera();else if(event.key==="Escape"&&$("#agent-drawer").classList.contains("open"))closeAgent();});
async function loadServerWorkspace({allowMigration=false}={}){try{const result=parseWorkspaceResponse(await serverRequest('/api/v1/workspace'),{allowUninitialized:true});const pending=persistenceQueue?.status?.dirty?pendingState():null;state=pending||result.workspace;serverVersion=result.version;}catch(error){if(error.status!==404)throw error;if(allowMigration&&state?.initialized&&confirm('Migrate local workspace to server?')){saveDirty=true;saveRevision+=1;saveRetryAttempt=0;const migrated=await persistNow();if(!migrated||saveDirty)return;localStorage.removeItem(STORAGE_KEY);location.reload();return;}state=cloneEmpty();serverVersion=0;}}
async function loadDomainState(user){
  const available=new Set(user?.capabilities||[]),requests=[];
  requests.push(available.has('objects:read')?serverRequest('/api/v1/products?limit=200'):Promise.resolve({items:[]}));
  requests.push(available.has('codes:write')?serverRequest('/api/v1/code-jobs'):Promise.resolve({items:[]}));
  requests.push(available.has('platform:tenants:read')?serverRequest('/api/v1/platform/tenant-applications?limit=200'):Promise.resolve({items:[]}));
  const [productsResult,jobsResult,applicationsResult]=await Promise.all(requests);
  state={...cloneEmpty(),initialized:true,workspace:{id:user.tenantId||uuid(),brandName:user.organizationName||'ReliaCode 平台运营',createdAt:timestamp()},accounts:[],currentAccountId:user.id,
    products:(productsResult.items||[]).map(item=>({id:item.id,name:item.name,sku:item.sku,gtin:item.gtin||'',status:item.status,createdAt:item.created_at})),
    codeBatches:(jobsResult.items||[]).map(item=>({id:item.id,productId:item.product_id,level:item.level,lot:item.lot||'',quantity:Number(item.quantity),generatedCount:Number(item.generated_count||0),codes:[],firstCode:'—',lastCode:'—',status:item.status,createdAt:item.created_at})),platformApplications:applicationsResult.items||[],objects:{},events:[],campaigns:[],ledger:[],risks:[],agentRuns:[]};
  ensureSessionAccount(user);localStorage.removeItem(STORAGE_KEY);
}
const localClearWorkspace=clearWorkspace;clearWorkspace=async function(){if(!persistentWorkspace)return localClearWorkspace();if(!confirm('Reset the server workspace? Export a local backup first.'))return;try{const result=await serverRequest('/api/v1/workspace/reset',{method:'POST',headers:{'X-CSRF-Token':csrfToken}});if(result.workspace){const parsed=parseWorkspaceResponse(result,{allowUninitialized:true});state=parsed.workspace;serverVersion=parsed.version;}localStorage.removeItem(STORAGE_KEY);location.reload();}catch(error){showPersistenceStatus(error.status===404?'Server reset is not available; nothing was cleared.':'Server reset failed; nothing was cleared.');}};$('#reset').onclick=clearWorkspace;
const originalToast=toast;toast=(message)=>{if(String(message).includes('Workspace changed')){saveDirty=true;saveConflict={status:409};showPersistenceStatus('Workspace conflict: local changes are not saved.',[{label:'Reload server',onClick:async()=>{if(saveDirty&&!confirm('Discard unsynced local changes? Export first if needed.'))return;try{const result=parseWorkspaceResponse(await serverRequest('/api/v1/workspace'),{allowUninitialized:true});const pending=persistenceQueue?.status?.dirty?pendingState():null;state=pending||result.workspace;serverVersion=result.version;saveDirty=false;saveConflict=null;clearPersistenceStatus();renderAll();}catch(error){originalToast(error.message);}}},{label:'Export local copy',onClick:()=>exportWorkspaceSnapshot()}]);return;}originalToast(message);};
async function loadPublicVerification(publicId,target,token){
  const out=target||$('#public-verification-result');
  const isCurrent=()=>Boolean(out&&out.isConnected&&out===$('#public-verification-result')&&(token===undefined||token===publicLoadToken));
  if(!isCurrent())return;
  if(!sameOriginApiAvailable){out.textContent="尚未连接生产验证服务";return;}
  if(!/^[0-9a-f-]{36}$/i.test(publicId)){if(isCurrent())out.textContent='Verification address is invalid';return;}
  try{
    const response=await fetch(apiUrl('/api/public/v1/objects/'+encodeURIComponent(publicId)),{headers:{Accept:'application/json'}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.message||'Verification service is unavailable');
    if(!isCurrent())return;
    out.innerHTML='<div class="result-status success-status">'+icon('check')+' Verified</div><h2>'+escapeHtml(body.product?.name||'Product')+'</h2>';
  }catch(error){if(isCurrent())out.textContent='Verification unavailable: '+error.message;}
}
if(pendingDeepLink)renderOnboarding();else if(!hostedApi)renderAll();
async function bootstrap() { if (!hostedApi) { if (state.initialized) ensureSessionAccount(account()); renderAll(); return; } try { const session=await serverRequest('/api/auth/session'); csrfToken=session.csrfToken; sessionUser=session.user;if(domainApi)await loadDomainState(session.user);else{await loadServerWorkspace({allowMigration:session.user?.id==='local-admin'});ensureSessionAccount(session.user);}serverReady=true;renderAll(); } catch (error) { showLogin(); } }
function showLogin() {
  if(pendingDeepLink)return;
  const overlay=$('#onboarding')||document.body.appendChild(Object.assign(document.createElement('div'),{id:'onboarding',className:'onboarding'}));
  overlay.hidden=false;
  const renderAuth=(mode='login')=>{
    const registering=mode==='register';
    if(registering&&domainApi){overlay.innerHTML=`<form id="tenant-application" class="onboarding-card auth-card"><div class="onboarding-brand">${icon('logo')}<div><b>ReliaCode 可靠码</b><small>企业租户人工审核</small></div></div><div class="auth-tabs"><button type="button" data-auth-mode="login">登录</button><button type="button" class="active">申请开通</button></div><h1>申请企业租户</h1><p>合同与付款在线下完成。平台运营审核通过后，将通过受控渠道交付首位租户所有者账号。</p><label>企业名称<input name="companyName" required maxlength="160" autocomplete="organization" /></label><label>联系人<input name="contactName" required maxlength="100" autocomplete="name" /></label><label>联系邮箱<input name="contactEmail" type="email" required maxlength="254" autocomplete="email" /></label><label>联系电话（可选）<input name="contactPhone" maxlength="40" autocomplete="tel" /></label><label>预计每月生码量<input name="expectedMonthlyCodes" type="number" min="0" max="100000000" value="10000" /></label><button class="primary" type="submit">提交审核申请</button><p id="login-error" class="auth-error" role="alert"></p></form>`;overlay.querySelector('[data-auth-mode="login"]').onclick=()=>renderAuth('login');$('#tenant-application').onsubmit=async event=>{event.preventDefault();const data=new FormData(event.currentTarget);try{await serverRequest('/api/v1/tenant-applications',{method:'POST',body:JSON.stringify({companyName:String(data.get('companyName')).trim(),contactName:String(data.get('contactName')).trim(),contactEmail:String(data.get('contactEmail')).trim(),contactPhone:String(data.get('contactPhone')).trim()||undefined,expectedMonthlyCodes:Number(data.get('expectedMonthlyCodes'))})});event.currentTarget.innerHTML='<h1>申请已提交</h1><p>平台运营人员审核后会通过已登记的联系渠道与你确认合同、套餐和账号交付。</p><button id="return-login" class="secondary" type="button">返回登录</button>';$('#return-login').onclick=()=>renderAuth('login');}catch(error){$('#login-error').textContent=error.message;}};return;}
    overlay.innerHTML=`<form id="server-auth" class="onboarding-card auth-card"><div class="onboarding-brand">${icon('logo')}<div><b>ReliaCode 可靠码</b><small>组织工作区与成员权限</small></div></div><div class="auth-tabs" role="tablist"><button type="button" data-auth-mode="login" class="${registering?'':'active'}">登录</button><button type="button" data-auth-mode="register" class="${registering?'active':''}">注册</button></div><h1>${registering?'创建账号':'欢迎回来'}</h1>${registering?'<div class="registration-purpose" role="group" aria-label="注册目的"><button type="button" class="purpose-card active" data-purpose="create"><strong>创建品牌组织</strong><span>公开注册，成为品牌管理员</span></button><button type="button" class="purpose-card" data-purpose="invite"><strong>接受组织邀请</strong><span>需要管理员提供邀请链接或邀请码</span></button></div>':''}<p id="auth-description">${registering?'注册将创建一个新的品牌组织并成为其管理员。':'优先使用 Passkey 登录；作业员可按租户策略使用密码。'}</p><label>用户名或邮箱<input name="username" required minlength="${registering?3:1}" maxlength="254" autocomplete="username webauthn" placeholder="用户名或邮箱" /></label>${registering?'<label>邮箱<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="name@example.com" /></label>':''}<label>密码<input name="password" type="password" ${registering?'required':''} minlength="${registering?10:1}" maxlength="200" autocomplete="${registering?'new-password':'current-password'}" placeholder="${registering?'至少 10 位，包含字母和数字':'作业员密码或恢复登录'}" /></label>${registering?'<label>确认密码<input name="confirmPassword" type="password" required minlength="10" maxlength="200" autocomplete="new-password" placeholder="再次输入密码" /></label><label id="invite-code-field" hidden>邀请码<input name="inviteCode" maxlength="160" autocomplete="one-time-code" placeholder="粘贴组织管理员发来的邀请码" /></label>':''}<button class="primary" type="submit">${registering?'创建品牌组织':'密码登录'}</button>${!registering&&domainApi?'<button id="passkey-login" class="secondary" type="button">使用 Passkey 登录</button>':''}<p id="login-error" class="auth-error" role="alert"></p><p class="auth-note">Passkey 是管理员主要登录与敏感操作凭据；恢复码请离线保存。</p></form>`;
    overlay.querySelectorAll('[data-auth-mode]').forEach((button)=>button.onclick=()=>renderAuth(button.dataset.authMode));
    if(registering){overlay.querySelectorAll('[data-purpose]').forEach((button)=>button.onclick=()=>{const invite=button.dataset.purpose==='invite';overlay.querySelectorAll('[data-purpose]').forEach((item)=>item.classList.toggle('active',item===button));$('#invite-code-field').hidden=!invite;$('#auth-description').textContent=invite?'输入组织管理员提供的邀请码，加入其组织并获得对应角色。':'注册将创建一个新的品牌组织并成为其管理员。';$('#server-auth button[type="submit"]').textContent=invite?'接受邀请':'创建品牌组织';});}
    if($('#passkey-login'))$('#passkey-login').onclick=async()=>{try{const username=String(new FormData($('#server-auth')).get('username')).trim();if(!username)throw new Error('请输入用户名或邮箱');const result=await loginWithPasskey(username);csrfToken=result.csrfToken;sessionUser=result.user;await loadDomainState(result.user);serverReady=true;renderAll();}catch(error){$('#login-error').textContent=error.message;}};
    $('#server-auth').onsubmit=async(event)=>{
      event.preventDefault();const data=new FormData(event.currentTarget);const password=String(data.get('password'));
      if(registering&&password!==String(data.get('confirmPassword'))){$('#login-error').textContent='两次输入的密码不一致';return;}
      const invite=registering&&event.currentTarget.querySelector('[data-purpose].active')?.dataset.purpose==='invite';
      const payload=invite?{token:String(data.get('inviteCode')).trim(),username:String(data.get('username')).trim(),email:String(data.get('email')).trim(),password}:{username:String(data.get('username')).trim(),password};
      if(registering&&!invite)payload.email=String(data.get('email')).trim();
      if(invite&&!payload.token){$('#login-error').textContent='请输入组织邀请码';return;}
      try{const result=await serverRequest(invite?'/api/auth/invitations/accept':(registering?'/api/auth/register':'/api/auth/login'),{method:'POST',body:JSON.stringify(payload)});csrfToken=result.csrfToken;sessionUser=result.user;if(registering){localStorage.removeItem(STORAGE_KEY);state=cloneEmpty();}if(domainApi)await loadDomainState(result.user);else{await loadServerWorkspace({allowMigration:!invite&&!registering&&result.user?.id==='local-admin'});ensureSessionAccount(result.user);}serverReady=true;renderAll();}
      catch(error){$('#login-error').textContent=error.message||(registering?'注册失败':'登录失败');}
    };
  };
  renderAuth('login');
}
startPersistenceQueue();
bootstrap();

const seed = {
  org: { name: "上海虹桥宠物生活馆", role: "门店收货员" },
  shipment: { id: "RC-SH-20260818-01", from: "华东宠物供应链中心", to: "上海虹桥宠物生活馆", dispatchedAt: "2026-08-24 09:10", expected: 3, received: 0, status: "运输中" },
  cartons: {
    "RC-CTN-202608-00101": { sku: "全价成猫粮 2kg", batch: "CAT-20260818-A", units: 5, status: "运输中", rewarded: false },
    "RC-CTN-202608-00102": { sku: "全价成猫粮 2kg", batch: "CAT-20260818-A", units: 5, status: "运输中", rewarded: false },
    "RC-CTN-202608-00103": { sku: "全价成猫粮 2kg", batch: "CAT-20260818-A", units: 5, status: "运输中", rewarded: false },
    "RC-CTN-202608-00092": { sku: "全价幼猫粮 1.5kg", batch: "KIT-20260818-B", units: 6, status: "异常待核验", rewarded: false }
  },
  campaigns: [{ id: "CMP-202608-HUADONG-01", name: "华东签约门店首次有效收货", scope: "上海/江苏签约门店 · 全价成猫粮 2kg", beneficiary: "门店主体", trigger: "匹配发货单的首次箱级收货", reward: 500, monthly: 5000, budget: 180000, used: 12500, hold: 7, cycle: "自然月结算", period: "2026-08-20 至 2026-09-30", startsAt: "2026-08-20", endsAt: "2026-09-30", sku: "全价成猫粮 2kg", status: "进行中", version: "v1.0", owner: "可靠码运营组" }],
  ledger: [
    { code: "RC-CTN-202608-00081", org: "杭州湖滨宠物门店", campaign: "华东签约门店首次有效收货", amount: 500, status: "冻结中", time: "2026-08-24 10:24", event: "TRACE-240824-081" },
    { code: "RC-CTN-202608-00074", org: "上海虹桥宠物生活馆", campaign: "华东签约门店首次有效收货", amount: 500, status: "可结算", time: "2026-08-23 16:08", event: "TRACE-240823-074" },
    { code: "RC-CTN-202608-00066", org: "南京宠物之家", campaign: "华东签约门店首次有效收货", amount: -500, status: "已冲正", time: "2026-08-22 13:31", event: "TRACE-240822-066" }
  ],
  events: [
    { id: "TRACE-240824-081", type: "收货确认", code: "RC-CTN-202608-00081", actor: "杭州湖滨宠物门店", time: "2026-08-24 10:24", result: "奖励冻结 500 积分" },
    { id: "TRACE-240824-092-CHECK", type: "收货待核验", code: "RC-CTN-202608-00092", actor: "上海虹桥宠物生活馆", time: "2026-08-24 10:42", result: "命中跨组织重复扫码规则，等待风控处置" },
    { id: "TRACE-240824-SHIP", type: "发货", code: "RC-SH-20260818-01", actor: "华东宠物供应链中心", time: "2026-08-24 09:10", result: "发往上海虹桥宠物生活馆" }
  ],
  risks: [
    { id: 1, title: "同一箱码在两家门店被扫描", code: "RC-CTN-202608-00092", rule: "跨组织重复扫码", level: "高风险", status: "待处理", amount: 500, time: "2026-08-24 10:42", evidence: "原目的地为上海虹桥宠物生活馆；第二次扫描来自苏州金鸡湖店。", event: "TRACE-240824-092-CHECK", decision: "未处置" },
    { id: 2, title: "收货早于关联发货事件", code: "RC-CTN-202608-00097", rule: "事件顺序异常", level: "中风险", status: "待处理", amount: 500, time: "2026-08-24 09:52", evidence: "收货时间早于发货单出库时间 42 分钟。", event: "TRACE-240824-097-CHECK", decision: "未处置" }
  ]
};

let state = JSON.parse(localStorage.getItem("reliacode-mvp") || "null") || structuredClone(seed);
const $ = (s) => document.querySelector(s);
const escape = (v) => String(v).replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const now = () => new Date().toLocaleString("zh-CN");
const save = () => localStorage.setItem("reliacode-mvp", JSON.stringify(state));
const sum = (status) => state.ledger.filter((x) => x.status === status).reduce((n, x) => n + x.amount, 0);
const tag = (value) => `<span class="tag ${/高风险|已拒绝/.test(value)?"red":/冻结|待处理|中风险|继续观察/.test(value)?"amber":/进行中|运输/.test(value)?"blue":"green"}">${escape(value)}</span>`;
const money = (value) => `${value > 0 ? "+" : ""}${value.toLocaleString()} 积分`;
const eventId = (suffix = "") => `TRACE-${Date.now().toString().slice(-8)}${suffix}`;
const demoDate = "2026-08-24";
function evaluateCampaign(carton) {
  const campaign = state.campaigns.find((item) => item.status === "进行中");
  if (!campaign) return { eligible:false, reason:"没有进行中的奖励活动" };
  if (demoDate < campaign.startsAt || demoDate > campaign.endsAt) return { eligible:false, reason:"活动未在当前演示日期生效" };
  if (campaign.sku !== carton.sku) return { eligible:false, reason:"商品不在活动范围" };
  if (campaign.used + campaign.reward > campaign.budget) return { eligible:false, reason:"活动预算已用尽" };
  const monthAwarded = state.ledger.filter((entry) => entry.org === state.org.name && entry.campaign === campaign.name && entry.amount > 0).reduce((total, entry) => total + entry.amount, 0);
  if (monthAwarded + campaign.reward > campaign.monthly) return { eligible:false, reason:"本门店已达到月度奖励上限" };
  return { eligible:true, campaign, amount:campaign.reward, reason:`活动 ${campaign.id} ${campaign.version}` };
}

function toast(message) { const t = $("#toast"); t.textContent = message; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2400); }
function updateChrome() { $("#risk-badge").textContent = state.risks.filter((x) => x.status === "待处理").length; $("#updated-at").textContent = `数据更新于 ${new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}`; }
function go(view) { document.querySelector(`[data-view="${view}"]`).click(); }

function renderDashboard() {
  const today = state.events.filter((x) => x.type === "收货确认").length;
  const pending = state.risks.filter((x) => x.status === "待处理").length;
  const events = state.events.slice(0, 4).map((x) => `<div class="activity"><div class="activity-icon">${x.type==="收货确认"?"✓":x.type==="发货"?"➜":"!"}</div><div><p><b>${escape(x.type)}</b> · <span class="code">${escape(x.code)}</span></p><small>${escape(x.actor)} · ${escape(x.time)} · ${escape(x.result)}</small></div></div>`).join("");
  $("#dashboard").innerHTML = `<div class="page-lead"><div><p class="eyebrow">工作台 · 当前组织：${escape(state.org.name)}</p><h2>今天需要处理的流转与奖励</h2><p>所有数字均由本浏览器中的发货、收货、奖励和风控记录计算。</p></div><button class="primary" data-go="receive">开始收货扫码</button></div><div class="metrics"><button class="card metric metric-button" data-go="receive"><span>今日有效收货</span><strong>${today}</strong><small>查看待收货发货单</small></button><button class="card metric metric-button" data-go="risk"><span>待处理风险</span><strong>${pending}</strong><small>需要核验，不会即时发奖</small></button><button class="card metric metric-button" data-go="ledger"><span>冻结奖励</span><strong>${sum("冻结中").toLocaleString()}</strong><small>到期后按规则释放</small></button><button class="card metric metric-button" data-go="ledger"><span>待结算余额</span><strong>${sum("可结算").toLocaleString()}</strong><small>下个自然月结算批次</small></button></div><div class="grid-two"><div class="panel"><h2>最近业务事实</h2><p class="sub">追溯事件与奖励判断分开保存。</p>${events}</div><div class="panel"><h2>当前待办</h2><p class="sub">按业务影响排序。</p><div class="activity"><div class="activity-icon">!</div><div><p><b>${pending} 笔风险待核验</b></p><small>处置结果只影响奖励，不修改原始扫描事实。</small></div></div><div class="activity"><div class="activity-icon">$</div><div><p><b>${sum("冻结中")} 积分处于冻结</b></p><small>最早一笔将按活动规则进入可结算。</small></div></div><button class="secondary" data-go="risk">处理风险队列</button></div></div>`;
}
function shipmentPanel() { const s = state.shipment; return `<div class="context-card"><div><span>发货单</span><b class="code">${s.id}</b></div><div><span>流转路径</span><b>${s.from} → ${s.to}</b></div><div><span>箱数进度</span><b>${s.received} / ${s.expected} 箱</b></div><div><span>发货时间</span><b>${s.dispatchedAt}</b></div>${tag(s.status)}</div>`; }
function renderReceive() {
  const c = state.campaigns[0];
  $("#receive").innerHTML = `<div class="page-lead"><div><p class="eyebrow">收货工作台</p><h2>确认到货，再判断是否计奖</h2><p>选定发货单后扫描箱码。箱内单品关系、收货组织与活动规则会一并校验。</p></div></div>${shipmentPanel()}<div class="receive-grid"><div class="panel"><h2>扫描并核验</h2><p class="sub">箱码输入后会显示商品、批次、单品数量和奖励判断。</p><label class="field-label" for="scan-code">可靠码</label><div class="scanner"><div class="scan-row"><input id="scan-code" value="RC-CTN-202608-00101" aria-label="可靠码"/><button class="primary" id="scan-submit">验证并确认收货</button></div><p class="hint">正常：RC-CTN-202608-00101 · 风险：RC-CTN-202608-00092</p></div><div id="scan-result" class="scan-result empty" aria-live="polite">尚未扫描。请扫描本张发货单中的箱码。</div></div><div class="panel"><h2>本次计奖规则</h2><p class="sub">${escape(c.id)} · ${escape(c.version)}</p><dl class="rule-list"><div><dt>触发条件</dt><dd>${escape(c.trigger)}</dd></div><div><dt>计奖方式</dt><dd>每个有效箱 ${c.reward} 积分；箱袋互斥</dd></div><div><dt>冻结与结算</dt><dd>${c.hold} 天冻结，${escape(c.cycle)}</dd></div><div><dt>异常策略</dt><dd>命中风险时进入待处理，不创建正向账本分录</dd></div></dl></div></div>`;
  $("#scan-submit").onclick = scan;
}
function createReceipt(code, carton, id, reason, assessment = evaluateCampaign(carton)) {
  if (carton.status !== "已收货") { carton.status = "已收货"; carton.rewarded = true; state.shipment.received += 1; state.shipment.status = state.shipment.received === state.shipment.expected ? "已收货" : "部分收货"; }
  state.events.unshift({id, type:"收货确认", code, actor:state.org.name, time:now(), result:`${carton.sku} · ${carton.units} 袋 · ${reason} · ${assessment.eligible ? `冻结 ${assessment.amount} 积分` : `本次不计奖：${assessment.reason}`}`});
  if (assessment.eligible) { assessment.campaign.used += assessment.amount; state.ledger.unshift({code, org:state.org.name, campaign:assessment.campaign.name, amount:assessment.amount, status:"冻结中", time:now(), event:id}); }
  return assessment;
}
function scan() {
  const code = $("#scan-code").value.trim().toUpperCase(), out = $("#scan-result"), carton = state.cartons[code];
  if (!code) return toast("请输入可靠码");
  if (!carton) { out.className="scan-result result-error"; out.innerHTML=`<b>无法确认收货</b><p>该码不在发货单 <span class="code">${state.shipment.id}</span> 中。请检查混箱、错货或发货单选择。</p>`; return; }
  if (code === "RC-CTN-202608-00092") {
    const risk = state.risks.find((x) => x.code === code && x.rule === "跨组织重复扫码");
    if (!risk) { const id = eventId("-CHECK"); state.events.unshift({id,type:"收货待核验",code,actor:state.org.name,time:now(),result:"命中跨组织重复扫码规则，奖励待风控处置"}); state.risks.unshift({id:Date.now(),title:"扫码命中跨组织重复风险",code,rule:"跨组织重复扫码",level:"高风险",status:"待处理",amount:state.campaigns[0].reward,time:now(),evidence:"该箱已有其他组织的收货核验记录。",event:id,decision:"未处置"}); }
    save(); renderDashboard(); renderRisk(); updateChrome(); out.className="scan-result result-warning"; out.innerHTML=`<b>已记录核验，暂不计奖</b><p>${carton.sku} · 批次 ${carton.batch} · ${carton.units} 袋。命中“跨组织重复扫码”规则，已转入风控队列。</p>`; return toast(risk ? "该风险已在风控队列中，未重复创建" : "风险已进入待处理队列");
  }
  if (carton.status === "已收货") { out.className="scan-result result-warning"; out.innerHTML=`<b>该箱已完成首次有效收货</b><p><span class="code">${code}</span> 已收货，不会新增奖励；可在账本查看来源事件。</p>`; return toast("重复收货已拦截"); }
  const id = eventId(), assessment = createReceipt(code, carton, id, "首次有效收货"); save(); renderDashboard(); renderLedger(); updateChrome(); out.className="scan-result result-success"; out.innerHTML=`<b>收货确认成功 ${assessment.eligible ? tag("冻结中") : tag("不计奖")}</b><p>${carton.sku} · 批次 ${carton.batch} · 已确认 ${carton.units} 袋。</p><p>追溯事件 <span class="code">${id}</span>；${assessment.eligible ? `奖励 +${assessment.amount} 积分，冻结 ${assessment.campaign.hold} 天后进入结算。` : `本次不计奖：${assessment.reason}。`}</p>`; toast(assessment.eligible ? "已确认收货并创建冻结奖励" : "已确认收货，本次不计奖");
}
function renderCampaigns() {
  const list = state.campaigns.map((c) => `<article class="campaign-card"><div class="campaign-title"><div><span class="code">${escape(c.id)} · ${escape(c.version)}</span><h3>${escape(c.name)}</h3><p>${escape(c.scope)}</p></div>${tag(c.status)}</div><div class="campaign-facts"><div><span>奖励对象</span><b>${escape(c.beneficiary)}</b></div><div><span>触发事件</span><b>${escape(c.trigger)}</b></div><div><span>奖励规则</span><b>${c.reward} 积分/箱 · 冻结 ${c.hold} 天</b></div><div><span>预算</span><b>${c.used.toLocaleString()} / ${c.budget.toLocaleString()} 积分</b></div><div><span>有效期</span><b>${escape(c.period)}</b></div><div><span>负责人</span><b>${escape(c.owner)}</b></div></div></article>`).join("");
  $("#campaigns").innerHTML = `<div class="page-lead"><div><p class="eyebrow">奖励活动</p><h2>配置可审计的激励规则</h2><p>草稿可编辑；发布后冻结规则版本。奖励活动只针对经过验证的业务事件。</p></div></div><div class="panel"><h2>新建活动草稿</h2><p class="sub">已补全参与范围、触发条件、计奖层级、上限、冻结期和有效期。</p><div class="campaign-form"><label>活动名称<input id="campaign-name" maxlength="60" value="华东签约门店 9 月收货激励"/></label><label>商品与区域<input id="campaign-scope" maxlength="100" value="上海/江苏 · 全价成猫粮 2kg"/></label><label>每有效箱积分<input id="campaign-reward" type="number" value="500" min="1" max="100000"/></label><label>单门店月上限<input id="campaign-cap" type="number" value="5000" min="500" max="1000000"/></label><label>全局预算<input id="campaign-budget" type="number" value="120000" min="500" max="10000000"/></label><label>冻结天数<input id="campaign-hold" type="number" value="7" min="1" max="365"/></label><label>有效期<input id="campaign-period" maxlength="40" value="2026-09-01 至 2026-09-30"/></label><label>结算周期<input id="campaign-cycle" maxlength="30" value="自然月结算"/></label></div><div class="form-actions"><p>受益主体：门店主体 · 触发事件：匹配发货单的首次箱级收货 · 箱袋互斥：启用</p><button class="primary" id="add-campaign">保存完整草稿</button></div></div><div class="campaign-list">${list}</div>`;
  $("#add-campaign").onclick = () => { const name=$("#campaign-name").value.trim(), scope=$("#campaign-scope").value.trim(), reward=Number($("#campaign-reward").value), cap=Number($("#campaign-cap").value), budget=Number($("#campaign-budget").value), hold=Number($("#campaign-hold").value), period=$("#campaign-period").value.trim(), cycle=$("#campaign-cycle").value.trim(), dates=/^(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})$/.exec(period); if (!name || !scope || !dates || dates[1]>dates[2] || !cycle || ![reward,cap,budget,hold].every(Number.isInteger) || reward<1 || cap<reward || budget<reward || hold>365) return toast("请填写完整且有效的活动规则：有效期须为起止日期，上限与预算不得小于单次奖励"); state.campaigns.unshift({id:`CMP-${Date.now().toString().slice(-8)}`,name,scope,beneficiary:"门店主体",trigger:"匹配发货单的首次箱级收货",reward,monthly:cap,budget,used:0,hold,cycle,period,status:"草稿",version:"v0.1",owner:"可靠码运营组"}); save(); renderCampaigns(); toast("完整活动草稿已保存"); };
}
function ledgerRow(x) { return `<div class="ledger-row"><div><b class="code">${escape(x.code)}</b><div class="muted">${escape(x.org)}</div></div><div class="hide-mobile"><b>${escape(x.campaign)}</b><div class="muted">${escape(x.event)}</div></div><div>${tag(x.status)}</div><div class="amount ${x.amount>0?"plus":""}">${money(x.amount)}</div><div class="muted hide-mobile">${escape(x.time)}</div></div>`; }
function renderLedger() {
  $("#ledger").innerHTML = `<div class="metrics"><div class="card metric"><span>冻结中</span><strong>${sum("冻结中")}</strong><small>未到活动释放日</small></div><div class="card metric"><span>可结算</span><strong>${sum("可结算")}</strong><small>等待下个结算批次</small></div><div class="card metric"><span>已冲正</span><strong>${Math.abs(sum("已冲正"))}</strong><small>以反向分录保留来源</small></div><div class="card metric"><span>账本分录</span><strong>${state.ledger.length}</strong><small>每笔均关联业务事件</small></div></div><div class="panel" style="margin-top:16px"><div class="toolbar"><div><h2>奖励账本</h2><p class="sub">筛选结果不会改变账本；冲正只追加反向分录。</p></div><label class="filter-label">按箱码、门店或活动筛选<input id="ledger-filter" aria-label="按箱码、门店或活动筛选"/></label></div><div id="ledger-list">${state.ledger.map(ledgerRow).join("")}</div></div>`;
  $("#ledger-filter").oninput = (e) => { const q=e.target.value.toLowerCase(), rows=state.ledger.filter((x)=>Object.values(x).join(" ").toLowerCase().includes(q)); $("#ledger-list").innerHTML=rows.length?rows.map(ledgerRow).join(""):"<p class='empty-state'>没有匹配的账本记录。请清空筛选后重试。</p>"; };
}
function renderRisk() {
  const rows = state.risks.map((r) => `<article class="risk ${r.status!=="待处理"?"risk-resolved":""}"><div><div>${tag(r.level)} ${tag(r.status)} <b>${escape(r.title)}</b></div><p><span class="code">${escape(r.code)}</span> · 命中规则：${escape(r.rule)} · 涉及 ${r.amount} 积分</p><p class="muted">证据：${escape(r.evidence)} · 原始事件 <span class="code">${escape(r.event)}</span> · ${escape(r.time)}</p>${r.decision!=="未处置"?`<p class="muted">处置：${escape(r.decision)}</p>`:""}</div>${r.status==="待处理"?`<div class="risk-actions"><button class="secondary" data-risk="${r.id}" data-action="hold">继续冻结</button><button class="secondary" data-risk="${r.id}" data-action="approve">核验通过</button><button class="secondary danger" data-risk="${r.id}" data-action="reject">拒绝奖励</button></div>`:"<div class='muted'>已由可靠码风控组处置</div>"}</article>`).join("");
  $("#risk").innerHTML = `<div class="page-lead"><div><p class="eyebrow">风险处置</p><h2>用可解释的证据处理异常</h2><p>风险判断不会删除追溯事件；处置只影响奖励申请的状态。</p></div></div><div class="panel"><h2>风险队列</h2><p class="sub">优先处理高风险和等待时间最长的记录。</p>${rows}</div>`;
  document.querySelectorAll("[data-risk]").forEach((b) => b.onclick = () => { const r=state.risks.find((x)=>x.id===Number(b.dataset.risk)), action=b.dataset.action, time=now(); if(!r || r.status!=="待处理") return; if(action==="approve"){r.status="已通过";r.decision=`风控核验通过 · ${time}`;const carton=state.cartons[r.code], id=eventId("-APPROVED");if(carton)createReceipt(r.code,carton,id,`风险核验通过，关联待核验事件 ${r.event}`);else state.ledger.unshift({code:r.code,org:state.org.name,campaign:state.campaigns[0].name,amount:r.amount,status:"冻结中",time,event:r.event});}else if(action==="reject"){r.status="已拒绝";r.decision=`拒绝奖励，保留待核验事实 · ${time}`;state.events.unshift({id:eventId("-REJECTED"),type:"奖励核验拒绝",code:r.code,actor:"可靠码风控组",time,result:`关联 ${r.event}；不创建正向奖励分录`});}else{r.status="继续观察";r.decision=`继续冻结，等待补充证据 · ${time}`;}r.time=time;save();renderAll();toast(action==="approve"?"风险已核验通过，已创建收货事实和冻结奖励":action==="reject"?"已拒绝本次奖励申请，原始事实已保留":"风险将继续冻结观察"); });
}
function renderAll(){renderDashboard();renderReceive();renderCampaigns();renderLedger();renderRisk();updateChrome();}
document.querySelectorAll(".nav-link").forEach((b)=>b.onclick=()=>{document.querySelectorAll(".nav-link,.view").forEach((x)=>x.classList.remove("active"));b.classList.add("active");$("#"+b.dataset.view).classList.add("active");$("#page-title").textContent=b.textContent.replace(/\d+/,"").trim();});
document.addEventListener("click",(e)=>{const target=e.target.closest("[data-go]");if(target)go(target.dataset.go);});
$("#reset").onclick=()=>{state=structuredClone(seed);save();renderAll();toast("已恢复可靠码演示基线数据");};
renderAll();

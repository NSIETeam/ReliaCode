// ============ 通用手机扫码组件 ============
// 用法:
//   openScanner({ onScanned: (code) => {...}, title: '请扫描箱码' })
//   openScanner({ onScanned: (code) => {...}, continuous: true })  // 连续扫码模式
//   openScanner({ onScanned: (code) => {...}, raw: true })         // 不提取溯源码（如订单编号）
// 默认模式：扫码成功后自动调用 onScanned(纯码值)，并关闭摄像头
// 连续模式：识别成功后不关摄像头，持续回调，适合装箱等批量扫码场景
// 外部可调用 stopScanner() 主动关闭（如需要用户填表时暂停扫码）
// 注意: 手机摄像头扫码需要 HTTPS 环境（localhost 除外）

let _currentScanner = null;
let _currentScannerId = null;

// 对外：主动关闭扫码器
function stopScanner() {
  if (_currentScanner) {
    try { _currentScanner.stop().catch(() => {}); } catch (e) {}
    _currentScanner = null;
  }
  _currentScannerId = null;
  const m = document.getElementById('scannerMask');
  if (m) m.remove();
}

// 对外：当前是否有扫码会话在运行（调用方据此避免抢焦点等打断行为）
function scannerIsOpen() {
  return !!(document.getElementById('scannerMask'));
}

function openScanner(options) {
  const { onScanned, title = '请将二维码对准取景框', continuous = false, raw = false } = options || {};

  // 先关掉上一次的
  if (_currentScanner) {
    try { _currentScanner.stop(); } catch (e) {}
    _currentScanner = null;
    _currentScannerId = null;
  }
  const staleMask = document.getElementById('scannerMask');
  if (staleMask) staleMask.remove();

  // 创建遮罩层
  const mask = document.createElement('div');
  mask.id = 'scannerMask';
  mask.className = 'scanner-mask';

  const panel = document.createElement('div');
  panel.className = 'scanner-panel';
  const heading = document.createElement('div');
  heading.className = 'scanner-heading';
  const headingLabel = document.createElement('div');
  headingLabel.className = 'scanner-heading-label';
  const cameraIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cameraIcon.setAttribute('class', 'ui-icon');
  cameraIcon.setAttribute('aria-hidden', 'true');
  const cameraUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  cameraUse.setAttribute('href', '/icons/ui.svg#camera');
  cameraIcon.appendChild(cameraUse);
  const headingText = document.createElement('span');
  headingText.textContent = String(title || '请将二维码对准取景框');
  headingLabel.append(cameraIcon, headingText);

  const region = document.createElement('div');
  region.id = 'scannerRegion';
  region.className = 'scanner-region';
  const hint = document.createElement('div');
  hint.id = 'scannerHint';
  hint.className = 'scanner-hint';
  hint.textContent = '正在启动摄像头...';

  // 手动输入区（摄像头不可用时兜底，默认隐藏）
  const manualRow = document.createElement('div');
  manualRow.className = 'scanner-manual is-hidden';
  const manualInput = document.createElement('input');
  manualInput.type = 'text';
  manualInput.className = 'form-control scan-flex-input';
  manualInput.placeholder = '手动输入码值后回车';
  const manualBtn = document.createElement('button');
  manualBtn.type = 'button';
  manualBtn.className = 'btn btn-primary';
  manualBtn.textContent = '确认';
  manualRow.append(manualInput, manualBtn);

  // 摄像头异常时的恢复入口
  const retryRow = document.createElement('div');
  retryRow.className = 'scanner-actions is-hidden';
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn-outline btn-sm';
  retryBtn.textContent = '重试摄像头';
  const manualToggle = document.createElement('button');
  manualToggle.type = 'button';
  manualToggle.className = 'btn btn-outline btn-sm';
  manualToggle.textContent = '手动输入';
  retryRow.append(retryBtn, manualToggle);

  const closeBtn = document.createElement('button');
  closeBtn.id = 'scannerCloseBtn';
  closeBtn.className = 'btn btn-outline scanner-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';
  heading.append(headingLabel, closeBtn);
  panel.append(heading, region, hint, manualRow, retryRow);
  mask.appendChild(panel);
  document.body.appendChild(mask);
  const scanId = Date.now();
  _currentScannerId = scanId;

  const closeScanner = () => {
    if (_currentScannerId !== scanId) return;
    if (_currentScanner) {
      try { _currentScanner.stop().catch(() => {}); } catch (e) {}
      _currentScanner = null;
    }
    mask.remove();
  };

  closeBtn.addEventListener('click', closeScanner);

  // 判断是否 HTTPS / localhost
  const isSecure = window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  const isAlive = () => _currentScannerId === scanId && document.body.contains(mask);

  if (typeof Html5Qrcode === 'undefined') {
    hint.textContent = '扫码组件加载失败，请刷新页面重试（也可手动输入码值）';
    retryRow.classList.remove('is-hidden');
    manualRow.classList.remove('is-hidden');
  } else if (!isSecure) {
    hint.textContent = '手机摄像头扫码需要 HTTPS 访问\n请用 https:// 打开本系统，或直接手动输入码值';
    retryRow.classList.remove('is-hidden');
    manualRow.classList.remove('is-hidden');
  }

  // 连续模式按本次扫码会话去重：同一码无论被摄像头重复识别多少次，都只计一次。
  const seenCodes = new Set();
  let scanCount = 0;

  const accept = (decodedText) => {
    if (!isAlive()) return;
    const code = raw ? String(decodedText == null ? '' : decodedText).trim() : extractCode(decodedText);
    if (!code) return;
    if (continuous) {
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      scanCount += 1;
      hint.textContent = '已识别 ' + scanCount + ' 个不同码，最新：' + code + '（重复码不计数）';
      try { onScanned(code); } catch (e) {}
    } else {
      hint.textContent = '识别成功！';
      // 成功先停再回调
      closeScanner();
      try { onScanned(code); } catch (e) {}
    }
  };

  const submitManual = () => {
    const v = (manualInput.value || '').trim();
    if (!v) return;
    manualInput.value = '';
    accept(v);
  };
  manualBtn.addEventListener('click', submitManual);
  manualInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitManual(); });
  manualToggle.addEventListener('click', () => {
    manualRow.classList.toggle('is-hidden');
    if (!manualRow.classList.contains('is-hidden')) manualInput.focus();
  });

  const startCamera = () => {
    if (!isAlive()) return;
    if (_currentScanner) {
      try { _currentScanner.stop().catch(() => {}); } catch (e) {}
      _currentScanner = null;
    }
    retryRow.classList.add('is-hidden');
    hint.textContent = '正在启动摄像头...';
    try {
      _currentScanner = new Html5Qrcode('scannerRegion');
      _currentScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        accept,
        () => {}
      ).then(() => {
        if (!isAlive()) return;
        hint.textContent = continuous
          ? '摄像头已开启，连续扫码中，扫完关闭即可退出'
          : '摄像头已开启，请对准二维码';
      }).catch((err) => {
        if (!isAlive()) return;
        hint.textContent = '无法开启摄像头：' + (err && err.message ? err.message : '权限被拒绝或非HTTPS环境')
          + '\n可点「重试摄像头」，或手动输入码值';
        retryRow.classList.remove('is-hidden');
        manualRow.classList.remove('is-hidden');
      });
    } catch (err) {
      if (!isAlive()) return;
      hint.textContent = '无法开启摄像头，请使用HTTPS访问，或手动输入码值';
      retryRow.classList.remove('is-hidden');
      manualRow.classList.remove('is-hidden');
    }
  };

  retryBtn.addEventListener('click', startCamera);
  if (typeof Html5Qrcode !== 'undefined' && isSecure) startCamera();
}

// 从完整URL或纯码值中提取溯源码
// 规则（2026-09-21 收敛）：纯码值原样返回；URL 或带前缀噪声时提取 B/S 开头的完整码值；
// 不再对普通文本做"截断式"提取，避免把带前后缀的码值改写成另一个码。
function extractCode(input) {
  if (!input) return input;
  const s = String(input).trim();
  if (/^[BS][A-Z0-9]+$/.test(s)) return s;                 // 本身就是码值
  if (/^https?:\/\//i.test(s)) {                          // 二维码里是网址
    const m = s.match(/([BS][A-Z0-9]{6,})/);
    return m ? m[1] : s;
  }
  const m = s.match(/([BS][A-Z0-9]{6,})/);                 // 带前后缀，如 "袋号:BMU..."
  return m ? m[1] : s;
}

// 取消操作可能已在服务器完成，但响应在网络中丢失。只读核对最终状态后再从清单移除。
async function cancelCodeWithReconciliation(code, endpoint, kind) {
  const timedFetch = async (url, options, timeoutMs) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  };
  let failure = '';
  try {
    const response = await timedFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    }, 15000);
    const payload = await response.json();
    if (response.ok && payload.success) return { code, success: true, msg: payload.msg };
    failure = payload.msg || '操作未完成';
  } catch (_error) {
    failure = '网络中断，正在核对服务器状态';
  }
  try {
    const query = `/api/codes/reversal-state?kind=${encodeURIComponent(kind)}&code=${encodeURIComponent(code)}`;
    const response = await timedFetch(query, {}, 8000);
    const state = await response.json();
    if (response.ok && state.success && state.settled) {
      return { code, success: true, reconciled: true, msg: state.state };
    }
    if (response.ok && state.success) return { code, success: false, msg: failure + '；服务器显示仍有业务关联，可重试' };
  } catch (_error) { /* 核对不可用时保留码，不能推断取消成功。 */ }
  return { code, success: false, uncertain: true, msg: failure + '；状态未核实，请稍后重试' };
}

// ============ 取消操作二次确认弹窗（取消入库 / 取消发货通用） ============
// 用法: showCancelConfirm(title, subtitleHtml, codes[], onConfirm)
//   - title: 弹窗标题
//   - subtitleHtml: 副标题（可含 HTML，如数量加粗）
//   - codes: 待取消的码数组（字符串），弹窗内列表展示
//   - onConfirm: 点「确认取消」回调（异步）
function showCancelConfirm(title, subtitleHtml, codes, onConfirm) {
  let mask = document.getElementById('cancelConfirmMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'cancelConfirmMask';
    mask.className = 'cancel-confirm-mask';
    mask.innerHTML = `
      <div class="cancel-confirm-panel">
        <div class="cancel-confirm-icon"><svg class="ui-icon ui-icon-lg" aria-hidden="true"><use href="/icons/ui.svg#alert"></use></svg></div>
        <div class="cancel-confirm-title" id="cancelConfirmTitle"></div>
        <div class="cancel-confirm-sub" id="cancelConfirmSub"></div>
        <div class="cancel-confirm-list" id="cancelConfirmList"></div>
        <div class="cancel-confirm-actions">
          <button type="button" class="btn btn-outline cancel-confirm-cancel" id="cancelConfirmCancelBtn">取消</button>
          <button type="button" class="btn btn-danger cancel-confirm-ok" id="cancelConfirmOkBtn">确认取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    mask.querySelector('#cancelConfirmCancelBtn').addEventListener('click', () => {
      mask.classList.remove('is-open');
    });
  }
  document.getElementById('cancelConfirmTitle').innerHTML = title;
  document.getElementById('cancelConfirmSub').innerHTML = subtitleHtml || '';
  const list = document.getElementById('cancelConfirmList');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  list.innerHTML = (codes || []).map(c => `<span class="cancel-confirm-code">${esc(c)}</span>`).join('');
  const okBtn = document.getElementById('cancelConfirmOkBtn');
  okBtn.textContent = '确认取消';
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    okBtn.textContent = '执行中…';
    try {
      await onConfirm();
      mask.classList.remove('is-open');
    } catch (_error) {
      document.getElementById('cancelConfirmSub').textContent = '提交中断，清单仍保留。请检查网络后重试。';
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = '确认取消';
    }
  };
  mask.classList.add('is-open');
}

// ============ 通用手机扫码组件 ============
// 用法:
//   openScanner({ onScanned: (code) => {...}, title: '请扫描箱码' })
//   openScanner({ onScanned: (code) => {...}, continuous: true })  // 连续扫码模式
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

function openScanner(options) {
  const { onScanned, title = '请将二维码对准取景框', continuous = false } = options;

  // 先关掉上一次的
  if (_currentScanner) {
    try { _currentScanner.stop(); } catch (e) {}
    _currentScanner = null;
    _currentScannerId = null;
  }

  // 创建遮罩层
  const mask = document.createElement('div');
  mask.id = 'scannerMask';
  mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;';

  mask.innerHTML = `
    <div style="width:90%;max-width:420px;text-align:center;">
      <div style="color:#fff;font-size:16px;margin-bottom:12px;"><svg class="ui-icon" aria-hidden="true"><use href="/icons/ui.svg#camera"></use></svg> ${title}</div>
      <div id="scannerRegion" style="background:#000;border-radius:12px;overflow:hidden;min-height:280px;"></div>
      <div id="scannerHint" style="color:#aaa;font-size:13px;margin-top:10px;">正在启动摄像头...</div>
      <button id="scannerCloseBtn" style="margin-top:16px;padding:10px 32px;background:#fff;color:#333;border:none;border-radius:24px;font-size:15px;cursor:pointer;">关闭</button>
    </div>
  `;
  document.body.appendChild(mask);

  const hint = document.getElementById('scannerHint');
  const closeBtn = document.getElementById('scannerCloseBtn');
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

  closeBtn.onclick = closeScanner;

  // 判断是否 HTTPS / localhost
  const isSecure = window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (typeof Html5Qrcode === 'undefined') {
    hint.textContent = '扫码组件加载失败，请刷新页面重试';
    return;
  }

  if (!isSecure) {
    hint.textContent = '手机摄像头扫码需要 HTTPS 访问\n请用 https:// 打开本系统（部署后自动支持），或用微信/浏览器扫二维码进入';
  }

  try {
    // 连续模式防重复：同一码停留在取景框内只触发一次
    let lastCode = null, lastTime = 0;

    _currentScanner = new Html5Qrcode('scannerRegion');
    _currentScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        const code = extractCode(decodedText);
        const now = Date.now();
        if (continuous) {
          // 同一码 5 秒内重复识别视为同一次（取景框未移开），刷新时间戳
          if (code === lastCode && now - lastTime < 5000) {
            lastTime = now;
            return;
          }
          lastCode = code;
          lastTime = now;
          hint.textContent = '已识别 ' + code + '，继续扫下一个';
          onScanned(code);
        } else {
          hint.textContent = '识别成功！';
          // 成功先停再回调
          closeScanner();
          onScanned(code);
        }
      },
      () => {}
    ).then(() => {
      if (_currentScannerId === scanId) {
        hint.textContent = continuous
          ? '摄像头已开启，连续扫码中，扫完关闭即可退出'
          : '摄像头已开启，请对准二维码';
      }
    }).catch((err) => {
      hint.textContent = '无法开启摄像头：' + (err && err.message ? err.message : '权限被拒绝或非HTTPS环境') + '\n可改为手动输入码值';
    });
  } catch (err) {
    hint.textContent = '无法开启摄像头，请使用HTTPS访问或用扫码枪';
  }
}

// 从完整URL或纯码值中提取溯源码
function extractCode(input) {
  if (!input) return input;
  const s = String(input).trim();
  const m = s.match(/([BS][A-Z0-9]+)/);
  return m ? m[1] : s;
}

# ReliaCode（可靠码）Web

同一前端提供两种明确隔离的运行模式。GitHub Pages 是无预置数据的本地演示工作区；生产容器通过 `RELIACODE_API_URL` 启用 `domainApi`，所有业务事实来自 Scan API 与 PostgreSQL，浏览器本地存储只用于非敏感界面状态。

首次打开时创建空白工作区，然后可以：

1. 录入产品、SKU 和 GTIN。
2. 批量生成单品、箱或托盘唯一可靠码；CSV 用于系统交换，二维码标签 HTML 用于打印、另存 PDF 和现场扫码。
3. 创建工厂、渠道、门店等作业账号；账号决定扫码事件类型。
4. 使用摄像头、扫码枪、验证网址或手工输入验证产品，执行装箱、发货、收货和销售核验。
5. 创建奖励活动，查看实际事件产生的账本和风险。
6. 使用 Agent 打开功能、验证可靠码、生码和导出备份。
7. 导出或导入整个 JSON 工作区。

```powershell
npm run dev
```

打开 `http://localhost:4173`。未配置 API 时数据仅保存在当前浏览器的 `localStorage`；该模式不得用于多人生产作业。

生产模式由 Web 服务器反向代理 API，并动态输出运行配置：

```powershell
$env:RELIACODE_API_URL='http://scan-api:4180'
npm start
```

生产现场工作台从服务端加载当前角色可执行的事件、已批准/执行中单据与活动设备。核验阶段查询对象和单据动作行，确认阶段提交 CSRF、幂等键、设备 ID 与设备令牌到 `/api/v1/trace-events`；不创建离线事件或浏览器待同步队列。设备令牌只保存在当前页面内存，刷新即清除，不写入 `localStorage`。装箱、拆箱、换箱、发货、渠道/门店收货、退货、销售和销毁均由服务端状态机最终裁决。

生码任务提供两种导出：

- `二维码标签`：下载一个完全离线的 HTML，每个可靠码对应一个可扫描的 SVG 二维码。二维码承载 `?verify=<publicId>` 验证网址；用浏览器打开后按 100% 实际尺寸打印，或选择“另存为 PDF”。
- `CSV`：保留产品、SKU、包装层级、批次和可靠码明细，供 ERP、WMS、标签软件或审计使用。

当前可靠码较长，因此不默认生成 Code 128 一维条码；在常见小标签尺寸上，二维码更紧凑、可扫描性更可靠。

## 公开验证 API

纯静态公开验证部署可在 `runtime-config.js` 中设置 API 地址：

```js
window.RELIACODE_CONFIG = Object.freeze({
  apiBaseUrl: "https://api.example.com"
});
```

未登录消费者打开二维码时，网页只调用
`GET /api/public/v1/objects/:publicId`，返回产品名称、GTIN、包装层级、批次、状态和经过验证的公开事件，不返回组织、人员、设备、发货单、奖励或内部对象 ID。品牌作业事件仍必须走带 OIDC 身份的业务接口。

摄像头优先使用浏览器原生 `BarcodeDetector`，不支持时自动切换到本地 `jsQR` 解码；视频帧不会上传。

GitHub Pages 无法提供可信多人身份、共享数据库或服务端审计。真实生产环境必须使用 `apps/scan-api`、OIDC 和 PostgreSQL。

# ReliaCode Scan API

生产写入边界，负责身份验证、租户隔离、码资产、流转事件、风险处置、奖励账本和审计。所有写接口必须携带 `Idempotency-Key`，追溯事件、账本和审计表由数据库触发器保证追加式保存。

本地开发：

```powershell
npm install
$env:DATABASE_URL='postgres://reliacode:reliacode@localhost:5432/reliacode'
$env:AUTH_MODE='development'
npm run migrate
npm start
```

开发身份通过 `X-ReliaCode-Principal` JSON 请求头提供；`NODE_ENV=production` 时服务会拒绝 development 身份模式，必须配置 OIDC。

公开产品验证端点为 `GET /api/public/v1/objects/:publicId`。该端点无需身份令牌，使用不可枚举 UUID、IP 速率限制和最小化响应；不会返回租户、组织、人员、设备、单据、奖励或内部对象 ID。生产环境应只允许受控的公开验证前端 Origin，并在 CDN/WAF 层增加滥用防护。

生产生码使用 `POST /api/v1/code-jobs`，审批后由 `worker:codes` 分块生成。完成后 `worker:code-exports` 以固定内存分页生成 UTF-8 CSV、分片上传到 S3 兼容对象存储并保存 SHA-256；`GET /api/v1/code-jobs/:id/download` 只为当前租户签发 5 分钟下载地址，不通过 API 进程传输文件。对象存储凭据必须通过文件型 secret 注入，导出失败十次后进入死信并由有审批权限的管理员审计重试。

本地账号会话默认每 15 分钟轮换令牌和 CSRF，IP 只以 keyed HMAC 保存，不落原始地址。密码、Passkey 和恢复码登录都会写入追加式 `authentication_events`；网络与浏览器同时变化时标记为高风险，并通过 `reliacode_risky_logins_24h` 告警。用户可查看设备会话并远程撤销，租户管理员可冻结非所有者成员，平台运营可暂停整个租户；冻结操作会立即撤销相关会话并保留理由。

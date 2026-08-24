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

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

# ReliaCode 运维手册

## 配置与启动

生产环境需要两个 Docker secret：

- `secrets/postgres_password.txt`：仅 PostgreSQL 初始化密码。
- `secrets/database_url.txt`：完整连接串，例如 `postgres://reliacode:密码@postgres:5432/reliacode`。

设置 `OIDC_ISSUER_URL`、`PUBLIC_ORIGIN`、`OPEN_EPCIS_BASE_URL` 后执行：

```powershell
docker compose build
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d api outbox-worker web
```

迁移应作为独立发布步骤执行，不允许多个 API 实例并发自动迁移。

## 健康检查

- Web 存活：`GET /health/live`
- API 存活：`GET /health/live`
- API 就绪：`GET /health/ready`，同时验证数据库连接。

就绪失败时应停止接收流量；存活失败才重启进程。

## 必须监控

- HTTP 请求量、4xx/5xx、P50/P95/P99、限流次数。
- PostgreSQL 连接、锁等待、慢查询、磁盘、复制延迟和备份状态。
- `event_outbox` 未处理数量、最老事件年龄、重试次数和最后错误。
- 风险待处理数量、Claim 冻结时长、账本与 Claim 对账差异。
- OIDC JWKS 获取失败、令牌校验失败和异常跨组织访问。

## 事件积压处理

OpenEPCIS 不可用时，业务事务仍写入 outbox。禁止人工删除积压行。先恢复目标服务，再观察 worker 自动重试；持续失败时根据 `last_error` 修复映射或目标配置。需要跳过坏事件时必须生成审批记录和替代补偿事件。

## 备份与恢复

- PostgreSQL 开启连续归档和时间点恢复；每日全备、至少保留 30 天。
- 每月恢复到隔离环境并运行追溯正反查、Claim/账本对账和 outbox 重放测试。
- 恢复后不得直接连接真实支付和渠道终端，必须使用隔离凭据。

## 安全事件

发现令牌或数据库凭据泄漏时：立即吊销/轮换，冻结可疑账号和设备，保存审计及网关日志，评估跨租户访问范围；不得通过修改或删除追溯事件掩盖影响。

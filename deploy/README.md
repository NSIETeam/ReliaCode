# ReliaCode API 生产部署

此目录只包含无密钥的部署清单。生产数据库、OIDC 和 OpenEPCIS 必须由真实托管服务提供；GitHub Pages 不能承载 Node.js API 或 PostgreSQL。

## 前置条件

- 一套启用 TLS、备份和时间点恢复的 PostgreSQL。
- 一个 OIDC 身份提供方，访问令牌需包含 ReliaCode 所需的租户、组织和角色声明。
- 一个可接收 EPCIS 2.0 Capture 的 OpenEPCIS 服务。
- 一个带 TLS 的容器运行环境和 API 域名，例如 `https://api.reliacode.example`。

## 发布顺序

1. 复制 `.env.production.example` 为 `.env` 并填写真实公开配置。
2. 在 `deploy/secrets/database_url.txt` 写入数据库连接串；该目录已被仓库根目录的 `secrets/` 规则排除。
3. 固定部署镜像为提交标签，例如 `ghcr.io/nsieteam/reliacode-api:sha-<40位提交>`，不要长期依赖 `latest`。
4. 执行一次迁移，再启动 API、outbox worker 和 Web：

```powershell
docker compose --env-file .env -f compose.production.yaml pull
docker compose --env-file .env -f compose.production.yaml run --rm migrate
docker compose --env-file .env -f compose.production.yaml up -d api outbox-worker web
```

迁移器使用 PostgreSQL advisory lock，重复执行安全；API 的 `/health/ready` 只有在数据库包含当前要求的迁移版本时才返回 200。

## 上线验证

```powershell
curl.exe -fsS https://api.reliacode.example/health/live
curl.exe -fsS https://api.reliacode.example/health/ready
```

生产 Web 容器通过同源 `/api` 代理连接 API，并自动启用服务端持久化；不要把默认 GitHub Pages 构建当作生产写入口。随后完成一次“生成码 -> 打印标签 -> 异机扫码 -> 公共验证”的真实闭环。

## 回滚

应用回滚只切回上一个不可变 `sha-...` 镜像。数据库迁移当前采用前向修复策略，不自动执行破坏性降级；涉及字段删除或数据重写时必须先做恢复演练并单独审批。

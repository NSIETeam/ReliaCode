# ReliaCode API 生产部署

此目录只包含无密钥的部署清单。应用内账号和 Passkey 是默认身份方案；也可显式切换到 OIDC。PostgreSQL 和 OpenEPCIS 必须由受控服务提供，GitHub Pages 不能承载 Node.js API 或 PostgreSQL。

## 前置条件

- 一套启用 TLS、备份和时间点恢复的 PostgreSQL。
- 一个正式 HTTPS 域名；Passkey 的 `WEBAUTHN_RP_ID` 和 `WEBAUTHN_ORIGIN` 必须与该域名匹配。
- 一个可接收 EPCIS 2.0 Capture 的 OpenEPCIS 服务。
- 一个支持分片上传、服务端加密和预签名下载的 S3 兼容对象存储；码文件不得写入 API 容器本地磁盘。
- 导出 bucket 必须配置生命周期规则，自动清理未完成的分片上传，并按合同要求设置成品文件保留期。
- 一个带 TLS 的容器运行环境和 API 域名，例如 `https://api.reliacode.example`。

## GitHub 自动部署

`production-release` 工作流会针对同一个 Git 提交测试并发布 API/Web 镜像，然后运行数据库迁移、更新服务并检查 API 与 Web 健康状态。请在 GitHub 创建 `production` Environment，并配置：

- Secret `DEPLOY_HOST`：生产服务器地址。
- Secret `DEPLOY_USER`：仅具备该部署目录和 Docker 权限的系统用户；不建议长期使用 root。
- Secret `DEPLOY_SSH_KEY`：该部署用户的专用私钥。
- Secret `DEPLOY_KNOWN_HOSTS`：预先核验的服务器 SSH 主机公钥记录，禁止运行时跳过主机校验。
- Variable `DEPLOY_PORT`：SSH 端口，默认 `22`。
- Variable `DEPLOY_PATH`：部署目录，默认 `/opt/reliacode/deploy`。

服务器上的 `DEPLOY_PATH` 必须预先保存不入库的 `.env`、`secrets/database_url.txt`、`secrets/object_storage_access_key_id.txt`、`secrets/object_storage_secret_access_key.txt` 和 `secrets/smtp_url.txt`。SMTP URL 应包含受限的事务邮件账号凭据。工作流只覆盖 `compose.production.yaml` 与 `release.sh`，不会覆盖生产密钥。对象存储凭据应限制为导出 bucket 的读写权限，不得授予账户级管理权限。建议给 `production` Environment 配置 required reviewers，使自动任务在真正更新服务器前等待人工批准。

`SESSION_FINGERPRINT_KEY` 与 `WEBHOOK_ENCRYPTION_KEY` 都必须使用独立随机 32 字节 base64url 值，禁止复用。前者用于不可逆会话网络指纹，轮换它会降低历史异常登录关联能力；后者用于解密现有 Webhook 签名密钥，轮换前必须执行端点密钥迁移。

## 发布顺序

1. 复制 `.env.production.example` 为 `.env` 并填写真实公开配置。
2. 在 `deploy/secrets/database_url.txt` 写入数据库连接串，并分别写入对象存储 Access Key 与 Secret Key 文件；该目录已被仓库规则排除。
3. 固定部署镜像为提交标签，例如 `ghcr.io/nsieteam/reliacode-api:sha-<40位提交>`，不要长期依赖 `latest`。
4. 自动工作流会执行以下等价发布流程；紧急情况下也可以手动运行：

```powershell
docker compose --env-file .env -f compose.production.yaml pull
docker compose --env-file .env -f compose.production.yaml run --rm migrate
docker compose --env-file .env -f compose.production.yaml up -d api outbox-worker code-worker code-export-worker webhook-worker web
```

迁移器使用 PostgreSQL advisory lock，重复执行安全；API 的 `/health/ready` 只有在数据库包含当前要求的迁移版本时才返回 200。

## 异地备份与恢复演练

生产主机每天通过系统定时器运行 `backup-postgres.sh`。脚本先使用 `pg_dump` 生成一致性归档，再用 age 公钥加密，最后上传 S3 兼容对象存储并记录校验和；`reliacode_backup_age_seconds` 超过 86400 必须告警。解密私钥不能放在生产主机。

每月在隔离的 `reliacode_drill` 数据库执行 `restore-drill.sh`。脚本会拒绝名称不含 `reliacode_drill` 的目标连接串，避免误覆盖生产库。恢复成功后仍须执行真实抽样查询并记录演练签字。

## 上线验证

```powershell
curl.exe -fsS https://api.reliacode.example/health/live
curl.exe -fsS https://api.reliacode.example/health/ready
```

生产 Web 容器通过同源 `/api` 代理连接 API，并自动启用服务端持久化；不要把默认 GitHub Pages 构建当作生产写入口。码生成完成后还必须等待 `export_status=COMPLETED`，下载接口只返回 5 分钟有效的对象存储签名地址。随后完成一次“生成码 -> 导出 -> 打印标签 -> 异机扫码 -> 公共验证”的真实闭环。

## 回滚

应用回滚只切回上一个不可变 `sha-...` 镜像。数据库迁移当前采用前向修复策略，不自动执行破坏性降级；涉及字段删除或数据重写时必须先做恢复演练并单独审批。

# ReliaCode API 生产部署

此目录只包含无密钥的部署清单。应用内账号和 Passkey 是默认身份方案；也可显式切换到 OIDC。PostgreSQL 和 OpenEPCIS 必须由受控服务提供，GitHub Pages 不能承载 Node.js API 或 PostgreSQL。

## 前置条件

- 一套启用 TLS、备份和时间点恢复的 PostgreSQL。
- 一个正式 HTTPS 域名；Passkey 的 `WEBAUTHN_RP_ID` 和 `WEBAUTHN_ORIGIN` 必须与该域名匹配。
- 升级到设备事件授权迁移后，所有没有设备凭据或有效作业范围的旧设备会自动转为 `SUSPENDED`；必须在对应 GLN 网点重新注册并安全下发一次性设备令牌，不能直接恢复旧记录。
- 一个可接收 EPCIS 2.0 Capture 的 OpenEPCIS 服务。
- 一个支持分片上传、服务端加密和预签名下载的 S3 兼容对象存储；码文件不得写入 API 容器本地磁盘。
- 导出 bucket 必须配置生命周期规则，自动清理未完成的分片上传，并按合同要求设置成品文件保留期。
- 一个带 TLS 的容器运行环境和 API 域名，例如 `https://api.reliacode.example`。

正式 `DEPLOYMENT_ENVIRONMENT=production` 会失败关闭：数据库连接固定启用 TLS，浏览器 Origin、WebAuthn、OIDC、OpenEPCIS、GS1 Digital Link、对象存储和账号恢复地址如已配置必须使用 HTTPS，事务邮件必须使用 SMTPS，必须由受控反向代理转发，并使用 `__Host-` 会话及 CSRF Cookie 防止其他子域覆盖。需要临时明文 IP 访问的单机试点只能标记为 `pilot`，不能冒充正式生产环境。

## GitHub 手动生产发布

`production-release` 只能由维护人员手动触发。它会针对同一个 Git 提交测试并发布 API/Web 镜像，然后在 `production` Environment 人工批准后运行数据库迁移、更新服务并检查 API 与 Web 健康状态；推送 `main` 不会部署服务器。请配置：

- Secret `DEPLOY_HOST`：生产服务器地址。
- Secret `DEPLOY_USER`：仅具备该部署目录和 Docker 权限的系统用户；不建议长期使用 root。
- Secret `DEPLOY_SSH_KEY`：该部署用户的专用私钥。
- Secret `DEPLOY_KNOWN_HOSTS`：预先核验的服务器 SSH 主机公钥记录，禁止运行时跳过主机校验。
- Variable `DEPLOY_PORT`：SSH 端口，默认 `22`。
- Variable `DEPLOY_PATH`：部署目录，默认 `/opt/reliacode/deploy`。

服务器上的 `DEPLOY_PATH` 必须预先保存不入库的 `.env`、`secrets/database_url.txt`、`secrets/system_database_url.txt`、`secrets/migration_database_url.txt`、`secrets/openepcis_bearer_token.txt`、`secrets/object_storage_access_key_id.txt`、`secrets/object_storage_secret_access_key.txt`、`secrets/smtp_url.txt`、`secrets/metrics_bearer_token.txt`、`secrets/webhook_encryption_key.txt`、`secrets/session_fingerprint_key.txt` 和 `secrets/otel_exporter_headers.txt`。每个 secret 文件只能包含一行值、权限必须为 `0400` 或 `0600`，并应仅允许部署用户读取。OTLP headers 使用标准逗号分隔 `name=value` 格式，空格等字符需百分号编码。SMTP URL 应包含受限的事务邮件账号凭据；OpenEPCIS 凭据只授予 capture/query 所需权限。工作流只覆盖 `compose.production.yaml` 与 `release.sh`，不会覆盖生产密钥。对象存储凭据应限制为导出 bucket 的读写权限，不得授予账户级管理权限。建议给 `production` Environment 配置 required reviewers，使自动任务在真正更新服务器前等待人工批准。

GitHub `integration` Environment 可配置 `OPEN_EPCIS_CONTRACT_BASE_URL` 与 `OPEN_EPCIS_CONTRACT_BEARER_TOKEN`，手动运行 `openepcis-live-contract`。任务会写入一个唯一合成事件并在 60 秒内通过标准 Query API 查回；该门禁应指向隔离的联调仓库，不应污染正式业务事件仓库。

`database_url.txt` 使用 `TENANT_DATABASE_ROLE` 指定的租户运行角色；`system_database_url.txt` 使用独立的 `SYSTEM_DATABASE_ROLE`，仅供认证、公开投影、平台控制面和 worker；两者都必须是可登录的非超级用户且没有 `BYPASSRLS`。`migration_database_url.txt` 使用独立受控的 schema owner，只提供给一次性迁移容器。迁移器登记唯一受信系统角色并授予运行权限；普通租户角色即使自行设置 `reliacode.system_access=on`，数据库函数仍返回 false。API 就绪检查会同时连接两套连接池，验证角色名称、权限、连接分离和系统访问结果。

`session_fingerprint_key.txt` 与 `webhook_encryption_key.txt` 都必须保存独立随机 32 字节 base64url 值，禁止复用；`metrics_bearer_token.txt` 至少 32 个随机字符。前者用于不可逆会话网络指纹，轮换它会降低历史异常登录关联能力；Webhook 主密钥用于解密现有端点签名密钥，轮换前必须执行端点密钥迁移。正式生产会拒绝通过普通环境变量直接传入这三项密钥。

正式生产不支持无数据库身份的共享 `local-admin`。首次上线在迁移完成后，将一个仅包含初始强密码的只读文件挂载到迁移容器，并一次性运行 `src/bootstrap-platform-operator.mjs`：

```powershell
docker compose --env-file .env -f compose.production.yaml run --rm `
  -e PLATFORM_BOOTSTRAP_USERNAME=platform_owner `
  -e PLATFORM_BOOTSTRAP_EMAIL=owner@example.cn `
  -e PLATFORM_BOOTSTRAP_PASSWORD_FILE=/run/secrets/platform_bootstrap_password `
  -v <host-protected-password-file>:/run/secrets/platform_bootstrap_password:ro `
  migrate src/bootstrap-platform-operator.mjs
```

命令在发现任何活动平台运营账号时会拒绝再次执行。成功后立即删除密码文件；首次登录先注册两个 Passkey、生成离线恢复码并完成 Passkey step-up。管理员拥有两个 Passkey 后，密码登录自动关闭。`ENABLE_LEGACY_BOOTSTRAP_ADMIN` 只能用于受控试点，`DEPLOYMENT_ENVIRONMENT=production` 会拒绝启动该模式。

## 发布顺序

1. 复制 `.env.production.example` 为 `.env` 并填写真实公开配置。
2. 在 `deploy/secrets/database_url.txt` 写入数据库连接串，并分别写入对象存储 Access Key 与 Secret Key 文件；该目录已被仓库规则排除。
3. 固定部署镜像为提交标签，例如 `ghcr.io/nsieteam/reliacode-api:sha-<40位提交>`，不要长期依赖 `latest`。
4. 手动生产工作流会执行以下等价发布流程；紧急情况下也可以手动运行：

```powershell
docker compose --env-file .env -f compose.production.yaml pull
docker compose --env-file .env -f compose.production.yaml run --rm migrate
docker compose --env-file .env -f compose.production.yaml up -d api outbox-worker code-worker code-export-worker webhook-worker web
```

迁移器使用 PostgreSQL advisory lock，重复执行安全；API 的 `/health/ready` 只有在数据库包含当前要求的迁移版本时才返回 200。

## 异地备份与恢复演练

生产主机每天通过系统定时器运行 `backup-postgres.sh`。目标 bucket 必须启用对象版本化；脚本先使用 `pg_dump` 生成一致性归档，再用 age 公钥加密，上传密文和清单，读取两者 VersionId 后才记录 `VERIFIED`；`reliacode_backup_age_seconds` 超过 86400 必须告警。解密私钥不能放在生产主机。

下载验证必须在隔离恢复主机执行：`verify-backup.sh <dump.age> <manifest> <age-identity>` 会先验证密文 SHA256，再解密到临时目录并执行 `pg_restore --list`；禁止直接把加密文件交给 `pg_restore`。

每月在隔离的 `reliacode_drill` 数据库执行 `restore-drill.sh`。脚本会拒绝名称不含 `reliacode_drill` 的目标连接串，避免误覆盖生产库。恢复成功后仍须执行真实抽样查询并记录演练签字。

## 上线验证

将 `monitoring/reliacode-alerts.yml` 导入生产 Prometheus，并在
Alertmanager 中把 `critical` 和 `warning` 路由到已确认的值班联系人。
只有完成一次测试告警并记录收到通知的人员和时间后，才可将监控门禁
标记为通过。

```powershell
curl.exe -fsS https://api.reliacode.example/health/live
curl.exe -fsS https://api.reliacode.example/health/ready
```

生产 Web 容器通过同源 `/api` 代理连接 API，并自动启用服务端持久化；不要把默认 GitHub Pages 构建当作生产写入口。码生成完成后还必须等待 `export_status=COMPLETED`，下载接口只返回 5 分钟有效的对象存储签名地址。随后完成一次“生成码 -> 导出 -> 打印标签 -> 异机扫码 -> 公共验证”的真实闭环。

## 回滚

应用回滚只切回上一个不可变 `sha-...` 镜像。数据库迁移当前采用前向修复策略，不自动执行破坏性降级；涉及字段删除或数据重写时必须先做恢复演练并单独审批。

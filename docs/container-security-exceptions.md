# 容器安全临时例外

生产镜像流水线先报告全部 High/Critical 漏洞，再阻断所有已有修复版本但镜像尚未升级的 High/Critical 漏洞。没有上游修复版本的发现不会被隐藏，但不能无限期豁免。

## CVE-2026-14456

- 组件：Debian 13 `libssl3t64`，随 `gcr.io/distroless/nodejs24-debian13` 进入运行镜像。
- 当前状态：Trivy 标记为 `fix_deferred`，扫描时没有可用修复版本。
- 影响判断：公告描述的攻击面为 OpenSSL QUIC server；ReliaCode API 使用 Fastify HTTP 服务，不启用 QUIC。此判断只降低当前可利用性，不代表漏洞不存在。
- 补偿控制：运行镜像固定摘要、非 root、无 shell、无包管理器；公网入口应由 TLS 反向代理/WAF 终止连接；流水线每次构建仍输出此项。
- 失效条件：Debian/distroless 发布修复版本后必须更新基础镜像摘要，届时阻断扫描会拒绝旧镜像。
- 最晚复核日期：2026-09-30；到期仍无修复时重新评估暴露面和替代运行镜像。

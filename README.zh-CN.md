# dsh-relay

[English](README.md) | [简体中文](README.zh-CN.md)

> **非官方社区项目：** 本项目由社区独立开发和维护，未经 DeepSeek 审核、推荐或支持。

用于 DSH 手机遥控 MVP 的云端 Relay。

公共生产地址：`https://relay.dshmobile.online`。0.1.3 默认只路由端到端加密的 sealed tunnel，不接收 DSH 业务明文。

## 本地运行

```bash
cp .env.example .env
npm install
npm run build
npm start
```

默认监听地址是 `http://127.0.0.1:8787`。生产环境必须将 `DATABASE_PATH` 设置到持久化存储。任何公网部署都应提供 HTTPS/WSS；Relay 不会持有或记录隧道业务明文。

## 版本发布

每个 Pull Request 和分支 Push 都会由 GitHub Actions 使用 lockfile 安装依赖，并执行构建、测试和生产依赖审计。推送与 `package.json`、`package-lock.json` 中版本完全一致的标签（例如 `v0.1.3`）后，GitHub Release 会自动创建。

每个 Release 提供包含预编译 `dist/`、部署文件和生产依赖清单的 `.tar.gz` 与 `.zip`，并附带 `SHA256SUMS`。解压后先运行 `npm ci --omit=dev`，再运行 `npm start`；原生依赖会针对目标平台安装，而不是打包 CI 环境中的二进制。

## Railway

从本目录创建 Railway Service，将 `JWT_SECRET` 设置为长随机值，并挂载持久卷到 `/data`。设置 `DATABASE_PATH=/data/relay.sqlite`。添加 HTTPS 自定义域名，例如 `relay.dshmobile.online`，然后在移动应用和 Companion 中使用该地址。Companion 会自动把 `https://` Relay URL 转换为设备连接所需的 `wss://`。

在 Railway 中设置 `TRUST_PROXY=1`，让限流使用 Railway 可信代理提供的第一个地址。直接暴露 Node 进程时应保持禁用。

MVP 有意采用单实例架构。在引入共享存储前，必须使用 SQLite 持久卷，并且只能运行一个 Relay 副本。

## 使用 Docker 私有部署

```bash
cp .env.example .env
```

设置一个长随机 `JWT_SECRET`，然后启动单实例 Relay：

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

在 `8787` 端口前配置 HTTPS 反向代理。除非该代理会覆盖客户端转发请求头，否则保持 `TRUST_PROXY=0`。`relay-data` Volume 保存 SQLite 状态，必须备份。在移动应用中选择 **Relay 服务器** 并输入公网 HTTPS Origin；电脑端使用相同的 `DSH_RELAY` 地址启动 DSH。

## 资源限制

Relay 会在转发前拒绝过大的请求，并使用有界的内存限流和并发计数。默认值适用于 MVP 部署，可以通过环境变量调整：

| 环境变量 | 默认值 | 限制范围 |
| --- | ---: | --- |
| `MAX_API_BODY_BYTES` | 65,536 | JSON API 请求体 |
| `MAX_TUNNEL_BODY_BYTES` | 2,097,152 | 单个转发 HTTP 请求 |
| `MAX_TUNNEL_RESPONSE_BYTES` | 33,554,432 | 单个转发 HTTP 响应 |
| `MAX_WS_PAYLOAD_BYTES` | 4,194,304 | 单个入站 WebSocket Frame |
| `MAX_PENDING_HTTP_PER_DEVICE` | 32 | 每台电脑的并发 HTTP 隧道 |
| `MAX_TUNNEL_WS_PER_DEVICE` | 16 | 每台电脑的并发 WebSocket 隧道 |
| `MAX_PENDING_HTTP_GLOBAL` | 512 | 单个 Relay 实例的并发 HTTP 隧道 |
| `MAX_TUNNEL_WS_GLOBAL` | 256 | 单个 Relay 实例的并发 WebSocket 隧道 |
| `API_RATE_LIMIT_PER_MINUTE` | 300 | 每个客户端地址的 API 请求 |
| `AUTH_RATE_LIMIT_PER_MINUTE` | 20 | 每个客户端地址的额外鉴权限制 |
| `PAIR_RATE_LIMIT_PER_MINUTE` | 30 | 每个客户端地址的额外配对限制 |
| `TUNNEL_RATE_LIMIT_PER_MINUTE` | 600 | 每个客户端地址的转发 HTTP 请求 |
| `WS_UPGRADE_RATE_LIMIT_PER_MINUTE` | 120 | 每个客户端地址的 WebSocket Upgrade |

限流计数有意保存在实例本地，与 MVP 单实例架构保持一致。过期的 Refresh Token、配对会话、访问会话和事件会在启动时清理，此后每 15 分钟清理一次。

## 移动版本策略

公开接口 `GET /app/version?platform=android|ios` 用于驱动移动应用的更新提示。每个平台可以独立配置：

```bash
APP_ANDROID_LATEST_VERSION=0.2.0
APP_ANDROID_MINIMUM_VERSION=0.1.3
APP_ANDROID_DOWNLOAD_URL=https://play.google.com/store/apps/details?id=io.github.apriljk.dshremote
APP_ANDROID_RELEASE_NOTES=Improved remote session stability.
APP_IOS_LATEST_VERSION=0.2.0
APP_IOS_MINIMUM_VERSION=0.1.3
APP_IOS_DOWNLOAD_URL=https://apps.apple.com/app/id0000000000
APP_IOS_RELEASE_NOTES=Improved remote session stability.
```

提高 `LATEST_VERSION` 会显示可关闭的更新提示。只有必须阻止旧版使用时才提高 `MINIMUM_VERSION`。提高任一版本前，必须先配置有效的平台下载地址。

## 许可证

[MIT](LICENSE)

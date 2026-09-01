# dsh-plugin-feishu — DSH 飞书通讯插件

借鉴 hermes 飞书通信架构，移植为 DSH 的 cordis 插件。
架构：`FeishuAdapter → AgentLoop → ToolLayer → ApprovalFlow`，全程官方标准件。

## 架构（对齐 hermes）

| hermes 组件 | 本插件 |
|---|---|
| plugins/platforms/feishu/adapter.py | `FeishuAdapter`（官方 `@larksuiteoapi/node-sdk` WebSocket 长连接） |
| agent.conversation_loop | `AgentLoop`（DeepSeek function-calling 循环） |
| exec approvals / authz | `ApprovalFlow`（系统级命令 → 飞书审批） |
| tools (terminal/file) | `ToolLayer`（read_file / list_dir / write_file / exec_command） |

## 文件结构

```
dsh-plugin-feishu/
├── package.json          # cordis bundle 声明 (dsh.bundle.patch)
├── cordis.patch.yml      # 插件注册 entry
└── lib/
    ├── index.js          # 插件入口 (apply/inject) + 独立运行 run()
    ├── run.mjs           # 独立运行入口
    ├── agent-loop.js     # DeepSeek function-calling 循环
    └── tools.js          # 工具层 + 系统级命令拦截
```

## 功能

- **飞书收发**：官方 SDK WebSocket 长连接（事件订阅 im.message.receive_v1）
- **工具调用**：读文件 / 列目录 / 写文件 / 执行命令（DeepSeek 自主决策）
- **权限策略**：除系统级修改外全开放；系统级命令 → 飞书审批（用户回复【批准】/【拒绝】）
- **多用户**：按 open_id 白名单响应（`allowedUsers` 配置）

## 运行方式

### 1. 独立运行（验证/开发）

```bash
cd dsh-plugin-feishu
node lib/run.mjs
```

### 2. cordis 插件（已注册到 DSH web profile）

- 插件已 symlink 到 `~/.dsh/profiles/node_modules/dsh-plugin-feishu`
- web profile 的 `package.json` bundles 已添加 `dsh-plugin-feishu`
- 插件自带 `cordis.patch.yml` 注册 entry（id: dsh-feishu）
- **重启 DSH web 后生效**（`dsh web` 或 GUI 进程重启）

## 配置

| 配置项 | 来源 | 默认 |
|---|---|---|
| appId | cordis config / env DSH_FEISHU_APP_ID | cli_YOUR_FEISHU_APP_ID |
| appSecret | env DSH_FEISHU_APP_SECRET / config / 默认 | (内置) |
| allowedUsers | cordis config / env DSH_FEISHU_ALLOWED_USERS | 当前用户 open_id |

## 已验证（2026-08-18）

- ✅ 官方 SDK WebSocket 连接就绪
- ✅ 消息接收（用户飞书消息实时捕获）
- ✅ agent 循环（DeepSeek function-calling）
- ✅ 工具调用（read_file 读取文件并总结）
- ✅ **审批流端到端**：用户发"执行 sudo whoami" → 审批询问 → 用户【批准】→ 执行返回 root → 回复结果
- ✅ cordis 配置合成（`dsh --profile web --dump-config` 显示 dsh-feishu entry）

## 注意事项

- 长连接为集群模式：同一 app 同时只能有一个活跃客户端收消息（独立实例与 cordis 实例不能并存）
- appSecret 不在 cordis.patch.yml 存放；DSH web 进程需 env 提供 DSH_FEISHU_APP_SECRET（或接受内置默认）
- 工具执行 cwd 默认工作区，命令超时 60s

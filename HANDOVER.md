# forksession 交接摘要（新会话入口）

> 写于 2026-11-17 15:20。本文件是给**新开发会话**的接续入口：先读本文 → 再读 dev-log 尾部。
> 背景：本开发会话（076b65ba）上下文已达 56 万 token，每次工具调用重发 ≈56 万 token，ds4.1 上已消耗 3.37 亿 token。
> 今后开发请**按工作单元开新会话**（dev-log + 本文件 + 仓库即全部记忆）。

## 一、项目一句话

`forksession` = DSH 的飞书桥接插件（/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu），把飞书消息变成"主干调度 + 树叶工作"的四级会话树（L1 主干 → L2 树干 → L3 领域 → L4 事件叶）。仓库: github.com/Methu-Xie/forksession（private，main @ 7dd1890 之后）。

## 二、当前架构（v0.2 + 守卫层，全部已验证）

```
飞书消息 → 主干(唯一)决策 → REPLY 直答 / STEER 续作某叶 / CREATE 建叶 / MULTI 拆解 / ASK 反问
叶执行 → 产出回传主干 → 主干汇总 → 飞书回复
```

**协议**: `[[REPLY]]` `[[STEER]]{sessionId,text}` `[[CREATE]]{l2,domain,topic,text}` `[[MULTI]] [...]` `[[ASK]] 问题`

**确定性守卫（关键设计，LLM 方差压不住时兜底）**，均在 `lib/index.js`:
1. `mirrorToMain` 头部守卫（system/message 未实体化禁止 append）
2. `findReplyHijack` REPLY 劫持守卫（tag+desc 最长公共子串 ≥3；词序变体规则：修改动词+共享双字词≥2）
3. REPLY 建叶守卫（TASK_SIGNAL 工作意图 → CREATE）
4. 平台词纠偏（飞书功能词限定飞书生态）
5. MULTI 守卫（`parseCompoundItems` 编号拆解，逐项独立调度）
6. 轮换头部守卫（无 system/message 禁止轮换）

**主干轮换**: 每日轮换（`main-session.json` 的 `day` 字段，跨日首条消息触发，对齐 hermes）+ token 阈值兜底（`mainMaxTokens` 默认 40000）。轮换 = 记忆精炼（`eventsToText` 10000 字符尾部截断）→ 新代 seed（`buildRotationSeed` v2：过滤 developer/message + system/message + headerSeq）。

**模型路由**: `modelFor(isMain)` 统一 setup/agentOptions 双源（不一致会被运行时拒绝整轮）。默认 `deepseek-official/deepseek-flash`（ds4.1）；`config.local.json` 可配 `mainModel`/`leafModel`。

**沙箱开发模式**: `~/.dsh-sandbox` + `dsh-web-sandbox.service`(3090) + mock 通道（mock-inbox.jsonl 注入 / mock-outbox.jsonl 回收）+ 主会话自举。脚本: `sandbox-sync.sh`（同步代码）/ `sandbox-reset.sh`（重置，**保留 usage-audit.jsonl**）。

**使用量审计**: `sweepUsage()` 每 30s 扫活会话 events + 离线 zstd 转录，落 `usage-audit.jsonl`（插件根，重置不清）。插件直连 API（chatText）以 `sessionId=plugin:chat` 入账。

**命令**: `/setmain <id>` `/tree` `/trace <id>` `/archive [叶名]`（v0.3 首项，已实现）

## 三、已验证结论（可直接信任）

| 项 | 结论 |
|---|---|
| 32 用例沙箱套件（ds4.1） | **30/32 达标**；失败 #13 词序变体（守卫已增强）、#27 驱动漏读（已修）→ **增强后最终回归未跑完**（被误重置打断） |
| 仿真 bench `route-test.mjs` | D 25/25，A 23/25（旧链基线），冻结 fixture 保证可复现 |
| 轮换 | 种子 v2 修复后连续轮换成功、新代自动 ds4.1、零损坏转录 |
| 每日轮换 | 伪造昨日日期实测触发 ✓ |
| `/archive` | 列表→归档→注册表状态全链 ✓ |
| deepseek 叶 TRANSPORT | 根因=中文 sessionId 进 HTTP 头（`x-deepseek-harness-session-id`）→ 适配器热修 `encodeURIComponent`（`patch-dsh-deepseek-sessionid.sh`，dsh 升级后需重跑） |
| token 优化 | 轮换精炼输入 1.3 万→2-4 千；阈值 4 万；直连记账 ✓ |

## 四、待办（按优先级）

1. **跑完增强守卫后的最终 32 用例回归**（沙箱空闲时）：`bash sandbox-sync.sh && bash sandbox-reset.sh` 后 `node sandbox-suite.mjs`，预期 ≥31。
2. **生产验证**：下条飞书消息应触发主干轮换（42 万 token 老主干 → 新代 ds4.1），检查 `♻️ 主干轮换完成`。
3. **v0.3 Backlog**: 自一致性投票（残余 LLM 方差的结构性治本，如 ASK 兜底策略）；结构化卡片回复；跨叶记忆检索。
4. **token 治理**: 开发会话按工作单元新建；compaction 已收紧（30%/10%，重启生效）。

## 五、新会话启动清单

1. 读本文件 → 读 `forksession-dev-log.md` 最后 3-5 条
2. 确认生产状态: `systemctl --user status dsh-web.service` + `tail -30 "<插件>/plugin.log"`
3. 沙箱: `systemctl --user status dsh-web-sandbox.service`（3090）
4. 凭据/路径: 插件 `config.local.json`、hermes .env（DeepSeek key）、`~/.dsh-sandbox/dsh-plugin-feishu/config.local.json`
5. 先跑一轮快速健康检查再开发（sim 或单个沙箱消息）

## 六、已知坑（踩过的）

- **中文 session id 进 HTTP 头** → deepseek TRANSPORT（已热修，升级需重跑脚本）
- **模型双源不一致** → "request proposed X after step preparation fixed Y" 整轮拒绝
- **沙箱重置会清 sessions/plugin.log**（审计账本保留）——**套件运行中禁止重置**（会崩驱动）
- **套件驱动** 必须用字节偏移读日志（UTF-8 中文），MULTI 守卫行无 🧠 父决策行
- **仿真基准树会漂移**（实时复制生产 registry）→ 已用冻结 fixture
- 我（AI）不要在 dsh-web 进程内重启它自己：用 `setsid bash -c 'sleep N; systemctl --user restart dsh-web.service'` 延时重启

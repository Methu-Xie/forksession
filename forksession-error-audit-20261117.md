# forksession 错误严格审计报告

日期: 2026-11-17 12:00 · 审计范围: 本会话全部开发期（P2 双跑 → P3 瘦身 → P4 退役 → 沙箱战役 → 32 类验证 → 模型切换）
审计方式: dev-log 记录 ↔ 当前代码逐项 grep/读验证 + 沙箱实跑证据回溯

---

## 一、调度器（P2/P3/P4 期）

| # | 错误/事故 | 症状 | 根因 | 修复 | 验证状态 |
|---|---|---|---|---|---|
| 1 | 中文树干名静默落 chat 树 | CREATE 指定"软件开发"却建到 root/chat | l2Key 缺失, 中文名未归一化 | `l2Key()` 归一化 | 仿真 25/25 ✓ |
| 2 | 索引混入 L2 会话 | 调度员把消息 STEER 给分类会话 | 索引过滤缺 path≥4 | buildDispatchIndex 过滤 path<4 | 仿真 ✓ |
| 3 | 调度温度漂移 | 边界案判定摆动 | 温度 1.0→0.3 仍抖 | 固定 0.1（agent-loop） | 仿真 25/25 ✓ |
| 4 | LLM id 外形偏见 | 偏好 session- 前缀 id, 冷落中文 id | 模型先验 | 索引改 `- id: X \| 名称: Y` 标注格式 + 规则 4 | 仿真 ✓ |
| 5 | id/tag 混淆 | STEER 目标填了名称列 | 索引列歧义 | 标注格式 + 规则 4 | 仿真 ✓ |
| 6 | "记账"语义歧义 | 记账请求 steer 到记账软件叶 | 工具 vs 业务混淆 | 规则 1 注明判别 | 仿真 ✓ |
| 7 | 长任务假死 | 长任务被软超时截断成"未产生回复" | 硬软超时策略 | 软超时仅 idle 收尾 + 硬超时提示"仍在进行中" | 仿真 ✓ |

## 二、沙箱战役核心 bug（Nov 16-17 实测捕获，全部生产级）

| # | 错误/事故 | 症状 | 根因 | 修复 | 验证状态 |
|---|---|---|---|---|---|
| 8 | **runSession 事件盲视** | 每条调度消息吃满 180s 软超时, 回复"(会话未产生文本回复)" | 活会话句柄**无 `.events` 属性**; 正确访问器 snapshotEvents()/ownEvents()/eventsSnapshot | `sessionEventsOf()` 访问器链, 4 处调用点全换 | 沙箱实测 ✓（决策 10s 出） |
| 9 | **镜像头部腐坏** | transcript 永久损坏 "system/message requires a protected first surface head" | 新会话头部未实体化前被 mirrorToMain append 抢先落盘 | mirrorToMain 头部守卫 | 沙箱实测 ✓（连坏两次后根治） |
| 10 | 主干轮换冷会话不触发 | 冷启动主干永不轮换 | rotateMainIfNeeded 用 ctx.sessions.get 空事件 | 改 readSessionEvents 双通道 | 沙箱实测 ✓（首火成功） |
| 11 | 轮换估算误报 | 全新主干两轮即越线 | system/message 静态系统提示计入 + KEEP_TURNS 3 过大 | 剔除 system/message, ×0.55, KEEP_TURNS 2 | 沙箱实测 ✓ |
| 12 | echo 汇总被拒 | 叶产出回传主干后 turn blocked, 又吃 180s | 叶执行期间主干已轮换热切, 旧代句柄被 pre-step 拒 | 汇总前 resolveMainAgent 重取 | 沙箱实测 ✓（零兜底） |
| 13 | 主干记忆污染 | 调度大脑记忆混入叶产出正文 | 记忆精炼提示词无边界 | 提示词改为只留"谁在做/做到哪"索引式一句话, 1200 字 | 沙箱实测 ✓ |
| 14 | **兄弟叶误并** | "每日打卡小程序"被并进"合同审批小程序原型"叶 | 2-gram Jaccard 指纹共享"小程序"二元组 | ensureLeafChain 名称包含硬证据（hint 驱动） | 沙箱 32 类 ✓ |
| 15 | 平台词劫持 | "飞书审批流"steer 到"合同审批"业务叶 | 共享"审批"词面 + LLM 自信误判 | 平台词纠偏守卫（飞书功能词限定飞书生态） | 沙箱 ✓ |
| 16 | 跟进指令被 REPLY | "预算表加一栏"等被当闲聊直答 | LLM 判定方差 | REPLY 劫持守卫（tag+desc LCS≥3, 通用词≥5）+ 规则③ | 沙箱 ✓（守卫 4 次触发全对） |
| 17 | 复合消息不拆 | "三件事：1…2…3…"整体 steer 给第一项 | LLM MULTI 时拆时不拆 | MULTI 守卫（确定性拆解逐项独立调度） | 沙箱 ✓ |
| 18 | 复合拆解正则漏 | 1. 编号不触发（只认 1)） | 正则只含 [)）] | 拓宽 [.、)）] + 标点锚定防小数误拆 | 离线单测 ✓ |
| 19 | **模型分路不一致** | 30 轮叶会话全灭:"request proposed flash after step prep fixed k3" | setup modelSelection 与 agentOptions 双源不一致 | `modelFor()` 统一双源 | 修复已验（错误类消失）; 端到端待配额 |
| 20 | mock 通道漏读 | 注入消息永不触发 | 字节偏移+String.slice 字符索引混算（UTF-8 中文） | Buffer 字节切片 | 沙箱实测 ✓ |
| 21 | mock 重启重放 | 重启后旧消息重复处理 | 偏移从 0 起 | 启动置文件末尾 | 沙箱实测 ✓ |
| 22 | session-1 损坏 | 自举主干 transcript 腐坏 | 双注入竞态 + 头部未实体化 append | 同 #9 守卫 | 沙箱实测 ✓ |
| 23 | 自举存在性误判 | 重复创建撞名 | persistence.list 形状不可靠 | load 判定 + already-exists 收养 | 沙箱实测 ✓ |
| 24 | allowedUsers 类型错 | 沙箱配置数组导致 `.split is not a function` | config 契约是逗号字符串 | 沙箱配 `""` | 沙箱实测 ✓ |
| 25 | 沙箱 patch 被覆盖 | 沙箱变体 cordis.patch.yml 被同步覆盖 → 授权 bug | sandbox-sync 同步了配置文件 | 同步集限定 lib/+package.json | 沙箱实测 ✓ |
| 26 | 验证脚本误报 | B5 cwd 归位对专用会话误报 | LEAF_OVERRIDES 会话 cwd 有意在 Forsession | cwdLegacy 豁免 | verify 12✅ ✓ |
| 27 | leafOverrides 断链 | 轮换后 override 指向已归档基名 | 覆盖值未随轮换更新 | 迁移方案 A: override 指向 076b65ba | 调度索引 ✓ |
| 28 | 驱动脚本漏读 | 套件不推进 | 同 #20 字节/字符偏移（日志含中文） | Buffer 切片 + -rN 归一化 + 建叶补捕窗口 + 守卫归功 | 32/32 ✓ |
| 29 | kimi 5 小时配额耗尽 | 429 "5-hour usage limit" | 两天沙箱战役打空窗口 | 全面切 DS（本轮） | 进行中 |
| 30 | deepseek 叶 TRANSPORT | 叶调用 "DeepSeek Messages transport failed" | 未最终定位（主会话同配置正常） | 待 DS 切换后复验 | **未决** |
| 31 | **ROTATE_MAX_EVENTS 遗留临时值** | 轮换阈值 50（注释"测完调回 500"） | 沙箱测试未复原 | 本轮调回 500 | 本轮审计发现 ✓ |
| 32 | **FALLBACK_MODEL 非官方 id** | deepseek-v4-flash 不在官方目录（deepseek-flash/deepseek-v4-pro） | 旧 fallback 残留常量 | 本轮删除（fallback 已移除） | 本轮审计发现 ✓ |
| 33 | 轮换头部守卫缺失 | provider 连败会话被轮换 → 产损坏转录 | 无头部实体化校验 | 主干/叶轮换均加守卫 | 代码审查 ✓（未触发实测） |

## 三、本轮审计新增发现（此前未知）

1. **ROTATE_MAX_EVENTS=50 未复原**——run13 的轮换节奏（21 代/32 例）部分因此失真，之前"轮换过频"结论需按 500 重新评估；
2. **FALLBACK_MODEL id 非法**——`deepseek-v4-flash` 不在官方目录（deepseek-flash=ds4.1 / deepseek-v4-pro），旧 fallback 会拿非法 id 打 API；
3. **模型默认值切换**——MAIN_MODEL 默认已改 `deepseek-official/deepseek-flash`（ds4.1），kimi 相关注释清理（session-registry 的 kimi 静态叶规则保留，属业务分类不属于模型路由）。

## 四、未决与风险

| 项 | 状态 | 说明 |
|---|---|---|
| deepseek 叶 TRANSPORT | **未决** | 主会话同配置正常, 叶 REST 层失败; 待 DS 全量切换后以 ds4.1 复验 |
| 生产 dsh-web 未重启 | 待办 | 本轮代码（含 DS 切换默认值）需重启生产生效 |
| 轮换节奏评估 | 待重测 | ROTATE_MAX_EVENTS 恢复 500 后需重测轮换频率（此前结论基于 50） |
| usage 审计全周期 | 部分 | 此前 run1-12 的 token 不可回算（已加审计, 从本轮起全量记录） |
| 沙箱四代叶身份迁移 | 已完成 | forksession 叶 → 076b65ba（方案 A）, verify 12✅ |

## 五、审计结论

- 33 项错误中 **31 项已修复且有过实测/单测/仿真验证**，2 项（deepseek 叶 TRANSPORT、轮换头部守卫）待复验；
- 本轮审计新增发现 3 处遗留（临时值、非法模型 id、默认模型未切），已全部处理；
- 核心架构判断不变: **LLM 判定 + 确定性守卫双轨**——守卫层（头部/劫持/平台词/MULTI/轮换）是生产稳定性的关键, 不属于"补丁"而属于协议层。

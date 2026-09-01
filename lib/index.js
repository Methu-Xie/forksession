// lib/index.js — dsh-plugin-feishu: DSH 飞书通讯插件（cordis 风格 + 可独立运行）
// 架构对齐 hermes: FeishuAdapter(createLarkChannel) → AgentLoop(DeepSeek) → ToolLayer → ApprovalFlow
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runAgentTurn, chatText } from './agent-loop.js';
import classifyRules from './classify-rules.js'; // 分类规则活文件, 随时按工作内容增改
import { extractKeyFacts, BranchStore, llmSemanticRoute, matchScore } from './root-branch.js'; // root-branch 分类机制
import { SessionRegistry, TAXONOMY, LEAF_WS_ROOT, classifyPath, formatPath } from './session-registry.js'; // 四级分类注册表（可分类+可追溯）
import { APP_ID as DEFAULT_APP_ID, ALLOWED_USERS as DEFAULT_ALLOWED_USERS, MAIN_SESSION_ID, MAIN_SESSION_FILE, WS_JSON, LAST_ACTIVE_FILE, WORKDIR, HOME } from './config.js'; // 本地配置（脱敏边界）
import { leafMemoryPath, eventsToText, buildRotationSeed } from './leaf-memory.js'; // 树叶记忆 + 压缩轮换
import { dirname } from 'node:path';

// 长叶轮换阈值（2026-08-21 用户裁定: 长叶旧轮次压缩回收进记忆文件）
const ROTATE_MAX_EVENTS = 50;   // 【轮换实测临时值, 测完调回 500】事件数超此值触发轮换
const ROTATE_KEEP_TURNS = 3;    // 轮换后保留最近 N 轮原文, 更早的进记忆文件

// L2 树干 id → 中文名（语义路由 LLM 纠偏用）
const TAXONOMY_NAMES = Object.fromEntries(Object.entries(TAXONOMY).filter(([, v]) => v.level === 'L2').map(([k, v]) => [k, v.name]));

import { LOG_FILE } from './config.js';
// 最后活跃分类会话记录: 重启后 autoResumeReport 靠它知道"重启前在忙哪个会话", 自动唤醒汇报
// LAST_ACTIVE_FILE 等本地常量统一由 lib/config.js 提供（脱敏边界）

// 模型路由: 主模型 = Kimi K3 (Kimi Code 订阅, kimi-coding provider), 副模型 = deepseek-v4-flash
// 每个分类会话 agent 默认走主模型; 主模型请求失败时自动切换副模型并重试一次（见 makePresetSetup）
const MAIN_MODEL = { provider: 'kimi-coding', model: 'k3' };
const FALLBACK_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };

// 项目级路由（L4 树叶机制）: 含项目关键词的飞书消息 → 固定专属会话
// 特点: 会话 id 无日期后缀、跨天持久；匹配优先级高于 classify-rules.js 的任务分类
// 新增项目 = 在此数组追加一条 { project, sessionId, patterns }，无需改其他逻辑
// 2026-08-21 决议: forksession 开发改用 Web 端手动专用会话（独立工作区），
// 不再由飞书桥自动生成 feishu-forksession —— 吃狗粮规则退役，规则表清空，禁止自动重建多余会话。
const PROJECT_ROUTES = [];

// ── 内容驱动的自动建叶（forksession 本质功能）────────────────────────
// L1 主对话内容 → 自动分类 L2→L3→L4；无对应树叶会话则按层次顺序自动创建（fork 主干）
// 只对这些 L2 树干自动建叶（事务性工作）；闲聊/查询/运维类不产生树叶
const AUTO_LEAF_L2 = new Set(['dev', 'business', 'legal', 'study', 'feishu']);
// 任务信号: 含有"做事"动词才算一个"事件", 避免每句闲聊都长树叶
const TASK_SIGNAL = /(开发|实现|修复|设计|整理|撰写|写一|写个|写份|部署|调试|排查|分析|对比|评估|调研|总结|翻译|制定|方案|计划|报告|脚本|代码|搭建|优化|重构|测试|制作|起草|编制|汇总|收拢)/;
// L4 树叶专属出口: 该树叶不自动建 feishu 会话, 固定路由到指定既有会话
// forksession → Web 端手动专用开发会话（2026-08-21 决议: 维护升级只用那个会话, 禁止自动重建）
import { LEAF_OVERRIDES } from './config.js';

// L1 主干会话显式标识（飞书串联主对话的唯一归属地）
// ⚠️ 不要用"initiator / 第一个 live agent / session- 前缀"启发式选主会话——
//    多 web 会话并存时必选错（2026-08-21 串联同步消息误入 forksession 开发会话事故）
// 主干可通过 main-session.json 或飞书指令 /setmain <sessionId> 热切换
// （如 feishusession 上线后指向它），无需改代码；本常量只是兜底默认值




// 飞书 markdown 格式化（学习 hermes: 受控格式 + 清理不支持元素）
// 飞书 lark_md 支持: 加粗/斜体/行内代码/代码块/链接/列表/引用/emoji
// 不支持或渲染差: 表格/多级标题/水平线/HTML 标签 → 转换或移除
function formatForFeishu(md) {
  const out = [];
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\r/g, '');
    const t = line.trim();
    if (!t) continue;
    // 表格行 → 项目列表（取非空单元格）
    if (/^\|.*\|$/.test(t) && t.includes('|')) {
      const cells = t.split('|').map((s) => s.trim()).filter(Boolean);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      if (cells.length >= 2) { out.push(`• ${cells.join(' ｜ ')}`); continue; }
    }
    // 标题 #~### → 加粗（飞书对多级标题支持差）
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) { out.push(`**${h[2]}**`); continue; }
    // 水平线 → 忽略
    if (/^(---+|\*\*\*+|___+)$/.test(t)) continue;
    // 移除 HTML 标签（飞书不渲染）
    const cleaned = line.replace(/<[^>]+>/g, '');
    out.push(cleaned);
  }
  // 压缩连续空行为单个换行段落
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function makeLogger(log) {
  return (...a) => {
    const line = `[${new Date().toISOString()}] ${a.map(String).join(' ')}`;
    try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
    if (log) log(...a);
    else console.log(line);
  };
}





const SYSTEM_PROMPT = `你是 DSH（大肥鱼），运行在用户的机器上，通过飞书与用户交流。
你的工作目录（工作区）是 ${WORKDIR}，用户的工作都在这。文件操作请直接使用该绝对路径，不要全盘搜索。
你有以下工具可用：
- read_file: 读取文件（绝对路径）
- list_dir: 列目录（绝对路径）
- write_file: 写文件（绝对路径）
- exec_command: 执行 shell 命令（默认在工作目录执行）
权限策略: 除系统级修改（安装软件、改系统配置、systemctl、sudo 等）需要用户审批外，其他读写和命令执行全部开放。
系统级命令会触发审批，用户批准后才执行。
【重要约束】禁止修改本插件目录下的任何插件代码与配置文件（lib/*.js、package.json、cordis.patch.yml 等）——那是 DSH 系统的自身组件，由主会话维护。用户未明确要求改插件代码时，绝不对其 write_file 或 exec 修改。
回复用户时用简洁友好的中文，直接回答。`;

function resolveSecret(config) {
  if (config?.appSecret) return config.appSecret;
  if (process.env.DSH_FEISHU_APP_SECRET) return process.env.DSH_FEISHU_APP_SECRET;
  return 'tGm3RJwzNEW4N3oMUtAKRha3JAtmEKuv';
}

class DSHFeishuBot {
  constructor({ appId = DEFAULT_APP_ID, appSecret, allowedUsers, log, ctx } = {}) {
    this.ctx = ctx;
    this.appId = appId;
    this.appSecret = resolveSecret({ appSecret });
    this.allowedUsers = (allowedUsers || process.env.DSH_FEISHU_ALLOWED_USERS || DEFAULT_ALLOWED_USERS)
      .split(',').map((s) => s.trim()).filter(Boolean);
    this.channel = null;
    this.pendingApprovals = new Map(); // chatId -> { command, resolve }
    this.categoryAgents = new Map();   // 任务类别 -> { sessionId, agent }（独立会话池）
    this.branchStore = new BranchStore(); // root-branch 分支注册表（关键事实指纹路由）
    this.sessionRegistry = new SessionRegistry(); // 四级分类注册表: 所有会话可分类(L1-L4 路径)+可追溯(parent 链)
    this.leafAgents = new Map();        // 树叶会话池: sessionId -> { sessionId, agent }（自动建叶机制）
    this.log = log || makeLogger();
  }

  // ApprovalFlow: 系统级命令 → 飞书审批 → 用户批准/拒绝
  // ApprovalFlow: 系统级命令 → 飞书交互卡片审批（按钮）→ 用户点击批准/拒绝
  requestApproval(chatId) {
    return (command) =>
      new Promise((resolve) => {
        const aid = crypto.randomUUID();
        this.pendingApprovals.set(chatId, { command, resolve, aid });
        const card = {
          config: { wide_screen_mode: true },
          header: {
            template: 'red', title: { tag: 'plain_text', content: '⚠️ 需要你的审批' },
          },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `DSH 请求执行**系统级命令**：\n\`\`\`\n${command}\n\`\`\`` } },
            {
              tag: 'action', actions: [
                { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '✅ 批准' }, value: { aid, decision: 'approve' } },
                { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '🚫 拒绝' }, value: { aid, decision: 'reject' } },
              ],
            },
          ],
        };
        this.channel.send(chatId, { card }).catch((e) => {
          this.log('审批卡片发送失败:', e.message);
          this.pendingApprovals.delete(chatId);
          resolve(false);
        });
      });
  }

  // 卡片按钮点击处理
  async handleCardAction(evt) {
    try {
      const value = evt.action?.value || {};
      const aid = value.aid;
      if (!aid) return;
      const chatId = evt.chatId;
      // 找该 chat 的 pending 审批
      const pending = this.pendingApprovals.get(chatId);
      if (!pending || pending.aid !== aid) return;
      if (value.decision === 'approve') {
        pending.resolve(true);
        this.pendingApprovals.delete(chatId);
        this.channel.send(chatId, { markdown: '✅ 已批准，正在执行…' }).catch(() => {});
      } else {
        pending.resolve(false);
        this.pendingApprovals.delete(chatId);
        this.channel.send(chatId, { markdown: '🚫 已取消该命令。' }).catch(() => {});
      }
    } catch (e) {
      this.log('卡片处理错误:', e.message);
    }
  }

  async handleApprovalReply(chatId, text) {
    const pending = this.pendingApprovals.get(chatId);
    if (!pending) return false;
    if (/批准|同意|允许|yes|ok|确认/i.test(text)) {
      pending.resolve(true);
      this.pendingApprovals.delete(chatId);
      this.channel.send(chatId, { markdown: '✅ 已批准，正在执行…' }).catch(() => {});
    } else if (/拒绝|不同意|no|取消/i.test(text)) {
      pending.resolve(false);
      this.pendingApprovals.delete(chatId);
      this.channel.send(chatId, { markdown: '🚫 已取消该命令。' }).catch(() => {});
    } else {
      this.channel
        .send(chatId, { markdown: '请回复 **【批准】** 或 **【拒绝】**。' })
        .catch(() => {});
    }
    return true;
  }

  // 发送文件到飞书会话（上传素材 + file 消息）
  async sendFile(chatId, filePath) {
    const { readFileSync, basename } = await import('node:fs');
    const file = readFileSync(filePath);
    const name = filePath.split('/').pop();
    try {
      const up = await this.channel.rawClient.im.v1.file.create({
        data: { file_type: 'stream', file_name: name, file },
      });
      const fileKey = up.file_key || up.data?.file_key;
      if (!fileKey) throw new Error(`upload no file_key: ${JSON.stringify(up.data).slice(0, 200)}`);
      const msg = await this.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });
      this.log(`✅ 文件已发送: ${name} (${file.length} bytes) msg=${msg.data?.message_id}`);
      return true;
    } catch (e) {
      this.log(`文件发送失败: ${e.message}`);
      return false;
    }
  }

  // 发送图片到飞书会话（上传 + image 消息）
  async sendImage(chatId, imagePath) {
    const { readFileSync } = await import('node:fs');
    try {
      const file = readFileSync(imagePath);
      const up = await this.channel.rawClient.im.v1.image.create({
        data: { image_type: 'message', image: file },
      });
      const imageKey = up.image_key || up.data?.image_key;
      if (!imageKey) throw new Error(`upload no image_key: ${JSON.stringify(up).slice(0, 200)}`);
      const msg = await this.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      });
      this.log(`✅ 图片已发送: ${imagePath.split('/').pop()} msg=${msg.data?.message_id}`);
      return true;
    } catch (e) {
      this.log(`图片发送失败: ${e.message}`);
      return false;
    }
  }

  // 下载图片资源到 feishu-inbox/images/
  async downloadImage(msg) {
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const res = msg.resources?.[0];
      if (!res?.fileKey) return null;
      const dir = `${WORKDIR}/feishu-inbox/images`;
      mkdirSync(dir, { recursive: true });
      const ext = res.type === 'image' ? '.png' : '.bin';
      const name = `feishu_${Date.now()}${ext}`;
      const r = await this.channel.rawClient.im.v1.messageResource.get({
        path: { message_id: msg.messageId, file_key: res.fileKey },
        params: { type: 'image' },
      });
      let buf = null;
      if (Buffer.isBuffer(r)) buf = r;
      else if (r?.getReadableStream) {
        const stream = r.getReadableStream();
        const chunks = [];
        for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        buf = Buffer.concat(chunks);
      } else if (r?.data) buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data);
      if (!buf) return null;
      const path = `${dir}/${name}`;
      writeFileSync(path, buf);
      this.log(`✅ 图片已保存: ${path} (${buf.length} bytes)`);
      return path;
    } catch (e) {
      this.log(`图片下载失败: ${e.message}`);
      return null;
    }
  }

  // 解析回复中的标记 [file:路径]/[image:路径] 并发送, 返回去除标记后的文本
  async sendFilesFromReply(chatId, reply) {
    let text = reply;
    const imgRe = /\[image:([^\]]+)\]/g;
    let m;
    while ((m = imgRe.exec(reply)) !== null) {
      const p = m[1].trim();
      if (p) { await this.sendImage(chatId, p); text = text.replace(m[0], ''); }
    }
    const re = /\[file:([^\]]+)\]/g;
    while ((m = re.exec(reply)) !== null) {
      const p = m[1].trim();
      if (p) { await this.sendFile(chatId, p); text = text.replace(m[0], ''); }
    }
    return text.trim();
  }

  // 通用会话执行: 注入消息到 agent, 等待完成, 返回最终文本（不发送飞书）
  // 供分类调度编排: 分会话执行专项任务 / 主会话汇总回复
  // 超时策略: 软超时只收"卡住"的尾（idle 才收尾）; agent 仍在工作则继续等到硬超时——
  // 长任务（调研/多步工具）动辄数分钟, 硬砍会让在跑的工作变成"(会话未产生文本回复)"
  async runSession(agent, text, { timeoutMs = 180000, hardCapMs = 900000 } = {}) {
    const message = {
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: crypto.randomUUID() },
      role: 'user',
      id: crypto.randomUUID(),
    };
    let session = null;
    try { session = this.ctx.sessions?.get(agent.id); } catch {}
    const beforeSeq = session?.events?.length ?? 0;
    this.log(`steer 会话(${agent.id}):`, text.slice(0, 80));
    agent.steer(message);

    const softDeadline = Date.now() + timeoutMs;
    const hardDeadline = Date.now() + hardCapMs;
    const replies = [];
    let lastTurnEndSeq = -1;
    let busyAtHardCap = false;
    while (Date.now() < hardDeadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        session = this.ctx.sessions?.get(agent.id);
        const events = session?.events ?? [];
        const fresh = events.slice(beforeSeq);
        for (const ev of fresh) {
          if (ev.type === 'assistant/message') {
            const m = ev.data?.message;
            if (m?.role === 'assistant') {
              const blocks = m.content || [];
              if (!blocks.some((b) => b.type === 'tool-call')) {
                const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
                if (t) replies.push(t);
              }
            }
          } else if (ev.type === 'turn/end') {
            lastTurnEndSeq = ev.seq;
          }
        }
      } catch (e) { this.log('读会话事件失败:', e.message); }
      const idle = agent.status === 'idle' || agent.status === 'maintenance';
      // 正常完成: idle + 有文本回复 + turn 结束
      if (idle && replies.length > 0 && lastTurnEndSeq >= 0) break;
      // 软超时: 仅当 agent 空闲（卡住/无产出）才收尾; 仍在工作就继续等
      if (Date.now() > softDeadline && idle) break;
      if (Date.now() >= hardDeadline - 2000 && !idle) busyAtHardCap = true;
    }
    if (!replies.length && busyAtHardCap) return '(任务仍在进行中，耗时超过预期；可稍后发"继续"收取结果)';
    return replies.length ? replies[replies.length - 1] : '(会话未产生文本回复)';
  }

  // 发送到飞书（格式化 + 附件标记）
  async sendToFeishu(chatId, reply) {
    const cleaned = await this.sendFilesFromReply(chatId, reply);
    if (cleaned) {
      this.channel.send(chatId, { markdown: formatForFeishu(cleaned).slice(0, 2000) })
        .then(() => this.log('✅ 回复已发送到飞书'))
        .catch((e) => this.log('回复失败:', e.message));
    } else {
      this.log('⚠️ 无文本可发送 (clean empty)');
    }
  }

  // 解析一个可用的 web agent: 优先当前 initiator, fallback 到任意 live agent
  resolveWebAgent() {
    if (!this.ctx?.agents) return null;
    try {
      const initiator = this.ctx.agents.requireInitiator();
      if (initiator) return { agent: initiator, mode: 'inject' };
    } catch { /* 无 active initiator */ }
    const agents = this.ctx.agents.list();
    if (agents.length) return { agent: agents[0], mode: 'steer' };
    return null;
  }

  // 项目级路由: 含项目关键词的消息 → 固定专属会话（先于任务分类, 规则见 PROJECT_ROUTES）
  // 返回 { project, sessionId } 或 null（null 时走 classifyTask 任务分类）
  routeProject(text) {
    for (const p of PROJECT_ROUTES) {
      for (const re of p.patterns) {
        if (re.test(text)) return p;
      }
    }
    return null;
  }

  // 任务分类: 不同类任务 → 独立会话（隔离上下文, 同类任务复用）
  // 规则来自 classify-rules.js（可随时编辑的活规则, 维护说明见 CLASSIFY_MAINTENANCE.md）
  classifyTask(text) {
    for (const rule of classifyRules.rules) {
      for (const re of rule.patterns) {
        if (re.test(text)) return rule.category;
      }
    }
    return classifyRules.fallback;
  }

  // 构建分类会话 agent 的 setup 钩子（统一 create/resume/自动唤醒共用）:
  // 1) 必须 join agent preset，否则工具/提示词段在空全局层解析（模型只能编 XML 假调用）
  // 2) 注入飞书桥接场景指令（分类会话无历史上下文）
  // 3) 模型路由: 主模型 K3 + 副模型 deepseek-v4-flash —— 每次请求按当前选择路由,
  //    主模型请求失败一次后自动切副模型并重试（dsh agent/request-error + agent/request 瀑布）
  makePresetSetup(category, leafMemPath = null) {
    const modelSelection = { current: { ...MAIN_MODEL } };
    let fallbackUsed = false;
    return async (agentCtx) => {
      // 用插件 ctx 的服务实例（agentCtx 属性访问会触发 cordis "without inject" 保护）
      await this.ctx.agentPresets?.mount(agentCtx, 'standard');
      agentCtx.systemPrompt?.section({
        name: 'feishu-bridge',
        order: 200,
        text: '你正在通过飞书与用户对话（DSH 飞书桥接会话，你是 DSH 大肥鱼的分类任务会话）。用户消息来自飞书。请直接回答用户的问题并完成请求，不要使用 ask_user_question 等需要用户额外输入的交互工具——你的最终回复会自动发送回飞书。用简洁友好的中文回复。',
      });
      // 树叶记忆指令（学 hermes MEMORY.md 机制: 开工先读, 阶段完成即策展更新）
      if (leafMemPath) {
        agentCtx.systemPrompt?.section({
          name: 'leaf-memory',
          order: 201,
          text: `你是 L4 树叶专项会话。你的持久工作记忆文件: ${leafMemPath}（跨轮次、跨会话轮换存续）。要求: 1) 开始工作前先读它恢复记忆; 2) 每完成一个阶段性工作, 就精炼地更新它——关键事实/决策/进展/交付物路径/待办, 覆盖式维护, 保持精简, 不写流水账。`,
        });
      }
      // 提示词组装时同步 {{model}} 变量（persona 段落与真实路由保持一致）
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next();
        const sel = modelSelection.current;
        if (!sel) return assembled;
        return { ...assembled, variables: { ...assembled.variables, provider: sel.provider, model: sel.model } };
      });
      // 每次请求按当前模型选择路由（镜像 dsh-agent installModelSelection 语义）
      agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next();
        const sel = modelSelection.current;
        if (!sel) return resolved;
        const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
        return {
          ...withoutInheritedEffort,
          provider: sel.provider,
          model: sel.model,
          ...(sel.reasoningEffort === void 0 ? {} : { reasoningEffort: sel.reasoningEffort }),
        };
      });
      // 主模型请求失败 → 切换到副模型并重试一次（之后不再切回, 避免来回横跳）
      agentCtx.on('agent/request-error', (payload, next) => {
        const sel = modelSelection.current;
        if (!fallbackUsed && sel && payload.provider === sel.provider) {
          fallbackUsed = true;
          modelSelection.current = { ...FALLBACK_MODEL };
          this.log(`⚠️ 主模型 ${sel.provider}/${sel.model} 请求失败(${payload.failure?.code || 'unknown'}), [${category}] 会话切换副模型 ${FALLBACK_MODEL.provider}/${FALLBACK_MODEL.model} 重试`);
          return { kind: 'retry' };
        }
        return next();
      });
    };
  }

  // 查找该分类最近一次的历史会话 id（重启/跨天后用户继续重启前的工作）
  // 会话按天隔离 (feishu-<分类>-<YYYY-MM-DD>)，重启后只接当天会话会丢掉旧上下文；
  // 这里通过 sessionPersistence.list() 找到该分类日期最大且 < 今天的历史会话续接。
  async findLastCategorySessionId(category) {
    try {
      const persistence = this.ctx?.get?.('sessionPersistence');
      if (!persistence?.list) return null;
      const today = new Date().toISOString().slice(0, 10);
      const prefix = `feishu-${category}-`;
      const headers = await persistence.list();
      let best = null;
      for (const h of headers || []) {
        const id = h?.id;
        if (!id || !id.startsWith(prefix)) continue;
        if (this.sessionRegistry.get(id)?.status === 'archived') continue; // 归档会话不续接（2026-08-21 归档 chat 被复活事故）
        const date = id.slice(prefix.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (date >= today) continue; // 只要历史（不含今天）
        if (!best || date > best.date) best = { id, date };
      }
      return best?.id ?? null;
    } catch (e) {
      this.log(`查找历史会话失败(${category}): ${e.message}`);
      return null;
    }
  }

  // 当前 L1 主干会话 id: main-session.json 优先（支持热切换）, 常量兜底
  getMainSessionId() {
    try {
      if (existsSync(MAIN_SESSION_FILE)) {
        const cfg = JSON.parse(readFileSync(MAIN_SESSION_FILE, 'utf8'));
        if (cfg?.sessionId && typeof cfg.sessionId === 'string') return cfg.sessionId;
      }
    } catch (e) { this.log('读取 main-session.json 失败(用常量兜底):', e.message); }
    return MAIN_SESSION_ID;
  }

  // 解析 L1 主干会话的 agent（飞书串联/同步/挂点消息的唯一目的地）
  // 顺序: live 的主会话 → resume 磁盘上的主会话 → 兜底原 resolveWebAgent 启发式
  async resolveMainAgent() {
    const mainId = this.getMainSessionId();
    try {
      return await this.acquireAgent(mainId, { label: '主会话' });
    } catch (e) {
      this.log(`主会话恢复失败(${mainId}): ${e.message}, 回退启发式选择`);
      return this.resolveWebAgent();
    }
  }

  // 定位 web 主会话（fork 的"主干"）: 显式优先 getMainSessionId();
  // 其次 session- 前缀但排除树叶专属出口会话（如 forksession 开发会话不是主干）
  findMainSessionId() {
    const mainId = this.getMainSessionId();
    try {
      const ids = (this.ctx.agents?.list?.() || []).map((a) => a?.id).filter(Boolean);
      if (ids.includes(mainId)) return mainId;
      const excluded = new Set(Object.values(LEAF_OVERRIDES));
      const alt = ids.find((id) => id.startsWith('session-') && !excluded.has(id));
      if (alt) return alt;
      // live 列表没有（如主会话未加载）: 主干 id 固定, 直接返回让 sessions.get 从磁盘读
      return mainId;
    } catch { return mainId; }
  }

  // 准备 fork 分支的种子（官方模式: 读主干 events 切片, 再由 agents.create 带 seed 创建）
  // ⚠️ 不要用 ctx.sessions.fork(): 它创建的子会话立即 live, 后续 agents.resume/create 同 id
  //    会报 "cannot prepare session while it is live"（2026-08-21 fork 失败事故根因）
  // 边界: 切到最后一个 turn/end 之后（turn 中间切开会导致恢复出"半截 turn"）
  // 返回 { seed, meta } 或 null（主干不存在/无完成 turn 时回退 create 空会话）
  prepareForkSeed(sessionId) {
    try {
      const mainId = this.findMainSessionId();
      if (!mainId) { this.log(`fork 分支(${sessionId}): 未找到 web 主会话, 回退空会话`); return null; }
      const main = this.ctx.sessions?.get(mainId);
      const events = main?.events;
      if (!events?.length) { this.log(`fork 分支(${sessionId}): 主干 ${mainId} 无事件, 回退空会话`); return null; }
      const boundary = events.findLast((e) => e.type === 'turn/end');
      if (!boundary) { this.log(`fork 分支(${sessionId}): 主干 ${mainId} 无完成 turn, 回退空会话`); return null; }
      let cut = boundary.seq + 1;
      while (cut < events.length && events[cut]?.type !== 'turn/start') cut++;
      const seed = events.slice(0, cut);
      const meta = {
        // cwd 永远用插件工作区: 工作会话要在工具/文档所在的工作区干活。
        // 只继承主干的事件内容, 不继承主干 cwd——主干（如 feishusession）在别的工作区,
        // 否则工作会话会被建到主干那边（2026-08-21 feishu-dev-2026-08-21 错位到 Feishu 工作区事故）
        cwd: WORKDIR,
        agentPreset: 'standard',
        parentSession: mainId,
        seedLength: cut,
      };
      this.log(`🌿 fork 分支会话 ${sessionId} ← 主干 ${mainId}（继承 ${seed.length} 条上下文事件）`);
      return { seed, meta };
    } catch (e) {
      this.log(`fork 分支准备失败(${sessionId}): ${e.message}, 回退 create 空会话`);
      return null;
    }
  }

  // 查找已加载（live）的 agent（agent.id == sessionId）
  findLiveAgent(sessionId) {
    try {
      return (this.ctx.agents?.list?.() || []).find((a) => a?.id === sessionId) || null;
    } catch { return null; }
  }

  // 统一接管一个既有会话的 agent: live 优先（直接用, 避免 "cannot prepare while it is live"）
  // → 否则 agents.resume 从磁盘恢复。调用方负责处理"会话不存在"的抛错。
  // 背景: 重启后 web 会自动重新 enter 关机前未完的会话（live）, 此时 resume 必冲突（2026-08-21 事故）
  async acquireAgent(sessionId, { label, setup } = {}) {
    // 归档会话只作查询数据, 任何情况下禁止自动接管（2026-08-21 用户裁定）
    if (this.sessionRegistry?.get(sessionId)?.status === 'archived') {
      throw new Error(`会话已归档, 禁止自动接管: ${sessionId}`);
    }
    const live = this.findLiveAgent(sessionId);
    if (live) return { agent: live, mode: 'steer', live: true };
    const h = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { label, ...MAIN_MODEL },
      ...(setup ? { setup } : {}),
    });
    return { agent: h.agent, mode: 'steer', live: false };
  }

  // ── 内容驱动自动建叶（forksession 本质功能）──────────────────────────
  // L1 主对话内容 → 分类路径 L2→L3→L4：
  //   · 路径已到 L3/L4（规则或动态节点命中）→ 找该树叶的活跃会话续作，没有则自动创建
  //   · 路径只有 L2 但内容是事务性事件（AUTO_LEAF_L2 + TASK_SIGNAL）→ 自动长新树叶并建会
  // 叶会话 = fork 主干继承完整上下文、注册分类路径 + parent 溯源指针 + 主题指纹（供续作匹配）
  // 返回 { agent, sessionId, mode } 或 null（调用方回退到 L2 分类会话）
  async resolveLeafAgent(path, text, category) {
    const registry = this.sessionRegistry;
    let node = path[path.length - 1];
    // 只有真正到达 L4 树叶才承接; L2/L3（含动态领域节点）交还给调用方走 ensureLeafChain 补全链路
    // （2026-08-21 事故: 指纹命中 L3 领域节点就直接建会, 产出「酒店尽调-undefined」）
    const nodeInfo = registry.allNodes()[node];
    if (nodeInfo?.level !== 'L4') return null;
    // 树叶专属出口（如 forksession → Web 专用会话）: 不建 feishu 叶会话
    const override = LEAF_OVERRIDES[node];
    if (override) {
      try {
        const h = await this.acquireAgent(override, { label: `叶-${node}`, setup: this.makePresetSetup(category) });
        return { agent: h.agent, sessionId: override, mode: 'steer' };
      } catch (e) {
        this.log(`专属叶会话恢复失败(${override}): ${e.message}, 回退分类会话`);
        return null;
      }
    }
    // 已有叶会话续作: 树叶节点即事件身份——该节点有会话就续作（指纹用于多会话择优, 无匹配取最近活跃）;
    // 只有节点下完全没有会话才新建（避免同叶重复建会）
    const facts = extractKeyFacts(text);
    const nodeSessions = Object.entries(registry.data.sessions)
      .filter(([, s]) => s.status !== 'archived' && s.path?.length && s.path[s.path.length - 1] === node && s.origin !== 'web');
    let bestId = null, bestScore = 0;
    for (const [sid, s] of nodeSessions) {
      const sc = matchScore(facts, s.keyFacts || []);
      if (sc > bestScore) { bestScore = sc; bestId = sid; }
    }
    if (!bestId && nodeSessions.length) {
      bestId = nodeSessions.sort(([, a], [, b]) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0][0];
    }
    if (bestId) {
      // 长叶先轮换（旧轮次压缩进记忆文件, 新会话重生）再接管
      const rotated = await this.rotateLeafIfNeeded(bestId, category);
      const targetId = rotated || bestId;
      const cached = this.leafAgents.get(targetId);
      if (cached?.agent) return { agent: cached.agent, sessionId: targetId, mode: 'steer', path };
      try {
        const h = await this.acquireAgent(targetId, { label: `叶-${node}`, setup: this.setupFor(category, { path }) });
        this.leafAgents.set(targetId, { sessionId: targetId, agent: h.agent });
        registry.register(targetId, { keyFacts: facts });
        this.log(`🍃 续作叶会话 ${targetId}（指纹重合 ${bestScore.toFixed(2)}${rotated ? ', 已轮换' : ''}）`);
        return { agent: h.agent, sessionId: targetId, mode: 'steer', path };
      } catch (e) { this.log(`叶会话续作失败(${targetId}): ${e.message}, 改为新建`); }
    }
    // 新建 L4 叶会话: fork 主干（继承主对话完整上下文）
    // 落位规则: L2 → 对应工作区 <根>/<L2>/, L3 → 其子层 <L2>/<L3>/, 会话命名 <L3>-<L4>
    const meta0 = registry.leafSessionMeta(path);
    let sessionId = meta0.sessionId;
    mkdirSync(meta0.cwd, { recursive: true }); // 确保 L2 工作区/L3 子层目录存在
    // 同 id 但属于别的路径（他树干的同名 L3-L4）→ 加后缀区分
    for (let i = 2; registry.get(sessionId) && JSON.stringify(registry.get(sessionId).path) !== JSON.stringify(path); i++) {
      sessionId = `${meta0.sessionId}-${i}`;
    }
    try {
      // 不带主干 seed: 树叶用自己的上下文做专项工作, 只记 parentSession 溯源指针
      // （全量注入既重又错——主干是所有流量的汇总地, 不是每片树叶的上下文）
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: meta0.cwd, agentPreset: 'standard', parentSession: this.findMainSessionId() },
        agentOptions: { label: `叶-${sessionId}`, ...MAIN_MODEL },
        setup: this.setupFor(category, { path }),
      });
      this.leafAgents.set(sessionId, { sessionId, agent: handle.agent });
      // L2 工作区落位 + L3-L4 标题（GUI 可见的分类身份; pin 住防 LLM 自动标题覆盖）
      // 注意用路径里的有效 L2（语义纠偏后可能与正则 category 不同, 否则 cwd 与工作区不匹配挂不上）
      await this.attachToL2Workspace(path[1] || category, sessionId, { title: sessionId });
      registry.register(sessionId, {
        path,
        parent: this.findMainSessionId(),
        origin: 'feishu-leaf',
        keyFacts: facts,
        note: `事件: ${text.slice(0, 50)}`,
      });
      this.log(`🍃 已建叶会话 ${sessionId} @ ${formatPath(path)}`);
      return { agent: handle.agent, sessionId, mode: 'steer', path };
    } catch (e) {
      // 同 id 已存在（注册表外残留）→ 直接接管而不是重复建
      if (/already exists/.test(e.message)) {
        try {
          const h = await this.acquireAgent(sessionId, { label: `叶-${node}`, setup: this.makePresetSetup(category) });
          this.leafAgents.set(sessionId, { sessionId, agent: h.agent });
          registry.register(sessionId, { path, keyFacts: facts });
          this.log(`🍃 叶会话 ${sessionId} 已存在, 直接接管续作`);
          return { agent: h.agent, sessionId, mode: 'steer', path };
        } catch (e2) { this.log(`叶会话接管也失败(${sessionId}): ${e2.message}`); }
      }
      this.log(`叶会话创建失败(${sessionId}): ${e.message}, 回退分类会话`);
      return null;
    }
  }

  // 获取某类任务的 agent 会话（无则自动创建独立会话）
  // forceNew=true 表示用户明确开新话题: 跳过历史续接, 直接建当天新会话
  // fixedSessionId: 项目级路由传入的固定专属会话 id（无日期后缀、跨天持久）,
  //   固定会话自身即持久身份, 不做"日期最大历史会话"续接查找
  async resolveCategoryAgent(category, forceNew = false, fixedSessionId = null) {
    const existing = this.categoryAgents.get(category);
    if (existing?.agent) return { agent: existing.agent, mode: 'steer', sessionId: existing.sessionId };
    const sessionId = fixedSessionId || `feishu-${category}-${new Date().toISOString().slice(0, 10)}`;
    try {
      let handle;
      // setup 钩子: mount standard preset + 飞书桥接指令 + 主/副模型路由 (K3 主, deepseek-v4-flash 副)
      const presetSetup = this.makePresetSetup(category);
      try {
        // 优先接管既有当天会话: live 直接用（重启后 web 自动 enter 的会话 resume 会冲突）, 否则磁盘恢复
        handle = await this.acquireAgent(sessionId, { label: `飞书-${category}`, setup: presetSetup });
        this.log(`↩️ 已恢复类别 [${category}] 既有会话 ${sessionId}${handle.live ? '（live 直取）' : ''}`);
      } catch (e) {
        // 当天会话不存在 → 优先续接该分类最近一次历史会话（重启/跨天后用户继续旧工作）
        // 项目级固定会话（fixedSessionId）自身跨天持久, 跳过历史续接查找
        if (!forceNew && !fixedSessionId) {
          const lastId = await this.findLastCategorySessionId(category);
          if (lastId) {
            try {
              handle = await this.acquireAgent(lastId, { label: `飞书-${category}`, setup: presetSetup });
              const { agent } = handle;
              this.categoryAgents.set(category, { sessionId: lastId, agent });
              this.log(`🔗 已续接类别 [${category}] 历史会话 ${lastId}（重启前工作延续${handle.live ? ', live 直取' : ''}）`);
              return { agent, mode: 'steer', sessionId: lastId };
            } catch (e2) {
              this.log(`续接历史会话失败(${lastId}): ${e2.message}, 回退新建当天会话`);
            }
          }
        }
        // 新建分类会话: 不带主干 seed（主干是全流量汇总地, 不是每个工作会话的上下文）,
        // 只记 parentSession 溯源指针; cwd 落 L2 工作区（不允许未分组会话）并挂载+pin 标题
        const l2Name = TAXONOMY_NAMES[category] || category;
        const cwd = `${LEAF_WS_ROOT}/${l2Name}`;
        try { mkdirSync(cwd, { recursive: true }); } catch {}
        handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd, agentPreset: 'standard', parentSession: this.findMainSessionId() },
          agentOptions: { label: `飞书-${category}`, ...MAIN_MODEL },
          setup: presetSetup,
        });
        await this.attachToL2Workspace(category, sessionId, { title: `${l2Name} · ${category} ${sessionId.slice(-10)}` });
        this.log(`🆕 已为任务类别 [${category}] 创建独立会话 ${sessionId}`);
      }
      const { agent } = handle;
      this.categoryAgents.set(category, { sessionId, agent });
      return { agent, mode: 'steer', sessionId };
    } catch (e) {
      this.log(`创建类别会话失败(${category}): ${e.message}, 回退默认`);
      return await this.resolveMainAgent();
    }
  }

  // ── /fork 指令协议实现 ──────────────────────────────────────────────

  // 分支会话 id: fork-<关键词>-<MMdd-HHmm>（每次 fork 都是新分支, id 自带时间戳避免冲突）
  makeBranchId(task) {
    const facts = extractKeyFacts(task);
    const slug = (facts[0] || 'task').replace(/[^\w一-龥-]/g, '').slice(0, 12) || 'task';
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `fork-${slug}-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  }

  // /fork <任务>: fork 主干 → 分支独立执行 → 结果直接回传飞书 → 注册分支表 → 主会话留指针
  async handleForkCommand(chatId, task) {
    const branchId = this.makeBranchId(task);
    this.log(`🌿 /fork 指令: 创建分支 ${branchId} ← 任务「${task.slice(0, 40)}」`);
    await this.channel.send(chatId, { markdown: `🌿 已创建 fork 分支 \`${branchId}\`，继承主干上下文，任务执行中…` }).catch(() => {});
    try {
      const forked = this.prepareForkSeed(branchId);
      // /fork 分支同样落 L2 工作区（按任务分类）, 不允许未分组
      const forkCat = this.classifyTask(task);
      const forkCwd = `${LEAF_WS_ROOT}/${TAXONOMY_NAMES[forkCat] || forkCat}`;
      try { mkdirSync(forkCwd, { recursive: true }); } catch {}
      const handle = await this.ctx.agents.create({
        sessionId: branchId,
        ...(forked ? { seed: forked.seed } : {}),
        meta: { ...(forked ? forked.meta : { agentPreset: 'standard' }), cwd: forkCwd },
        agentOptions: { label: `分支-${branchId}`, ...MAIN_MODEL },
        setup: this.makePresetSetup('fork'),
      });
      const { agent } = handle;
      await this.attachToL2Workspace(forkCat, branchId, { title: branchId });
      // 注册分支（root-branch 注册表: 关键事实指纹, 供后续分支路由/查询）
      this.branchStore.upsert({
        id: branchId,
        topic: task.slice(0, 60),
        category: 'fork',
        keyFacts: extractKeyFacts(task),
        status: 'active',
        parent: forked?.meta?.parentSession || null,
        createdAt: Date.now(),
      });
      // 四级分类注册: 分支挂上分类树（路径由任务文本深化到 L3/L4）, parent 指针保证可追溯
      this.sessionRegistry.register(branchId, {
        path: classifyPath(task, this.classifyTask(task)),
        parent: forked?.meta?.parentSession || null,
        origin: 'fork',
        note: `任务: ${task.slice(0, 60)}`,
      });
      const branchPrompt = `你是从主干会话 fork 出的专项工作分支（继承了主干全部已完成轮次的上下文）。请在分支内独立完成以下专项任务，直接产出结果文本（你的最终回复会自动回传给用户，主会话只留指针）:\n\n${task}`;
      const result = await this.runSession(agent, branchPrompt, { timeoutMs: 300000 });
      this.log(`分支 ${branchId} 产出: ${String(result).slice(0, 120)}`);
      this.branchStore.upsert({ ...this.branchStore.get(branchId), lastResult: String(result).slice(0, 200), lastActiveAt: Date.now() });
      await this.sendToFeishu(chatId, `🌿 **分支 ${branchId} 结果**\n${result}`);
      // 主会话只留指针（显示流镜像, 不触发主会话 turn）
      this.mirrorToMain(`📌 [分支指针] /fork「${task.slice(0, 60)}」由分支 ${branchId} 完成`, String(result).slice(0, 300));
    } catch (e) {
      this.log(`/fork 分支执行失败(${branchId}):`, e.message);
      await this.channel.send(chatId, { markdown: `⚠️ 分支 ${branchId} 执行失败: ${e.message}` }).catch(() => {});
    }
  }

  // /branches: 列出分支注册表中的活跃分支
  async handleBranchesCommand(chatId) {
    const branches = this.branchStore.list().filter((b) => b.status !== 'archived');
    if (!branches.length) {
      await this.channel.send(chatId, { markdown: '🌿 当前没有活跃分支。用 `/fork <任务>` 创建一个。' }).catch(() => {});
      return;
    }
    const lines = branches.map((b) => `• \`${b.id}\`\n  主题: ${b.topic}${b.lastResult ? `\n  最近结果: ${b.lastResult.slice(0, 60)}` : ''}`);
    await this.channel.send(chatId, { markdown: `🌿 **活跃分支 (${branches.length})**\n${lines.join('\n')}` }).catch(() => {});
  }

  // 语义路由（规则未深化到 L3/L4 时的兜底判定）:
  // a) 同树干已有叶会话 + 主题指纹吻合 → { reuse }（快速通道, 不调 LLM）
  // b) LLM 综合判定: 跟进某既有叶 → { reuse } / 新工作话题 → { newTopic }（自动建叶, 无需手动 /fork）
  //    / 闲聊一次性 → { casual: true }（走 L2 分类会话）
  async semanticLeafRoute(text, category, currentId = null) {
    const facts = extractKeyFacts(text);
    const allLeaves = Object.entries(this.sessionRegistry.data.sessions)
      .filter(([, s]) => s.status !== 'archived' && s.keyFacts?.length && s.origin !== 'web');
    // 优先同树干候选; 正则误判树干时（如法律数据库→dev）退到全量, 由 LLM 语义兜底
    const sameL2 = allLeaves.filter(([, s]) => s.path?.includes(category));
    const candidates = sameL2.length ? sameL2 : allLeaves;
    // 续作树干一致性闸门（2026-08-30 复合测试事故: LLM 把"服务器CPU"续进法律叶）:
    // 强树干（非 chat/query 兜底）消息, 拒绝续作到不含该树干的叶——跨树干续作只在弱树干放行
    const crossTreeBlocked = (sid) => {
      if (category === 'chat' || category === 'query') return false;
      const rec = this.sessionRegistry.get(sid);
      return !(rec?.path || []).includes(category);
    };
    let bestId = null, bestScore = 0;
    for (const [sid, s] of candidates) {
      const sc = matchScore(facts, s.keyFacts);
      if (sc > bestScore) { bestScore = sc; bestId = sid; }
    }
    if (bestId && bestScore >= 0.34 && !crossTreeBlocked(bestId)) return { reuse: bestId, score: bestScore };
    if (bestId && bestScore >= 0.34) this.log(`🚫 指纹续作被树干闸门拦截: ${bestId} 不含 [${category}] ← ${text.slice(0, 30)}`);
    // LLM 兜底: 指纹粗粒度盖不住中文改写（"商业尽调" vs "尽调报告怎么写"）, 用语义判跟进/新建/闲聊
    try {
      const branchList = candidates.map(([sid, s]) => `- ${sid}（主题: ${(s.note || s.keyFacts.join('/')).slice(0, 40)}）`).join('\n');
      const l2Names = '软件开发|系统运维|信息查询|飞书生态|日常闲聊|商业经营|法律合规|知识学习';
      const continueRule = currentId
        ? `- 消息没有明确提起新的项目/话题名词（属于本轮对话的延续, 含闲聊口吻的跟进） → 只回复 CONTINUE
  当前进行中的会话: ${currentId}
`
        : '';
      const ans = (await chatText(
        `你是消息路由器。给定用户消息和候选工作分支，判断消息属于哪类，只输出四选一：
${continueRule}- 属于某候选分支的跟进/延续（同一件事，换说法也算；与候选共享主题关键词如"申论写作"即算） → 只回复该分支的完整 id（原样照抄，以 feishu- 开头或中文名）
- 明确提起新的项目/话题名词，或消息的核心对象名词不在任何候选分支主题中（如"充电桩"不在"酒店/商铺"里） → 只回复 TASK:<树干>/<领域>-<事件>（树干从【${l2Names}】中选最贴切的, 领域-事件各 2-8 字带区分性对象名, 如 TASK:商业经营/酒店尽调-海峡奥体全季; 拿不准领域就只给事件名）
- ${currentId ? '与本轮对话完全无关的' : ''}纯闲聊/问候/一次性查询 → 只回复 CHAT
不要输出任何解释。`,
        `用户消息: ${text}\n\n候选分支:\n${branchList || '(无)'}`)).trim();
      if (/^CONTINUE/i.test(ans)) return { continueCurrent: true };
      const taskM = ans.match(/^TASK[:：]\s*(.+)$/);
      if (taskM) {
        let body = taskM[1].trim();
        let newL2 = null;
        const slash = body.match(/^([一-龥]{2,6})\s*[\/／]\s*(.+)$/);
        if (slash) {
          const hit = Object.entries(TAXONOMY_NAMES).find(([, name]) => name === slash[1]);
          if (hit) { newL2 = hit[0]; body = slash[2]; }
        }
        const parts = body.split(/[-—–]/).map((w) => w.replace(/[^\w一-龥]/g, '').slice(0, 10)).filter(Boolean);
        if (parts.length >= 2) return { newL2, newDomain: parts[0], newTopic: parts.slice(1).join('') };
        if (parts.length === 1 && parts[0]) return { newL2, newTopic: parts[0] }; // 单段: 领域进"专项事务"桶, 不再自我翻倍
      }
      if (/^CHAT/i.test(ans)) return { casual: true };
      const hit = candidates.find(([sid]) => ans.includes(sid));
      if (hit && !crossTreeBlocked(hit[0])) return { reuse: hit[0], score: 1, via: 'llm' };
      if (hit) this.log(`🚫 LLM 续作被树干闸门拦截: ${hit[0]} 不含 [${category}] ← ${text.slice(0, 30)}`);
      return { casual: true };
    } catch (e) {
      this.log('语义路由失败(回退启发式):', e.message);
      return AUTO_LEAF_L2.has(category) && TASK_SIGNAL.test(text) ? { newTopic: 'task' } : { casual: true };
    }
  }

  // 按 sessionId 接管一个既有叶会话（live 直取 → 磁盘恢复）
  async acquireLeafById(sessionId, category) {
    const rec = this.sessionRegistry.get(sessionId);
    const node = rec?.path?.[rec.path.length - 1] || 'leaf';
    try {
      const rotated = await this.rotateLeafIfNeeded(sessionId, category);
      const targetId = rotated || sessionId;
      const cached = this.leafAgents.get(targetId);
      if (cached?.agent) return { agent: cached.agent, sessionId: targetId, mode: 'steer', path: rec?.path };
      const h = await this.acquireAgent(targetId, { label: `叶-${node}`, setup: this.setupFor(category, rec) });
      this.leafAgents.set(targetId, { sessionId: targetId, agent: h.agent });
      this.sessionRegistry.register(targetId, {});
      return { agent: h.agent, sessionId: targetId, mode: 'steer', path: rec?.path };
    } catch (e) {
      this.log(`叶会话接管失败(${sessionId}): ${e.message}`);
      return null;
    }
  }

  // 按注册记录给出 setup（树叶会话带记忆文件指令）
  setupFor(category, rec) {
    if (rec?.path?.length >= 4) {
      return this.makePresetSetup(category, leafMemoryPath(this.sessionRegistry.leafSessionMeta(rec.path)));
    }
    return this.makePresetSetup(category);
  }

  // 外部会话清扫器（2026-08-27 用户裁定: hermes 传入内容必须分组到 dsh-hermes 双向通信树叶）:
  // hermes/CLI/headless 等插件外渠道直接写到会话库, 绕过插件路由——这里定期收编:
  // 未注册会话 → 读首条消息识别（hermes 特征 → dsh-hermes 叶; cwd 落 FeishuTree/<L2名> → 该树干）→ 注册 + 挂工作区
  async sweepExternalSessions() {
    try {
      const persistence = this.ctx?.get?.('sessionPersistence');
      if (!persistence?.list) return;
      const wsReg = this.ctx.workspaceRegistry ?? this.ctx.get?.('workspaceRegistry');
      const headers = await persistence.list();
      for (const h of headers || []) {
        const id = h?.id;
        if (!id || this.sessionRegistry.get(id)) continue; // 已注册跳过
        if (h.createdAt && Date.now() - h.createdAt < 30000) continue; // 创建宽限期（插件自建会话注册可能在路上）
        const cwd = h.cwd || '';
        let firstText = '';
        try {
          const view = await persistence.load?.(id);
          const evs = view?.events || view?.session?.events || [];
          const um = (evs || []).find((e) => e.type === 'user/message');
          firstText = (um?.data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 300);
        } catch {}
        let path, note;
        if (/hermes/i.test(firstText)) {
          path = ['root', 'dev', 'dual-agent', 'dsh-hermes'];
          note = 'Hermes 双向通信（外部渠道自动收编）';
        } else {
          const l2hit = Object.entries(TAXONOMY).find(([, v]) => v.level === 'L2' && cwd === `${LEAF_WS_ROOT}/${v.name}`);
          path = l2hit ? ['root', l2hit[0]] : ['root'];
          note = '外部渠道会话（自动收编）';
        }
        this.sessionRegistry.register(id, { path, origin: 'external', note });
        this.log(`🧹 收编外部会话 ${id} → ${formatPath(path)}`);
        if (wsReg && cwd) {
          try {
            // cwd 匹配既有工作区即挂载; cwd=$HOME 的 hermes 会话 → 建"Hermes 通信"专区收容
            const title = cwd === HOME ? 'Hermes 通信' : (Object.values(TAXONOMY).find((v) => `${LEAF_WS_ROOT}/${v.name}` === cwd)?.name || cwd.split('/').pop());
            const ws = await wsReg.create(cwd, title);
            await ws.attachSession(id);
            this.log(`🗂️ 外部会话 ${id} 已挂入工作区 [${title}]`);
          } catch (e) { this.log(`外部会话挂载失败(${id}, 忽略):`, e.message); }
        }
      }
    } catch (e) { this.log('外部会话清扫失败(忽略):', e.message); }
  }

  // 长叶压缩轮换（2026-08-21 用户裁定）: 超阈值 → 旧轮次精炼进记忆文件 →
  // 新会话带「记忆轮 + 最近 N 轮原文」重生 → 旧会话归档为只读数据。返回新会话 id 或 null
  async rotateLeafIfNeeded(sessionId, category) {
    try {
      const rec = this.sessionRegistry.get(sessionId);
      if (!rec?.path || rec.path.length < 4 || rec.status === 'archived') return null;
      const session = this.ctx.sessions?.get(sessionId);
      const events = session?.events;
      if (!events || events.length < ROTATE_MAX_EVENTS) return null;
      const meta0 = this.sessionRegistry.leafSessionMeta(rec.path);
      const memPath = leafMemoryPath(meta0);
      this.log(`♻️ 叶会话 ${sessionId} 达 ${events.length} 事件, 启动压缩轮换`);
      // 1) 旧轮次精炼合并进记忆文件
      mkdirSync(dirname(memPath), { recursive: true });
      const existing = existsSync(memPath) ? readFileSync(memPath, 'utf8') : '(空)';
      const transcript = eventsToText(events);
      const merged = await chatText(
        '你是记忆整理器。把"旧对话录"的有价值信息精炼合并进"既有记忆"，输出更新后的完整记忆（markdown）。规则: 保留关键事实/决策/进展/交付物路径/待办/用户偏好; 去寒暄与过程噪音; 总量 1500 字内; 直接输出记忆正文, 不要解释。',
        `# 既有记忆\n${existing}\n\n# 旧对话录\n${transcript}`);
      writeFileSync(memPath, `# ${meta0.sessionId} 工作记忆\n\n${merged.trim()}\n`);
      // 2) 新会话: 记忆轮 + 最近 N 轮原文（seed seq 连续重排）
      const baseId = sessionId.replace(/-r\d+$/, '');
      let n = 2;
      while (this.sessionRegistry.get(`${baseId}-r${n}`)) n++;
      const newId = `${baseId}-r${n}`;
      const seed = buildRotationSeed(events, readFileSync(memPath, 'utf8').slice(0, 6000), { keepTurns: ROTATE_KEEP_TURNS, uuid: () => crypto.randomUUID() });
      const handle = await this.ctx.agents.create({
        sessionId: newId,
        seed,
        meta: { cwd: meta0.cwd, agentPreset: 'standard', parentSession: this.findMainSessionId(), rotatedFrom: sessionId },
        agentOptions: { label: `叶-${baseId}`, ...MAIN_MODEL },
        setup: this.makePresetSetup(category, memPath),
      });
      await this.attachToL2Workspace(rec.path[1], newId, { title: baseId });
      // 3) 旧会话归档（注册表 + GUI 归档服务）, 注册表指向新会话
      this.sessionRegistry.register(sessionId, { status: 'archived', note: `已轮换 → ${newId}（记忆已回收进 ${memPath}）` });
      this.sessionRegistry.register(newId, { path: rec.path, parent: this.findMainSessionId(), origin: 'feishu-leaf', keyFacts: rec.keyFacts, note: `轮换自 ${sessionId}` });
      try { await (this.ctx.workspaceRegistry ?? this.ctx.get?.('workspaceRegistry'))?.archiveSession(sessionId); } catch {}
      this.leafAgents.set(newId, { sessionId: newId, agent: handle.agent });
      this.leafAgents.delete(sessionId);
      this.log(`♻️ 轮换完成: ${sessionId} → ${newId}（记忆 → ${memPath}）`);
      return newId;
    } catch (e) { this.log(`轮换失败(${sessionId}, 维持原会话):`, e.message); return null; }
  }

  // 一切插件自建会话的统一落位（2026-08-21 用户裁定: 不允许未分组会话）:
  // cwd = FeishuTree/<L2名>/（= L2 工作区实体 path, 成员校验要求一致）→ 挂入工作区 → pin 标题
  async attachToL2Workspace(category, sessionId, { title } = {}) {
    const l2Name = TAXONOMY_NAMES[category] || category;
    const cwd = `${LEAF_WS_ROOT}/${l2Name}`;
    try { mkdirSync(cwd, { recursive: true }); } catch {}
    try {
      const wsReg = this.ctx.workspaceRegistry ?? this.ctx.get?.('workspaceRegistry');
      if (wsReg) {
        const ws = await wsReg.create(cwd, l2Name);
        await ws.attachSession(sessionId);
      }
      const titleSvc = this.ctx.sessionTitle ?? this.ctx.get?.('sessionTitle');
      const liveSession = this.ctx.sessions?.get(sessionId);
      if (titleSvc && liveSession) titleSvc.rename(liveSession, title || sessionId);
      this.log(`🗂️ ${sessionId} 已挂入工作区 [${l2Name}]`);
    } catch (e) { this.log(`工作区挂载失败(${sessionId}, 忽略):`, e.message); }
    return cwd;
  }

  // 树叶记忆流水（机械保底; 策展由叶 agent 维护, 轮换时精炼回收）
  appendLeafDigest(workTarget, userText, workResult) {
    if (workTarget?.path?.length < 4) return;
    try {
      const memPath = leafMemoryPath(this.sessionRegistry.leafSessionMeta(workTarget.path));
      mkdirSync(dirname(memPath), { recursive: true });
      if (!existsSync(memPath)) writeFileSync(memPath, `# ${workTarget.sessionId} 工作记忆\n\n`);
      appendFileSync(memPath, `\n## ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n- 用户: ${userText.slice(0, 200)}\n- 产出: ${String(workResult).slice(0, 400)}\n`);
    } catch (e) { this.log('记忆流水追加失败(忽略):', e.message); }
  }

  // 复合消息拆解（2026-08-30 用户测试: 一条消息涵盖多方向, 不应整条进单会话）:
  // "1) … 2) … 3) …" 且跨 ≥3 个正则树干 → 逐项独立路由
  parseCompoundItems(text) {
    const parts = text.split(/\s*\d{1,2}[)）]\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    // 首段为引言（如"帮我办一批事, 逐项来:"）时丢弃
    const intro = parts[0].length <= 20 || /[，。:：]$/.test(parts[0]);
    const items = intro && parts.length >= 4 ? parts.slice(1) : parts;
    if (items.length < 3) return null;
    const cats = new Set(items.map((it) => this.classifyTask(it)));
    if (cats.size < 3) return null;
    return items;
  }

  // 单条消息的工作会话路由（分类 → 树叶 → 语义 → L2 兜底）, 返回 { category, workTarget, leafPath } | null
  async routeWorkTarget(text, { forceNew = false } = {}) {
    const regexCategory = this.routeProject(text)?.project || this.classifyTask(text);
    this.log(`任务分类: [${regexCategory}] ← ${text.slice(0, 40)}`);
    let leafPath = this.sessionRegistry.classify(text, regexCategory);
    let workTarget = null;
    if (!forceNew) {
      workTarget = await this.resolveLeafAgent(leafPath, text, regexCategory);
      if (!workTarget) {
        // 规则未命中树叶 → 语义路由: 续作既有叶 / 新话题自动建叶 / 闲聊回退 L2
        const d = await this.semanticLeafRoute(text, regexCategory);
        if (d.reuse) {
          workTarget = await this.acquireLeafById(d.reuse, regexCategory);
          if (workTarget) this.log(`🍃 语义续作叶会话 ${d.reuse}（指纹重合 ${d.score.toFixed(2)}）`);
        } else if (d.newTopic) {
          // L2 裁定权分层: 正则特定规则优先; 只有兜底类（chat/query）才接受 LLM 纠偏
          const weakL2 = regexCategory === 'chat' || regexCategory === 'query';
          let effectiveL2 = regexCategory;
          if (d.newL2 && d.newL2 !== regexCategory) {
            if (weakL2) {
              effectiveL2 = d.newL2;
              this.log(`🧭 语义纠正树干: ${regexCategory} → ${d.newL2} ← ${text.slice(0, 30)}`);
            } else {
              this.log(`🧭 语义建议树干 ${d.newL2}, 但正则特定规则优先维持 [${regexCategory}] ← ${text.slice(0, 30)}`);
            }
          }
          const node = this.sessionRegistry.ensureLeafChain(text, effectiveL2, { domain: d.newDomain || '专项事务', topic: d.newTopic });
          leafPath = this.sessionRegistry.nodePath(node);
          this.log(`🍃 语义判定新工作话题「${[d.newDomain, d.newTopic].filter(Boolean).join('-')}」→ 自动建 L4 叶 ${formatPath(leafPath)}`);
          workTarget = await this.resolveLeafAgent(leafPath, text, regexCategory);
        }
      }
      if (workTarget) this.log(`🍃 树叶路由: ${formatPath(workTarget.path || leafPath)} → ${workTarget.sessionId}`);
    }
    if (!workTarget) workTarget = await this.resolveCategoryAgent(regexCategory, forceNew, null);
    if (!workTarget) return null;
    // 四级分类注册（树叶会话已在 resolveLeafAgent 里按正确路径注册, 不覆盖）
    if (!workTarget.path) this.sessionRegistry.register(workTarget.sessionId, { path: this.sessionRegistry.classify(text, regexCategory), origin: 'feishu' });
    return { category: regexCategory, workTarget, leafPath };
  }

  // 复合消息处理: 逐项路由（顺序, 快）→ 按目标会话分组 → 组间并行执行, 组内顺序 → 逐条回报 + 汇总
  async handleCompoundMessage(chatId, text, items) {
    this.log(`🧩 复合消息拆解: ${items.length} 个子项`);
    await this.channel.send(chatId, { markdown: `🧩 识别为 **${items.length} 项复合任务**，已逐项分发到对应树叶并行处理，结果逐项回报…` }).catch(() => {});
    this.mirrorToMain(`🧩 [复合任务 ×${items.length}]`, text);
    // ① 路由（顺序, 快）
    const routed = [];
    for (const [i, item] of items.entries()) {
      try {
        const r = await this.routeWorkTarget(item, { forceNew: false });
        routed.push({ i, item, ...(r || {}) });
      } catch (e) { routed.push({ i, item, error: e.message }); }
    }
    // ② 按目标会话分组: 组间并行, 组内顺序（同一会话的子项不并发, 避免写冲突）
    const groups = new Map();
    for (const r of routed) {
      const key = r.workTarget?.sessionId || `err-${r.i}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    await Promise.all([...groups.values()].map(async (group) => {
      for (const r of group) {
        let workResult;
        if (r.error || !r.workTarget) {
          workResult = `⚠️ 该项路由失败: ${r.error || '无可用工作会话'}`;
        } else {
          try {
            workResult = await this.runSession(r.workTarget.agent, r.item, { timeoutMs: 240000 });
          } catch (e) { workResult = `⚠️ 执行失败: ${e.message}`; }
          this.recordActive(r.category, r.workTarget.sessionId);
          this.appendLeafDigest(r.workTarget, r.item, workResult);
        }
        await this.sendToFeishu(chatId, `【${r.i + 1}/${items.length}】${r.item.slice(0, 40)}\n→ [${r.category || '?'} · ${r.workTarget?.sessionId || '—'}]\n\n${workResult}`);
        this.mirrorToMain(`📤 [子项${r.i + 1} · ${r.workTarget?.sessionId || '失败'}]`, workResult);
      }
    }));
    // ③ 汇总
    const okCount = routed.filter((r) => r.workTarget && !r.error).length;
    const leaves = [...new Set(routed.map((r) => r.workTarget?.sessionId).filter(Boolean))];
    await this.channel.send(chatId, { markdown: `🧩 **复合任务完成**：${okCount}/${items.length} 项成功，分发到 ${leaves.length} 个会话：\n${leaves.map((l) => `• ${l}`).join('\n')}` }).catch(() => {});
    this.mirrorToMain(`🧩 [复合任务完成]`, `${okCount}/${items.length} 项成功, 涉及 ${leaves.length} 个会话`);
  }

  // 主会话显示流镜像（2026-08-21 用户裁定: 主会话仅是串联工具/显示流, 不加载上下文、不跑 LLM）:
  // 直接 session.append 消息事件（user 角色 + 📥/📤 标签 + surfaceOp append）, 不 steer、不产生 turn
  mirrorToMain(label, text) {
    try {
      const mainId = this.getMainSessionId();
      const session = this.ctx.sessions?.get(mainId);
      if (!session?.append) { this.log('主会话不在线, 显示流镜像跳过:', label); return false; }
      session.append('user/message', {
        content: [{ type: 'text', text: `${label}\n${String(text ?? '').slice(0, 1500)}` }],
        source: { kind: 'user', rpcId: crypto.randomUUID() },
        role: 'user',
        id: crypto.randomUUID(),
      }, { surfaceOp: 'append' });
      return true;
    } catch (e) { this.log('主会话显示流镜像失败(忽略):', e.message); return false; }
  }

  // 记录最后活跃的分类会话（写盘, 供重启后自动唤醒汇报使用）
  recordActive(category, sessionId) {
    try {
      const rec = { category, sessionId, ts: new Date().toISOString() };
      writeFileSync(LAST_ACTIVE_FILE, JSON.stringify(rec));
    } catch (e) {
      this.log('记录活跃会话失败:', e.message);
    }
  }

  // 重启后自动唤醒: 恢复重启前最后活跃的分类会话, 注入"继续向用户汇报重启前的工作"命令,
  // 并把恢复汇报主动推送给用户（无需用户先发消息, 让用户明确感知重启后的状态）
  async autoResumeReport() {
    try {
      const target = this.allowedUsers[0];
      if (!target) { this.log('自动唤醒汇报: 无授权用户, 跳过'); return; }
      if (!existsSync(LAST_ACTIVE_FILE)) {
        this.log('自动唤醒汇报: 无活跃会话记录(首次部署), 跳过');
        return;
      }
      let rec;
      try { rec = JSON.parse(readFileSync(LAST_ACTIVE_FILE, 'utf8')); } catch { return; }
      const { sessionId, category } = rec || {};
      if (!sessionId || typeof sessionId !== 'string') {
        this.log('自动唤醒汇报: 记录无效, 跳过');
        return;
      }
      if (this.sessionRegistry.get(sessionId)?.status === 'archived') {
        this.log(`自动唤醒汇报: 会话 ${sessionId} 已归档, 跳过（归档会话只读）`);
        return;
      }
      this.log(`🔔 自动唤醒汇报: 恢复会话 ${sessionId} (分类 ${category || '?'})`);
      const presetSetup = this.makePresetSetup(category || 'resume');
      const { agent } = await this.acquireAgent(sessionId, { label: `飞书-${category || 'resume'}`, setup: presetSetup });
      this.categoryAgents.set(category || 'auto', { sessionId, agent });
      const prompt = `【系统自动唤醒】DSH 服务刚刚重启完成（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}），你已自动恢复重启前的工作会话。请**主动向用户汇报**（这不是用户的新提问）: 1) 重启前正在处理的工作是什么; 2) 已完成的进展; 3) 当前状态与下一步计划。用简洁友好的中文直接回复用户。`;
      this.log(`自动唤醒汇报 steer: ${sessionId}`);
      // 超时给足 5 分钟（对齐 pi-ai streamIdleTimeoutMs）: 大会话（如 15 万 token）的 K3 请求
      // 可能跑 3 分钟以上, 之前 180s 超时导致"请求还在跑、兜底文本先被推给用户"的事故
      const report = await this.runSession(agent, prompt, { timeoutMs: 300000 });
      this.log(`自动唤醒汇报产出: ${String(report).slice(0, 120)}`);
      // 兜底文本不是真汇报 → 不推送, 改发明确的"恢复完成、汇报待生成"提示, 让用户明确感知状态
      if (!report || String(report).includes('会话未产生文本回复')) {
        this.log('⚠️ 自动唤醒汇报未产出文本(超时), 推送降级提示');
        await this.channel.rawClient.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: target,
            msg_type: 'text',
            content: JSON.stringify({ text: `⚠️ 已自动恢复重启前的工作会话（${sessionId}），但汇报内容生成超时。你可以直接发消息继续之前的工作（如"继续汇报"），上下文已接上。` }),
          },
        });
        return;
      }
      await this.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: target,
          msg_type: 'text',
          content: JSON.stringify({ text: `🔔 **重启恢复汇报**\n${formatForFeishu(report)}` }),
        },
      });
      this.log('✅ 自动唤醒汇报已发送到飞书');
    } catch (e) {
      this.log('自动唤醒汇报失败:', e.message);
    }
  }

  async handleMessage(msg) {
    this.log('收到消息:', JSON.stringify(msg).slice(0, 300));
    const chatId = msg.chatId;
    let text = (msg.content || '').trim();
    if (msg.senderId && this.allowedUsers.length && !this.allowedUsers.includes(msg.senderId)) {
      this.log(`忽略非授权用户消息: ${msg.senderId}`);
      return;
    }

    // 图片消息: 下载后把说明文本纳入标准分类管线（工作不落在主会话, 主会话只是显示流）
    if (msg.rawContentType === 'image' || (msg.resources?.length && !text)) {
      const imgPath = await this.downloadImage(msg);
      text = imgPath
        ? `用户通过飞书发来一张图片，已保存到 ${imgPath}。请查看并回复用户（如需回发图片，回复中用 [image:${imgPath}] 标记）。`
        : '用户通过飞书发来一张图片，但下载失败。';
    }

    if (!text) return;

    // ② 所有入站消息优先镜像进主会话（纯显示流, 先于一切路由）
    this.mirrorToMain('📥 [飞书入站]', text);

    // 审批测试命令: 直接触发卡片审批（验证 web 环境卡片能力）
    if (/审批测试|测试审批|approval test|card test/i.test(text)) {
      this.log('触发审批测试卡片');
      const p = this.requestApproval(chatId);
      await p('echo "卡片审批测试 — 确认按钮工作"');
      return;
    }

    // 审批回复优先
    if (this.pendingApprovals.has(chatId) && /批准|拒绝|同意|取消|yes|no|ok/i.test(text)) {
      const handled = await this.handleApprovalReply(chatId, text);
      if (handled) return;
    }

    // ── /fork 指令: 从主干 fork 专项工作分支（forksession 机制的用户直连入口）
    // 用法: /fork <任务描述> —— 分支继承主干完整上下文独立执行, 结果直接回传;
    // 主会话只留指针（SESSION_TAXONOMY 挂点规则: 主干只留指针）
    const forkCmd = text.match(/^\/fork\s+([\s\S]+)$/);
    if (forkCmd) {
      const task = forkCmd[1].trim();
      if (!task) {
        await this.channel.send(chatId, { markdown: '用法: `/fork <任务描述>` —— 从主干 fork 一个专项工作分支独立执行任务，结果直接回传这里。' }).catch(() => {});
        return;
      }
      await this.handleForkCommand(chatId, task);
      return;
    }
    if (/^\/fork\s*$/.test(text)) {
      await this.channel.send(chatId, { markdown: '用法: `/fork <任务描述>` —— 从主干 fork 一个专项工作分支独立执行任务，结果直接回传这里。' }).catch(() => {});
      return;
    }
    if (/^\/branches\s*$/.test(text)) {
      await this.handleBranchesCommand(chatId);
      return;
    }
    // /setmain <sessionId>: 热切换 L1 主干会话（写 main-session.json, 立即生效无需重启）
    const setMainCmd = text.match(/^\/setmain\s+(\S+)\s*$/);
    if (setMainCmd) {
      const sid = setMainCmd[1];
      const prev = this.getMainSessionId();
      try {
        writeFileSync(MAIN_SESSION_FILE, JSON.stringify({ sessionId: sid, updatedAt: new Date().toISOString(), prev }, null, 1));
        this.sessionRegistry.register(sid, { path: ['root'], origin: 'web', note: 'L1 主干（/setmain 指定）' });
        this.log(`🔀 主干切换: ${prev} → ${sid}`);
        await this.channel.send(chatId, { markdown: `✅ L1 主干已切换\n旧: \`${prev}\`\n新: \`${sid}\`\n飞书串联/同步消息即刻起全部流入新主干。` }).catch(() => {});
      } catch (e) {
        await this.channel.send(chatId, { markdown: `⚠️ 主干切换失败: ${e.message}` }).catch(() => {});
      }
      return;
    }
    // /tree: 四级分类树全景（所有会话挂在哪个节点一目了然）
    if (/^\/tree\s*$/.test(text)) {
      await this.channel.send(chatId, { markdown: `\`\`\`\n${this.sessionRegistry.renderTree()}\n\`\`\`` }).catch(() => {});
      return;
    }
    // /trace <sessionId>: 单会话溯源（沿 parent 链追根到主干）
    const traceCmd = text.match(/^\/trace\s+(\S+)\s*$/);
    if (traceCmd) {
      const chain = this.sessionRegistry.trace(traceCmd[1]);
      const lines = chain.map((c, i) => {
        const rec = this.sessionRegistry.get(c.id);
        const path = rec?.path ? formatPath(rec.path) : '(未注册)';
        return `${i === 0 ? '根' : `↓`} \`${c.id}\`\n  ${path}${c.missing ? '（注册表无记录）' : ''}`;
      });
      await this.channel.send(chatId, { markdown: `🔍 **溯源链**\n${lines.join('\n')}` }).catch(() => {});
      return;
    }

    this.channel.send(chatId, { markdown: '🤔 收到，正在思考…' }).catch(() => {});

    // ── 路径 C: 主会话唯一核心 + 分类专项工作会话 ──
    // 2) 派发: 优先内容驱动的树叶会话（自动建叶机制）, 否则回退 L2 分类专项会话
    // 用户明确说"开新话题/新任务"时跳过历史续接与树叶续作, 创建当天全新会话
    const forceNew = /(开新话题|新任务|另起炉灶|重新开始|开个新话题|新开一个|不要延续|别接着|从零开始)/.test(text);

    // 🧩 复合消息拆解优先（2026-08-30 复合测试: 多主题消息不该整条进单会话;
    // 拆解在延续判定之前——整体不是"本轮延续", 而是多项分发）
    const compoundItems = this.parseCompoundItems(text);
    if (compoundItems) {
      await this.handleCompoundMessage(chatId, text, compoundItems);
      return;
    }

    // ① 本轮对话延续优先（2026-08-21 用户裁定）: 无明确新项目名词 → 默认延续当前会话;
    //    只有明确提起新的项目名词才切换。当前会话 = 60 分钟内活跃且未归档的工作会话
    // 优先级裁定: 显式项目名词（静态/动态树叶命中, 如 forksession）> 延续优先
    // （2026-08-21 事故: "verify-forksession.sh" 被延续进谢光亮叶会话, 静态规则被绕过）
    let workTarget = null;
    let category = null;
    const regexCategory = this.routeProject(text)?.project || this.classifyTask(text);
    const prePath = this.sessionRegistry.classify(text, regexCategory);
    const explicitTopic = prePath.length >= 3; // 命中静态规则/动态树叶 = 显式项目名词
    if (explicitTopic) this.log(`🎯 显式项目名词命中树叶路径 ${formatPath(prePath)}, 跳过延续判定 ← 「${text.slice(0, 30)}」`);
    const last = (() => { try { return existsSync(LAST_ACTIVE_FILE) ? JSON.parse(readFileSync(LAST_ACTIVE_FILE, 'utf8')) : null; } catch { return null; } })();
    const lastRec = last?.sessionId ? this.sessionRegistry.get(last.sessionId) : null;
    const lastFresh = last?.ts && (Date.now() - new Date(last.ts).getTime() < 60 * 60 * 1000);
    const current = (!forceNew && !explicitTopic && lastFresh && lastRec && lastRec.status !== 'archived') ? last : null;
    const continueCurrent = async (why) => {
      const h = await this.acquireAgent(current.sessionId, { label: `续-${current.category || 'work'}`, setup: this.setupFor(current.category || 'chat', lastRec) });
      workTarget = { agent: h.agent, sessionId: current.sessionId, mode: 'steer', path: lastRec.path };
      category = current.category || 'chat';
      this.log(`⏩ ${why}, 延续当前会话 ${current.sessionId} ← 「${text.slice(0, 30)}」`);
    };
    if (current) {
      const quickContinue = /^(授权完成|授权已完成|已完成授权|完成授权|授权完毕|授权成功|已授权|授权好了|授权了|审批完成|已审批|完成了|已完成|做好了|可以了|好了|继续|接着来|接着做|行|好的|好|嗯|对|是的|ok|okay|done|go|批准了|已通过|通过了)(授权|审批)?[了呀哈呢吧。.!！~～\s]*$/i.test(text);
      try {
        if (quickContinue) {
          await continueCurrent('延续短句直达');
        } else {
          // 关联性二判定（替代四选一路由, 2026-08-25 测试发现: 是非题比路由题对 LLM 更友好）:
          // 先指纹快通道, 再 LLM 只答"相关/无关"——相关延续, 无关落回正常路由
          const curFacts = lastRec.keyFacts || [];
          const overlap = curFacts.length ? matchScore(extractKeyFacts(text), curFacts) : 0;
          if (overlap >= 0.34) {
            await continueCurrent(`指纹重合 ${overlap.toFixed(2)}`);
          } else {
            const topic = (lastRec.note || curFacts.join('/') || current.sessionId).slice(0, 40);
            const ans = (await chatText(
              `判断用户消息与当前对话主题是否同一件事。当前对话主题: 「${topic}」。只回答"相关"或"无关"，不要解释。`,
              `用户消息: ${text}`)).trim();
            if (/^无关/.test(ans)) {
              this.log(`🔀 关联判定「无关」（主题「${topic}」）→ 切换正常路由 ← 「${text.slice(0, 30)}」`);
              // 不置 workTarget, 落入下方正常路由
            } else {
              await continueCurrent('关联判定「相关」');
            }
          }
        }
      } catch (e) { this.log('延续判定失败(落回正常路由):', e.message); }
    }

    // 主路径路由（延续未接管时走标准管线）
    if (!workTarget) {
      const r = await this.routeWorkTarget(text, { forceNew });
      if (r) {
        workTarget = r.workTarget;
        category = r.category;
      }
    }
    if (!workTarget) {
      // 主会话不干活（显示流裁定）: 无可用工作会话时直接告知, 不再让主会话顶上
      this.log('⚠️ 无可用工作会话');
      await this.sendToFeishu(chatId, '⚠️ 当前无可用工作会话，请稍后重试。');
      return;
    }
    category = category || regexCategory;
    this.log(`✅ 派发到 [${category}] 专项工作会话 ${workTarget.sessionId}`);
    this.recordActive(category, workTarget.sessionId); // 记录最后活跃会话, 供重启后自动唤醒汇报
    const workResult = await this.runSession(workTarget.agent, text, { timeoutMs: 240000 });
    this.log(`分会话产出: ${String(workResult).slice(0, 120)}`);

    // 3) 结果直回飞书（工作会话的原声）; 主会话只做显示流镜像, 不再 LLM 汇总（不加载上下文）
    await this.sendToFeishu(chatId, workResult);
    this.mirrorToMain(`📤 [${category} · ${workTarget.sessionId} 产出]`, workResult);

    // 4) 树叶记忆流水
    this.appendLeafDigest(workTarget, text, workResult);
  }

  async start() {
    this.log(`启动飞书连接 (appId=${this.appId})`);
    this.channel = createLarkChannel({ appId: this.appId, appSecret: this.appSecret });
    this.channel.on('message', (msg) => {
      this.handleMessage(msg).catch((e) => this.log('消息处理错误:', e.message));
    });
    this.channel.on('cardAction', (evt) => {
      this.handleCardAction(evt).catch((e) => this.log('卡片事件处理错误:', e.message));
    });
    this.channel.on('error', (e) => this.log('channel 错误:', e.message));
    await this.channel.connect();
    this.log('✅ 飞书连接就绪 (WebSocket 长连接)');
    // 四级分类注册: web 主会话 = L1 主干（追溯链的根）
    const mainId = this.findMainSessionId();
    if (mainId) this.sessionRegistry.register(mainId, { path: ['root'], origin: 'web', note: 'web 主会话（主干）' });
    // 主会话保持在线（显示流镜像需要 sessions.get 命中; 只 append, 不跑 turn）
    if (mainId) {
      try { await this.acquireAgent(mainId, { label: '主会话' }); }
      catch (e) { this.log('主会话预载失败(镜像将跳过):', e.message); }
    }
    // 同步 WebUI 归档状态（用户在 GUI 归档的会话不再参与续作路由/上树展示）
    try {
      const ws = JSON.parse(readFileSync(WS_JSON, 'utf8'));
      const n = this.sessionRegistry.syncArchived(ws?.global?.archivedSessionIds);
      if (n) this.log(`🗂️ 归档状态已同步（${n} 条变更）`);
    } catch (e) { this.log('归档状态同步失败(忽略):', e.message); }
    await this.sendStartupNotice();
    // 外部会话清扫: 启动即扫一次 + 每分钟定时（收编 hermes/CLI/headless 等插件外渠道会话）
    setTimeout(() => this.sweepExternalSessions().catch(() => {}), 8000);
    this._sweepTimer = setInterval(() => this.sweepExternalSessions().catch(() => {}), 60000);
    // 重启后自动唤醒: 恢复重启前最后活跃的分类会话并主动向用户汇报（不依赖用户先发消息）
    this.autoResumeReport().catch((e) => this.log('自动唤醒汇报异常:', e.message));
  }

  // 启动完成后主动给用户发飞书确认（无需用户刷新/提问）
  async sendStartupNotice() {
    try {
      const target = this.allowedUsers[0];
      if (!target) return;
      await this.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: target,
          msg_type: 'text',
          content: JSON.stringify({ text: `✅ DSH web 已启动（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}），飞书通道就绪。正在自动恢复重启前的工作会话并汇报，请稍候…` }),
        },
      });
      this.log('✅ 已向用户发送启动确认');
    } catch (e) {
      this.log('启动通知发送失败:', e.message);
    }
  }

  async stop() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    if (this.channel?.disconnect) await this.channel.disconnect();
  }
}

// ---- cordis 插件接口 (apply/inject)，config 由 DSH profile 注入 ----
// 依赖 agents + sessions 服务（web 会话 agent 与会话读取），用于飞书→web 串联
export const inject = ["agents", "sessions", "agentPresets", "workspaceRegistry", "sessionTitle"];
export function apply(ctx, config) {
  const bot = new DSHFeishuBot({ ...(config || {}), ctx });
  // DSH cordis 环境无 ready 事件, 在 apply 中直接启动（fire-and-forget）
  bot.start().catch((e) => {
    const w = ctx?.logger?.warn?.bind(ctx.logger);
    if (w) w(`dsh-feishu 启动失败: ${e.message}`);
    else console.error('dsh-feishu 启动失败:', e.message);
  });
  ctx.on('dispose', () => bot.stop());
  // 标准 cordis service 注册（ctx.reflect.provide, 无需扩展方法）
  ctx.reflect.provide('dsh.feishu', bot);
}

// ---- 独立运行入口（便于验证，不依赖 cordis） ----
export async function run() {
  const bot = new DSHFeishuBot();
  await bot.start();
  const shutdown = async () => { await bot.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log('DSH 飞书插件运行中 (Ctrl+C 退出)');
}

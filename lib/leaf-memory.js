// lib/leaf-memory.js — 树叶记忆文件 + 长叶压缩轮换的纯函数层
// 设计（2026-08-21 用户裁定）:
//   1) 每片 L4 树叶一个记忆文件, 绑定树叶身份（L3-L4 名）而非会话 id → 轮换后记忆连续
//   2) 长叶会话的旧轮次经 LLM 精炼回收进记忆文件, 新会话带"记忆轮+最近 N 轮原文"重生

/** 记忆文件路径（按树叶身份, 跨轮换稳定） */
export function leafMemoryPath(meta) {
  // meta = leafSessionMeta(path) → { cwd, sessionId(=L3-L4名), ... }
  return `${meta.cwd}/.memory/${meta.sessionId}.md`;
}

/** 事件流 → 可压缩文本（只取 user/assistant 文本, 工具调用只留名） */
export function eventsToText(events, { maxChars = 24000, tail = false } = {}) {
  const lines = [];
  for (const e of events || []) {
    if (e.type === 'user/message') {
      const t = (e.data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (t) lines.push(`[用户] ${t.slice(0, 600)}`);
    } else if (e.type === 'assistant/message') {
      const blocks = e.data?.message?.content || [];
      const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const tools = blocks.filter((b) => b.type === 'tool-call').map((b) => b.name).join(',');
      if (t) lines.push(`[助手] ${t.slice(0, 800)}`);
      if (tools) lines.push(`[助手调工具] ${tools}`);
    }
  }
  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  // tail=true 保留最新段（轮换精炼: 旧信息已在既有记忆里, 近期上下文才是新增量）
  return tail ? '…(早段截断)\n' + text.slice(-maxChars) : text.slice(0, maxChars) + '\n…(截断)';
}

/** 构造轮换 seed: 头部配置事件 + 记忆轮（user/message 完整微 turn）+ 最近 N 个完整轮次。
 *  输出 seq 从 0 连续、turn 号顺序重排（DSH 恢复校验要求 seq 连续, 2026-08-21 feishu-forksession 事故教训） */
export function buildRotationSeed(events, memoryText, { keepTurns = 3, uuid } = {}) {
  const id = () => (uuid ? uuid() : Math.random().toString(36).slice(2));
  const firstTurnIdx = events.findIndex((e) => e.type === 'turn/start');
  const head = (firstTurnIdx > 0 ? events.slice(0, firstTurnIdx) : [])
    .filter((e) => e.type !== 'agent/inbox/spliced'); // 剔除 steer 残留, 只留配置类

  // 轮次切分（只收 turn/start..turn/end 闭合的完整轮）
  const turns = [];
  let cur = null;
  for (const e of events.slice(Math.max(firstTurnIdx, 0))) {
    if (e.type === 'turn/start') { if (cur) turns.push(cur); cur = [e]; continue; }
    if (cur) {
      cur.push(e);
      if (e.type === 'turn/end') { turns.push(cur); cur = null; }
    }
  }
  const tail = turns.slice(-keepTurns);

  const now = Date.now();
  const memTurn = [
    { type: 'turn/start', time: now, data: { turn: 1 } },
    {
      type: 'user/message', time: now, surfaceOp: 'append',
      data: {
        content: [{ type: 'text', text: `【记忆回收】本会话的早期轮次已压缩为以下工作记忆（完整记忆文件随工作持续更新）。请把它当作你自己的记忆，基于此继续工作：\n\n${memoryText}` }],
        source: { kind: 'user', rpcId: id() },
        role: 'user',
        id: id(),
      },
    },
    { type: 'turn/end', time: now, data: { turn: 1, reason: { kind: 'completed' } } },
  ];

  // seed 卫生（2026-08-25 轮换事故: 历史事件携带 sourceEventSeqs/replace 面,
  // 重排 seq 后 provenance 引用断裂 → "invalid seed event: sourceEventSeqs must reference earlier"）
  // 处置: 剥离 sourceEventSeqs; surfaceOp 一律降为 append（seed 只做纯追加式回放）
  const clean = (e) => {
    const { sourceEventSeqs, surfaceOp, ...rest } = e;
    return surfaceOp ? { ...rest, surfaceOp: 'append' } : rest;
  };
  // inbox splice 事件是 steer 的运行时残留, seq 重排后必失效——全量剔除
  // （2026-08-30 事故: "invalid persisted inbox splice at session seq 8", 此前只滤了头部, 尾部轮次的 splice 漏网）
  const isSplice = (e) => e.type === 'agent/inbox/spliced';
  // seed 卫生 v2（2026-11-17 生产轮换失败 "developer/message headerSeq must reference an earlier request/header"
  // 与 v4 保护头规则 "system/message requires a protected first surface head"）:
  //  - developer/message 是工具变更通报, 携带 headerSeq 指向原 request/header, seq 重排后必断 → 剔除;
  //  - system/message 是每轮系统提示快照, 回放不需要且可能触发保护头约束 → 剔除（新会话首轮由运行时重写）。
  const isUnsafe = (e) => e.type === 'agent/inbox/spliced' || e.type === 'developer/message' || e.type === 'system/message';
  const stripHeaderSeq = (e) => { if (e.data && typeof e.data === 'object' && 'headerSeq' in e.data) { const { headerSeq, ...rest } = e.data; return { ...e, data: rest }; } return e; };
  const out = [];
  for (const e of head) { if (isUnsafe(e)) continue; out.push({ ...clean(stripHeaderSeq(e)), seq: out.length }); }
  for (const e of memTurn) { if (isUnsafe(e)) continue; out.push({ ...clean(stripHeaderSeq(e)), seq: out.length }); }
  let turnNo = 1;
  for (const t of tail) {
    turnNo++;
    for (const e of t) {
      if (isUnsafe(e)) continue;
      const data = e.data && typeof e.data === 'object' && 'turn' in e.data ? { ...e.data, turn: turnNo } : e.data;
      const ev = stripHeaderSeq({ ...e, data });
      out.push({ ...clean(ev), data: ev.data, seq: out.length });
    }
  }
  return out;
}

// lib/context-manager.js — 上下文压缩 / Token 预算管理（对齐 hermes trajectory_compressor 的启发式思路）
// 轻量实现: 不引入 tokenizer 库，用「字符估算 + 结构化裁剪 + 旧工具结果摘要」控制输入 token。
// 目标: 让多轮工具循环的历史 token 稳定在预算内，避免无脑膨胀。

// ---- 私有: 简易 token 估算（中文≈1字/token, 英文≈4字符/token, 取偏保守） ----
export function estimateTokens(str) {
  if (!str) return 0;
  // 中文/全角字符记 1，其余 ASCII 每 4 个记 1
  let cjk = 0, ascii = 0;
  for (const ch of String(str)) {
    if (ch.charCodeAt(0) > 0x2e7f) cjk += 1;
    else ascii += 1;
  }
  return cjk + Math.ceil(ascii / 4);
}

// ---- 私有: 压缩一段较长的工具文本为「头部+尾部+省略提示」 ----
export function trimToLen(text, maxChars = 2500, headRatio = 0.6) {
  if (!text || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * headRatio);
  const tail = maxChars - head;
  const headText = String(text).slice(0, head);
  const tailText = String(text).slice(-tail);
  return `${headText}\n… [已省略 ${text.length - maxChars} 字符，共 ${text.length}] …\n${tailText}`;
}

const ROLE_PRIORITY = { system: 0, user: 1, tool: 3, assistant: 2 };
const MAX_MAIN_LEN = 2400;   // 主役(用户/最近assistant)保留长度
const MAX_TOOL_LEN = 1400;   // 单个 tool 结果保留长度（比其他严格，tool 是最耗 token 的）

// 压缩单个消息条目，使其符合各自角色的长度上限
export function shrinkMessage(msg) {
  const text = msg.content || '';
  if (msg.role === 'tool') {
    return { ...msg, content: trimToLen(text, MAX_TOOL_LEN, 0.5) };
  }
  if (msg.role === 'assistant' || msg.role === 'user') {
    return { ...msg, content: trimToLen(text, MAX_MAIN_LEN, 0.7) };
  }
  return msg; // system 不裁剪（保持指令完整性）
}

/**
 * 主入口: 对完整 messages 做 token 预算管理。
 * 策略（对齐 hermes: 保护首尾 + 压缩/折叠中间旧内容）:
 *  1. system prompt 完整保留（第一条）。
 *  2. 用户最近输入保留（最后一条 user）。
 *  3. 计算总额，若超过 tokenBudget:
 *     - 先从 **最旧的 tool/assistant 中间消息** 开始压缩（shrinkMessage）。
 *     - 若仍超，则对「最早的非首尾核心消息」做整体摘要收敛（tool 直接折叠成一行提示）。
 * @param {array} messages   [{role, content, tool_call_id?, tool_calls?}]
 * @param {number} tokenBudget  输入 token 上限（默认约 8k tokens）
 * @returns {array} 压缩后的 messages
 */
export function compressMessages(messages, tokenBudget = 8000) {
  if (!messages?.length) return messages;
  const arr = [...messages];
  const n = arr.length;

  // 1. 严格保护: system(0) 与最后一条用户消息 永不压缩
  const protectedIdx = new Set();
  arr.forEach((m, i) => {
    if (m.role === 'system') protectedIdx.add(i);
  });
  // 最后一条 user 也保护
  for (let i = n - 1; i >= 0; i--) {
    if (arr[i].role === 'user') { protectedIdx.add(i); break; }
  }

  // 2. 先裁剪每条消息到各自长度上限（保守，先挡掉大块工具返回）
  const shrunk = arr.map((m, i) => (protectedIdx.has(i) ? m : shrinkMessage(m)));

  // 3. 计算总量，超预算则进一步折叠「最旧的 tool/assistant」为核心提示
  let total = shrunk.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
  if (total <= tokenBudget) return shrunk;

  // 构建可折叠序列: 除 protected 外的所有索引，按 旧→新 / tool 优先
  const foldable = [];
  for (let i = 0; i < n; i++) {
    if (protectedIdx.has(i)) continue;
    const m = shrunk[i];
    if (m.role === 'tool') foldable.push({ i, w: 0 });      // tool 先折叠
    else if (m.role === 'assistant' && !m.tool_calls) foldable.push({ i, w: 1 });
    else foldable.push({ i, w: 2 });
  }
  foldable.sort((a, b) => a.w - b.w || a.i - b.i); // tool 优先、旧的优先

  for (const { i } of foldable) {
    if (total <= tokenBudget) break;
    const m = shrunk[i];
    const before = estimateTokens(m.content || '');
    if (m.role === 'tool') {
      // tool 结果折叠成一行摘要
      const first = m.content || '';
      const snippet = first.replace(/\s+/g, ' ').slice(0, 120);
      shrunk[i] = { ...m, content: `[工具结果已折叠] ${snippet}${first.length > 120 ? ' …' : ''}` };
    } else if (m.role === 'assistant' && !m.tool_calls) {
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 120);
      shrunk[i] = { ...m, content: c ? `[过程已折叠] ${c}` : c };
    } else {
      // 带 tool_calls 的 assistant 或中间 user: 尽量收敛
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 80);
      shrunk[i] = { ...m, content: c };
    }
    total = total - before + estimateTokens(shrunk[i].content || '');
  }

  // 移除可能被压缩成空串的条目（保留 tool_call_id 结构完整性由调用方保证）
  return shrunk.filter((m) => m.role === 'system' || (m.content ?? '') !== '');
}

// 便捷: 给外界一个可读取当前配置的调试工具
export const ContextConfig = {
  tokenBudget: 12000,
  maxToolTurns: 24,
  maxToolLen: MAX_TOOL_LEN,
  maxMainLen: MAX_MAIN_LEN,
};

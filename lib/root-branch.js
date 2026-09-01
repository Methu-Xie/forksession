// lib/root-branch.js — Root-Branch 分类机制核心模块
// 主干(飞书会话)=root, 工作会话=branch。每轮对话压缩为关键事实, 用关键事实路由到分支。
// 匹配: 关键词重合度为主(≥阈值直接路由) + LLM 语义为辅(模糊时判定)。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { BRANCHES_FILE as STORE_FILE } from './config.js';

// 停用词（不参与关键事实）
const STOP = new Set([
  '的','了','我','你','他','她','它','是','在','和','就','都','而','及','与','或','一个','没有','我们','你们',
  '如何','怎么','什么','这个','那个','这些','那些','可以','吗','呢','吧','啊','呀','一下','现在','需要','帮我','帮忙',
  '请','告诉','一下','进行','以及','还有','然后','所以','因为','如果','但是','就是','还是','不是','已经','应该',
  'the','a','an','is','are','to','of','in','on','and','or','for','with','this','that','it',
]);

/**
 * 提取关键事实（关键词为主）: CJK 词组 + 英文单词, 去停用词
 * @returns {string[]} 关键事实短语（去重, 最多 8 个）
 */
export function extractKeyFacts(text) {
  const out = [];
  const t = String(text || '');
  // CJK 连续段（2-8 字）
  const cjk = t.match(/[一-龥]{2,8}/g) || [];
  for (const w of cjk) {
    if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  // 英文单词
  const eng = t.match(/[a-zA-Z][a-zA-Z0-9_.-]{1,}/g) || [];
  for (const w of eng) {
    const lw = w.toLowerCase();
    if (lw.length >= 2 && !STOP.has(lw)) out.push(lw);
  }
  return [...new Set(out)].slice(0, 8);
}

/** CJK 2-gram 集合（指纹模糊匹配用） */
function bigrams(w) {
  const s = new Set();
  for (let i = 0; i + 2 <= w.length; i++) s.add(w.slice(i, i + 2));
  return s;
}

/**
 * 计算新消息关键事实与分支指纹的重合度（0-1）
 * 策略: 命中数 / 分支指纹数。命中判据:
 *   ① 完全相等或互为子串; ② CJK 2-gram Jaccard ≥ 0.3（覆盖"法律数据库运维" vs "法律数据库的"这类词形变化）
 */
export function matchScore(newFacts, branchFacts) {
  if (!branchFacts?.length) return 0;
  let hit = 0;
  for (const bf of branchFacts) {
    for (const nf of newFacts) {
      if (bf === nf || bf.includes(nf) || nf.includes(bf)) { hit++; break; }
      if (/[一-龥]/.test(bf) && /[一-龥]/.test(nf)) {
        const a = bigrams(bf), b = bigrams(nf);
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        const union = a.size + b.size - inter;
        if (union > 0 && inter / union >= 0.3) { hit++; break; }
      }
    }
  }
  return hit / branchFacts.length;
}

/**
 * 分支注册表（持久化）
 */
export class BranchStore {
  constructor(file = STORE_FILE) {
    this.file = file;
    this.data = { branches: {}, rootFacts: [] };
    this.load();
  }
  load() {
    try { if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf-8')); } catch {}
    this.data.branches ||= {};
    this.data.rootFacts ||= [];
  }
  save() {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch (e) { console.error('branch store save fail:', e.message); }
  }
  list() { return Object.values(this.data.branches); }
  get(id) { return this.data.branches[id]; }
  upsert(branch) { this.data.branches[branch.id] = branch; this.save(); }
  addRootFact(fact, branchId, ts = Date.now()) {
    this.data.rootFacts.push({ fact, branchId, ts });
    if (this.data.rootFacts.length > 500) this.data.rootFacts = this.data.rootFacts.slice(-300);
    this.save();
  }
  /** 找最匹配的分支: 返回 {branch, score} 或 null */
  bestMatch(newFacts, threshold = 0.5) {
    let best = null, bestScore = 0;
    for (const b of this.list()) {
      if (b.status === 'archived') continue;
      const score = matchScore(newFacts, b.keyFacts || []);
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best && bestScore >= threshold) return { branch: best, score: bestScore };
    return null;
  }
}

/**
 * LLM 语义兜底（关键词模糊/无命中时）: 判断消息属于哪个分支或新话题
 * @param {string} text 消息文本
 * @param {Array} branches 分支列表 [{id, topic, category, keyFacts}]
 * @param {function} chatFn async (system, user) => string  LLM 调用
 * @returns {Promise<{branchId: string}|{newCategory: string}>}
 */
export async function llmSemanticRoute(text, branches, chatFn) {
  const list = branches.filter((b) => b.status !== 'archived')
    .map((b) => `- ${b.id}（主题: ${b.topic}｜类别: ${b.category}）`).join('\n');
  const system = `你是路由分类器。给定用户消息和现有工作分支列表，判断这条消息属于哪个分支。
- 如果属于某分支，只回复该分支的 id
- 如果是全新话题（任何分支都不相关），只回复 NEW:<类别名>（类别用简短英文，如 dev/query/legal/business/study/sys/chat）
- 只输出 id 或 NEW:<类别>，不要解释`;
  const user = `用户消息: ${text}\n\n现有分支:\n${list || '(无)'}`;
  const ans = (await chatFn(system, user)).trim();
  const m = ans.match(/^NEW:(\w+)/i);
  if (m) return { newCategory: m[1] };
  const found = branches.find((b) => ans.includes(b.id));
  if (found) return { branchId: found.id };
  return { newCategory: 'chat' };
}

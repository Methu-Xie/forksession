// lib/session-registry.js — 会话四级分类注册表（forksession 机制的目标状态载体）
// 目标状态: 所有会话都像"树叶→树枝→树干→主干"一样【可分类 + 可追溯】
//   可分类: 每个会话有确定的 L1→L4 分类路径（TAXONOMY + classifyPath）
//   可追溯: 每个会话记录 parent 指针，可沿链一路追根到主干（trace）
// ============================================================================
// 【活规则】TAXONOMY 与 L34_RULES 可随时增改（对齐 SESSION_TAXONOMY.md），
//   无需改本文件逻辑；新增 L3/L4 节点 = 在 TAXONOMY 加节点 + 在 L34_RULES 加规则。
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extractKeyFacts, matchScore } from './root-branch.js'; // 关键事实指纹（动态节点匹配/自动建叶用）

import { REGISTRY_FILE, LEAF_WS_ROOT as LEAF_WS_ROOT_CFG } from './config.js';
// L4 叶会话的工作区根: L2 树干 = 其下一个工作区目录, L3 树枝 = 工作区下的子层, L4 会话落其中
export const LEAF_WS_ROOT = LEAF_WS_ROOT_CFG;

// 分类树（节点 id → {level, name, parent}）。L1=root 主干，L2 树干，L3 树枝，L4 树叶(具体项目)
export const TAXONOMY = {
  root:             { level: 'L1', name: '飞书会话串联主对话', parent: null },
  dev:              { level: 'L2', name: '软件开发',          parent: 'root' },
  'dsh-plugin-dev': { level: 'L3', name: 'DSH插件开发',       parent: 'dev' },
  forksession:      { level: 'L4', name: 'forksession开发',   parent: 'dsh-plugin-dev' },
  'llm-integration':{ level: 'L3', name: '多模型接入',         parent: 'dev' },
  kimi:             { level: 'L4', name: 'kimi接入',           parent: 'llm-integration' },
  'dual-agent':     { level: 'L3', name: '双Agent协作',        parent: 'dev' },
  'dsh-hermes':     { level: 'L4', name: 'DSH⇄Hermes',        parent: 'dual-agent' },
  'legal-work':     { level: 'L3', name: '法务工作',           parent: 'legal' },
  'legal-db':       { level: 'L4', name: '法律数据库',          parent: 'legal-work' },
  sys:              { level: 'L2', name: '系统运维',           parent: 'root' },
  query:            { level: 'L2', name: '信息查询',           parent: 'root' },
  feishu:           { level: 'L2', name: '飞书生态',           parent: 'root' },
  chat:             { level: 'L2', name: '日常闲聊',           parent: 'root' },
  business:         { level: 'L2', name: '商业经营',           parent: 'root' },
  legal:            { level: 'L2', name: '法律合规',           parent: 'root' },
  study:            { level: 'L2', name: '知识学习',           parent: 'root' },
};

// L3/L4 深化规则（活规则）: 文本命中 → 更深的节点；规则按数组顺序，先命中先得
// 约束: 仅当规则节点的祖先链包含消息的 L2 类别时才生效（防止跨树干误挂）
export const L34_RULES = [
  { node: 'legal-db',         patterns: [/法律数据库|司法解释|判例|法规库/i] }, // 常设项目: 法律数据库家族全部收敛此叶
  { node: 'forksession',      patterns: [/forksession|fork\s?会话|fork\s?分支|分支会话机制|root[-\s]?branch/i] },
  { node: 'dsh-plugin-dev',   patterns: [/dsh[-\s]?plugin|插件开发|飞书插件|cordis/i] },
  { node: 'kimi',             patterns: [/kimi|k3|moonshot/i] },
  { node: 'llm-integration',  patterns: [/多模型|模型接入|模型切换|主模型|副模型/i] },
  { node: 'dsh-hermes',       patterns: [/hermes|双\s?agent|双代理/i] },
];

// 节点 → 根路径（[root, ..., node]）；节点不在树上返回 null
export function pathOf(node) {
  const path = [];
  let cur = node;
  while (cur) {
    if (!TAXONOMY[cur]) return null;
    path.unshift(cur);
    cur = TAXONOMY[cur].parent;
  }
  return path[0] === 'root' ? path : null;
}

// 消息 → 完整分类路径（[root, L2, (L3), (L4)]）
// l2Category 来自 classify-rules.js 的任务分类；L34_RULES 负责把路径深化到树枝/树叶
export function classifyPath(text, l2Category) {
  const l2 = TAXONOMY[l2Category] ? l2Category : 'chat';
  for (const rule of L34_RULES) {
    if (!rule.patterns.some((re) => re.test(text))) continue;
    const p = pathOf(rule.node);
    if (p && p.includes(l2)) return p; // 祖先链必须包含该 L2 树干
  }
  return pathOf(l2);
}

// 路径显示: L1 飞书会话串联主对话 → L2 软件开发 → L3 DSH插件开发 → L4 forksession开发
export function formatPath(path) {
  return (path || []).map((n) => {
    const t = TAXONOMY[n];
    return t ? `${t.level} ${t.name}` : n;
  }).join(' → ');
}

/**
 * 会话注册表（持久化）: sessionId → { path, parent, origin, keyFacts, createdAt, lastActiveAt, note }
 *   path:   分类路径（数组, 见 classifyPath）
 *   parent: 父会话 id（fork/分支的溯源指针; 主干会话为 null）
 *   origin: web | feishu | fork | feishu-leaf | subagent | backfill
 *   keyFacts: 会话主题指纹（树叶会话续作匹配用）
 * data.nodes: 运行时动态长出的分类节点（新事件自动建叶, 与静态 TAXONOMY 合并视图）
 */
export class SessionRegistry {
  constructor(file = REGISTRY_FILE) {
    this.file = file;
    this.data = { sessions: {}, nodes: {} };
    this.load();
  }
  load() {
    try { if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf-8')); } catch {}
    this.data.sessions ||= {};
    this.data.nodes ||= {};
  }
  save() {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch (e) { console.error('session registry save fail:', e.message); }
  }
  get(id) { return this.data.sessions[id]; }
  list() { return Object.values(this.data.sessions); }
  /** 注册/刷新一个会话（幂等: 已存在则合并并刷新 lastActiveAt）
   *  每次先 load() 刷新磁盘: 防止本进程内存旧副本覆盖外部刚做的删除/修改
   *  （2026-08-21 事故: 外部删除的条目被旧内存 save 复活） */
  register(id, { path, parent, origin = 'feishu', note, keyFacts, status } = {}) {
    this.load();
    const now = Date.now();
    const prev = this.data.sessions[id] || {};
    this.data.sessions[id] = {
      ...prev, // 保留自定义标记字段（namingLegacy 等, 2026-08-30 标记被冲刷事故）
      path: path || prev.path || ['root'],
      parent: parent !== undefined ? parent : (prev.parent ?? null),
      origin: prev.origin || origin,
      createdAt: prev.createdAt || now,
      lastActiveAt: now,
      ...(status ? { status } : prev.status ? { status: prev.status } : {}),
      ...(keyFacts ? { keyFacts } : prev.keyFacts ? { keyFacts: prev.keyFacts } : {}),
      ...(note ? { note } : prev.note ? { note: prev.note } : {}),
    };
    this.save();
    return this.data.sessions[id];
  }

  /** 同步 WebUI 归档状态（workspace.json 的 archivedSessionIds）:
   *  列表内 → status:'archived'; 曾 archived 但已移出列表 → 摘除状态。
   *  归档会话不参与续作路由、不在 /tree 展示, 但保留注册与溯源能力。 */
  syncArchived(archivedIds) {
    this.load();
    const archived = new Set(archivedIds || []);
    let changed = 0;
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if (archived.has(id) && s.status !== 'archived') { s.status = 'archived'; changed++; }
      else if (!archived.has(id) && s.status === 'archived') { delete s.status; changed++; }
    }
    if (changed) this.save();
    return changed;
  }

  // ── 动态节点（运行时自动建叶: 新事件按 L2→L3→L4 层次顺序长出树叶）──────

  /** 静态 TAXONOMY + 运行时动态节点的合并视图 */
  allNodes() { return { ...TAXONOMY, ...this.data.nodes }; }

  /** 节点 → 根路径（含动态节点）; 不在树上返回 null */
  nodePath(node) {
    const nodes = this.allNodes();
    const path = [];
    let cur = node;
    while (cur) {
      if (!nodes[cur]) return null;
      path.unshift(cur);
      cur = nodes[cur].parent;
    }
    return path[0] === 'root' ? path : null;
  }

  /** 消息 → 完整分类路径（静态 L34_RULES 优先, 动态节点指纹兜底, 否则停在 L2） */
  classify(text, l2Category) {
    const l2 = this.allNodes()[l2Category] ? l2Category : 'chat';
    // 静态规则命中即权威（规则路径自带正确树干, 祖先链校验只约束动态节点）;
    // 多锚点竞争取"文本中提及位置最靠前"的规则（2026-08-30 复合测试事故:
    // 数组顺序先中先得与提及顺序无关, 把复合消息劫去了次要锚点）
    let bestRule = null, bestIdx = Infinity;
    for (const rule of L34_RULES) {
      for (const re of rule.patterns) {
        const m = re.exec(text);
        if (m && m.index < bestIdx) { bestIdx = m.index; bestRule = rule; }
      }
    }
    if (bestRule) {
      const p = this.nodePath(bestRule.node);
      if (p) return p;
    }
    // 动态节点: 关键事实指纹匹配（同类事件续挂同一树叶）
    const facts = extractKeyFacts(text);
    let best = null, bestScore = 0, bestLen = 0;
    for (const [id, node] of Object.entries(this.data.nodes)) {
      if (!node.keyFacts?.length) continue;
      const p = this.nodePath(id);
      if (!p || !p.includes(l2)) continue;
      const s = matchScore(facts, node.keyFacts);
      // 同分时更深的路径优先（L4 树叶 > L3 领域; 2026-08-21 同分取浅导致树叶路径被刷浅的事故）
      if (s > bestScore || (s === bestScore && s > 0 && p.length > bestLen)) { bestScore = s; best = id; bestLen = p.length; }
    }
    if (best && bestScore >= 0.5) return this.nodePath(best);
    return this.nodePath(l2) || ['root'];
  }

  /** 确保一条通往 L4 树叶的完整链路（会话必须落在 L4 树叶级, 命名 L2-L3-L4 嵌套）:
   *  已到 L4/动态叶 → 直接用; 只到 L3 → 补 L4; 只到 L2 → 补 L3(领域)+L4(事件)
   *  hint: { domain, topic } 语义路由给出的两级命名。返回 L4 节点 id */
  ensureLeafChain(text, l2Category, { domain = null, topic = null } = {}) {
    const base = this.classify(text, l2Category);
    const parent = base[base.length - 1];
    const pNode = this.allNodes()[parent];
    if (pNode?.level === 'L4') return parent; // 已是 L4 树叶: 复用
    const facts = extractKeyFacts(text);
    const clean = (w) => String(w || '').replace(/[^\w一-龥-]/g, '').slice(0, 10) || 'topic';
    const topicSlug = clean(topic || facts[0]);
    const domainSlug = clean(domain || topicSlug);
    this.load();
    const mk = (slug, level, parentId) => {
      let id = `x-${slug}`;
      let i = 2;
      while (this.data.nodes[id] && this.data.nodes[id].parent !== parentId) id = `x-${slug}-${i++}`;
      if (this.data.nodes[id]) return id; // 同父同 slug → 复用
      // 指纹分层: 领域节点挂领域词, 事件节点挂事件词+全量事实（减少 L3/L4 指纹同分）
      const nodeFacts = level === 'L3' ? [slug] : [slug, ...facts];
      this.data.nodes[id] = { level, name: slug, parent: parentId, keyFacts: [...new Set(nodeFacts)].slice(0, 8), dynamic: true, createdAt: Date.now() };
      return id;
    };
    let l3 = parent;
    if (pNode.level === 'L2') {
      l3 = mk(domainSlug, 'L3', parent); // 补领域层
    } else if (pNode.dynamic) {
      // 落在动态 L3 领域上: 子叶里有同事件的直接复用, 否则在其下补 L4
      for (const [id, n] of Object.entries(this.data.nodes)) {
        if (n.parent === parent && n.level === 'L4' && matchScore(facts, n.keyFacts || []) >= 0.34) return id;
      }
      l3 = parent;
    }
    const l4 = mk(topicSlug, 'L4', l3); // 补事件层
    this.save();
    return l4;
  }

  /** 路径 → 叶会话 id（L2-L3-L4 嵌套命名: feishu-leaf-<l2>-<l3>-<l4>） */
  leafSessionId(path) {
    const parts = (path || []).slice(1).map((n) => (n.startsWith('x-') ? n.slice(2) : n));
    return `feishu-leaf-${parts.join('-')}`;
  }

  /** 路径 → 叶会话落位元数据（2026-08-21 组织规则 v2, 对齐 DSH 工作区模型）:
   *  L2 树干 → GUI 工作区实体（path=<LEAF_WS_ROOT>/<L2名>, 标题=L2名）
   *  L3 树枝 → 体现在会话名内（工作区不可嵌套, 成员要求 cwd==工作区 path）
   *  L4 会话 → cwd=L2 工作区, 命名/标题 = <L3名>-<L4名>
   *  返回 { sessionId, cwd, l2Name, l3Name, l4Name } */
  leafSessionMeta(path) {
    const nodes = this.allNodes();
    const seg = (n) => String(nodes[n]?.name || n).replace(/[\\/:*?"<>|]/g, '').slice(0, 16) || 'node';
    const [, l2, l3, l4] = path || [];
    return {
      sessionId: `${seg(l3)}-${seg(l4)}`,
      cwd: `${LEAF_WS_ROOT}/${seg(l2)}`,
      l2Name: seg(l2),
      l3Name: seg(l3),
      l4Name: seg(l4),
    };
  }

  /** 自动建叶: 在 parent（L2/L3）下为新事件长出下一层节点（L2→L3→L4 不跳层）;
   *  分类已落在动态节点（树叶本身）或 L4 时直接复用, 不再深化。
   *  hintTopic: 语义路由给出的主题词（比 keyFacts[0] 更干净）。返回节点 id */
  ensureLeaf(text, l2Category, hintTopic = null) {
    const base = this.classify(text, l2Category);
    const parent = base[base.length - 1];
    const pNode = this.allNodes()[parent];
    if (pNode?.level === 'L4' || pNode?.dynamic) return parent; // 已是树叶/动态叶: 复用
    const parentLevel = pNode?.level;
    const facts = extractKeyFacts(text);
    const slug = (hintTopic || facts[0] || 'topic').replace(/[^\w一-龥-]/g, '').slice(0, 10) || 'topic';
    const id = `x-${slug}`;
    this.load(); // 同 register: 先刷新磁盘, 防旧内存覆盖外部修改
    if (this.data.nodes[id]) return id;
    this.data.nodes[id] = {
      level: parentLevel === 'L2' ? 'L3' : 'L4', // 严格逐层深化
      name: slug,
      parent,
      keyFacts: facts,
      dynamic: true,
      createdAt: Date.now(),
    };
    this.save();
    return id;
  }

  /** 溯源: 沿 parent 链从树叶追根, 返回 [根, ..., 该会话] 的注册项链 */
  trace(id) {
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const rec = this.get(cur);
      chain.unshift({ id: cur, ...(rec || { missing: true }) });
      cur = rec?.parent;
    }
    return chain;
  }
  /** 渲染整棵分类树 + 每个节点挂载的会话（可分类/可追溯状态的全景视图） */
  renderTree() {
    const byNode = new Map(); // node -> [sessionId]
    for (const s of this.list()) {
      if (s.status === 'archived') continue; // 归档会话不上树
      const leaf = (s.path || ['root'])[(s.path || ['root']).length - 1];
      if (!byNode.has(leaf)) byNode.set(leaf, []);
      byNode.get(leaf).push(s);
    }
    const lines = [];
    const nodes = this.allNodes(); // 静态 + 动态节点都参与渲染
    const walk = (node, prefix, isLast, isRoot) => {
      const t = nodes[node];
      if (!t) return;
      const label = `${t.level} ${t.name}${t.dynamic ? '（动态）' : ''}`;
      lines.push(isRoot ? label : `${prefix}${isLast ? '└─' : '├─'} ${label}`);
      const sessions = (byNode.get(node) || [])
        .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
      const childPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
      for (const s of sessions) {
        const sid = Object.keys(this.data.sessions).find((k) => this.data.sessions[k] === s);
        lines.push(`${childPrefix}│  · ${sid}${s.parent ? ` (←${s.parent})` : ''}`);
      }
      const children = Object.keys(nodes).filter((k) => nodes[k].parent === node);
      children.forEach((c, i) => walk(c, childPrefix + (sessions.length ? '│  ' : ''), i === children.length - 1, false));
    };
    walk('root', '', true, true);
    return lines.join('\n');
  }
}

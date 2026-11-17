// route-test.mjs — forksession 路由决策仿真测试台（不依赖飞书发信）
// 原理: 加载真实模块（classify-rules/session-registry/root-branch/agent-loop），
// 在注册表临时副本上复刻决策链, 逐用例比对预期。真实 LLM 调用——测的就是语义层的真实表现。
//
// P2 双跑对比（2026-11-16）: 每个用例并行跑两种模式——
//   A 算法链（复刻 routeWorkTarget 裁定链, 原 25 用例基线）
//   D 调度员（复刻 dispatcherPrompt + parseDecision + CREATE 树干归一化, v0.2 主线）
// 两模式各自持有独立注册表副本（建叶互不污染）, 结果做宽松一致性比对（agree）。
// 报告落盘 p2-dual-run-<时间戳>.jsonl。
import { readFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import rules from '/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu/lib/classify-rules.js';
import { SessionRegistry, TAXONOMY, formatPath } from '/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu/lib/session-registry.js';
import { extractKeyFacts, matchScore } from '/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu/lib/root-branch.js';
import { chatText } from '/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu/lib/agent-loop.js';
import { MAIN_SESSION_ID, MAIN_SESSION_FILE } from '/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu/lib/config.js';

const REAL_REG = '/home/methu/Deep Darl Fantaseek/dsh-plugin-feishu/session-registry.json';
const TMP_A = '/tmp/route-test-registry-a.json'; // 算法链副本
const TMP_D = '/tmp/route-test-registry-d.json'; // 调度员副本
// 冻结 fixture（2026-11-17）: 基准树必须可复现——实时生产树会因新增叶漂移, 导致用例期望失真。
// fixture 存在则优先使用; 缺失时回退真实树快照。
const FIXTURE = '/home/methu/Forsession/route-test-fixture.json';
const sourceTree = existsSync(FIXTURE) ? FIXTURE : REAL_REG;
for (const f of [TMP_A, TMP_D]) writeFileSync(f, readFileSync(sourceTree, 'utf8')); // fixture → 两份独立副本
const reg = new SessionRegistry(TMP_A);   // 算法链用
const regD = new SessionRegistry(TMP_D);  // 调度员用

// 主干 id: main-session.json 优先, 常量兜底（与插件 getMainSessionId 一致）
const MAIN_ID = (() => { try { return JSON.parse(readFileSync(MAIN_SESSION_FILE, 'utf8')).sessionId || MAIN_SESSION_ID; } catch { return MAIN_SESSION_ID; } })();

const TAXONOMY_NAMES = Object.fromEntries(Object.entries(TAXONOMY).filter(([, v]) => v.level === 'L2').map(([k, v]) => [k, v.name]));
const L2NAMES = Object.values(TAXONOMY_NAMES).join('|');

// L2 树干标识归一化（与插件 l2Key 一致）: key 或中文名 → key
const l2Key = (s) => {
  if (!s) return null;
  if (TAXONOMY[s]) return s;
  const hit = Object.entries(TAXONOMY).find(([, v]) => v.level === 'L2' && v.name === s);
  return hit?.[0] || null;
};

const classifyTask = (text) => {
  for (const r of rules.rules) for (const re of r.patterns) if (re.test(text)) return r.category;
  return rules.fallback;
};

// ── A 模式: 复刻 semanticLeafRoute（与插件同逻辑同提示词）──────────────
async function semanticRoute(text, category) {
  const facts = extractKeyFacts(text);
  // 与生产一致: 会话映射表（tag/desc 增强指纹）
  const allLeaves = reg.sessionMap().filter((s) => s.status !== 'archived').map((s) => [s.id, s]);
  const weakBucket = category === 'chat' || category === 'query';
  const sameL2 = allLeaves.filter(([, s]) => s.path?.includes(category));
  const candidates = (weakBucket || !sameL2.length) ? allLeaves : sameL2;
  const crossTreeBlocked = (sid) => {
    if (category === 'chat' || category === 'query') return false;
    return !(reg.get(sid)?.path || []).includes(category);
  };
  const cardFacts = (s) => [s.tag, ...extractKeyFacts(s.desc || '')].filter(Boolean);
  const cardHit = (s) => cardFacts(s).some((cf) => facts.some((nf) => cf === nf || (nf.length >= 2 && cf.includes(nf)) || nf.includes(cf)));
  let bestId = null, bestScore = 0;
  for (const [sid, s] of candidates) {
    const sc = Math.max(
      matchScore(facts, s.keyFacts || []),
      matchScore(facts, cardFacts(s)));
    if (sc > bestScore) { bestScore = sc; bestId = sid; }
  }
  // 卡强命中 > 树干闸门（与生产一致）: 卡命中压过正则树干误判
  const cardBest = reg.sessionMap()
    .filter((s) => s.status !== 'archived')
    .map((s) => [s.id, s])
    .filter(([, s]) => cardHit(s))
    .sort((a, b) => matchScore(facts, cardFacts(b[1])) - matchScore(facts, cardFacts(a[1])))[0];
  if (cardBest) return { reuse: cardBest[0], score: 0.9, via: 'card' };
  if (bestId && bestScore >= 0.34 && !crossTreeBlocked(bestId)) return { reuse: bestId, score: bestScore };
  try {
    const branchList = candidates.slice(0, 15).map(([sid, s]) => `- ${sid}（${s.tag}${s.desc ? ': ' + s.desc : ''}）`).join('\n');
    const ans = (await chatText(
      `你是消息路由器。给定用户消息和候选工作分支，判断消息属于哪类，只输出三选一：
- 属于某候选分支的跟进/延续（同一件事，换说法也算；与候选共享主题关键词即算） → 只回复该分支的完整 id（原样照抄）
- 明确提起新的项目/话题名词，或消息的核心对象名词不在任何候选分支主题中 → 只回复 TASK:<树干>/<领域>-<事件>（树干从【${L2NAMES}】中选, 领域-事件各 2-8 字）
- 纯闲聊/问候/一次性查询 → 只回复 CHAT
不要输出任何解释。`,
      `用户消息: ${text}\n\n候选分支:\n${branchList || '(无)'}`)).trim();
    const hit = candidates.find(([sid]) => ans.includes(sid));
    if (hit && !crossTreeBlocked(hit[0])) return { reuse: hit[0], score: 1, via: 'llm' };
    const taskM = ans.match(/^TASK[:：]\s*(.+)$/);
    if (taskM) {
      let body = taskM[1].trim(); let newL2 = null;
      const slash = body.match(/^([一-龥]{2,6})\s*[\/／]\s*(.+)$/);
      if (slash) { const h = Object.entries(TAXONOMY_NAMES).find(([, n]) => n === slash[1]); if (h) { newL2 = h[0]; body = slash[2]; } }
      const parts = body.split(/[-—–]/).map((w) => w.replace(/[^\w一-龥]/g, '').slice(0, 10)).filter(Boolean);
      if (parts.length >= 2) return { newL2, newDomain: parts[0], newTopic: parts.slice(1).join('') };
      if (parts.length === 1 && parts[0]) return { newL2, newTopic: parts[0] };
    }
    return { casual: true };
  } catch { return { casual: true }; }
}

// ── A 模式: 复刻 routeWorkTarget 决策（不含 agent 创建/执行）──────────
async function decide(text) {
  const category = classifyTask(text);
  const path = reg.classify(text, category);
  if (path.length >= 4) {
    const node = path[path.length - 1];
    const ss = Object.entries(reg.data.sessions).filter(([, s]) => s.status !== 'archived' && s.path?.at(-1) === node && s.origin !== 'web');
    return { via: 'explicit', category, path, sessionId: ss[0]?.[0] || `(新建 ${reg.leafSessionMeta(path).sessionId})` };
  }
  const d = await semanticRoute(text, category);
  if (d.reuse) return { via: 'reuse', category, sessionId: d.reuse, path: reg.get(d.reuse)?.path };
  if (d.newTopic) {
    const node = reg.ensureLeafChain(text, d.newL2 || category, { domain: d.newDomain || '专项事务', topic: d.newTopic });
    const p = reg.nodePath(node);
    return { via: 'new-leaf', category, path: p, sessionId: `(新建 ${reg.leafSessionMeta(p).sessionId})` };
  }
  return { via: 'l2', category, sessionId: `(feishu-${category}-<日期>)` };
}

// ── D 模式: 复刻调度员协议（与插件同提示词同解析, 2026-11-15 v0.2）─────
function buildDispatchIndex(r) {
  const now = Date.now();
  const WEEK = 7 * 24 * 3600 * 1000;
  const active = [], dormant = [], external = [];
  for (const s of r.sessionMap()) {
    if (s.id === MAIN_ID || s.status === 'archived') continue;
    if (s.origin === 'external') { external.push(s); continue; }
    if ((s.path?.length || 0) < 4) continue; // 与插件一致: 索引只列 L4 树叶
    const fresh = s.lastActiveAt && now - s.lastActiveAt < WEEK;
    (fresh || s.desc ? active : dormant).push(s);
  }
  // 与插件一致: session- 前缀的机读 id 沉底（消除 LLM 的 id 外形+位置偏见）
  active.sort((a, b) => Number(a.id.startsWith('session-')) - Number(b.id.startsWith('session-')));
  return { active, dormant, external };
}

function dispatcherPrompt(text) {
  const { active, dormant, external } = buildDispatchIndex(regD);
  // 与插件 formatIndexLine 一致: 字段打标（防 LLM 把名称当 id 照抄）
  const map = active.map((s) => `- id: ${s.id} | 名称: ${s.tag}${s.desc ? ` | 描述: ${s.desc}` : ''}`).join('\n');
  const fold = (dormant.length + external.length)
    ? `\n另有 ${dormant.length} 个休眠叶${external.length ? ` + ${external.length} 个外部渠道会话` : ''}（未列出; 用户明确点名时可唤醒）`
    : '';
  return `你是 DSH 的飞书总调度（唯一主会话）。用户所有飞书消息经你决策分发。规则（按优先级）:
0. 先判断是否多件独立事项（"1. 2. 3."编号/分号并列的多个任务） → 是则必须回复 [[MULTI]] [每项一个指令对象], 绝不把整条消息 STEER 给其中某一项的树叶
1. 与索引中某树叶相关 → 回复 [[STEER]] {"sessionId":"叶会话id","text":"转达的工作指令"}（执行结果会回传给你, 你再 [[REPLY]] 向用户汇总）。相关 = ①消息的核心对象（人名/项目名/产品名）出现在该叶主题/描述中; ②该叶领域的一般性提问、没带新对象（如"尽调报告怎么写"之于酒店尽调叶）; ③对该叶的追加/修改/更新指令（"加一栏""补充两条""整理进去""改成"等）——即使你觉得能直接回答, 也一律 STEER 不 REPLY。消息带了该叶没有的新对象（如"充电桩"之于商铺尽调叶） → 不算相关, 按规则 4 新建。注意区分"做某事"和"做某事的工具": "帮我记账/记一笔账"是账务行为 → 按规则 4 归商业经营, 不要 steer 到记账软件/小程序叶; 平台名开头的功能词（"飞书审批流/飞书多维表格"）是平台话题, 属于飞书生态——按规则 4 建飞书生态叶（已有则 STEER）, 别 steer 到"合同审批"这类业务叶, 也别 REPLY 直接答；用户是单人单线程推进（同时只专注一项工作）: 消息要么是近期活跃叶的续作（优先检查最近活跃的叶）, 要么是新开的专项工作（CREATE）
2. 你对**分发目标**真有疑惑（多个树叶都像/拿不准是新话题还是既有叶的跟进/用户指向不明） → 回复 [[ASK]] 一句明确的提问（请用户点明方向; 只问目标归属, 不问任务细节——细节树叶会自己追问; 能按规则 1/4 判定的不要偷懒反问）
3. 纯闲聊/问候/与所有树叶都无关的常识性一次性问答 → 直接回复 [[REPLY]] 内容（这类不要 CREATE 建叶; 注意收窄: 涉及具体平台/业务/系统操作的问题, 询问用户自己系统/项目/业务现状的问题——如"服务器CPU还高吗"——以及带工作动作意图的请求（排查/整理/分析/评估/设计/开发/跟进/核对/推演, 哪怕是名词性短语如"服务器CPU占用过高排查"）都是工作话题, 按规则 1/4 处理, 不得 REPLY 直接答）
4. 有持续工作产出的新话题 → 回复 [[CREATE]] {"l2":"树干","domain":"领域","topic":"事件","text":"工作指令"}（树干从 软件开发|系统运维|信息查询|飞书生态|日常闲聊|商业经营|法律合规|知识学习 中选最贴切的——如: 记账/账目/投资/尽调→商业经营, 脚本/小程序/原型/插件→软件开发, 服务器/网络/部署→系统运维, 合同/诉讼/法条→法律合规; 领域/事件各 2-8 字, 我会自动建叶）; 用户明确提出新对象/新项目时直接 CREATE, 不要反问澄清（树叶会在工作中追问细节）
5. STEER 的 sessionId 必须原样照抄索引行里 "id: " 后的完整值（不是名称列）。索引里所有条目都是同级合法会话 id——中文名和 session- 串一样都是 id; 只按主题相关性选择, 不要按 id 外形或排列顺序选择
6. 只输出指令块, 不要解释。树叶会话才有执行工具; 你是大脑, 它们是手脚。优先续作索引中的既有树叶, 不要轻易新建。

[调度请求] 用户消息: ${text}

当前会话索引（活跃树叶）:
${map || '(暂无活跃树叶会话)'}${fold}`;
}

// 与插件 parseDecision 一致（平衡括号提取, 失败兜底 reply）
function parseDecision(text) {
  const t = String(text || '');
  const extract = (marker) => {
    const i = t.indexOf(marker);
    if (i < 0) return null;
    let j = i + marker.length;
    while (j < t.length && /\s/.test(t[j])) j++;
    if (t[j] === '{') {
      let depth = 0, k = j;
      for (; k < t.length; k++) { if (t[k] === '{') depth++; else if (t[k] === '}') { depth--; if (!depth) { k++; break; } } }
      try { return JSON.parse(t.slice(j, k)); } catch { return null; }
    }
    if (t[j] === '[') {
      let depth = 0, k = j;
      for (; k < t.length; k++) { if (t[k] === '[') depth++; else if (t[k] === ']') { depth--; if (!depth) { k++; break; } } }
      try { return JSON.parse(t.slice(j, k)); } catch { return null; }
    }
    return t.slice(j).trim();
  };
  const multi = extract('[[MULTI]]');
  if (Array.isArray(multi)) return { kind: 'multi', actions: multi };
  const steer = extract('[[STEER]]');
  if (steer?.sessionId) return { kind: 'steer', ...steer };
  const create = extract('[[CREATE]]');
  if (create?.l2 || create?.topic) return { kind: 'create', ...create };
  const ask = extract('[[ASK]]');
  if (typeof ask === 'string' && ask) return { kind: 'ask', text: ask };
  const reply = extract('[[REPLY]]');
  if (typeof reply === 'string' && reply) return { kind: 'reply', text: reply };
  return { kind: 'reply', text: t };
}

// 决策归一化成与 decide() 可比的形状（含 executeDecision 的落点语义:
// CREATE 经 ensureLeafChain 落节点, 节点已有会话 = 复用; STEER 按 id 接管）
function normalizeDecision(dec, text) {
  if (dec.kind === 'reply') return { kind: 'reply', via: 'l2', category: 'chat' };
  if (dec.kind === 'ask') return { kind: 'ask', via: 'ask', category: 'chat' };
  if (dec.kind === 'steer') {
    const rec = regD.get(dec.sessionId);
    return { kind: 'steer', via: 'reuse', category: rec?.path?.[1], path: rec?.path, sessionId: dec.sessionId, unknown: !rec };
  }
  if (dec.kind === 'create') {
    const l2 = l2Key(dec.l2) || 'chat';
    const node = regD.ensureLeafChain(dec.text || text, l2, { domain: dec.domain || '专项事务', topic: dec.topic || (dec.text || text).slice(0, 8) });
    const path = regD.nodePath(node);
    const existing = Object.entries(regD.data.sessions).find(([, s]) => s.status !== 'archived' && s.path?.at(-1) === node && s.origin !== 'web');
    return { kind: 'create', via: existing ? 'reuse' : 'new-leaf', category: l2, path, sessionId: existing?.[0] || `(新建 ${regD.leafSessionMeta(path).sessionId})` };
  }
  return { kind: 'reply', via: 'l2', category: 'chat' };
}

async function decideDispatcher(text) {
  const raw = (await chatText('你是 DSH 的飞书总调度（唯一主会话）。用户所有飞书消息经你决策分发。', dispatcherPrompt(text))).trim();
  const dec = parseDecision(raw);
  if (dec.kind === 'multi') {
    const actions = (dec.actions || []).map((a) => normalizeDecision(
      a.kind ? a : (a.sessionId ? { kind: 'steer', ...a } : ((a.l2 || a.topic) ? { kind: 'create', ...a } : { kind: 'reply', text: a.text || JSON.stringify(a) })), text));
    return { ...(actions[0] || { kind: 'reply', via: 'l2', category: 'chat' }), kind: 'multi', actions, raw: raw.slice(0, 200) };
  }
  return { ...normalizeDecision(dec, text), kind: dec.kind, raw: raw.slice(0, 200) };
}

// ── 用例集（含历史 bug 回归）────────────────────────────────
const CASES = [
  { text: 'forksession 的 Backlog 还剩哪些', expect: { leaf: 'forksession' } },
  { text: '把这个会话发入forknsession里', expect: { leaf: 'forksession' } }, // 拼写变体回归
  { text: '法律数据库的8月新司法解释入库', expect: { leaf: 'legal-db' } },
  { text: '法律数据库的向量检索什么时候能修好', expect: { leaf: 'legal-db' } },
  { text: '服务器CPU还高吗', expect: { notSession: '法务工作-法律数据库', category: 'sys' } }, // 树干闸门回归
  { text: 'Kimi K3 接口限流是多少', expect: { leaf: 'kimi' } },
  { text: 'hermes 双向通信最近正常吗', expect: { leaf: 'dsh-hermes' } },
  { text: '海峡奥体全季的租约风险再补充两点', expect: { sessionId: '酒店尽调-海峡奥体全季' } },
  { text: '尽调报告怎么写', expect: { sessionId: '酒店尽调-海峡奥体全季' } }, // 跟进归叶
  { text: '帮我评估一个新能源汽车充电桩投资项目', expect: { viaAny: ['new-leaf', 'reuse'], notSession: '酒店尽调-海峡奥体全季', sessionContainsAny: ['充电桩'] } }, // 新对象防线回归（树内已有充电桩叶时复用亦正确）
  { text: '今天天气怎么样', expect: { via: 'l2', category: 'chat' } },
  { text: '写个Python脚本批量重命名照片', expect: { sessionId: '照片重命名-Python脚本' } }, // 叶已存在, 复用即正确
  { text: '这个脚本能加个按拍摄日期分类吗', expect: { sessionId: '照片重命名-Python脚本' } }, // 连续依赖上一条建叶
  { text: '谢光亮案的庭审策略再推演一遍', expect: { sessionId: '合同纠纷-谢光亮诉倪隽' } },
  { text: '周杰伦演唱会门票开票时间', expect: { sessionId: '票务关注-周杰伦演唱会' } },
  { text: '整理一份申论写作的笔记', expect: { sessionId: '申论写作-学习笔记框架' } }, // 重复建叶回归
  { text: '飞书审批流在哪里配置', expect: { category: 'feishu', notSession: '法务工作-法律数据库' } }, // 误派发回归
  { text: '商铺投资的回报率一般怎么算', expect: { sessionId: '商铺尽调-二手商铺投资' } },
  { text: '帮我记账', expect: { category: 'business' } }, // 记账归商业回归
  { text: '设计一个家庭记账小程序的原型', expect: { category: 'dev' } }, // 记账负向前瞻回归
  // ── 会话映射表时代新增用例 ──
  { text: '租约条款和真实P&L再核一遍', expect: { sessionId: '酒店尽调-海峡奥体全季' } }, // 卡强命中(desc 含租约/P&L)
  { text: '回报率帮我按三种情景算一下', expect: { sessionId: '商铺尽调-二手商铺投资', allowAsk: true } }, // 卡强命中(desc 含回报率); 三叶歧义时允许 ASK 反问
  { text: '抢票一般提前多久开票', expect: { sessionId: '票务关注-周杰伦演唱会' } }, // 卡强命中(desc 含开票)
  { text: '帮我看看共享充电宝项目', expect: { via: 'new-leaf', notSession: '酒店尽调-海峡奥体全季' } }, // 全新对象建叶
  { text: '下午好', expect: { via: 'l2' } }, // 纯寒暄兜底
];

// 期望校验（两种模式共用）
function checkExpect(d, e) {
  if (e.allowAsk && d.kind === 'ask') return ''; // 歧义反问（2026-11-17 新特性）: 首先判定, 视为通过
  if (e.leaf && !(d.path?.at(-1) === e.leaf)) return `树叶=${d.path?.at(-1)}`;
  if (e.sessionId && d.sessionId !== e.sessionId) return `会话=${d.sessionId}`;
  if (e.notSession && d.sessionId === e.notSession) return `误续 ${e.notSession}`;
  if (e.category && d.category !== e.category) return `树干=${d.category}`;
  if (e.via && d.via !== e.via) return `via=${d.via}`;
  if (e.viaAny && !e.viaAny.includes(d.via)) return `via=${d.via}`;
  if (e.sessionContainsAny && !e.sessionContainsAny.some((k) => String(d.sessionId || '').includes(k))) return `目标=${d.sessionId}`;
  return '';
}

// 双跑一致性（宽松口径, 与插件 dualAgree 同精神）: 同会话 / 同叶节点 / 同判新建 / 同判闲聊直答
function agree(a, d) {
  const real = (s) => s && !String(s).startsWith('(');
  if (real(a.sessionId) && real(d.sessionId)) return a.sessionId === d.sessionId;
  if (a.path && d.path && a.path.at(-1) === d.path.at(-1)) return true;
  if (a.via === 'new-leaf' && d.kind === 'create') return true;
  if (a.via === 'l2' && d.kind === 'reply' && (a.category === 'chat' || a.category === 'query')) return true;
  if (a.via === 'l2' && d.kind === 'create' && a.category === d.category) return true;
  return false;
}

const REPORT = `/home/methu/Forsession/p2-dual-run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.jsonl`;
let passA = 0, passD = 0, agreeN = 0;
const failuresA = [], failuresD = [], disagreements = [];
for (const [i, c] of CASES.entries()) {
  const [a, d] = await Promise.all([
    decide(c.text),
    decideDispatcher(c.text).catch((e) => ({ kind: 'error', via: 'error', error: e.message })),
  ]);
  const whyA = checkExpect(a, c.expect);
  const whyD = checkExpect(d, c.expect);
  const ag = agree(a, d);
  passA += !whyA; passD += !whyD; agreeN += ag;
  if (whyA) failuresA.push({ i: i + 1, text: c.text, why: whyA, got: { via: a.via, sessionId: a.sessionId, path: a.path } });
  if (whyD) failuresD.push({ i: i + 1, text: c.text, why: whyD, got: { kind: d.kind, via: d.via, sessionId: d.sessionId, path: d.path, raw: d.raw } });
  if (!ag) disagreements.push({ i: i + 1, text: c.text, algo: { via: a.via, sessionId: a.sessionId, category: a.category }, disp: { kind: d.kind, sessionId: d.sessionId, category: d.category } });
  const mark = (why) => (why ? '❌' : '✅');
  console.log(
    `#${i + 1} ${c.text.slice(0, 24)}\n` +
    `   ${mark(whyA)} A算法 [${a.via}] ${a.sessionId || formatPath(a.path || [])}${whyA ? ' （' + whyA + '）' : ''}\n` +
    `   ${mark(whyD)} D调度 [${d.kind}/${d.via}] ${d.sessionId || formatPath(d.path || []) || '(直答)'}${whyD ? ' （' + whyD + '）' : ''}${ag ? '' : '  ⚠️分歧'}`);
  appendFileSync(REPORT, JSON.stringify({ ts: Date.now(), i: i + 1, text: c.text, expect: c.expect, algo: a, dispatcher: d, agree: ag, passA: !whyA, passD: !whyD }) + '\n');
}
console.log(`\n═══ P2 双跑结果 ═══`);
console.log(`A 算法链: ${passA}/${CASES.length} 通过`);
console.log(`D 调度员: ${passD}/${CASES.length} 通过`);
console.log(`双跑一致: ${agreeN}/${CASES.length}`);
if (failuresA.length) console.log('A 失败:', JSON.stringify(failuresA, null, 1));
if (failuresD.length) console.log('D 失败:', JSON.stringify(failuresD, null, 1));
if (disagreements.length) console.log('分歧项:', JSON.stringify(disagreements, null, 1));
console.log(`报告: ${REPORT}`);
rmSync(TMP_A, { force: true });
rmSync(TMP_D, { force: true });
// 退出码只看调度员模式（v0.2 主线, P2 验收口径）; A 失败仅作旧链基线弱点记录, 不影响通过判定
process.exit(failuresD.length ? 1 : 0);

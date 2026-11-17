// sandbox-suite.mjs — 沙箱端到端分发验证（目标: ≥30 类消息准确分发）
// 机制: 逐条注入 mock-inbox → 监听 plugin.log（字节偏移）捕获调度决策 → 按用例期望打分。
// 打分口径: create=落叶到期望树干; steer=命中期望叶会话; reply=直接应答; multi=复合拆解。
import { appendFileSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';

const SB = '/home/methu/.dsh-sandbox';
const INBOX = `${SB}/dsh-plugin-feishu/mock-inbox.jsonl`;
const LOG = `${SB}/dsh-plugin-feishu/plugin.log`;
const REG = `${SB}/dsh-plugin-feishu/session-registry.json`;

const L2KEY = { 软件开发: 'dev', 系统运维: 'sys', 信息查询: 'query', 飞书生态: 'feishu', 日常闲聊: 'chat', 商业经营: 'business', 法律合规: 'legal', 知识学习: 'study' };

// ── 32 用例：10 建叶 + 10 续作 + 6 直答 + 2 复合 + 4 边界 ─────────────
// ref: 引用前面某个 create 用例建出的叶（驱动按日志实况解析）
const CASES = [
  // 建叶波（8 树干覆盖）
  { text: '开发一个合同审批小程序原型', expect: { kind: 'create', l2: 'dev' } },                    // #1
  { text: '帮我评估新能源汽车充电桩投资项目', expect: { kind: 'create', l2: 'business' } },          // #2
  { text: '整理一份申论写作的笔记', expect: { kind: 'create', l2: 'study' } },                       // #3
  { text: '服务器CPU占用过高排查', expect: { kind: 'create', l2: 'sys' } },                          // #4
  { text: '帮我跟踪特斯拉股价的每周变动', expect: { kind: 'create', l2Any: ['query', 'business'] } },   // #5（股价跟踪=信息查询/商业经营两可, 边界放宽）
  { text: '飞书审批流怎么设计多级审批', expect: { kind: 'create', l2: 'feishu', allowAsk: true } },    // #6（与 #1 合同审批叶有"审批"词面冲突, 允许反问）
  { text: '起草一份商铺租赁合同模板', expect: { kind: 'create', l2: 'legal' } },                     // #7
  { text: '帮我制定家庭月度预算表', expect: { kind: 'create', l2: 'business' } },                    // #8
  { text: '设计一个每日打卡小程序', expect: { kind: 'create', l2: 'dev' } },                         // #9
  { text: '整理民法典合同编的重点法条', expect: { kind: 'create', l2: 'legal' } },                   // #10
  // 续作波（跟进上波建的叶）
  { text: '合同审批小程序加个会签功能', expect: { kind: 'steer', ref: 1 } },                         // #11
  { text: '充电桩项目的回本周期再算细一点', expect: { kind: 'steer', ref: 2 } },                     // #12
  { text: '申论笔记的第二章展开写', expect: { kind: 'steer', ref: 3 } },                             // #13
  { text: 'CPU排查里把温度数据也加上', expect: { kind: 'steer', ref: 4 } },                          // #14
  { text: '特斯拉股价加上周线分析', expect: { kind: 'steer', ref: 5 } },                             // #15
  { text: '多级审批的撤回流程怎么设计', expect: { kind: 'steer', ref: 6 } },                         // #16
  { text: '合同模板加上违约金条款', expect: { kind: 'steer', ref: 7 } },                             // #17
  { text: '预算表加一栏弹性支出', expect: { kind: 'steer', ref: 8 } },                               // #18
  { text: '打卡小程序加排行榜功能', expect: { kind: 'steer', ref: 9 } },                             // #19
  { text: '民法典里定金和订金的区别也整理进去', expect: { kind: 'steer', ref: 10 } },                // #20
  // 直答波（闲聊/常识, 不建叶）
  { text: '下午好', expect: { kind: 'reply' } },                                                     // #21
  { text: '谢谢你', expect: { kind: 'reply' } },                                                     // #22
  { text: '给我讲个冷笑话', expect: { kind: 'reply' } },                                             // #23
  { text: '一加一等于几', expect: { kind: 'reply' } },                                               // #24
  { text: '你能做什么', expect: { kind: 'reply' } },                                                 // #25
  { text: '用一句诗形容今天', expect: { kind: 'reply' } },                                           // #26
  // 复合波（跨树干多事项）
  { text: '三件事：1.充电桩项目补充两条政策风险 2.申论笔记加一个开头段 3.服务器磁盘空间排查一下', expect: { kind: 'multi', minActions: 2 } }, // #27
  { text: '再来三项：1.打卡小程序界面改深色 2.民法典笔记生成目录 3.苏州明天天气如何', expect: { kind: 'multi', minActions: 2 } },          // #28
  // 边界波（既有叶召回/泛指追问/新树干）
  { text: '那个充电桩项目现在进展如何', expect: { kind: 'steer', ref: 2 } },                         // #29
  { text: '帮我分析人工智能行业最新趋势', expect: { kind: 'create', l2Any: ['query', 'business'] } }, // #30
  { text: '谢光亮案的庭审策略再推演一遍', expect: { kind: 'create', l2: 'legal' } },                 // #31（沙箱无此叶, 应建 legal 叶）
  { text: '帮我排查家里路由器频繁掉线的问题', expect: { kind: 'create', l2: 'sys' } },               // #32
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let logOffset = existsSync(LOG) ? statSync(LOG).size : 0;
const readNewLog = () => {
  const buf = readFileSync(LOG); // Buffer: 字节级切片（日志含中文, String.slice 按字符会错位——与插件 mock 通道同坑）
  if (buf.length < logOffset) logOffset = 0;
  if (buf.length === logOffset) return '';
  const chunk = buf.toString('utf8', logOffset);
  logOffset = buf.length;
  return chunk;
};
readNewLog(); // 丢弃历史

const createdLeaf = {}; // case# → { id, l2 }
const results = [];

for (const [i, c] of CASES.entries()) {
  const n = i + 1;
  appendFileSync(INBOX, JSON.stringify({ text: c.text }) + '\n');
  // 决策等待 900s: 沙箱主干串行（上一条的叶执行+汇总占着主干时, 本条 steer 排队）, 实测单条可达 5 分钟
  const deadline = Date.now() + 900000;
  let decision = null, leafLine = null;
  const marker = c.text.slice(0, 10);
  while (Date.now() < deadline) {
    await sleep(2000);
    const chunk = readNewLog();
    // MULTI 守卫会先于 🧠 行执行并 return（父决策行不落）: 独立识别守卫行作为多事项结果
    const multiLine = chunk.split('\n').find((l) => l.includes('🛡️ MULTI 守卫') && l.includes(marker));
    if (multiLine) {
      decision = { kind: 'multi', guarded: true };
      break;
    }
    const dLine = chunk.split('\n').find((l) => l.includes('🧠 调度决策:') && l.includes(marker));
    if (dLine) {
      const m = dLine.match(/调度决策: \[(\w+)\]\s*([^←]*)←/);
      decision = { kind: m?.[1], target: (m?.[2] || '').trim() };
      // 🛡️ 守卫改判归功: 决策后 12s 窗口内找本条文本的守卫行, 以其为实际执行结果
      // （REPLY 劫持/建叶守卫把 reply 改判; MULTI 守卫把整转改判为逐项调度——🧠 行仍是原始决策）
      if (decision.kind === 'reply' || c.expect.kind === 'multi') {
        const gDeadline = Date.now() + 12000;
        let guard = null;
        let buf = chunk;
        while (Date.now() < gDeadline && !guard) {
          const gLine = buf.split('\n').find((l) => l.includes('🛡️') && l.includes(marker));
          if (gLine) guard = gLine;
          else { await sleep(2000); buf = readNewLog(); }
        }
        if (guard) {
          const steerM = guard.match(/与叶 (\S+) 词面重合/);
          const createM = guard.match(/改判 CREATE \[(\w+)\]/);
          const multiM = guard.match(/MULTI 守卫: .*拆为 (\d+) 项/);
          if (steerM) decision = { kind: 'steer', target: steerM[1], guarded: true };
          else if (createM) decision = { kind: 'create', target: '(守卫建叶)', guarded: true, guardL2: createM[1] };
          else if (multiM) decision = { kind: 'multi', guarded: true };
        }
      }
      // 建叶行可能在决策后的下几个 tick（executeDecision 的建叶/挂工作区在决策日志之后）: 补捕窗口 20s（守卫建叶也补）
      if (decision.kind === 'create') {
        const leafDeadline = Date.now() + 20000;
        while (Date.now() < leafDeadline && !leafLine) {
          const c2 = leafLine ? '' : (chunk + readNewLog());
          const found = c2.split('\n').find((l) => l.includes('🍃 已建叶会话'));
          if (found) leafLine = found;
          if (!leafLine) await sleep(2000);
        }
      }
      break;
    }
  }
  if (!decision) {
    results.push({ n, text: c.text, pass: false, why: '决策超时(300s)' });
    console.log(`#${n} ⏱️ 超时: ${c.text.slice(0, 20)}`);
    continue;
  }
  // 建叶实况解析（叶 id + L2 树干）
  let leafId = null, leafL2 = null;
  if (leafLine) {
    const m1 = leafLine.match(/已建叶会话 (\S+) @/);
    const m2 = leafLine.match(/→ L2 ([^→]+)→/);
    leafId = m1?.[1] || null;
    leafL2 = L2KEY[m2?.[1]?.trim()] || null;
    if (leafId) createdLeaf[n] = { id: leafId, l2: leafL2 };
    if (!leafL2 && decision.guardL2) leafL2 = decision.guardL2; // 守卫建叶: l2 直接取自守卫行
  }
  // 打分
  let pass = false, why = '';
  const e = c.expect;
  if (decision.kind === 'ask' && e.allowAsk) {
    pass = true; why = 'ask(歧义反问, 允许)';
  } else if (e.kind === 'create') {
    const l2ok = e.l2 ? leafL2 === e.l2 : true;
    const l2AnyOk = e.l2Any ? e.l2Any.includes(leafL2) : true;
    pass = decision.kind === 'create' && (leafId ? (l2ok && l2AnyOk) : false);
    why = `kind=${decision.kind} 叶=${leafId} 树干=${leafL2}`;
  } else if (e.kind === 'steer') {
    const want = e.ref ? createdLeaf[e.ref]?.id : null;
    const stripR = (s) => String(s || '').replace(/-r\d+$/, ''); // 轮换后缀归一化（-r2/-r3 都是同一片叶的当代）
    const target = decision.target;
    pass = decision.kind === 'steer' && (want ? stripR(target) === stripR(want) : (e.leafContains ? target.includes(e.leafContains) : true));
    why = `kind=${decision.kind} 目标=${target} 期望叶=${want || e.leafContains}`;
  } else if (e.kind === 'reply') {
    pass = decision.kind === 'reply';
    why = `kind=${decision.kind}`;
  } else if (e.kind === 'multi') {
    pass = decision.kind === 'multi';
    why = `kind=${decision.kind}`;
  }
  results.push({ n, text: c.text, pass, why, decision, leafId, leafL2 });
  console.log(`#${n} ${pass ? '✅' : '❌'} [${decision.kind}] ${c.text.slice(0, 22)} → ${decision.target || leafId || '(直答)'}${pass ? '' : ' （' + why + '）'}`);
  await sleep(3000); // 节奏间隔, 避免主干连续 steer 堆积
}

// ── 汇总 ──
const passed = results.filter((r) => r.pass).length;
console.log(`\n═══ 沙箱分发验证: ${passed}/${CASES.length} 通过 ═══`);
const fails = results.filter((r) => !r.pass);
if (fails.length) console.log('失败明细:', JSON.stringify(fails, null, 1));
// 兜底文本事故统计（管线失败的信号）
let fallbackCount = 0;
try { fallbackCount = readFileSync(`${SB}/dsh-plugin-feishu/mock-outbox.jsonl`, 'utf8').split('（会话未产生文本回复）').length - 1; } catch {}
console.log(`兜底回复（会话未产生文本回复）出现次数: ${fallbackCount}`);
// 注册表树叶清单
try {
  const reg = JSON.parse(readFileSync(REG, 'utf8'));
  const leaves = Object.entries(reg.sessions).filter(([, s]) => (s.path?.length || 0) >= 4 && s.status !== 'archived');
  console.log(`沙箱存活树叶 ${leaves.length} 片:`);
  for (const [id, s] of leaves) console.log('  -', id, '→', s.path.join('/'));
} catch {}
const report = `/home/methu/Forsession/sandbox-suite-report-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
writeFileSync(report, JSON.stringify({ passed, total: CASES.length, fallbackCount, results, createdLeaf }, null, 2));
console.log('报告:', report);
process.exit(fails.length ? 1 : 0);

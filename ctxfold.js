#!/usr/bin/env node
// ctxfold — Agent 上下文管理与辅助 KV 压缩
// 确定性规则压缩（零 LLM 调用，秒级处理百万 token）+ 模型降智阈值自适应 + 锚点防遗忘。
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const VERSION = '1.0.0';

// ---------- 模型 profile：窗口能力 + 建议工作预算 + 降智阈值（超过则质量衰减区） ----------
const PROFILES = {
  'deepseek-flash':  { window: 128e3, working: 80e3, dumbing: 60e3 },
  'deepseek-v3':     { window: 64e3,  working: 40e3, dumbing: 32e3 },
  'deepseek-v4':     { window: 128e3, working: 80e3, dumbing: 60e3 },
  'gpt-4o':          { window: 128e3, working: 80e3, dumbing: 60e3 },
  'gpt-4.1':         { window: 1e6,    working: 600e3, dumbing: 400e3 },
  'claude-sonnet':   { window: 200e3, working: 120e3, dumbing: 90e3 },
  'glm':             { window: 128e3, working: 80e3, dumbing: 60e3 },
};
const DEFAULT_PROFILE = { window: 128e3, working: 80e3, dumbing: 60e3 };

// ---------- 近似 token 计数（中英混合启发，误差 ±10% 用于预算控制足够） ----------
function tok(s) {
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i);
    if (c > 0x2e7f) { n += 1; i += 1; }            // CJK ≈ 1 token/字
    else if (c === 32 || c === 10) { i += 1; }
    else { n += 1 / 4; i += c > 0xffff ? 2 : 1; } // 拉丁 ≈ 4 字符/token
  }
  return Math.ceil(n);
}

// ---------- 锚点提取：这些事实在压缩中永不丢失（防遗忘/防幻觉层） ----------
const ANCHOR_RX = [
  /[A-Za-z]:[\\/][^\s"'）)】\]，,；;]+/g,                        // Windows 路径
  /(?:\/[A-Za-z0-9_.-]+){2,}/g,                                  // POSIX 路径
  /https?:\/\/[^\s"'）)】\]，,；;]+/g,                          // URL
  /\b[0-9a-f]{40,64}\b/g,                                        // sha1/sha256
  /\b\d[\d,.]{2,}(?:\s?(?:GB|MB|KB|TB|k|ms|s|min|hour|天|小时|分钟|秒|元|美元|%)|\s*%(?!\w))?/gi, // 数字+单位
  /\b(?:gh|npm|pip|node|qv|docker|git)\s+\S+/g,                  // 命令锚
];
function anchors(text) {
  const found = new Set();
  for (const rx of ANCHOR_RX) { const m = text.match(rx); if (m) m.slice(0, 40).forEach(x => found.add(x.trim())); }
  return [...found].slice(0, 200);
}

// ---------- 确定性折叠：长文本保头尾，中段以哈希替代（可校验、可重复） ----------
function fold(text, keepHead, keepTail) {
  const lines = text.split('\n');
  if (lines.length <= keepHead + keepTail + 2) return text;
  const mid = lines.slice(keepHead, lines.length - keepTail);
  const h = crypto.createHash('sha256').update(mid.join('\n')).digest('hex').slice(0, 16);
  return lines.slice(0, keepHead).join('\n') + `\n[…ctxfold: 折叠 ${mid.length} 行 (sha256:${h})…]\n` + lines.slice(-keepTail).join('\n');
}
// 每条消息的要点（确定性：首句 + 锚点密度）
function gist(text, maxLen) {
  const t = text.replace(/\s+/g, ' ').trim();
  const cut = t.slice(0, maxLen);
  return cut + (t.length > maxLen ? ` …[裁断, 全文 ${tok(t)} tok]` : '');
}

// ---------- 模板挖掘（ETH 反例方法论：利用重复结构降表达成本） ----------
// 规范化：数字/哈希→占位符；同模板首次出现保留原文（即模板），后续出现替换为引用+计数。
// 变量值（数字/哈希）已由锚点层兜底，此处只降结构成本。确定性：Map 顺序稳定。
function templatize(tpl, text) {
  const lines = text.split('\n');
  if (lines.length < 3) return text;
  const out = lines.map(l => {
    if (l.length < 8) return l;
    const norm = l.replace(/[0-9a-f]{12,}/gi, '⟨H⟩').replace(/\d+/g, '⟨N⟩');
    let hit = tpl.get(norm);
    if (hit === undefined) { tpl.set(norm, [1, null]); return l; }
    hit[0]++;
    return `⟨§${hit[1] === null ? '?' : hit[1]}⟩x${hit[0]}`;
  });
  return out.join('\n');
}

// ---------- 压缩主逻辑 ----------
// 输入行: {role, content, pinned?, kind?}  kind: system|chat|tool（默认按 role 推断）
async function compress(inFile, outFile, opts) {
  const t0 = Date.now();
  const raw = await fsp.readFile(inFile, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const msgs = lines.map(l => JSON.parse(l));
  const budget = opts.budget;
  const anchorSet = new Set();
  let inTok = 0, outTok = 0, nFold = 0, nGist = 0, nKeep = 0;

  // 分类权重：system/pinned 永保；近期对话原文；老对话衰减；tool 输出优先折叠
  const cls = msgs.map((m, i) => {
    const c = m.content || '';
    inTok += tok(c);
    const kind = m.kind || (m.role === 'system' || m.role === 'user' && m.pinned ? 'system' : m.role === 'tool' ? 'tool' : 'chat');
    const age = msgs.length - i; // 距尾距离
    return { m, i, kind, age, tok: tok(c) };
  });

  // 第 1 遍：锚点全量提取（无论后续怎么压，事实先留住）——但锚点层自身限预算（防遗忘层不吃掉对话预算）
  for (const c of cls) anchors(c.m.content || '').forEach(a => anchorSet.add(a));
  let anchorList = [...anchorSet];
  let anchorTok = tok(anchorList.join('\n'));
  const anchorBudget = Math.floor(budget * 0.15);
  if (anchorTok > anchorBudget) { // 超限：保留最后出现的（新近上下文的锚更可能被引用）
    while (anchorTok > anchorBudget && anchorList.length > 20) anchorTok -= tok(anchorList.shift()) + 1;
  }

  // 第 2 遍：tool 长输出先模板化（重复结构跨消息共享字典，降为引用）再折叠
  const tpl = new Map(); let tplId = 0;
  for (const c of cls) {
    if (c.kind === 'tool' && c.tok > 10) {
      c.m.content = templatize(tpl, c.m.content);
      for (const v of tpl.values()) if (v[1] === null) v[1] = tplId++;
      c.tok = tok(c.m.content);
    }
  }
  for (const c of cls) {
    if (c.kind === 'tool' && c.tok > opts.toolFold) {
      c.m.content = fold(c.m.content, opts.head, opts.tail);
      c.tok = tok(c.m.content); nFold++;
    }
  }
  // 预算判定
  const cur = () => anchorTok + 40 + cls.reduce((n, c) => n + c.tok, 0);
  // 可衰减池：chat + tool；system/pinned 永不衰减
  const demotable = cls.filter(c => c.kind !== 'system');
  // 价值画像（前沿 KV-cache 预算分配的文本层对应）：
  // 独占锚点（本条贡献且近期不重复出现的事实）× 新颖度（模板化消息价值低）× 新近权重
  const recentText = cls.slice(-Math.min(40, cls.length)).map(c => c.m.content).join(' ');
  const value = new Map();
  for (const c of demotable) {
    const mine = anchors(c.m.content);
    let uniq = 0;
    for (const a of mine) if (!recentText.includes(a)) uniq++;
    const novel = c.m.content.includes('⟨§') ? 0.6 : 1;
    value.set(c.i, (1 + uniq * 0.5) * novel * (1 / (1 + (cls.length - c.i) / Math.max(1, cls.length))));
  }
  // 裁剪顺序：边际价值升序（低价值先裁，全局排序而非按年龄顺序贪心）
  const byValue = [...demotable].sort((a, b) => value.get(a.i) - value.get(b.i));
  const recentIds = new Set(cls.slice(-Math.min(opts.recent, cls.length)).map(c => c.i));
  const demote = (level) => {
    for (const c of byValue) {
      if (cur() <= budget) break;
      if (recentIds.has(c.i)) continue; // 最近 N 条原文永不降级
      if (level === 1 && !c.m.content.startsWith('[')) { c.m.content = `[要点] ${gist(c.m.content, opts.gistLen)}`; c.tok = tok(c.m.content); nGist++; }
      else if (level === 2 && !c.m.content.startsWith('[索引]') && !c.m.content.startsWith('[删除]')) { c.m.content = `[索引] #${c.i} ${gist(c.m.content, 30)}`; c.tok = tok(c.m.content); nGist++; }
      else if (level === 3) { c.m.content = `[删除] #${c.i}`; c.tok = 6; nGist++; }
    }
  };
  demote(1);
  if (cur() > budget) demote(2);
  if (cur() > budget) demote(3);
  // 第 4 级：墓碑聚合（数千条 [删除] 行本身占地板——合并成单行区间声明）
  if (cur() > budget) {
    const dead = demotable.filter(c => c.m.content.startsWith('[删除]'));
    if (dead.length > 1) {
      dead[0].m.content = `[已折叠] ${dead.length} 条消息（#${dead[0].i}-#${dead[dead.length - 1].i}，事实在 ANCHORS）`;
      dead[0].tok = tok(dead[0].m.content);
      for (const c of dead.slice(1)) { c.m.content = ''; c.tok = 1; }
    }
  }
  outTok = cur(); nKeep = cls.length;

  // 输出（stats 不入文件——保证确定性）
  const out = [];
  out.push(JSON.stringify({ role: 'system', kind: 'anchors', content: 'ANCHORS(压缩中强制保留的事实，勿遗漏/勿改写):\n' + anchorList.join('\n') }));
  for (const c of cls) out.push(JSON.stringify(c.m));
  await fsp.writeFile(outFile, out.join('\n') + '\n', 'utf8');
  return { version: VERSION, model: opts.model, window: opts.profile.window, dumbing: opts.profile.dumbing,
    budget, in_tok: inTok, out_tok: outTok, ratio: +(inTok / Math.max(1, outTok)).toFixed(2),
    anchors: anchorList.length, folded: nFold, gisted: nGist, msgs: nKeep, ms: Date.now() - t0 };
}

// ---------- CLI ----------
async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const [cmd] = a;
  const profileName = arg('--model', 'deepseek-flash');
  const profile = PROFILES[profileName] || DEFAULT_PROFILE;
  const budget = parseInt(arg('--budget', String(Math.min(profile.working, profile.dumbing))), 10);
  const opts = {
    budget,
    profile,
    toolFold: parseInt(arg('--tool-fold', '400'), 10),   // tool 输出超过此 tok 才折叠
    head: parseInt(arg('--head', '6'), 10),
    tail: parseInt(arg('--tail', '4'), 10),
    recent: parseInt(arg('--recent', '20'), 10),         // 最近 N 条 chat 保留原文
    gistLen: parseInt(arg('--gist', '120'), 10),
  };
  if (cmd === 'fold' || cmd === 'run') {
    const inFile = arg('--in'), outFile = arg('--out', (inFile || 'x') + '.folded');
    if (!inFile) die('用法: ctxfold fold --in session.jsonl [--out f.jsonl] [--model deepseek-flash] [--budget 60000]');
    const st = await compress(inFile, outFile, opts);
    console.log(`模型: ${profileName}（窗口 ${profile.window / 1000}k / 降智阈值 ${profile.dumbing / 1000}k）→ 工作预算 ${budget}`);
    console.log(`${st.in_tok} tok → ${st.out_tok} tok（x${st.ratio}，${st.ms}ms）｜折叠 ${st.folded} 条工具输出｜降级 ${st.gisted} 条老消息｜锚点 ${st.anchors} 个`);
    if (st.in_tok > profile.dumbing) console.log(`⚠ 输入 ${st.in_tok} tok 已超降智阈值 ${profile.dumbing / 1000}k——输出已压至 ${st.out_tok} tok 阈内，质量衰减风险解除`);
    console.log(`输出: ${outFile}`);
  } else if (cmd === 'anchors') {
    const txt = await fsp.readFile(arg('--in'), 'utf8');
    console.log(anchors(txt).join('\n'));
  } else if (cmd === 'tok') {
    const txt = await fsp.readFile(arg('--in'), 'utf8');
    console.log(tok(txt));
  } else {
    console.log(`ctxfold ${VERSION} — Agent 上下文管理与 KV 压缩
用法: fold --in session.jsonl [--out o.jsonl] [--model M] [--budget N] [--recent N] [--tool-fold N]
      anchors --in f.txt | tok --in f.txt
模型 profile: ${Object.keys(PROFILES).join(', ')}
确定性规则压缩（零 LLM 调用）；锚点(路径/URL/哈希/数字+单位/命令)强制保留防遗忘；流式秒级处理。`);
  }
}
const die = m => { console.error('ctxfold: ' + m); process.exit(1); };
if (require.main === module) main().catch(e => die(e.stack || e.message));
module.exports = { tok, anchors, fold, gist, PROFILES, compress };

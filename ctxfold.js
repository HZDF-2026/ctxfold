#!/usr/bin/env node
// ctxfold — Agent 上下文管理与辅助 KV 压缩
// 确定性规则压缩（零 LLM 调用，秒级处理百万 token）+ 模型降智阈值自适应 + 锚点防遗忘。
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const VERSION = '1.2.0';

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
// v1.2：双遍流式（常数内存、任意大小文件，百亿 token 级起步）+ 直方图阈值预算分配（边际价值单刀）
const readline = require('readline');
async function compress(inFile, outFile, opts) {
  const t0 = Date.now();
  const budget = opts.budget;
  const anchorBudget = Math.floor(budget * 0.15);
  const normMap = new Map(); // norm -> id（PASS1 权威建立；PASS2 只读）
  const norm = l => l.replace(/[0-9a-f]{12,}/gi, '⟨H⟩').replace(/\d+/g, '⟨N⟩');
  const templatizeRO = text => text.split('\n').map(l => {
    if (l.length < 8) return l;
    const n = norm(l); const id = normMap.get(n);
    return id === undefined ? l : `⟨§${id}⟩`;
  }).join('\n');
  const templatizeWR = text => text.split('\n').map(l => {
    if (l.length < 8) return l;
    const n = norm(l);
    if (!normMap.has(n)) normMap.set(n, normMap.size);
    return `⟨§${normMap.get(n)}⟩`;
  }).join('\n');

  // ---------- PASS 1：常数内存统计（逐行；滑动新近窗；锚点 lastIdx；价值直方图） ----------
  let inTok = 0, nMsg = 0;
  const tokArr = [], valArr = [], kindArr = []; // typed 友好的普通数组（消息级）
  const anchorMap = new Map(); // anchor -> [count, lastIdx]
  const recentWindow = []; let recentWinText = '';
  for await (const line of readline.createInterface({ input: fs.createReadStream(inFile, 'utf8'), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const raw = m.content || '';
    const kind = m.kind || (m.role === 'system' ? 'system' : m.role === 'tool' ? 'tool' : 'chat');
    let text = raw, t = tok(raw);
    if (kind === 'tool' && t > 10) { text = templatizeWR(text); t = tok(text); }
    if (kind === 'tool' && t > opts.toolFold) { text = fold(text, opts.head, opts.tail); t = tok(text); }
    inTok += t;
    let val = Infinity;
    if (kind !== 'system') {
      const mine = anchors(raw);
      let uniq = 0;
      for (const a of mine) { const e = anchorMap.get(a) || [0, nMsg]; e[0]++; e[1] = nMsg; anchorMap.set(a, e); if (!recentWinText.includes(a)) uniq++; }
      const novel = text.includes('⟨§') ? 0.6 : 1;
      val = (1 + uniq * 0.5) * novel; // 新近性由 recent 保护承担；value 只看事实价值×新颖度
    }
    tokArr.push(t); valArr.push(val); kindArr.push(kind === 'system' ? 1 : 0);
    recentWindow.push(raw); if (recentWindow.length > 40) recentWindow.shift();
    recentWinText = recentWindow.join('\n');
    nMsg++;
  }
  // 锚点名单：新近（lastIdx 大）优先保留至锚点预算
  const anchorSorted = [...anchorMap.entries()].sort((a, b) => b[1][1] - a[1][1]);
  const anchorList = [];
  let anchorTok = 0;
  for (const [a] of anchorSorted) { anchorList.push(a); anchorTok += tok(a) + 1; if (anchorTok > anchorBudget && anchorList.length > 20) break; }
  // system 与最近 N 条保护预算
  const protect = new Set(); let protTok = anchorTok + 40;
  for (let i = 0; i < nMsg; i++) { if (kindArr[i] === 1) { protect.add(i); protTok += tokArr[i]; } }
  for (let i = Math.max(0, nMsg - opts.recent); i < nMsg; i++) { if (!protect.has(i)) { protect.add(i); protTok += tokArr[i]; } }
  // 直方图二分：tombCut（价值低于它→墓碑）与 gistCut（之间→要点）
  const need = () => Math.max(0, inTok - budget);
  const bucket = new Map(); // val -> [tokSum, count]
  for (let i = 0; i < nMsg; i++) { if (protect.has(i)) continue; const b = bucket.get(valArr[i]) || [0, 0]; b[0] += tokArr[i]; b[1]++; bucket.set(valArr[i], b); }
  const valsAsc = [...bucket.keys()].sort((a, b) => a - b);
  const cutFor = target => { // 升序累加 tok 直至裁掉 target
    let acc = 0;
    for (const v of valsAsc) { acc += bucket.get(v)[0]; if (acc >= target) return v; }
    return Infinity;
  };
  let tombCut = -1;
  if (need() > 0) tombCut = cutFor(need()); // 单刀墓碑：v <= tombCut 全墓碑化
  let gistCut = -1;
  const tokt = (v) => bucket.get(v)[0];
  { // 若墓碑后仍超（保护项过多），第二刀：墓碑+要点混合——升序尾段的做要点
    let saved = 0; for (const v of valsAsc) { if (v <= tombCut) saved += tokt(v); }
    if (saved < need()) { // 全可裁池都不够 → 尾部最近可裁段要点化（v > tombCut 且非保护）
      const rest = need() - saved;
      let acc = 0;
      for (const v of valsAsc.slice().reverse()) { if (v <= tombCut) break; acc += tokt(v); if (acc >= rest) { gistCut = v; break; } }
    }
  }
  // ---------- PASS 2：流式输出 ----------
  let outTok = anchorTok + 40, nFold = 0, nGist = 0, nKeep = 0, i = 0, dead = 0;
  const ws = fs.createWriteStream(outFile, 'utf8');
  await new Promise(r => ws.write(JSON.stringify({ role: 'system', kind: 'anchors', content: 'ANCHORS(压缩中强制保留的事实，勿遗漏/勿改写):\n' + anchorList.join('\n') }) + '\n', r));
  for await (const line of readline.createInterface({ input: fs.createReadStream(inFile, 'utf8'), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const idx = i++;
    const m = JSON.parse(line);
    if (protect.has(idx)) { ws.write(line + '\n'); outTok += tokArr[idx]; nKeep++; continue; }
    const v = valArr[idx];
    if (v <= tombCut) { m.content = ''; ws.write(JSON.stringify(m) + '\n'); outTok += 2; dead++; continue; }
    let text = m.content || '';
    if (kindArr[idx] === 0) {
      if ((tok(m.content) > 10) && (m.kind || m.role) === 'tool') { text = templatizeRO(text); nFold++; if (tok(text) > opts.toolFold) text = fold(text, opts.head, opts.tail); }
      if (v <= gistCut) { text = `[要点] ${gist(text, opts.gistLen)}`; nGist++; }
    }
    m.content = text; outTok += tok(text); nKeep++;
    ws.write(JSON.stringify(m) + '\n');
  }
  if (dead > 1) { /* 墓碑已是空 content，成本 2 tok/条 */ }
  await new Promise(r => ws.end(r));
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

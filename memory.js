// ctxfold memory — RSI 记忆管理层（通用 Agent 版核心）
// 三层职责：沉淀(distill) → 召回(recall) → 策展(curate)，外加审计(verify)。
//
// 混合存储形态（用户拍板）：
//   权威层 = Markdown（MEMORY.md 索引页 + topics/<slug>.md 分片）——任何 agent 裸读裸改，零适配
//   派生层 = 索引（node:sqlite FTS5，缺运行时自动降级 index.json 倒排）——只加速召回，可随时从权威层重建
//
// 确定性承诺：distill/curate 全规则零 LLM，同一输入同一产出（时间戳/命中数等元数据除外）；
// 条目 id = sha(topic + 归一化正文)，同事实重复沉淀自动去重并累加 hits——RSI 循环的审计底座。
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { tok, anchors, gist } = require('./ctxfold.js');

const MEM_VERSION = '2.0.0';
const DEFAULT_RETENTION_DAYS = 180;

// ---------- 小工具 ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normText = t => String(t || '').replace(/\s+/g, ' ').trim();
const hashId = (topic, text) => sha(topic + '\n' + normText(text)).slice(0, 12);
const slug = t => String(t || 'general').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'general';
const encAnchors = list => (list || []).map(a => String(a).replace(/;/g, '；')).join(';');
const decAnchors = s => (s || '').split(';').map(x => x.trim()).filter(Boolean);

// ---------- SQLite 派生索引（可选，缺运行时降级 JSON） ----------
function openSqlite(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, topic TEXT, kind TEXT, body TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, body);
      CREATE TABLE IF NOT EXISTS anchors (anchor TEXT, id TEXT);
      CREATE INDEX IF NOT EXISTS idx_anchors ON anchors(anchor);
    `);
    return db;
  } catch { return null; } // 无 node:sqlite（或打开失败）→ 调用方走 index.json
}

// ---------- 权威层文件解析 ----------
// 条目格式（agent 可读 markdown，机器可解析）：
//   <!-- ctxfold:entry id=.. topic=.. kind=.. created=.. hits=.. anchors="a;b" -->
//   正文（任意 markdown）
//   <!-- /ctxfold:entry -->
const RX_OPEN = /<!--\s*ctxfold:entry\s+([^>]*?)\s*-->/;
const RX_CLOSE = /<!--\s*\/ctxfold:entry\s*-->/;
const RX_ATTR = /(\w+)=("[^"]*"|\S+)/g;

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(RX_ATTR)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function serializeEntry(e) {
  const attrs = `id=${e.id} topic=${e.topic} kind=${e.kind} created=${e.created} hits=${e.hits} anchors="${encAnchors(e.anchors)}"`;
  return `<!-- ctxfold:entry ${attrs} -->\n${e.text}\n<!-- /ctxfold:entry -->\n`;
}

function parseTopicFile(name, raw) {
  const entries = [];
  let rest = raw;
  for (;;) {
    const open = rest.match(RX_OPEN);
    if (!open) break;
    const head = rest.slice(0, open.index);
    const afterOpen = rest.slice(open.index + open[0].length);
    const close = afterOpen.match(RX_CLOSE);
    if (!close) break; // 残缺条目（人工编辑中断）：跳过该条，保留剩余原文
    const a = parseAttrs(open[1]);
    entries.push({
      id: a.id, topic: a.topic || 'general', kind: a.kind || 'fact',
      created: parseInt(a.created || '0', 10) || 0, hits: parseInt(a.hits || '0', 10) || 0,
      anchors: decAnchors(a.anchors || ''),
      text: afterOpen.slice(0, close.index).replace(/^\n+|\n+$/g, ''),
      _stray: head, // 该条目前散落的非条目文本（保留人写笔记用）
    });
    rest = afterOpen.slice(close.index + close[0].length);
  }
  return { file: name, entries, tail: rest };
}

// ---------- MemoryStore ----------
class MemoryStore {
  /** @param dir 记忆库根目录（权威层+派生层同居） */
  constructor(dir) {
    this.dir = dir;
    this.topicsDir = path.join(dir, 'topics');
    this.indexFile = path.join(dir, 'index.json');
    this.sqliteFile = path.join(dir, 'ctxfold.sqlite');
    this.db = null;
  }

  async open() {
    fs.mkdirSync(this.topicsDir, { recursive: true });
    this.topics = new Map(); // topic -> entry[]
    this.byId = new Map();
    this._stray = [];        // 人工笔记，策展时原样保留
    for (const f of fs.existsSync(this.topicsDir) ? await fsp.readdir(this.topicsDir) : []) {
      if (!f.endsWith('.md')) continue;
      const raw = await fsp.readFile(path.join(this.topicsDir, f), 'utf8');
      const parsed = parseTopicFile(f, raw);
      for (const e of parsed.entries) {
        if (!this.byId.has(e.id)) { this.byId.set(e.id, e); this._push(e); }
      }
      if (parsed._stray && parsed._stray.trim()) this._stray.push({ file: f, text: parsed._stray.trim() });
      if (parsed.tail && parsed.tail.trim()) this._stray.push({ file: f, text: parsed.tail.trim() });
    }
    this.db = openSqlite(this.sqliteFile);
    return this;
  }
  _push(e) {
    if (!this.topics.has(e.topic)) this.topics.set(e.topic, []);
    const arr = this.topics.get(e.topic);
    if (!arr.some(x => x.id === e.id)) arr.push(e);
  }

  /** 沉淀一条记忆；同 id 重复沉淀 = 命中（hits+1），可选补充正文。返回 {id, merged}。 */
  async add({ text, topic = 'general', kind = 'fact', anchors: anchorList }) {
    const t = normText(text);
    if (!t) throw new Error('memory.add: empty text');
    const id = hashId(topic, t);
    const hit = this.byId.get(id);
    if (hit) { hit.hits += 1; return { id, merged: true, entry: hit }; }
    const entry = {
      id, topic: slug(topic), kind, created: Date.now(), hits: 0,
      anchors: dedupeAnchors(anchorList || anchors(t)), text: t,
    };
    this.byId.set(id, entry); this._push(entry);
    return { id, merged: false, entry };
  }

  /** 召回：anchor 精确匹配为主、token 交叠为辅、hits 加权，预算内出切片。 */
  recall(query, { budget = 800, k = 12 } = {}) {
    const q = normText(query);
    const qa = new Set(anchors(q));
    const qt = new Set(q.toLowerCase().match(/[a-z0-9\u4e00-\u9fa5]{2,}/g) || []);
    const scored = [];
    for (const e of this.byId.values()) {
      let score = 0;
      for (const a of e.anchors) if (qa.has(a)) score += 3;
      const et = new Set((e.text + ' ' + e.topic).toLowerCase().match(/[a-z0-9\u4e00-\u9fa5]{2,}/g) || []);
      let overlap = 0; for (const t of qt) if (et.has(t)) overlap++;
      score += overlap / (1 + et.size / 32);
      score += 0.15 * e.hits + (e.kind === 'lesson' ? 0.3 : 0);
      if (score > 0) scored.push([score, e]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].id.localeCompare(b[1].id));
    const picked = [];
    let used = 0;
    for (const [, e] of scored) {
      if (picked.length >= k) break;
      const cost = tok(e.text) + 10;
      if (used + cost > budget) continue;
      picked.push(e); used += cost;
    }
    return picked;
  }

  renderRecall(picked, query) {
    if (picked.length === 0) return '';
    const lines = [
      '## 召回的长期记忆（ctxfold memory，按相关度排序；锚点为逐字事实，勿改写）',
      ...picked.map(e => `- [${e.kind}/${e.topic}] ${e.text}${e.anchors.length ? `\n  锚点: ${e.anchors.join(' | ')}` : ''}`),
    ];
    return lines.join('\n');
  }

  /** 确定性策展：子集合并 + 长期未命中衰减归档 + 权威层/派生层重写。返回审计报告。 */
  async curate({ retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
    const report = { merged: 0, archived: 0, kept: 0, rebuilt: true };
    const cutoff = Date.now() - retentionDays * 86400000;
    // 1) 子集合并：同类同主题、锚点集合为子集且正文高度重叠 → 并入超集
    const byTopic = [...this.topics.values()];
    const removed = new Set();
    for (const arr of byTopic) {
      for (const x of arr) {
        if (removed.has(x.id)) continue;
        for (const y of arr) {
          if (y === x || removed.has(y.id) || y.kind !== x.kind) continue;
          const xs = new Set(x.anchors), ys = new Set(y.anchors);
          const sub = xs.size > 0 && ys.size >= xs.size && [...xs].every(a => ys.has(a));
          const jac = textJaccard(x.text, y.text);
          if ((sub && jac >= 0.5) || jac >= 0.8) {
            y.hits += x.hits + 1; y.created = Math.min(y.created, x.created);
            removed.add(x.id); this.byId.delete(x.id); report.merged++;
            break;
          }
        }
      }
    }
    // 2) 衰减归档：零命中且超龄 → 移入 archive
    const archived = [];
    for (const [id, e] of this.byId) {
      if (e.hits === 0 && e.created > 0 && e.created < cutoff) {
        archived.push(e); removed.add(id); this.byId.delete(id); report.archived++;
      }
    }
    if (archived.length) {
      const f = path.join(this.dir, 'archive.md');
      const prev = fs.existsSync(f) ? await fsp.readFile(f, 'utf8') : '';
      await fsp.writeFile(f, prev + archived.map(serializeEntry).join('\n'), 'utf8');
    }
    report.kept = this.byId.size;
    // 3) 重写权威层 + 索引
    await this.flush();
    return report;
  }

  async forget(id) {
    const e = this.byId.get(id);
    if (!e) return false;
    this.byId.delete(id);
    this.flush(); // 异步容忍：forget 后立即 flush
    return true;
  }

  /** 校验：条目 id 与 (topic, 正文) 再哈希一致，权威层无残缺条目。 */
  verify() {
    const bad = [];
    for (const e of this.byId.values()) {
      if (e.id !== hashId(e.topic, e.text)) bad.push({ id: e.id, reason: 'id 不匹配（正文被改过？）' });
    }
    return { ok: bad.length === 0, bad, entries: this.byId.size };
  }

  /** 关闭派生层句柄（sqlite）。权威层是文件，无需关闭。 */
  close() { try { this.db?.close(); } catch {} this.db = null; }

  stats() {
    const byKind = {}, byTopic = {};
    for (const e of this.byId.values()) { byKind[e.kind] = (byKind[e.kind] || 0) + 1; byTopic[e.topic] = (byTopic[e.topic] || 0) + 1; }
    return { version: MEM_VERSION, entries: this.byId.size, topics: this.topics.size, byKind, byTopic, index: this.db ? 'sqlite' : 'json' };
  }

  /** 全量落盘：权威层（topics/*.md + MEMORY.md）+ 派生层（sqlite 或 index.json）。 */
  async flush() {
    // 权威层：确定性排序（topic → created → id）
    const files = new Map();
    for (const e of this.byId.values()) {
      const f = slug(e.topic) + '.md';
      if (!files.has(f)) files.set(f, []);
      files.get(f).push(e);
    }
    for (const [f, list] of files) {
      list.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
      await fsp.writeFile(path.join(this.topicsDir, f), list.map(serializeEntry).join('\n'), 'utf8');
    }
    // 主题文件被清空/改名后移除旧文件
    for (const f of await fsp.readdir(this.topicsDir)) if (f.endsWith('.md') && !files.has(f)) await fsp.unlink(path.join(this.topicsDir, f)).catch(() => {});
    await fsp.writeFile(path.join(this.dir, 'MEMORY.md'), this.renderIndex(), 'utf8');
    // 派生层
    if (this.db) {
      try {
        this.db.exec('DELETE FROM entries; DELETE FROM entries_fts; DELETE FROM anchors;');
        const insE = this.db.prepare('INSERT INTO entries (id, topic, kind, body) VALUES (?,?,?,?)');
        const insF = this.db.prepare('INSERT INTO entries_fts (id, body) VALUES (?,?)');
        const insA = this.db.prepare('INSERT INTO anchors (anchor, id) VALUES (?,?)');
        this.db.exec('BEGIN');
        for (const e of this.byId.values()) {
          insE.run(e.id, e.topic, e.kind, e.text);
          insF.run(e.id, e.text);
          for (const a of e.anchors) insA.run(a, e.id);
        }
        this.db.exec('COMMIT');
        fsp.unlink(this.indexFile).catch(() => {});
        return;
      } catch { /* sqlite 写失败 → 降级 json */ this.db = null; }
    }
    const inv = {};
    for (const e of this.byId.values()) for (const a of e.anchors) (inv[a] = inv[a] || []).push(e.id);
    await fsp.writeFile(this.indexFile, JSON.stringify({ version: MEM_VERSION, entries: this.byId.size, inverted: inv }, null, 1), 'utf8');
  }

  renderIndex() {
    const topics = [...this.topics.keys()].sort();
    const out = [`<!-- ctxfold:index version=${MEM_VERSION} entries=${this.byId.size} -->`,
      '# 记忆索引（MEMORY.md）',
      '',
      '> ctxfold memory 权威层索引页。正文在 topics/<主题>.md，条目以 ctxfold:entry 注释标记；可直接编辑，`ctxfold memory curate` 会重写本页。',
      ''];
    for (const t of topics) {
      const arr = this.topics.get(t).slice().sort((a, b) => b.hits - a.hits || a.created - b.created || a.id.localeCompare(b.id));
      out.push(`## ${t}（${arr.length}）`, '');
      for (const e of arr) out.push(`- [${e.kind}] ${e.id}（hits ${e.hits}）${firstLine(e.text, 80)}`);
      out.push('');
    }
    return out.join('\n');
  }
}

// ---------- 沉淀：会话/文本 → 记忆条目（确定性规则，零 LLM） ----------
const RX_LESSON = /(失败|报错|错误|教训|踩坑|注意|避免|根因|bug|fix(?:ed)?|lesson|mistake|pitfall|don't)/i;
const RX_DECISION = /(决定|决策|选定|方案是|拍板|采用|改用|decided|we (?:use|go with)|chose)/i;

function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?])|(?<=\.)\s+|\n/)
    .map(s => s.trim()).filter(s => s.length > 8);
}

/**
 * 确定性蒸馏：从会话 jsonl（{role,content,kind?} 行）或纯文本提取三类记忆。
 * @returns {{facts: string[], lessons: string[], decisions: string[]}}
 */
function distillText(rawText, { maxFacts = 40, maxLessons = 12, maxDecisions = 12 } = {}) {
  const all = normText(rawText);
  const facts = anchors(all).slice(0, maxFacts);
  const lessons = [], decisions = [];
  for (const s of sentences(rawText)) {
    if (RX_LESSON.test(s) && lessons.length < maxLessons) lessons.push(gist(s, 240));
    else if (RX_DECISION.test(s) && decisions.length < maxDecisions) decisions.push(gist(s, 240));
  }
  return { facts, lessons, decisions };
}

/** 会话文件/文本 → 写入 MemoryStore。返回审计摘要。 */
async function distill(store, input, { topic, maxFacts, maxLessons, maxDecisions } = {}) {
  let raw;
  if (typeof input === 'string' && /\n/.test(input) && !fs.existsSync(input)) raw = input;
  else if (typeof input === 'string') {
    const t = await fsp.readFile(input, 'utf8');
    raw = t.split('\n').filter(l => l.trim()).map(l => {
      try { const m = JSON.parse(l); return `[${m.role || m.kind || '?'}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')}`; }
      catch { return l; } // 纯文本行原样
    }).join('\n');
  } else raw = String(input || '');
  const d = distillText(raw, { maxFacts, maxLessons, maxDecisions });
  // 主题推断：路径锚点的公共根，否则 general
  let autoTopic = topic;
  if (!autoTopic) {
    const paths = d.facts.filter(a => /[\\/]/.test(a));
    const roots = paths.map(p => (p.match(/[^\\/]+$/) ? p.replace(/[\\/][^\\/]*$/, '') : p).split(/[\\/]/).pop());
    const tally = {};
    roots.forEach(r => { if (r) tally[r] = (tally[r] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    autoTopic = top && top[1] >= 2 ? top[0] : 'general';
  }
  const out = { topic: slug(autoTopic), facts: 0, lessons: 0, decisions: 0, merged: 0, added: 0 };
  const push = async (kind, text) => {
    const r = await store.add({ text, topic: autoTopic, kind });
    out[kind === 'lesson' ? 'lessons' : kind === 'decision' ? 'decisions' : 'facts']++;
    r.merged ? out.merged++ : out.added++;
  };
  for (const f of d.facts) await push('fact', f);
  for (const l of d.lessons) await push('lesson', `${l}`);
  for (const s of d.decisions) await push('decision', `${s}`);
  await store.flush();
  return out;
}

// ---------- 内部 ----------
function dedupeAnchors(list) {
  const out = [];
  for (const a of list) { const v = String(a).trim(); if (v && !out.includes(v)) out.push(v); }
  return out.slice(0, 40);
}
function textJaccard(a, b) {
  const A = new Set(a.toLowerCase().match(/[a-z0-9\u4e00-\u9fa5]{2,}/g) || []);
  const B = new Set(b.toLowerCase().match(/[a-z0-9\u4e00-\u9fa5]{2,}/g) || []);
  if (A.size === 0 && B.size === 0) return a === b ? 1 : 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function firstLine(t, n) { const s = normText(t).split(' ')[0] || ''; return `— ${s.slice(0, n)}${s.length > n || normText(t).length > n ? '…' : ''}`; }

module.exports = { MEM_VERSION, MemoryStore, distill, distillText, hashId, slug, serializeEntry, parseTopicFile };

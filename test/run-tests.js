// ctxfold 测试：百万 token 性能 + 锚点保留 + 预算达标 + 确定性 + 降智提示
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CF = require(path.join(__dirname, '..', 'ctxfold.js'));

const BIN = path.join(__dirname, '..', 'ctxfold.js');
let pass = 0, fail = 0;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const run = (d, ...a) => execFileSync('node', [BIN, ...a], { cwd: d, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));

t('U1 tok 近似计数', () => {
  assert(CF.tok('hello world') === 3, '英文 11 字符≈3');
  assert(CF.tok('你好世界') === 4, '中文 4 字=4');
  assert(CF.tok('') === 0, '');
});
t('U2 anchors 提取关键事实', () => {
  const a = CF.anchors('部署到 H:\\work\\greenroom 且端口 18342，预算 1299 元，镜像 1panel/maxkb，hash abcd' + '0'.repeat(36));
  assert(a.some(x => x.includes('greenroom')), '路径锚');
  assert(a.some(x => x.includes('18342')), '数字锚');
  assert(a.some(x => x.includes('1299')), '金额锚');
  assert(a.some(x => x.length === 40 || x.length === 64), 'sha 锚');
});
t('U3 fold 折叠确定性', () => {
  const long = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n');
  const f1 = CF.fold(long, 6, 4), f2 = CF.fold(long, 6, 4);
  assert(f1 === f2, '同输入同输出');
  assert(f1.includes('ctxfold: 折叠 90 行') && f1.includes('line 0') && f1.includes('line 99'), '头尾保留+中段折叠');
});

t('P1 百万 token 一次压缩（性能主目标）', async () => {
  const D = tmp();
  const f = path.join(D, 'session.jsonl');
  const lines = [];
  // 构造 ~1.1M token：2000 条 chat（各 ~250 tok）+ 500 条 tool 输出（各 ~1200 tok）
  const filler = 'x'.repeat(1000); // ≈250 tok/条
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ role: i % 2 ? 'user' : 'assistant', content: `任务 ${i} 的上下文段落。${filler} 关键数值 ${i * 7}，路径 C:/run/${i}/out.log` }));
  const toolOut = Array.from({ length: 150 }, (_, j) => `log line ${j} ${'y'.repeat(6)}`).join('\n'); // ~1200 tok
  for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ role: 'tool', content: `工具执行 #${i}\n${toolOut}` }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const inTok = CF.tok(lines.map(l => JSON.parse(l).content).join(' '));
  console.log(`  输入规模: ${inTok} token（${(fs.statSync(f).size / 1e6).toFixed(1)}MB）`);
  const t0 = Date.now();
  const stats = await CF.compress(f, f + '.folded', { model: 'deepseek-flash', profile: CF.PROFILES['deepseek-flash'], budget: 60000, toolFold: 400, head: 6, tail: 4, recent: 20, gistLen: 120 });
  const ms = Date.now() - t0;
  console.log(`  压缩: ${stats.in_tok} -> ${stats.out_tok} tok (x${stats.ratio}), ${stats.ms}ms`);
  const st = stats;
  assert(st.in_tok > 500e3, '输入应达数十万+ token: ' + st.in_tok);
  assert(stats.out_tok <= 62000, '输出必须达预算: ' + stats.out_tok);
  assert(stats.anchors > 100, '锚点应大量保留: ' + stats.anchors);
  assert(ms < 15000, `百万级压缩应在 15s 内，实际 ${ms}ms`);
  console.log(`  压缩耗时(含进程): ${ms}ms`);
  // 锚点防遗忘验证：抽查的关键事实必须出现在输出
  const outTxt = fs.readFileSync(f + '.folded', 'utf8');
  assert(outTxt.includes('C:/run/1999/out.log'), '关键路径经 ANCHORS 保留');
  assert(outTxt.includes('13993'), '关键数值(1999*7)经 ANCHORS 保留');
});
t('P2 确定性：两次压缩逐位一致', () => {
  const D = tmp();
  const f = path.join(D, 's.jsonl');
  fs.writeFileSync(f, Array.from({ length: 60 }, (_, i) => JSON.stringify({ role: 'user', content: `m${i} `.repeat(50) })).join('\n'));
  run(D, 'fold', '--in', f, '--out', f + '.a', '--budget', '3000');
  run(D, 'fold', '--in', f, '--out', f + '.b', '--budget', '3000');
  assert(fs.readFileSync(f + '.a').equals(fs.readFileSync(f + '.b')), '输出必须可重复');
});
t('P3 pinned/system 永不压缩', () => {
  const D = tmp();
  const f = path.join(D, 's.jsonl');
  const sys = '你是无人化交付助手，必须遵守宪法 8 条。' + 'z'.repeat(3000);
  const lines = [JSON.stringify({ role: 'system', content: sys })];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ role: 'user', content: `chat ${i} `.repeat(40) }));
  fs.writeFileSync(f, lines.join('\n'));
  run(D, 'fold', '--in', f, '--out', f + '.o', '--budget', '2000');
  const out = fs.readFileSync(f + '.o', 'utf8');
  assert(out.includes('宪法 8 条'), 'system 全文必须保留');
});

(async () => {
  for (const [n, f] of tests) { try { await f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + ': ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

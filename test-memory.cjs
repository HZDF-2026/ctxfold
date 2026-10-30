// ctxfold memory 测试（确定性沉淀/召回/策展/校验 + 混合索引降级）
// 运行: node test-memory.mjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { MemoryStore, distill, distillText, hashId } = require('./memory.js');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxfold-mem-'));
  const t = {};

  // ---- 1. distillText：教训/决策/事实三类确定性提取 ----
  const sample = [
    '把 handoff.enabled 打开，阈值设为 25000，用 /bin/jq.exe 解析 H:\\ctxfold\\docs\\x.md。',
    '构建失败：Permission denied dist/babele.exe——根因是旧进程占用，教训是先 Stop-Process 再重建。',
    '决定采用 node:sqlite 做派生索引，改用 Markdown 做权威层。',
  ].join('\n');
  const d = distillText(sample);
  assert.ok(d.facts.includes('25000') && d.facts.includes('handoff.enabled'), '锚点事实提取: ' + JSON.stringify(d.facts));
  assert.ok(d.lessons.length >= 1 && /教训/.test(d.lessons[0]), '教训提取');
  assert.ok(d.decisions.length >= 1, '决策提取');
  t.distillText = 'PASS';

  // ---- 2. distill → 权威层落盘 + 混合派生索引 ----
  const store = await new MemoryStore(dir).open();
  const r = await distill(store, sample, { topic: 'ctxfold-通用化' });
  assert.ok(r.added > 0 && r.facts > 0, '沉淀产出条目');
  assert.ok(fs.existsSync(path.join(dir, 'MEMORY.md')), 'MEMORY.md 索引页存在');
  const topicFile = path.join(dir, 'topics', 'ctxfold-通用化.md');
  assert.ok(fs.existsSync(topicFile), '主题分片存在');
  const raw = fs.readFileSync(topicFile, 'utf8');
  assert.ok(raw.includes('ctxfold:entry id='), '条目机器可解析标记');
  assert.ok(raw.includes('25000') || raw.includes('handoff.enabled'), '锚点随条目保存');
  const hasSql = fs.existsSync(path.join(dir, 'ctxfold.sqlite'));
  const hasJson = fs.existsSync(path.join(dir, 'index.json'));
  assert.ok(hasSql || hasJson, '派生索引存在（sqlite 或 json 降级）');
  t.distill = `PASS（派生索引=${hasSql ? 'sqlite' : 'json'}）`;

  // ---- 3. 重复沉淀同一会话 = 合并命中（去重 + hits 累加）----
  const before = store.byId.size;
  const r2 = await distill(store, sample, { topic: 'ctxfold-通用化' });
  assert.equal(store.byId.size, before, '同内容重复沉淀零新增');
  assert.ok(r2.merged > 0, '重复沉淀计入命中');
  t.dedupe = 'PASS';

  // ---- 4. recall：锚点匹配召回 + 预算收敛 ----
  const picked = store.recall('继续处理 babele.exe 构建失败的问题，注意 handoff.enabled 的配置', { budget: 600 });
  assert.ok(picked.length > 0, '有召回');
  const texts = picked.map(e => e.text).join(' ');
  assert.ok(/babele|handoff/.test(texts), '召回与查询相关');
  assert.ok(picked.every(e => !e.text.includes('\n\n')), '条目为紧凑切片');
  const md = store.renderRecall(picked, 'q');
  assert.ok(md.includes('召回的长期记忆'), '注入格式渲染');
  t.recall = 'PASS';

  // ---- 5. verify：权威层完整性 ----
  const v = store.verify();
  assert.equal(v.ok, true, '全部条目 id 可复算: ' + JSON.stringify(v.bad));
  t.verify = 'PASS';

  // ---- 6. 人工改坏一条正文 → verify 必须报警（检完还原）----
  const first = [...store.byId.values()][0];
  const original = first.text;
  first.text = first.text + '（被人改过）';
  const v2 = store.verify();
  assert.equal(v2.ok, false, '改写后 id 不再匹配');
  first.text = original;
  t.tamper = 'PASS（改写可检出）';

  // ---- 7. curate：策展后权威层重写、索引重建、条目仍完整 ----
  const report = await store.curate({ retentionDays: 1 });
  assert.ok(typeof report.kept === 'number' && report.kept >= 0, '策展报告');
  assert.equal(store.verify().ok, true, '策展后权威层完整');
  const raw2 = fs.readFileSync(topicFile, 'utf8');
  assert.ok(raw2.includes('ctxfold:entry id='), '策展重写后条目标记仍在');
  t.curate = `PASS（合并 ${report.merged}｜归档 ${report.archived}）`;

  // ---- 8. 换目录重开（模拟另一 agent 直接读文件）→ 状态一致 ----
  const store2 = await new MemoryStore(dir).open();
  assert.equal(store2.byId.size, store.byId.size, '重开记忆库条目数一致');
  const picked2 = store2.recall('babele.exe Permission denied', { budget: 400 });
  assert.ok(picked2.length > 0, '重开后召回仍工作');
  t.reopen = 'PASS';

  store.close(); store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(Object.entries(t).map(([k, s]) => `${k}: ${s}`).join('\n'));
  console.log('\ntest-memory.mjs: ALL PASS');
  const { tok } = require('./ctxfold.js');
  console.log(`（派生索引模式: ${store2.db ? 'node:sqlite' : 'index.json 降级'}｜样本注入约 ${tok(store2.renderRecall(picked2, ''))} tok）`);
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });

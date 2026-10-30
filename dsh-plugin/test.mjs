/**
 * 宿主外自测：node test.mjs —— 只验证 summary builder（不依赖 dsh 宿主）。
 * 完整链路（peer 拦截 + 宿主类加载 + 引擎契约）见 ctxfold 仓库 docs/DSH_COMPACTION_ANALYSIS.md。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildCtxfoldSummary, resolveCtxfoldConfig } from "./summary.js";

const require2 = createRequire(import.meta.url);
const { tok } = require2("./ctxfold.cjs");

const config = resolveCtxfoldConfig({});

// 足够大的会话，确保主路径（结构化三层）而非小 region 兜底被测到
const filler = Array.from({ length: 30 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: [{ type: "text", text: `第 ${i} 条工作消息：常规内容 ${i}，改动文件 module_${i}.ts，一切按计划推进。` }],
}));
const input = {
  messages: [
    { role: "system", content: [{ type: "text", text: "system prompt stays on the surface head" }] },
    { role: "user", content: [{ type: "text", text: "把 handoff.enabled 打开，阈值设为 25000，用 /bin/jq.exe 解析。" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "考虑配置顺序。" },
        { type: "tool-call", name: "edit", arguments: '{"path": "H:\\\\ctxfold\\\\config.yml"}' },
        { type: "text", text: "完成。" },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "<compacted-summary>\n- C:\\old\\seed.txt\n- 65536\n</compacted-summary>" }],
    },
    ...filler,
  ],
};

const text = buildCtxfoldSummary(input, config);

// 锚点保真：三类典型事实逐字在场
for (const fact of ["handoff.enabled", "25000", "/bin/jq.exe", "C:\\old\\seed.txt", "65536"]) {
  assert.ok(text.includes(fact), `anchor lost: ${fact}`);
}

// 旧 checkpoint 前向携带 + 结构存在
assert.ok(text.includes("Prior Checkpoint"), "prior checkpoint must be carried");
assert.ok(text.includes("Verbatim Anchors"), "anchor section header");
assert.ok(text.includes("Chronological Fold"), "fold section header");

// 确定性：同输入两次构建字节一致
assert.equal(buildCtxfoldSummary(input, config), text);

// 收敛：摘要恒小于输入
const inputTokens = tok(input.messages.map((m) => m.content?.map?.((b) => b.text ?? b.arguments ?? "").join("\n") ?? "").join("\n"));
assert.ok(tok(text) < inputTokens, `summary ${tok(text)} must be smaller than input ${inputTokens}`);

// 收窄：非法配置值被夹回区间
const narrow = resolveCtxfoldConfig({ budgetRatio: 99, maxSummaryTokens: -1, gistMaxChars: 1e9, anchorLimit: 0 });
assert.ok(narrow.budgetRatio <= 0.9 && narrow.maxSummaryTokens >= 256 && narrow.gistMaxChars <= 4000 && narrow.anchorLimit >= 10);

// 小 region 兜底：病态小输入下也必须产出非空 checkpoint
// （dsh 的 selectCompactableRange 本就不会选中无意义小区间，此处只验证不抛异常）
const tinyIn = { messages: [{ role: "user", content: [{ type: "text", text: "a b c" }] }] };
const tiny = buildCtxfoldSummary(tinyIn, config);
assert.ok(typeof tiny === "string" && tiny.length > 0);

console.log("test.mjs: ALL PASS");

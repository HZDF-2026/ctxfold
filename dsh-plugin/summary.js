/**
 * ctxfold 摘要构建器 —— 确定性、零 LLM、锚点保真。
 *
 * 输入是 dsh buildSummarizationInput() 的回放前缀：{ messages: [...], tools? }。
 * 输出一段结构化 checkpoint 文本，由引擎套上 <compacted-summary> 标签替换被遮蔽区。
 *
 * 三层防线：
 *  1. ANCHORS  —— 逐字事实清单（路径/数字/URL/哈希/命令 + 反引号代码片段 + 点分标识符，
 *                 如 handoff.enabled、25000、/bin/jq.exe）。永不转述，永不丢失。
 *  2. PRIOR    —— 若被遮蔽区内已有旧的 <compacted-summary>，整段前向携带（过长则头尾折叠，
 *                 中段以 sha256 指纹替代，可校验可复现）。
 *  3. FOLD     —— 会话按时间序做确定性 gist（首句裁断 + 锚点密度），新消息权重高于旧消息。
 *
 * 全程无 Date/random/Set 遍历序，同一输入永远产生同一输出（字节级确定性）。
 * 模块只依赖 ./ctxfold.cjs，可在宿主外单测。
 */
import ctxfold from "./ctxfold.cjs";

const { tok, anchors, fold, gist } = ctxfold;

// ---------- 插件级锚点补充（ctxfold ANCHOR_RX 之外的高价值事实形态） ----------
// 反引号代码片段：agent 会话里关键事实最常出现的形态，如 `handoff.enabled`、`/bin/jq.exe`
const RX_BACKTICK = /`([^`\n]{2,160})`/g;
// 点分标识符：配置键、常量名、API 名（handoff.enabled、ctx.llm.stream）
const RX_DOTTED = /\b[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){1,5}\b/g;

/** 提取一段文本的全部锚点（ctxfold 基础正则 + 插件补充正则），按出现顺序去重。 */
function allAnchors(text, limit) {
  const seen = [];
  const add = (value) => {
    const v = value.trim();
    if (v.length === 0 || v.length > 200) return;
    // 子串去重：jq.exe 已含于 /bin/jq.exe，留最长形态；超集到来时原位升级（确定性）
    for (let i = 0; i < seen.length; i++) {
      if (seen[i].includes(v)) return;
      if (v.includes(seen[i])) {
        seen[i] = v;
        return;
      }
    }
    seen.push(v);
  };
  for (const a of anchors(text)) add(a);
  RX_BACKTICK.lastIndex = 0;
  for (const m of text.matchAll(RX_BACKTICK)) add(m[1]);
  RX_DOTTED.lastIndex = 0;
  for (const m of text.matchAll(RX_DOTTED)) add(m[0]);
  return seen.slice(0, limit);
}

/** 把一条回放消息的 content 块压成纯文本（text 保留、reasoning 短注、tool-call 记名+参数、图片记占位）。 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "reasoning" && typeof block.text === "string") parts.push(`(reasoning) ${block.text}`);
    else if (block.type === "tool-call") {
      const args = typeof block.arguments === "string" ? block.arguments : "";
      parts.push(`[tool-call ${block.name ?? "?"}] ${args}`);
    } else if (block.type === "image") parts.push("[image omitted]");
  }
  return parts.join("\n");
}

const SUMMARY_OPEN = "<compacted-summary>";
const SUMMARY_CLOSE = "</compacted-summary>";

/**
 * 拆出消息文本中携带的旧 checkpoint。
 * 返回 { prior: string[] }（旧摘要正文列表，可能为空）或 null（普通消息）。
 */
function splitPriorCheckpoint(text) {
  const open = text.indexOf(SUMMARY_OPEN);
  if (open < 0) return null;
  const inner = [];
  let rest = text;
  for (;;) {
    const a = rest.indexOf(SUMMARY_OPEN);
    if (a < 0) break;
    const b = rest.indexOf(SUMMARY_CLOSE, a);
    if (b < 0) break;
    inner.push(rest.slice(a + SUMMARY_OPEN.length, b).trim());
    rest = rest.slice(b + SUMMARY_CLOSE.length);
  }
  if (inner.length === 0) return null;
  return { prior: inner };
}

/** 按行数自适应的确定性折叠：过长文本保头尾，中段以 sha256 指纹替代。 */
function foldToBudget(text, tokenBudget) {
  if (tok(text) <= tokenBudget) return text;
  const lines = text.split("\n");
  // 预算折算行数（按平均每行 6 token 保守估计），头尾各半，至少保 3+3
  let keep = Math.max(6, Math.floor((tokenBudget / 6) * 1.2));
  if (keep >= lines.length) {
    // 行数放得下但单行太长：退化为 ctxfold gist 裁断，按 token 约束收敛（确定性）
    let chars = Math.max(40, tokenBudget * 3);
    let out = gist(text, chars);
    while (tok(out) > tokenBudget && chars > 20) {
      chars = Math.floor(chars / 2);
      out = gist(text, chars);
    }
    return out;
  }
  return fold(text, Math.max(3, Math.ceil(keep / 2)), Math.max(3, Math.floor(keep / 2)));
}

/** ctxfold 插件配置的默认值与收窄。 */
export function resolveCtxfoldConfig(raw = {}) {
  const number = (value, fallback, min, max) => {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    budgetRatio: number(raw.budgetRatio, 0.35, 0.05, 0.9),
    maxSummaryTokens: Math.floor(number(raw.maxSummaryTokens, 12000, 256, 65536)),
    gistMaxChars: Math.floor(number(raw.gistMaxChars, 320, 64, 4000)),
    anchorLimit: Math.floor(number(raw.anchorLimit, 200, 10, 1000)),
  };
}

/**
 * 构建 checkpoint 摘要文本。
 * @param input dsh 回放前缀 { messages, tools? }
 * @param config resolveCtxfoldConfig 的产物
 * @returns 确定性摘要字符串（非空）
 */
export function buildCtxfoldSummary(input, config) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];

  // 1. 拆消息：系统提示留在原对话 surface 头部（不占预算）；旧 checkpoint 单独前向
  const rows = [];
  const prior = [];
  for (const message of messages) {
    if (message?.role === "system") continue;
    const text = messageText(message);
    if (text.length === 0) continue;
    const split = splitPriorCheckpoint(text);
    if (split !== null) prior.push(...split.prior);
    else rows.push({ role: String(message?.role ?? "?"), text });
  }

  const fullText = rows.map((r) => r.text).join("\n") + "\n" + prior.join("\n");
  const estInputTokens = tok(fullText);
  // 摘要必须严格小于被遮蔽区（summarizeCompaction 的收敛校验），预算恒为输入的一个比例
  const budget = Math.min(
    Math.max(Math.floor(estInputTokens * config.budgetRatio), 24),
    config.maxSummaryTokens,
  );

  // 2. ANCHORS 层（≤40% 预算）
  const anchorBudget = Math.max(24, Math.floor(budget * 0.4));
  const anchorLines = [];
  let anchorTokens = 0;
  for (const a of allAnchors(fullText, config.anchorLimit)) {
    const cost = tok(a) + 2;
    if (anchorTokens + cost > anchorBudget && anchorLines.length > 0) break;
    anchorLines.push(a);
    anchorTokens += cost;
  }

  // 3. PRIOR 层（≤30% 预算）：旧 checkpoint 是更早历史的唯一载体，整段前向（过长折叠）
  const priorBudget = Math.floor(budget * 0.3);
  const priorBlock = prior.length === 0 ? "" : foldToBudget(prior.join("\n\n---\n\n"), priorBudget);

  // 4. FOLD 层（剩余预算）：时间序 gist，新消息权重高（每往前 8 条配额减半）
  const gistBudget = Math.max(24, budget - anchorTokens - tok(priorBlock));
  const weights = [];
  for (let i = 0; i < rows.length; i++) {
    const ageFromNewest = rows.length - 1 - i;
    weights.push(1 / 2 ** Math.floor(ageFromNewest / 8));
  }
  const weightSum = weights.reduce((s, w) => s + w, 0) || 1;
  const gists = [];
  let gistTokens = 0;
  // 新→旧分配；旧且无预算的消息至少留锚点已在 ANCHORS 层兜底
  for (let i = rows.length - 1; i >= 0; i--) {
    const share = Math.max(24, Math.floor((gistBudget * weights[i]) / weightSum));
    const maxChars = Math.min(config.gistMaxChars, Math.max(40, share * 2));
    const line = `- [${rows[i].role}] ${gist(rows[i].text, maxChars).replace(/\s+/g, " ")}`;
    const cost = tok(line);
    if (gistTokens + cost > gistBudget && gists.length > 0) continue;
    if (gistTokens + cost > gistBudget * 2) break;
    gists.push(line);
    gistTokens += cost;
  }
  gists.reverse(); // 恢复 旧→新

  // 5. 组装
  const out = [];
  out.push("## Verbatim Anchors (facts preserved exactly; never paraphrased)");
  if (anchorLines.length === 0) out.push("(none)");
  else for (const a of anchorLines) out.push(`- ${a}`);
  if (priorBlock !== "") {
    out.push("");
    out.push("## Prior Checkpoint (carried forward from an earlier compaction)");
    out.push(priorBlock);
  }
  out.push("");
  out.push("## Chronological Fold (oldest to newest; hashed middles are exact, see anchors)");
  if (gists.length === 0) out.push("(none)");
  else out.push(...gists);
  const text = out.join("\n");

  // 6. 最终确定性收敛：任何配置错误都不允许产出 ≥ 输入的摘要。
  // 小 region（主路径预算下限放不下结构时）退化为极简 checkpoint：
  // prior checkpoint（若有，占一半预算）+ 逐字锚点清单。
  if (tok(text) >= estInputTokens) {
    const cap = Math.max(8, Math.floor(estInputTokens / 2));
    const mini = [];
    if (prior.length > 0) {
      // prior 占 40%，当前 region 的逐字锚点优先拿余量（新事实先保）
      const priorMini = foldToBudget(prior.join("\n\n---\n\n"), Math.floor(cap * 0.4));
      mini.push(priorMini);
    }
    for (const a of allAnchors(fullText, 40)) {
      const line = `- ${a}`;
      if (tok(mini.join("\n")) + tok(line) >= cap) break;
      mini.push(line);
    }
    return mini.length > 0 ? mini.join("\n") : "(empty region)";
  }
  return text;
}

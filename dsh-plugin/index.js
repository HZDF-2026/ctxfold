/**
 * dsh-compaction-ctxfold —— ctx.compaction 的确定性后端。
 *
 * 继承 BasicCompactionEngine，只覆盖官方留出的唯一子类钩子 summarize()：
 * 不调 ctx.llm.stream()，改跑 ctxfold 管线（锚点 + 折叠 + 边际价值 gist），
 * 毫秒级、零 token、字节级可复现，关键事实（handoff.enabled / 25000 / /bin/jq.exe …）
 * 以原 token 逐字进 ANCHORS 层，消除模型转述的事实漂移。
 *
 * 宿主依赖通过 peerDependencies 声明，由 dsh 的 profile-resolution
 * 拦截解析到安装内置版本（与 app 内同一模块实例，无副本冲突）。
 *
 * @module @local/dsh-compaction-ctxfold
 */
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { buildCtxfoldSummary, resolveCtxfoldConfig } from "./summary.js";

const CTXFOLD_PROVIDER = "ctxfold";
const CTXFOLD_MODEL = "ctxfold-rules-v1.2";

export default class CtxfoldCompactionEngine extends BasicCompactionEngine {
  /** 沿用 basic 的配置 schema；ctxfold 自有键经 schemastery 透传，由本构造器消化。 */
  static Config = BasicCompactionEngine.Config;

  /** ctxfold 摘要预算（resolveCtxfoldConfig 收窄后的产物）。 */
  ctxfoldConfig;

  constructor(ctx, config = {}) {
    const raw = typeof config === "object" && config !== null ? config : {};
    const {
      // CtxfoldConfig —— 摘要预算键，不进 basic 的严格白名单
      budgetRatio,
      maxSummaryTokens,
      gistMaxChars,
      anchorLimit,
      // 其余全部透传给 BasicCompactionConfig（thresholdRatio/retainRatio/auto/…）
      ...basicConfig
    } = raw;
    super(ctx, basicConfig);
    this.ctxfoldConfig = resolveCtxfoldConfig({ budgetRatio, maxSummaryTokens, gistMaxChars, anchorLimit });
  }

  /**
   * 唯一子类钩子的 ctxfold 覆盖：确定性规则摘要，零 LLM 调用。
   * 返回契约与 basic 一致（summary 文本块 + rawOutput + provider/model），
   * llmStreamCall=false 使 commitCompactionBody 只把 rawOutput 记入
   * compaction/summary 事件（供审计与可复现验证）。
   */
  async summarize(input, agent, signal) {
    signal?.throwIfAborted();
    const text = buildCtxfoldSummary(input, this.ctxfoldConfig);
    signal?.throwIfAborted();
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("ctxfold summarization produced no text summary content");
    }
    const rawOutput = [{ type: "text", text }];
    return {
      summary: [{ type: "text", text }],
      rawOutput,
      llmStreamCall: false,
      provider: CTXFOLD_PROVIDER,
      model: CTXFOLD_MODEL,
    };
  }
}

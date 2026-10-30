# dsh compaction 对照分析：为什么替代要这样做才可靠

基于对 dsh 内置压缩子系统（`@deepseek-ai/dsh-compaction` 系列，源码自 app.asar 解包取证）的官方文档与实现记录。不是猜测——以下每条都有出处。

## 一、dsh 内置 compaction 的工作机制（basic 后端）

- **触发**：压力阈值 `floor(min(W×0.8, W − O − 65536))`（W=路由模型窗口，O=输出预留，65536=官方 headroom）；逐字保留近期对话 16%（`retainRatio`）。
- **摘要**：`ctx.llm.stream()` **用模型自己写**——回放节点 0 系统提示 + 被遮蔽范围消息 + 冻结压缩指令，输出一条 `<compacted-summary>` 标签的 user 消息**整体替换**早期范围。
- **回放确定性**：被遮蔽事件保留在日志中，回放可重现——dsh 明确以"确定性重现"为设计承诺。

## 二、deepseek-v4.1-1017 与该压缩的配合原因

1. **容量即路由**：阈值按"持久路由的模型容量"解析（`resolveCompactSpec` 要求显式 adapter 容量）——dsh 是 deepseek 自家 harness，0.8/headroom-64k 参数系按 deepseek 系列窗口特征整定（128k 窗 → 80k 触发，恰在质量衰减区之前）。
2. **热前缀缓存**：官方设计承诺"摘要复用提供方的热前缀 cache"——摘要调用回放原前缀使 deepseek 端 context cache 命中。deepseek 前缀缓存是压测过的成本杠杆，压缩设计围绕它展开。

## 三、来自官方记录的缺陷清单（替代要逐条解决的）

| # | 缺陷 | 出处 |
|---|---|---|
| 1 | **KV cache 失效**："成功的后端替换会使从第一个被遮蔽的历史 token 起的复用失效" | dsh-compaction README「KV Cache 影响」 |
| 2 | **摘要=模型转述，事实漂移**：模型写摘要把 `handoff.enabled`、`25000`、`/bin/jq.exe` 类关键事实摘丢（外部 agent 评审实测确认） | basic `summarize()` 走 llm.stream；无锚点保真层 |
| 3 | **token 序列整体改变 → 模型忽略旧内容**：替换消息使旧事实以转述形式存在于全新 token 序列中，注意力定位失效——即用户观察到的"切分方式改变而模型忽略内容" | 缺陷 1 的下游效应 |
| 4 | 摘要拒绝规则只有"不缩小则拒绝"——无事实级验证 | README「区域事务」 |
| 5 | 每次压缩一次 LLM 调用（上限 65536 token 输出），慢且有失败重试路径 | README `maxTokens` |
| 6 | 不可分单元无法压缩；envelope 超窗不归 compaction | 「已知限制」 |

## 四、ctxfold 后端的替代设计（走官方留的口子）

dsh 的 seam 设计明确支持第三方后端：**`summarize()` 是唯一子类钩子**，`SummaryResult.rawOutput` 变体"供不通过 ctx.llm.stream() 识别调用的摘要器使用"，且 README 写明"模板与远程后端，尚未决定"。

**dsh-compaction-ctxfold**（规划）：

```
继承 BasicCompactionEngine，仅覆盖 summarize()：
不调 LLM → 调 ctxfold 管线（fold + 锚点 + 边际价值要点）
→ rawOutput 返回结构化摘要：① ANCHORS 逐字事实清单（正则保全 handoff.enabled/25000/jq.exe）
  ② 按边际价值保留的历史要点
```

逐条对上缺陷：#2/#3/#4 消除（规则生成、事实以原 token 保留、确定性使验证可重复）；#5 消除（零 LLM 调用、毫秒级）；#1 仍在（替换本身必然失效 KV——前缀缓存损失是所有"替换式"压缩的共同代价，但确定性摘要至少使**重复压缩可复现**：同一历史永远产生同一 token 序列，第二次替换后行为可预测）。#6 属范围选择问题，与摘要方式无关。

## 五、给 dsh 侧的配置对照（何时用哪个）

| 场景 | 推荐 |
|---|---|
| 常规会话，deepseek 热前缀缓存敏感 | 内置 basic（前缀 cache 命中是它的成本优势） |
| 长任务关键事实密集（配置/参数/路径） | ctxfold 后端（锚点保真 > 缓存收益） |
| 需要压缩结果可审计/可重复 | ctxfold 后端（字节级确定性） |
| 会话交接（跨进程） | ctxfold handoff 输出（固定 markdown 格式） |

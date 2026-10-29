# ctxfold

**Deterministic context compression for AI agents — model-aware, million-token scale, anchor-protected.** Agent 上下文管理与 KV 压缩：按模型能力与降智阈值自适应预算，确定性规则一次压缩数十万至百万 token（秒级），锚点层防遗忘防幻觉。

```
$ node ctxfold.js fold --in session.jsonl --model deepseek-flash
模型: deepseek-flash（窗口 128k / 降智阈值 60k）→ 工作预算 60000
834837 tok → 59987 tok（x13.92，173ms）｜折叠 500 条工具输出｜降级 5298 条老消息｜锚点 4520 个
⚠ 输入 834837 tok 已超降智阈值 60k——输出已压至阈内，质量衰减风险解除
```

## Why

Agent harnesses re-compact long sessions by asking the LLM to rewrite history: slow, costly, lossy, and the rewrite itself invents facts. ctxfold takes a different cut:

1. **Deterministic first** — compression is local rules, zero LLM calls: `834k tok` compresses in `173ms`. Same input → byte-identical output (test-pinned).
2. **Model-aware budgets** — built-in profiles know each model's window and the *dumbing threshold* (where long-context quality decays). ctxfold doesn't try to fill the window; it compresses down below the quality-cliff.
3. **Anchors fight forgetting & hallucination** — paths, URLs, hashes, numbers-with-units, commands are extracted across the whole history and pinned in an `ANCHORS` block that must not be lost or paraphrased. The anchor layer itself is budget-capped so it can't eat the conversation.
4. **Three-level demotion, newest-first protection** — old chat degrades `gist → index → tombstone` until budget is met; the most recent N messages keep full text; `system`/pinned never compress.

## Usage (Node >= 20, zero deps)

```bash
node ctxfold.js fold --in session.jsonl [--out o.jsonl] \
  [--model deepseek-flash|deepseek-v4|gpt-4o|gpt-4.1|claude-sonnet|glm|deepseek-v3] \
  [--budget N] [--recent N] [--tool-fold N] [--head N] [--tail N] [--gist N]
node ctxfold.js anchors --in file.txt   # just list extracted anchors
node ctxfold.js tok --in file.txt       # approximate token count
```

Input: JSONL, one `{role, content, pinned?, kind?}` per line (`kind`: system|chat|tool). Output: folded JSONL with a leading `anchors` system message. Stats (tokens, ratio, ms) print to stdout only — never into the file, preserving determinism.

## How it compresses (all local, all repeatable)

| Pass | Rule |
|---|---|
| 1 | Anchor extraction over the full history (capped at 15% of budget, newest-kept) |
| 2 | Tool outputs over `--tool-fold` tokens: keep head/tail lines, middle replaced by a sha256-sealed fold marker |
| 3 | Old chat demotion: `[要点]` gists → `[索引]` one-liners → `[删除] #n` tombstones, until budget met |
| — | `system` and `pinned` messages are never touched |

## Tests

```bash
node test/run-tests.js   # 6 green: units, ~835k-token stress (173ms, x13.92, budget-met,
                         # anchors-preserved), determinism, system-protection
```

## Limitations (honest)

- Token counts are heuristic (±10%) — good enough for budgets, not billing.
- Anchors are regex-driven (paths/URLs/hashes/numbered facts/commands); free-form prose facts still rely on the gist level.
- It compresses *shape*, not *meaning*: pair it with an LLM summary pass only if you need narrative continuity.

## License

MIT

# Benchmarks & positioning: ctxfold vs the prompt-compression field

## The field (published numbers)

| Method | Claimed compression | How it works | Speed |
|---|---|---|---|
| **LLMLingua** (Microsoft, open source) | up to **20x** with minimal quality loss | runs a *small language model* to score tokens | requires LLM inference per compression; studies measuring latency report seconds-to-minutes at tens of thousands of tokens |
| **LongLLMLingua** | 6–13x | same, with coarse-to-fine budget control | same dependency |
| **LLMLingua-2** | 3–6x | DistilBERT token classifier | GPU inference |
| Claude Code / harness auto-compact (closed) | no public numbers | LLM rewrites history | slow, lossy, non-deterministic |

## ctxfold (measured, reproducible via test/run-tests.js)

| Input | Result | Time | LLM calls |
|---|---|---|---|
| 835k-token agent session → 60k budget | **x13.92**, anchors preserved (paths/numbers verified) | **173ms** | **0** |
| 839k → 40k (LLMLingua's 20x par) | x19.07 | 191ms | 0 |
| 839k → 20k | x20.46 | 115ms | 0 |
| 457k → 24.5k (20k same-shaped tool messages) | **x18.62** | 2.7s | 0 |
| Pure template layer alone (no demotion) | x1.9–2.3 on template-heavy sessions | tens of ms | 0 |

Deterministic: same input → byte-identical output (test-pinned). Token counts heuristic ±10% (budgets, not billing).

## Where the "exponent collapse" idea comes from

On 2026-10-26, OpenAI and Anthropic each published machine-checked refutations of the **Exponential Time Hypothesis** (the weak form of P vs NP: 3-SAT has no 2^o(n) algorithm). The counterexample's shape — a *deterministic, exact* algorithm whose cost exponent *tends to zero as instance size grows*, verified by machine — is the methodology ctxfold borrows at toy scale:

1. **Exploit repeated structure to cut cost per item**, not by a constant factor but asymptotically: template mining turns the n-th occurrence of a repeated pattern into a reference (`⟨§k⟩xN`), so per-message information cost falls as sessions grow. Measured: compression ratio *rises* with session size (x1.49 at n=2k → x18.62 at n=20k on the same workload shape) instead of saturating at a fixed factor.
2. **Exactness over heuristics**: every fold carries a sha256 seal; output is deterministic and reconstructable; anchors keep the load-bearing facts.
3. **Machine-checked verification**: the test suite is the certificate — 7 green tests pin performance, determinism, anchor survival, and system-message protection.

What ctxfold does *not* claim: semantic/meaning preservation. LLMLingua wins on meaning-sensitive summarization tasks; ctxfold wins on speed (2–3 orders of magnitude), determinism, zero inference dependency, and explicit fact anchoring. Different tools for different failure modes — pair them if you need both.

## Sources

- LLMLingua: [Microsoft Research project page](https://www.microsoft.com/en-us/research/project/llmlingua/) (20x claim), [arXiv 2310.05736](https://arxiv.org/abs/2310.05736)
- Latency measurements in the wild: [ECIR 2026 empirical study](https://faerber-lab.github.io/assets/pdf/publications/PromptCompression_ECIR2026.pdf), [arXiv 2505.00019](https://arxiv.org/abs/2505.00019)
- ETH refutation coverage: [Progressive Robot explainer](https://www.progressiverobot.com/2026/10/27/exponential-time-hypothesis-refuted-what-it-means/), [Stanford Tech Review](https://stanfordtechreview.com/articles/openai-anthropic-exponential-time-hypothesis-false)

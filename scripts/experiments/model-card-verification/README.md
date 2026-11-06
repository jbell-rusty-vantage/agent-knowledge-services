# Model-card verification experiment

Knowledge Verification is the **post-research** half of the loop. It does not browse, research, or invent assertions. This experiment adds the missing producer: a Terra run that reads a captured model-card page and emits extraction + claim intent, then runs the four verifier stages as standalone package functions.

```text
Firecrawl capture (markdown bytes)
  → Terra producer (AI SDK, openai/gpt-5.6-terra)
  → registered-style handles in memory
  → 1 capture integrity
  → 2 selector integrity
  → 3 mechanical correctness (extraction + claims)
  → 4 semantic support (Gateway judge, same Terra model)
```

Source page: Anthropic models overview (`https://docs.anthropic.com/en/docs/about-claude/models/overview`). Metrics are published prices, API IDs, context windows, and knowledge cutoffs.

`occurrences` / `bindQuote` in `run.ts` are **producer-side locator construction**, not missing verifier APIs. The library already rejects quotes that are missing or appear more than once (`resolveTextQuote` → `LOCATOR_UNIQUE`). The helpers exist so the pass arm can reach semantic eligibility. Full sequences, CLI/MCP inventory, and the flywheel gap: [../verification-module-sequences.md](../verification-module-sequences.md).

## Run

From `ai-engineer-knowledge-services/`:

```bash
corepack pnpm experiment:model-card-verification
```

Requires `.env` with `AI_GATEWAY_API_KEY`. `FIRECRAWL_API_KEY` is used when present; otherwise the script fetches the page directly.

Receipt: `scripts/experiments/model-card-verification/output/latest.json`.

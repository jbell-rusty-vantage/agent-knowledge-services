---
description: Use when creating reviewed retrieval cases, running ablations, diagnosing failures, or recommending a knowledge release.
license: Proprietary
metadata:
  version: "1.2.0"
  contract: "knowledge-service/v1"
---

# Knowledge evaluation

Freeze dataset, query, judgment, policy, model, prompt, capability, and pricing versions before a run. Keep deterministic graders, model judges, and sampled human review distinct. Evaluate all required domains and exact, conceptual, mixed, constrained, multi-hop, code, contradiction, freshness, and negative query classes.

Record recall, nDCG, MRR, citation/locator validity, false acceptance, abstention, latency, cost, failures, and per-stage ablations. Classify provider, runtime, data, policy, and model failures separately. Compare candidates on identical cases and preserve regressions.

## Real evaluation and status commands

Use only the admitted platform commands: `ks knowledge eval generate`, `ks knowledge eval run`,
`ks knowledge eval compare`, and `ks knowledge eval failures`. The MCP catalog has
`knowledge_eval_generate`, `knowledge_eval_run`,
`knowledge_eval_compare`, and `knowledge_eval_failures`. Persist the evaluated
candidate, query set, result digest, gates and exclusions so a distinct publisher can bind them.

```text
ks knowledge eval generate --context '<OperationContext>' --input '<evaluation dataset input>'
ks knowledge eval run --context '<OperationContext>' --input '<evaluation run input>'
ks knowledge eval failures --context '<OperationContext>' --input '{"runId":"<uuid>"}'
```

An evaluation report is a recommendation and evidence binding. It never switches an official
pointer, revokes support, or restores a previous publication.

You may recommend promotion or rollback with a reasoned report. Never execute publication, weaken a failed hard gate, tune on locked test data, expose judge reasoning as proof, or describe a bounded smoke eval as production quality.

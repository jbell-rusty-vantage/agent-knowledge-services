# Knowledge Services experiments

Prototyping and live proofs. Scripts load `ai-engineer-knowledge-services/.env` via `tsx --env-file=.env`. Do not print tokens or PEMs.

Module inventory (CLI, MCP, HTTP-only, library-only), every verification sequence, and why the model-card script had to write `occurrences` / `bindQuote`: [verification-module-sequences.md](verification-module-sequences.md).

| Experiment | What it proves | Command |
| --- | --- | --- |
| [model-card-verification](model-card-verification/README.md) | A producer (Vercel AI SDK + `openai/gpt-5.6-terra`) extracts metrics from a live model-card page, then standalone verification stages run: capture integrity, selector integrity, mechanical correctness, semantic support. | `corepack pnpm experiment:model-card-verification` |
| [sprint-v (SV-09)](sprint-v/run.ts) | Sprint V checkpoint C control slice: the locked synthetic AI Engineer fixture corpus (`catalog/research/fixtures`, manifest-locked) driven directly through `ResearchCoordinator` + the PostgreSQL binding on a disposable database for both report kinds (support judges, recorded authority/challenge, auditor census via `report.assess`, signed seal, derive, report/assertion use decisions, native admission + effect receipt, exact read). T0 (recorded, free) must pass before paid mode; paid mode meters every call against a persisted USD ceiling. Replaces the model-card instrument's same-model producer/judge and live inputs. A control slice: no evaluator-quality or readiness claim. | `corepack pnpm exec tsx scripts/experiments/sprint-v/run.ts --mode t0`, then `--mode paid --env-file <MC .env path>` |

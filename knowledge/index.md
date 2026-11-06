<!-- BEGIN GENERATED: knowledge-index -->
# ai-engineer-knowledge-services knowledge index

OKF 0.2 Markdown concepts. Read the matching explanation, then follow its source/test links. These are evidence-backed working-copy descriptions, not new accepted decisions or deployment attestations.

## Find the relevant concept

- **Ownership, profiles and caller contracts:** [service-boundaries](service-boundaries.md) → [execution-profiles-and-transports](execution-profiles-and-transports.md)
- **Capture, convert and prepare faithful content:** [capture-conversion-and-custody](capture-conversion-and-custody.md) → [preparation-and-publication](preparation-and-publication.md)
- **Schema, bounded reads and canonical ingestion:** [schema-read-and-ingestion](schema-read-and-ingestion.md)
- **Retrieve evidence, evaluate and publish:** [retrieval-and-evidence](retrieval-and-evidence.md) → [evaluation-and-publication-gates](evaluation-and-publication-gates.md)
- **Verify claims and policy admission:** [verification-and-admission](verification-and-admission.md)
- **Leases, retries, cancellation and recovery:** [durable-execution-and-recovery](durable-execution-and-recovery.md)
- **Jev decisions and workers:** [jev-decisions-and-workers](jev-decisions-and-workers.md)
- **Agent skills and consumer readiness:** [agent-skills-and-consumer-readiness](agent-skills-and-consumer-readiness.md)

## Concepts

- [Knowledge service boundaries](service-boundaries.md) — Shared platform versus Biotech domain knowledge services, canonical ownership, product APIs, and safe entry points for ingestion and retrieval. [reference; Service Boundary]
- [Schema, bounded reads, and deterministic ingestion](schema-read-and-ingestion.md) — Knowledge-read operation execution, unavailable retrieval operations, pinned schema navigation, reproducible reads, and admitted deterministic ingestion. [reference; Playbook]
- [Knowledge preparation and publication](preparation-and-publication.md) — How admitted source material becomes traceable, policy-gated knowledge and a versioned retrieval publication. [reference; Architecture Concept]
- [Retrieval and evidence](retrieval-and-evidence.md) — How policy-scoped retrieval produces bounded, replayable evidence packets instead of unsupported answers. [reference; Architecture Concept]
- [Verification and admission](verification-and-admission.md) — How Knowledge Services verifies evidence and admits it to knowledge effects after the SV-17 cutover. [reference; concept]
- [Durable execution and recovery](durable-execution-and-recovery.md) — How durable workers lease, retry and cancel steps, and where verification recovery went after SV-17. [reference; concept]
- [Execution profiles and transport availability](execution-profiles-and-transports.md) — Choose the server, local verification, remote CLI, or transitional executor surface without mistaking a declared operation for an executable capability. [reference; Service Boundary]
- [Capture, conversion, and artifact custody](capture-conversion-and-custody.md) — Preserve exact source bytes and conversion lineage while keeping acquisition, document conversion, native parsing, and admission separate. [reference; Architecture Concept]
- [Evaluation and publication gates](evaluation-and-publication-gates.md) — Separate frozen retrieval evaluation, human quality evidence, and authorized publication-pointer changes. [reference; Architecture Concept]
- [Jev decisions and worker lifecycle](jev-decisions-and-workers.md) — Use closed-choice semantic judgments through a captured-input, single-host queue while keeping calibration, authority, and side effects outside the model. [reference; Architecture Concept]
- [Agent skills and consumer readiness](agent-skills-and-consumer-readiness.md) — Pin executable skill procedures to current transports and distinguish the shipped skill catalog from the planned DeepAgents-ready consolidation. [reference; Service Boundary]

## Search

Run from the repository root (PowerShell or bash):

```text
node .agent-docs/cli.mjs search --repo . --query "retry cancellation"
node .agent-docs/cli.mjs search --repo . --query "admission" --format json
rg -n -i -C 2 "admission|deterministic" knowledge -g "*.md"
```

The executable searches registered concepts only, using current files. It ranks title, description, tags, headings, and body matches; returns paths and line snippets; accepts --type, --tag and --limit. It is lexical search, not embeddings. No match exits 1; invalid input exits 2. Try a domain term from the routes or rg when wording differs.

For bounded source/test context: `node .agent-docs/cli.mjs context --repo . --query "worker lease" --limit 2 --format json`.

## Maintain this bundle

Edit concept Markdown and its registration in `.agent-docs/config.json`; keep `type`, `title`, and `description` in YAML frontmatter. Types are open vocabulary. Acceptance status stays in the registry. Retain source/test links and identify uncertainties. Build and check with the repository-local CLI. Do not edit this generated listing.

Build validates the local navigation profile and cited local file paths; provenance hashes cited files so changed evidence requires review. It does not prove prose is semantically correct. Reconcile code and accepted architecture rather than refreshing hashes blindly.

[OKF specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md). The local flat-file navigation profile requires titles/descriptions and resolvable local file links beyond OKF’s minimal requirements. No `verified` claim is inferred from formatting checks.
<!-- END GENERATED: knowledge-index -->

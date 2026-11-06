# Deliverable validation

**Status: document validation, not verification-system performance evidence.** [Proposal](README.md).

## Scope completed

The package contains the main approval proposal, an evaluation protocol, a primary-source register, and two specialist research notes. It covers assertion meaning, source support, factual credibility, attribution, provenance, workflow execution, resource allocation, benchmark selection, experiment design, statistical limits, correction/revision, and staged promotion. Recommendations and projected operating behavior are labeled as proposals rather than observed capabilities.

The previous research was found under `internal_hidden_docs/proposals/accountable-evidence-20260916`, read, and linked. Its architecture and dated implementation baseline were not silently promoted or treated as current deployment evidence. The new document is stored in a tracked documentation path; the old material remains in its ignored local path.

## Review and checks

| Check | Result |
|---|---|
| Primary-source review | 34 source-register entries; inspection depth and limits recorded. Some are candidate/abstract-level leads, explicitly marked. No benchmark execution or literature replication claimed. |
| Independent bounded reviews | Benchmark and economics researchers reviewed the main proposal and protocol. Both identified annotation-cost undercount and candidate/final metric ambiguity; those were corrected. |
| Annotation accounting | Seed-gold estimate separated from candidate outputs: 1,440 seed assertions → 192 double-annotation hours + 48 adjudication + 60 task preparation = 300 hours. 624 comparison reports × 12 assertions × 8 reviewer minutes × 1.25 = 1,248 additional hours. Further development/revision work remains additional. |
| Metric denominators | Candidate versions, final assertions, permitted candidates, source-support failures, use-ineligible claims, and unknowns are distinguished. Rejected and repaired versions remain in the candidate census. |
| Statistical promotion | One-sided non-inferiority bounds specified; zero-error empirical bootstrap cannot provide a zero-width safety claim. Correlation, sampling, and insufficient sample-size limits retained. |
| Numerical examples | Cascade judgment cost 250 versus 500 units checked; excludes other costs. Search-depth differences are 61.9 and 22.1 percentage points. Planned heldout/shift report count is 480 + 144 = 624. |
| Local links | At initial review, all 28 local link occurrences resolved on this machine. Before tracking, machine-specific skill and ignored historical-material links were changed to plain provenance paths so the proposal has no nonportable local hyperlinks. External references were counted (101 occurrences); no separate blanket HTTP availability audit was run. |
| Markdown structure | Balanced code fences, consistent table column delimiters, and no trailing whitespace in the five substantive files. Table metric notation was corrected to avoid unescaped pipe characters. Mermaid reviewed as text, not browser-rendered. |
| Repository documentation check | Attempted `node .agent-docs/cli.mjs check --repo .` via the workspace-relative equivalent. It cannot complete because configured path `apps/api/src/retrieval-executor.ts` is missing. No generated navigation/configuration was changed to mask this unrelated condition. |
| Change isolation | Only this proposal directory was written by this mission. Concurrent untracked application/access and package-cleanup inventory work was observed and left untouched. No production code, migrations, settings, deployments, or benchmark data changed. |

## Limitations for the approver

This is a research synthesis and proposed specification. The source material is not a sealed archive; Firecrawl returned some indexed/cached content. The proposal's thresholds, caps, and staffing figures are design choices and illustrative estimates. No outcome has yet satisfied those gates. Public benchmark adoption still requires version, license, and evaluator review. Current implementation compatibility and production readiness require a separate pinned-code review after a direction is approved.

The proposed pilot is not commissioned by writing this document. The requested research mission is complete; execution of experiments and promotion into accepted contracts remain explicit subsequent decisions.

## Tracking maintenance — 30 September 2026

Before the proposal was added to the package-cleanup branch, machine-specific skill links and links into ignored local research were changed to plain provenance paths. The six Markdown files remain a proposed research package; their external findings and URLs were not re-audited in this maintenance pass. The current repository documentation build and check complete successfully after the 5P navigation update.

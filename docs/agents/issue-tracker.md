# Issue tracker: Linear

Knowledge Platform delivery uses Linear workspace `overtonbell`, team `OVE`, project **BellLabs Knowledge Platform**. See the [publication register](../specs/belllabs-knowledge-platform/LINEAR.md) for verified IDs and URLs. Mission Control's own project remains separate; cross-service changes in this program link their owning repository and existing decisions without duplicating issues.

Use the installed Matt Pocock `to-spec` and `to-tickets` skills: self-contained user stories/decisions/testing, then context-sized vertical slices with native blocking relations. Use expand/migrate/contract for wide mechanical changes. Apply one category (`Feature` or `Bug`) and one triage-state label (`ready-for-agent` for specified work). Blocked work stays visibly blocked; this label means specified, not deployable.

Every issue includes Provenance: this program's source conversation/date, source document paths and inspected revisions, ADRs, glossary terms and a stable local slice ID. Paths belong in Provenance; behavioral briefs use interfaces and outcomes rather than fragile file-edit recipes.

Linear is the delivery-status authority after promotion. Versioned architecture/specifications remain in this repository; amend them when issue decisions change. Local issue files are retained publication snapshots and must not become a competing live status board.

Prefer the Linear connector. The documented fallback is Linear's GraphQL API using the configured `LINEAR_API_KEY` from the Mission Control local environment; resolve it at execution time and never print, copy into documents or commit it. This planning session used the fallback because the connector requested reauthentication. Tooling must verify existing IDs before retrying an uncertain create.

Drafts belong in ignored `.scratch/<feature>/`; official specification packages live under `docs/specs/`. Do not publish incomplete or placeholder issue bodies. Do not close parent scope issues until acceptance is demonstrated.

The owner explicitly waived interview/quiz pauses and preapproved this program's planning and publication on 2026-10-10. That is not evidence of implementation, deployment or final-fixture success.

The subsequent owner request explicitly adds interviews for unfinished schema, native-agent and retrieval decisions. Prior waiver applies to publishing the plan, not to inventing those answers. Q01–Q04 use ready-for-human; unresolved implementation acceptance contracts use needs-info. Preserve native blockers and update architecture plus tracker when answers arrive.

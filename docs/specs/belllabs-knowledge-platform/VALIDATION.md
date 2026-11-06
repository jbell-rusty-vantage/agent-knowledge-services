# Planning validation

Date: 2026-10-10. Scope: source inspection, specification/ADR planning, official Linear publication and the subsequent GraphQL/native-agent clarification amendment. This file does not certify application implementation, schema migration or production qualification.

## Initial publication checks (historical)

- Three GPT-6.1-sol specialists inspected verification, domain surfaces and capability/delivery implementation.
- Independent cross-document review identified and corrected annex-status drift, stale skill version wording, CLI catalog mapping, per-app custody scope, release-manifest independence, and the PostgreSQL/Neo4j outbox/revocation race contract.
- `python docs/specs/belllabs-knowledge-platform/validate_packet.py`: passed; 42 issues, nine ADRs, 199 dependency edges, 41 direct final-fixture blockers, 65 Markdown files, 125 local links and four installed planning skills validated.
- `node .agent-docs/cli.mjs build --repo .` and `check --repo .`: generated navigation refreshed successfully (403 selected inputs at build). The navigation budget was explicitly raised from 9,216 to 12,288 bytes to include the new program and planning routes; no check was disabled.
- `git diff --check`: passed. Existing line-ending conversion warnings were informational; no whitespace errors were reported.
- Official Linear read-back: passed. Project `BellLabs Knowledge Platform`, specification `OVE-87`, 42 child issues `OVE-88`–`OVE-129`, six milestones, six populated project documents, correct parent/labels/milestone assignments and all 199 exact native blocking edges verified. Final fixture `OVE-129` has 41 incoming blockers. No implementation issue is completed.
- A second read-only domain review corrected missing Research/Product dependencies, explicit ordinary-MCP publication exclusions, and ownership of project test request/status with a real external editor/workspace path. Local briefs and existing Linear records were updated together; no duplicate issues were created.

## Amendment checks

- Three GPT-6.1-sol specialists inspected GraphQL/library/Fly evidence, native PostgreSQL/Neo4j retrieval and ingestion semantics, and cross-document readiness. Read-through corrections distinguish the planned client agent from existing tools, qualify native UID cache identity, preserve direct Neo4j skill principal provisioning, and retain unanswered owner decisions.
- User confirmed the newer v2 assembly as the review candidate and TypeScript web + React Native/Expo as client targets. Neither answer accepts or migrates v2.
- A read-only deployed health observation reported the original pinned SDL and configured features. The prescribed Fly wrapper could not find flyctl, so actual Machine/image/resource and Aura/index inventory remains unverified G00 work.
- `python docs/specs/belllabs-knowledge-platform/validate_packet.py`: passed with 60 unique issues, eleven ADRs, 283 dependency edges, 59 direct final-fixture blockers, 88 Markdown files, 192 valid local links and four planning skills. Topological ordering, required Q/G/N gates and exact D10/F99 prerequisite closure passed.
- Documentation generator build and check: clean, 403 selected inputs. `git diff --check` passed in Knowledge Services and Biotech Knowledge Services; line-ending notices are informational.
- Official Linear read-back: 60 children (18 added, existing IDs preserved), seven milestones, nine project documents, all 283 exact native blocking edges, parent/label/milestone assignments and issue acceptance criteria verified. Q01–Q04 are OVE-131–OVE-134, labeled ready-for-human; unresolved implementation contracts are needs-info. Fully specified blocked descendants retain ready-for-agent.
- OVE-129/F99 has all 59 preceding decision/implementation/readiness slices as direct blockers; D10 has all 58 other prerequisite slices. No issue was marked implemented or completed.
- Biotech runtime source remained untouched; only README/deployment-guide claims were corrected. Existing dirty shared-KS work and retained maintenance worktrees were preserved.

## Evidence limits

No runtime code was changed, database migrations applied, domain capability rows registered, embedding/judge providers invoked, semantic/performance benchmark run, or complete application fixture executed. Unit/integration/runtime test success is not claimed. All 60 decision and implementation slices remain uncompleted; their acceptance criteria are future obligations. Historical schema measurements were inspected, not rerun.

The five retained maintenance worktrees and pre-existing dirty changes remain preserved. Source commit IDs identify inspected baselines; dirty working-copy observations are labeled. The Linear connector required reauthentication; the documented API fallback was authenticated successfully without exposing or copying credentials.

The final fixture issue must retain native blockers from all 59 prerequisites, including owner decision gates. Lower-level component/replay/disposable-database and labeled quality checks are required during implementation; the owner's restriction applies to the two complete application fixtures.

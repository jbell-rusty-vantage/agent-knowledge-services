---
type: Plan
title: "Binding relocation: move each domain binding next to the schema it binds, behind a narrow port package"
description: "Owner direction of 2026-11-10 and the plan to complete it: what the two bindings depend on today, why the move is mostly seam work and only lastly a package move, the six steps with their proofs, what stays in Knowledge Services, and the decisions still open. Nothing in this plan is executed."
tags: [knowledge-services, bindings, plan, aiengineer-postgres, biotech-graph, ports, refactor]
date: 2026-11-10
status: accepted direction, not started
source: "Owner conversation 2026-11-10 after Build 08 loop 2; dependency counts read from live source on main the same day."
---

# Binding relocation

**Owner direction, 2026-11-10:** "let's document that now and the plan to complete it." The direction is that each binding implementation lives next to the schema it binds, and Knowledge Services keeps the interface and the tests that any binding must pass. **No code has moved. No refactor is authorized to start by this page;** it runs when John schedules it, at the earliest inside the bridge build after Build 08 loop 3. The layer vocabulary is in [knowledge service structure](../../../../../docs/navigation/KNOWLEDGE-SERVICE-STRUCTURE.md).

**Gap it closes for the Deep Agents mission path:** missions ingest through these bindings. A schema change in a domain repository can today break a binding in this repository without either side noticing until a mission fails. After the move, a schema change and the code that depends on it change together.

<a id="s1"></a>
## 1. Is it mostly moving packages and updating references and pins?

No. The move is the last and smallest step. The bindings are not yet separable, so the work is first to cut a narrow seam inside this repository. Read from source on 2026-11-10:

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Each binding imports six internal packages | `application`, `application/testing`, `knowledge-db`, `knowledge-db-contract`, `host/knowledge-operation`, `knowledge-operation-protocol`, `research-core` (76 import statements across the two bindings) | There is no single port package to depend on. One must be extracted first |
| Every package is private and workspace-linked | `"private": true` on both bindings and on the packages they import; no domain repository depends on any Knowledge Services package today | A way for a domain repository to consume the port package has to be chosen and set up |
| The Biotech binding imports the AI Engineer binding | `ComponentDatabase`, `componentError`, `pinSealSigningKey` imported by `biotech-graph` from `knowledge-binding-aiengineer-postgres` | Shared component-database code sits in the wrong package and must move to a general one before either binding leaves |
| The executor and host import bindings directly | 20 files in `apps/verification-executor`, plus the registry in `packages/host` | Bindings must be loaded through a registry by configuration, and executor tests must run against a stand-in binding |
| The schema-specific code that broke in loop 1 is mostly outside the bindings | `corpus.` appears in 16 files of `packages/knowledge-db`, 1 of `persistence`, 3 of `testkit`, and in none of the binding sources | `knowledge-db` must be split into general mechanics and AI Engineer-specific SQL; the specific part belongs with the binding |
| Size | about 6,000 lines in `aiengineer-postgres`, 4,000 in `biotech-graph`, tests included | A real change, not a rename |

<a id="s2"></a>
## 2. Target shape

| Stays in Knowledge Services | Moves to the domain |
| --- | --- |
| A port package: the interfaces a binding implements and the protocol types they use, with no implementation | `aiengineer-postgres` → AI Engineer, next to the database contract |
| A conformance test kit that any binding must pass | `biotech-graph` → `biotech/biotech-knowledge-services/packages` |
| Shared component-database code (the common operational tables both bindings use) | The AI Engineer-specific SQL now in `knowledge-db` |
| An in-memory stand-in binding for this repository's own tests | Each binding's integration tests against its real database |
| The registry that loads a configured binding | |

Dependency direction after the move: a binding depends on the port package; Knowledge Services depends on no binding at build time and loads one at start.

<a id="s3"></a>
## 3. Steps

Steps 1 to 4 happen inside this repository and are worth doing even if the move were never made. Step 6 is the move.

| # | Step | Proof it is done |
| --- | --- | --- |
| 0 | **Guard now, cheaply.** In the AI Engineer contract repository, add a check that runs the binding's statements against a freshly migrated schema and fails on a break | A deliberate column rename on a branch makes the check fail |
| 1 | **Extract the port package.** Interfaces and types only. Change both bindings to import from it instead of `application`, `host` and `research-core` | Each binding's dependency list is the port package, the protocol types and its database driver; build and tests pass |
| 2 | **Move the shared component-database code** out of the AI Engineer binding into a general package | `biotech-graph` no longer imports the AI Engineer binding |
| 3 | **Split `knowledge-db`.** General schema-read and ingestion mechanics stay; AI Engineer table knowledge moves behind the port | No `catalog.` or `corpus.` table name remains in `knowledge-db`, `persistence` or `testkit` |
| 4 | **Load bindings through the registry.** The executor and host stop importing binding packages; executor tests use the stand-in; the conformance kit runs against both real bindings | Conformance green for both; no import of a binding package outside the registry's configuration |
| 5 | **Choose distribution.** How a domain repository gets the port package and how a deployment gets the binding ([§4](#s4)) | A domain repository builds against a pinned port version on a clean checkout |
| 6 | **Move.** Relocate the two packages with their integration tests; update references, deployment images, the code map and the guides | Existing integration tests pass from the new locations: AI Engineer apply, Biotech graph apply, native recovery |
| 7 | **Prove the composed path.** One recorded read and one plan-and-apply through the executor for each application, on disposable targets | Evidence recorded; this is integration, not qualification |

**Sequencing with other work.** The AI Engineer binding has to be rewritten for the `corpus` → `catalog` rename before any mission can ingest again (review unit RV21). Doing steps 1 to 4 in that same change avoids touching the code twice. Step 0 can be done at any time.

<a id="s4"></a>
## 4. Decisions still open

| Decision | Options | Lean |
| --- | --- | --- |
| Where the AI Engineer binding lands | `ai-engineer-db-contract` (same repository as the migrations) or `ai-engineer-service` (same repository as the product transports) | The contract repository: the point of the move is that schema and binding change in one commit |
| Distribution of the port package and the bindings | Publish to a registry; or pin by Git reference; or vendor a built tarball | Publish. Both repositories are already public on GitHub |
| Version rule | Port version, binding version and schema contract version pinned together per deployment | One lock file per application that names all three; start refuses a mismatch |
| Package names | Keep `@aiengineer/knowledge-*` or rename with the move | Keep. Rename is a separate cutover |
| Stop after step 4 | The seam work alone removes most of the risk when combined with the step-0 guard | Decide after step 4 with the evidence in hand |

<a id="s5"></a>
## 5. Risks

- **Two-repository versioning.** Today one commit can change an interface and both bindings. Afterwards an interface change needs a port release and two binding updates. The conformance kit and the version rule exist to keep that honest.
- **Hidden coupling.** The import counts above are from a text search. Step 1 will show whether the bindings also rely on behaviour, not only types, of `application` and `host`.
- **Mission Control qualification.** W1 is open and exercises these bindings. Do not move packages in the middle of a W1 run; land between runs and rerun the affected proofs.
- **Deployment locks.** Existing locks pin component versions. They must name the binding version too, or a deployment can load a binding that does not match its schema.

## Evidence limits

Dependency and reference counts come from `grep` over `apps`, `packages` and `scripts` on `main`, excluding `node_modules`, `dist` and `.scratch`. No test was run and no database was touched for this plan. Line counts include test files.

# Implementation plan

Status: owner-authorized plan, amended 2026-10-10 with explicit schema, agent and retrieval decision gates. The issues are specified, not implemented. Linear owns execution status after publication.

## Delivery model

Use Matt Pocock vertical tracer-bullet slices: each issue produces a caller-visible behavior and meaningful acceptance evidence. Each can be developed in one fresh context; an unexpectedly broad slice must be split into equally explicit child issues with preserved blocker closure before implementation. V04 and the X-series use expand/migrate/contract for wide extraction; no removal lands before migrated callers work.

The root specification issue stays open until final acceptance. Work the native dependency frontier, not document order. Milestones group outcomes and are not invented calendar deadlines. All slices carry Feature and one triage label. Q01–Q04 require human decisions; underspecified acceptance contracts use needs-info. Fully specified work may remain ready-for-agent while natively blocked. Planning preapproval does not answer the interviews.

## Milestones

| ID | Outcome | Exit |
| --- | --- | --- |
| M1 | Boundaries and native verification | Executable application bindings, auth, evidence contracts, owned operational storage and native admission/recovery. |
| M2 | Verification assurance and optimization | Independent labels, replay-safe reuse, batching, correction closure, quality/cost qualification and transport parity. |
| M3 | Product retrieval and domain procedures | Direct/Fast/Explore/Research, domain content/Jev, User/Product APIs, product agent and external-agent handshakes. |
| M4 | Complete domain distributions | Canonical host/CLI folds, provider/fallback capture, app-local catalog installations and actual consumer conformance. |
| M5 | Release and maintenance readiness | Independent compatible releases, in-flight recovery, maintenance impact, retirement and both installation qualifications. |
| M7 | Biotech GraphQL and typed application client | Qualified product read projection, authorization, bounded operations, web/Expo SDK, measured database/Fly release and explicit vector capability. |
| M6 | Final application acceptance | Run both complete fixtures only after all preceding work and evidence are complete. |

## Slices and native blocking edges

| Slice | Deliverable | Blocked by | Milestone | Triage |
| --- | --- | --- | --- | --- |
| [F01](issues/01-f01.md) | Describe and validate an application-bound knowledge installation | None | M1 | ready-for-agent |
| [D01](issues/02-d01.md) | Reconcile a complete per-application capability assembly | F01 | M1 | ready-for-agent |
| [F02](issues/03-f02.md) | Authorize one scoped knowledge read for product and external consumers | F01 | M1 | ready-for-agent |
| [V01](issues/04-v01.md) | Verify a versioned claim with explicit obligations and support sets | F01 | M1 | ready-for-agent |
| [D02](issues/05-d02.md) | Publish and materialize an exact app-scoped skill bundle | D01 | M1 | ready-for-agent |
| [V02](issues/06-v02.md) | Reject a report that omits material assertions or original obligations | V01 | M1 | ready-for-agent |
| [V03](issues/07-v03.md) | Route verification through pinned education, engineering and science policies | V01 | M1 | ready-for-agent |
| [V04](issues/08-v04.md) | Persist standalone and mission-linked verification through one owned SQL component | V01 | M1 | ready-for-agent |
| [R01](issues/09-r01.md) | Answer familiar AI Engineer questions through direct and Fast retrieval | F02 | M3 | ready-for-agent |
| [D05](issues/10-d05.md) | Capture provider and fallback results with truthful evidence contracts | F01, V01 | M4 | ready-for-agent |
| [V05](issues/11-v05.md) | Evaluate source authority, applicability and bounded counterevidence | V01, V03 | M1 | ready-for-agent |
| [V06](issues/12-v06.md) | Admit an exact verified knowledge effect into AI Engineer PostgreSQL | V01, V03, V04 | M1 | ready-for-agent |
| [V10](issues/13-v10.md) | Reuse evidence-bound observations without inventing fresh verification | V01, V04 | M2 | ready-for-agent |
| [J01](issues/14-j01.md) | Use an AI Engineer Jev recipe in an executable domain procedure | F01, R01 | M3 | ready-for-agent |
| [V09](issues/15-v09.md) | Import independent labels and publish honest calibration state | V01, V03, V05 | M2 | ready-for-agent |
| [V11](issues/16-v11.md) | Batch and schedule semantic checks within isolated budgets | V03, V04, V10 | M2 | ready-for-agent |
| [C01](issues/17-c01.md) | Create and publish an evidence-bound AI Engineer learning artifact | V06, V02, R01 | M3 | ready-for-agent |
| [P01](issues/18-p01.md) | Compose AI Engineer user state and knowledge into a product API | F02, C01, R01 | M3 | ready-for-agent |
| [G00](issues/19-g00.md) | Reconcile the deployed GraphQL service with schema and Fly configuration | None | M7 | ready-for-agent |
| [Q01](issues/20-q01.md) | Interview and record the staged v2 schema adoption boundary | G00 | M1 | ready-for-human |
| [Q02](issues/21-q02.md) | Interview and select native agent read and write artifact semantics | None | M1 | ready-for-human |
| [Q03](issues/22-q03.md) | Interview and select the Biotech corpus embedding and GraphRAG contract | Q01 | M1 | ready-for-human |
| [Q04](issues/23-q04.md) | Interview and freeze first web and Expo operations and access rules | None | M1 | ready-for-human |
| [G01](issues/24-g01.md) | Export a reviewed executable GraphQL read contract for one product slice | Q01, Q04 | M7 | needs-info |
| [G02](issues/25-g02.md) | Bound the first product GraphQL operations using actual schema semantics | G01, Q04 | M7 | ready-for-agent |
| [N01](issues/26-n01.md) | Execute and retain a native agent read under the selected artifact contract | F01, Q02 | M3 | needs-info |
| [N02](issues/27-n02.md) | Make native ingestion snapshot preconditions and lost-response replay truthful | F01, Q02 | M3 | needs-info |
| [R02](issues/28-r02.md) | Answer familiar Biotech questions through bounded graph and evidence reads | F02, N01 | M3 | ready-for-agent |
| [V07](issues/29-v07.md) | Admit a verified Biotech effect through a minimal versioned graph binding | V01, V03, V04, Q01 | M1 | needs-info |
| [J02](issues/30-j02.md) | Use a Biotech Jev recipe for scientific applicability triage | F01, R02, V03 | M3 | ready-for-agent |
| [R03](issues/31-r03.md) | Explore unfamiliar questions with bounded schema slices | R01, R02, Q02, N01 | M3 | ready-for-agent |
| [X01](issues/32-x01.md) | Fold bounded database operations into canonical application surfaces | R01, R02, N01, N02 | M4 | ready-for-agent |
| [V08](issues/33-v08.md) | Recover cross-store result delivery and prevent stale official use | V04, V06, V07 | M1 | ready-for-agent |
| [C02](issues/34-c02.md) | Create and publish an evidence-bound Biotech research artifact | V07, V02, V05, R02 | M3 | ready-for-agent |
| [X03](issues/35-x03.md) | Expose Jev through the canonical CLI without replacing its queue implicitly | J01, J02 | M4 | ready-for-agent |
| [V12](issues/36-v12.md) | Revalidate affected claims and uses after evidence or content revision | V02, V05, V08 | M2 | ready-for-agent |
| [V14](issues/37-v14.md) | Expose equivalent verification admission and recovery across API MCP and CLI | V01, V03, V06, V07, V08 | M2 | ready-for-agent |
| [V13](issues/38-v13.md) | Qualify verification quality and full cost on paired domain evaluations | V02, V03, V09, V10, V11, V12 | M2 | ready-for-agent |
| [A01](issues/39-a01.md) | Delegate a Research request to a durable mission and reconnect | R03, V14, D05 | M3 | ready-for-agent |
| [X02](issues/40-x02.md) | Unify verification hosts and transports while preserving sealed replay | V14, V10, V11 | M4 | ready-for-agent |
| [D03](issues/41-d03.md) | Install the complete AI Engineer domain skill and MCP assembly | D02, V14, C01, J01, X01, X02, X03, A01, P01 | M4 | ready-for-agent |
| [G03](issues/42-g03.md) | Serve an authorized product entity and evidence view through GraphQL | G01, F02, V08, Q04 | M7 | needs-info |
| [G04](issues/43-g04.md) | Ship a transport-neutral typed GraphQL client for the approved operations | G01, G02, G03 | M7 | ready-for-agent |
| [G05](issues/44-g05.md) | Consume one entity and evidence page in web and Expo | G04, Q04 | M7 | ready-for-agent |
| [G06](issues/45-g06.md) | Optimize selected GraphQL reads against measured plans and indexes | G02, G03 | M7 | ready-for-agent |
| [N03](issues/46-n03.md) | Migrate and ingest one approved v2 entity assertion and evidence case | Q01, Q02, N02, V07 | M4 | needs-info |
| [N04](issues/47-n04.md) | Ingest one approved source into a versioned searchable corpus | Q03, N03, D05 | M4 | needs-info |
| [N05](issues/48-n05.md) | Retrieve scientific evidence through the selected native graph profile | N04, N01, F02 | M3 | needs-info |
| [P02](issues/49-p02.md) | Compose Biotech saved research and knowledge into a product API | F02, C02, R02, G05 | M3 | ready-for-agent |
| [D04](issues/50-d04.md) | Install the complete Biotech domain skill and MCP assembly | D02, V14, C02, J02, X01, X02, X03, A01, P02, N03, N05 | M4 | ready-for-agent |
| [P03](issues/51-p03.md) | Run the client-facing Deep Agent with both domain assemblies | A01, D03, D04, P01, P02 | M3 | ready-for-agent |
| [P04](issues/52-p04.md) | Accept scoped external-agent progress and artifact handshakes | P01, P02, D03, D04 | M3 | ready-for-agent |
| [D06](issues/53-d06.md) | Qualify external MCP, CLI and skill consumers for both applications | D03, D04, D05, P04 | M4 | ready-for-agent |
| [G08](issues/54-g08.md) | Report truthful GraphQL vector capability and qualified search availability | Q03, G01, N04 | M7 | ready-for-agent |
| [G07](issues/55-g07.md) | Qualify Fly capacity and compatible product API rollout | G00, G05, G06, G08 | M7 | ready-for-agent |
| [D07](issues/56-d07.md) | Upgrade a compatible application release with in-flight work | V13, D06, P03, X01, X02, X03, G07 | M5 | ready-for-agent |
| [D08](issues/57-d08.md) | Route maintenance proposals through affected-domain compatibility checks | D01, D07 | M5 | ready-for-agent |
| [D09](issues/58-d09.md) | Retire obsolete executor and capability versions after consumer migration | D06, D07, X01, X02, X03 | M5 | ready-for-agent |
| [D10](issues/59-d10.md) | Qualify both application installations before final workflows | F01, D01, F02, V01, D02, V02, V03, V04, R01, R02, D05, V05, V06, V07, V10, J01, J02, R03, X01, V08, V09, V11, C01, C02, X03, V12, V14, P01, P02, V13, A01, X02, D03, D04, P03, P04, D06, D07, D08, D09, G00, Q01, Q02, Q03, Q04, G01, G02, G03, G04, G05, G06, G08, G07, N01, N02, N03, N04, N05 | M5 | ready-for-agent |
| [F99](issues/60-f99.md) | Run the final AI Engineer and Biotech application fixtures | F01, D01, F02, V01, D02, V02, V03, V04, R01, R02, D05, V05, V06, V07, V10, J01, J02, R03, X01, V08, V09, V11, C01, C02, X03, V12, V14, P01, P02, V13, A01, X02, D03, D04, P03, P04, D06, D07, D08, D09, D10, G00, Q01, Q02, Q03, Q04, G01, G02, G03, G04, G05, G06, G08, G07, N01, N02, N03, N04, N05 | M6 | ready-for-agent |

## Final-fixture admission

F99 has native blocking edges from every other issue in this release, not just an umbrella milestone. D10 likewise waits for every implementation slice. Program tooling validates that complete closure. No complete AI Engineer or Biotech fixture runs until all gates pass. Component tests, installed-package conformance, disposable adapter integration, frozen replay and independently labeled quality evaluation must run during implementation. A fixture failure reopens the owning slice and reblocks acceptance.

V15 from the verification research annex is explicitly deferred outside this release: attribution-sensitivity experiments and additional media qualification are optional extensions. No optional ticket is silently omitted from the mandatory set; unsupported modalities remain blocked. Automatic scientific promotion that lacks its required labels/calibration stays disabled under the specified human-review scope, never falsely certified.

## Existing work and priority

Preserve the five retained maintenance worktrees and dirty source described in CURRENT-STATE.md. Establish reviewed implementation baselines before code changes. Independent frontiers include F01, G00 and preparation of Q02/Q04; Q01 follows baseline reconciliation and Q03 follows schema-scope review. Existing shared verification, bindings and inventory can proceed while owner-dependent graph work remains gated. Prioritize the shared verification/native admission chain alongside bounded retrieval; domain content and skill installations consume those demonstrated contracts. Do not begin with package renames or a full ontology rewrite.

## Research and source coverage

V01–V14 implement the mandatory verification annex. R/C/J/P/A slices implement the domain annex. D01–D10 and X01–X03 implement capability, maintenance and cleanup delivery. ADRs 0005–0015 resolve ownership and consumer boundaries; Q01–Q04 retain explicit decisions. G00–G08 cover the GraphQL/client workstream; N01–N05 cover native read/ingestion/corpus work. Every promoted issue retains its annex, decision references, acceptance criteria and native dependencies. Historical cleanup tickets that overlap these slices should link to this plan and be reconciled rather than separately executed twice.

## Verification and publication register

See [Linear](LINEAR.md) for actual IDs and [validation](VALIDATION.md) for the checks run on this packet. `issues.json` and local per-issue Markdown are retained publication snapshots; do not edit local status instead of Linear after promotion.

## Amendment and interviews

Read [clarifications](CLARIFICATIONS.md), [GraphQL/client research](GRAPHQL-CLIENT.md) and [native retrieval/ingestion](NATIVE-RETRIEVAL-INGESTION.md). The 18 added slices are part of the same program, not a replacement backlog. Existing issue IDs remain stable; local file order is regenerated in dependency order. Product GraphQL work does not make GraphQL an agent dependency. The first native read can use the current supported pin; new v2 writes and corpus design wait for their own gates.

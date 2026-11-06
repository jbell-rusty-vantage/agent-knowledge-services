# Current state and evidence boundaries

Inspected 2026-10-10 for planning. Source and documentation inspection only; no application databases were queried, no providers invoked and no deployment or final application fixture executed.

| Repository | Inspected HEAD | Working state |
| --- | --- | --- |
| Knowledge Services | `28c4422228826c41f92dd837f3c5f0b561471b3b` | Existing tracked/untracked changes retained; new program documents added separately. |
| Mission Control | `2d20f62f4336595170ab99184288dc55903bf2f5` | Existing runtime/documentation changes retained. |
| Biotech Knowledge Services | `431c8a7c287ee3d914843390a080dbfbe949acdc` | Clean at initial inspection. |
| AI Engineer database contract | `c809a11a96268f6e1c673e8e03766afcb2ca0dab` | Extensive pre-existing generated workspace/type/migration changes retained. |

A revision is provenance for the checkout, not a claim that dirty inspected bytes equal that commit. Reinspect the relevant source and owning instructions at implementation time.

## Preserved worktrees

Knowledge Services has five retained maintenance worktrees under its Git metadata:

| Maintenance job / attempt | HEAD | Inspection outcome |
| --- | --- | --- |
| `20d31a43-1c91-4b4d-ae7c-11741488a8e6` / 1 | `7b71506c7c8b0c9c1d3b5376bdf72c5c72238510` | Dirty review/documentation material retained. |
| Same / 2 | same | Dirty review/documentation/provenance material retained. |
| `a08ad151-9515-4efb-82af-fe6de742c6b0` / 1 | `9224d3df57c128485438ece13597ac3a335948d5` | Clean tracked status; historical job checkout retained. |
| Same / 2 | same | Clean tracked status; historical job checkout retained. |
| `ce22a293-cf46-44e0-bbdd-440b70c8a1de` / 1 | `5bddfd6428a976164e86d964ca97d43d2e9876c5` | Dirty maintenance/watcher/review material retained. |

None is a suitable current platform implementation checkout. No worktree was deleted, reset, repurposed or committed. The main checkout receives only scoped new planning material and navigation/setup edits for this program.

## Grounded limitations

- Shared directory identity does not imply backend neutrality: the Knowledge Services host composes PostgreSQL persistence and consumes the AI Engineer contract pin.
- The bounded read executor skips retrieval; the separate canonical retrieval executor explicitly rejects required unsupported graph/context/anchor features.
- Biotech has bounded native read/plan/apply/receipt operations, not the proposed tier router or product API.
- Verification has substantial deterministic and evidence-closed behavior; some assurance properties and calibration remain unimplemented or unqualified. See the verification annex.
- Biotech's complete v2 ontology remains a candidate. Its verification mapping is useful input; the complete schema is neither accepted nor deployed by this packet.
- Skill manifests, catalog entries, provider bindings and live installation evidence are separate. Existing production seeds and parser conformance have gaps.
- Some older readiness guides reference retired repositories. This program assigns replacement consumer ownership explicitly; it must not recreate those repositories.
- Existing rollout documents contain different release/installation references. This task did not inspect live databases and makes no fresh installation claim.

## Starting evidence

- Shared foundation: `AGENTS.md`, `docs/architecture/current-state.md`, operation catalog, host composition, canonical retrieval executor and the verification package/guide.
- Mission Control: its canonical `mission-control-general/general-mission-control/expansion/KNOWLEDGE-SERVICES.md`, capability ADRs, capability search/custody code, seed manifests and database package.
- AI Engineer: database-contract schema workspace, named queries, evidence/content/curriculum schemas and product north-star guidance.
- Biotech: native executor/contracts, schema sidecars, question patterns, pinned proposal and separately labeled v2 candidate.
- Planning process: Mission Control's installed Matt Pocock `to-spec`, `to-tickets`, `triage` and setup skills plus issue-tracker/label/domain configuration.

## GraphQL/native-agent amendment evidence — 2026-10-10

The initial source-only inspection above is historical. The follow-up observed the public Fly health endpoint with original pinned source digest `sha256:8313a6f83a2429fffdc9ce6cbdb03cc2808c7b06022040a1e4f36cd2720ae3eb`, connectivity true, mutations false and vector true. This does not attest installed indexes, data migration or performance. The required Fly wrapper could not run because flyctl is unavailable; Machine/image/Aura inventory remains G00 work. No graph data query, production benchmark, embedding call, migration or complete application fixture was run.

Biotech source HEAD remains `431c8a7c287ee3d914843390a080dbfbe949acdc`; its README and deployment guide were clean before the targeted documentation corrections. User confirmed review of the newer v2 assembly and TypeScript web + Expo targets. v2 remains unaccepted and unimplemented in the graph. See [GraphQL research](GRAPHQL-CLIENT.md) and [native contract findings](NATIVE-RETRIEVAL-INGESTION.md).

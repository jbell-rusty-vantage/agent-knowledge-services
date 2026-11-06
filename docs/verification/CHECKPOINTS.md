# Scoped intermediate work custody

KS preserves intermediate work before Mission Control exists. Source discovery accounting records attempts, provider results, redirects, encounters and trust; artifact custody records immutable bytes and logical derivations; checkpoints record a scoped, verifiable set of files and executor indexes. These are separate responsibilities. A checkpoint receipt confirms custody, not factual support, publication admission or completion of a research objective.

The deterministic Eve harness collects approved files and awaits KS receipts. Research agents author notes, drafts, gaps and handoffs using their existing tools. No storage subagent is needed. Mission Control can later reference these receipts and own workflow continuation, accepted stage results and mission lifecycle. Standalone checkpoints use actual tenant, run, producer attempt, session and sandbox identities; child scope records its parent and child identity. They do not fabricate Mission Control foreign keys.

## Existing storage and identity

The executor uses its existing `FilesystemStore`, `ArtifactCustody`, canonical verification repository and runtime Supabase store. `pre-mission-control.v1` maps captures and intermediate artifacts to `ai-engineer-cloud-bucket`. Existing ingestion ledger and report artifacts retain their existing buckets and identities. Equal bytes share a digest-addressed object while different parents, transformations and producers retain distinct logical artifact handles.

`scoped-checkpoint.v1` includes approved paths, exact artifact handles, an executor-state capsule, optional semantic handoff, pending owner identities, and the previous checkpoint. A canonical transaction records immutable receipt and reference rows and advances the exact expected head. Storage upload and readback verification precede acknowledgement. Original harness input digests are stored independently from the generated manifest digest, so acknowledgement-loss replay returns the original receipt before taking a new snapshot. Native observation identity is the scoped event ID; replay cannot create a new event merely because the head advanced.

## Service operations

CLI commands under `knowledge checkpoint`, MCP tools named `checkpoint_*`, and HTTP `/knowledge/checkpoint_*` use one catalog:

| Operation | Result |
| --- | --- |
| `harness` | Collect host-provided approved files, observe a native event, or restore a session. HTTP input is `{ "request": ... }`. |
| `commit` | Verify a typed manifest and its remote closure, then commit with expected-head CAS. |
| `head` | Read and verify the latest receipt for an exact scope. |
| `read` | Verify archive contents without attempting continuation. |
| `restore` | Verify bytes, scope and profile pins; reconcile pending operations through existing owners. |
| `tombstone` | Retire only eligible aged orphan artifacts under canonical reference checks. |

An archive can preserve incomplete work without claiming it is ready. Continuation intent requires a remotely held executor capsule and nonempty UTF-8 `handoff.md`, wrapped in a typed semantic handoff. Pending operations keep readiness false. A partial handoff remains an immutable record of what was pending; restore becomes ready only after exact owner reconciliation. The final agent message is never a persistence acknowledgement.

## Collection and restore

The pinned capability policy approves `inputs`, `discovery`, `captures`, `claims`, `reports`, `ingestion`, `retrieval`, `notes`, `drafts`, `gaps`, `manifest.json` and `handoff.md`. It also includes the existing authored root files: `00-plan.md`, `10-captures.md`, `20-quote-ledger.md`, `30-claims-intent.json`, `40-extraction-intent.json`, `50-report.md`, `60-report-intent.json` and `70-run-summary.md`. Path traversal, absolute paths, symlinks, secret files and forbidden directories are rejected. Eve applies an 8 MB per-file collection bound, a 64 MB active workspace bound and 2,000 files. KS separately bounds current artifact closure and manifest metadata, so metadata overhead and retained historical work do not consume the active file budget.

Root and every child mount their own hooks. Dirty timers run without model messages. Stage boundaries, tool outputs, failure and cancellation await custody. A host-held sandbox marker detects replacement of physical storage even when the logical sandbox ID is unchanged. Restore materializes archived files before reporting a continuation block. Existing executor indexes from unrelated runs remain intact; a conflicting index in the restored run fails closed.

The capsule preserves actual capture records, run states and ordered step receipts. Step-only runs derive timestamps from their persisted receipts, not the current clock. Local mutation exclusion prevents snapshots during a verifier step, and a revision check rejects mutations during snapshot reads. This local snapshot guard is separate from durable operation ownership and lease fencing.

## Retention and recovery

Historical checkpoint references, artifact derivation parents, ingestion receipts, report references and other canonical artifact foreign keys prevent retirement. Orphan age uses an immutable database registration clock with a 30-day minimum. A tombstone cannot resurrect through re-registration or a late reference. Physical storage deletion is denied while any live logical alias references the bucket/object. The existing pending/available custody transitions and lease fences remain authoritative.

Restore also appends verified reconciliation outcome references and their dependencies to the checkpoint's canonical retention records before acknowledging readiness. This pins newly recovered receipts without rewriting the original manifest.

Each historical checkpoint remains independently readable. The immediate previous accepted manifest is verified as a historical leaf during a new checkpoint; its canonical references remain retained without recursively charging all past workspace bytes against every new snapshot.

Proofs run only against an isolated disposable database and actual Docker sandboxes. Process-loss tests kill producers, remove their containers and restore into clean replacements. Fixture tool output proves the custody path without claiming a real provider-side effect occurred. Acceptance evidence and exact source bindings live in the pre-Mission Control implementation ledger; this guide alone does not assert deployment or acceptance.

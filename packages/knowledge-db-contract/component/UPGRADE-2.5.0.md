# knowledge_verification 2.5.0 (migration 0008): consumer notes

For application bindings (AI Engineer `aiengineer/ai-engineer-db-contract`, Biotech) and the Knowledge Services
executor. 2.4.0 installs upgrade by applying `0008_effect_dispatch_journal` only; 2.4.0 rows are kept. This release
delivers Sprint OC WI-05 (OVE-167, RV-06): native commits recover across a lost K01 protocol receipt without a second
native write.

| Object | 2.5.0 contract | Consumer action |
| --- | --- | --- |
| `effect_dispatch` + `journal_effect_dispatch(p_tenant, p_effect_key, p_dispatch_id, p_operation, p_envelope_digest, p_semantic_payload_digest, p_bound_effect_digest, p_originating_origin_digest, p_caller_origin_digest, p_caller_origin, p_envelope)` | Immutable journal of every K01 dispatch, written before native dispatch in its own transaction: dense per-effect `dispatch_sequence`, the envelope document and digest, the caller origin. Same dispatch id + envelope: idempotent; another envelope: `DISPATCH_CONFLICT`; other bound bytes or originating origin than the BOUND EFFECT: `EFFECT_CONFLICT`. Uncommitted journal rows never bind the key, so a refused (e.g. wrong-digest) dispatch cannot pin it against a later correct one. Both origins must exist in `origin`. | The KS executor writes it (`PostgresEffectLedger.journal`). Bindings do nothing. |
| `effect_commit` + `record_effect_commit(p_tenant, p_effect_key, p_dispatch_id, p_native_ref)` | Written INSIDE the native transaction: which journaled dispatch committed the effect, and where its native receipt is (`{receiptId}` AI Engineer, `{outboxDispatchId}` Biotech). One per effect: a second native commit raises `EFFECT_ALREADY_COMMITTED` (the native transaction rolls back), also for two concurrent first commits (serialized by a per-effect advisory lock; a lost insert race in a REPEATABLE READ transaction maps to the same code, never a raw unique violation); an unjournaled dispatch raises `DISPATCH_NOT_JOURNALED`. | AI Engineer: the knowledge-db ingestion transaction calls it (`IngestionOptions.effectDispatchId`). Biotech: the admission + enqueue transaction calls it. `executor_service` reaches it through `knowledge_verification_writer` (existing AIDB grant); no AIDB migration is needed. |
| `effect_dispatch_fence` + `abandon_effect_dispatch(p_tenant, p_effect_key, p_dispatch_id)` | One terminal fence per journaled dispatch: `committed` (written by the commit stamp) or `abandoned`. The abandon takes the commit stamp's per-effect lock: it answers `committed` when the effect is committed (a commit in flight is waited for), else records `abandoned`, after which that dispatch's native commit raises `DISPATCH_ABANDONED` (rolls back; also under REPEATABLE READ, through the shared fence key). | The KS executor calls it before reporting a refused dispatch `journaled_uncommitted`. Bindings do nothing. |
| `record_protocol_receipt(p_tenant, p_effect_key, p_receipt)` | Same signature. For an effect with a commit stamp, the receipt must name the committing dispatch and its journaled envelope digest (`RECEIPT_DISPATCH_MISMATCH` otherwise). PUBLIC execute is revoked. | None. |

Recovery: `effect_commit` present and `protocol_receipt` absent is `native_only`. The executor rebuilds the original
dispatch's receipt from the journal and the binding's read-back of the committed native receipt, records it and never
applies again. Every `knowledge.apply` refusal carries `details.dispatch`: `not_journaled` (also every `EFFECT_CONFLICT`: the presented
bytes can never apply under the key), `journaled_uncommitted` (only for a typed pre-commit refusal, and only after the
dispatch is fenced: `details.fenced: true`), `committed` or `unknown` (any other failure: a commit may be in flight).
Bindings pinning 2.4.0 must move their installer pin to 2.5.0 (the executor's backend refuses a
component older than 2.5.0).

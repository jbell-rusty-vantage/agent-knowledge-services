# Operations runbooks

Every incident record includes detection signal, tenant-safe containment, retry or repair authority, affected immutable IDs, produced receipts, user impact, verification evidence, and the regression/evaluation case added afterward.

| Incident | Detect and contain | Safe recovery and verification |
| --- | --- | --- |
| Acquisition outage/rate limit | provider error/latency circuit opens; stop new calls | same-idempotency retry or admitted fallback; compare capture and receipt digests |
| Changed source/identity conflict | capture or identity digest differs | preserve both versions, quarantine, require reviewer; replay locators |
| Parser crash/malicious file | sandbox exit, resource or scan alert | isolate artifact, revoke parser job access, patch/pin new profile; rerun malicious fixture |
| Low-confidence/broken table or locator | fidelity/round-trip gate fails | create derived repair candidate; human confirmation required; never overwrite original |
| Partial embedding/provider mismatch | dimension, route, count, or manifest mismatch | abandon unpublished run, retry with same input key or new profile version; reconcile exact counts |
| Cost spike | tenant/provider budget or token anomaly | open circuit and cancel unleased work; budget-owner approval to resume |
| HNSW/recall regression | ANN-vs-exact or latency gate fails | route to exact bounded search, rebuild index; pass locked recall and EXPLAIN checks |
| Stuck/poison job or expired lease | queue age, heartbeat and repeated failure alerts | expire lease, quarantine poison input, reclaim idempotently; verify one terminal receipt |
| Outbox backlog | event age/sequence gap | pause callbacks, drain in order, deduplicate delivery IDs; compare ledger and consumer acknowledgments |
| Approval digest invalidation | decision digest differs from proposal | reject decision and request a new review; prove no publication receipt exists |
| Stale/retracted knowledge | lifecycle/freshness source signal | mark ineligible, publish correction/rollback through policy; confirm scoped retrieval excludes it |
| Cross-tenant/false acceptance | authorization or evaluation alert | disable affected surface, revoke tokens, quarantine publication; complete security review and replay |
| Prompt injection | inspection finding or unexpected tool attempt | quarantine or retain as labeled content; verify no capability/approval changed |
| Storage loss | reconciliation cannot resolve artifact digest | stop dependent publication, restore immutable object from approved backup; digest-verify lineage |
| Key compromise | secret-use or signature anomaly | revoke/rotate, reject replay window, reconcile callbacks and accesses; verify least privilege |

## Restart and reconciliation drill

1. Start an operation and record its operation, attempt, work-item, correlation, causation, and external-run IDs.
2. Terminate the worker after a lease is claimed and before completion.
3. Restart it after lease expiry. The replacement worker reclaims the step, heartbeats, and emits one idempotent terminal receipt.
4. Reconcile operations, steps, outbox deliveries, artifacts, vector items, and publication manifests.
5. Confirm there are no duplicate canonical objects, vectors, decisions, callbacks, or terminal receipts.

## Callback drill

Accept a correctly signed current delivery once. Reject the identical delivery ID, an expired timestamp, modified body, mismatched correlation/external-run identity, and an unknown signing key. Rotation keeps the prior verification key only for the documented overlap window.

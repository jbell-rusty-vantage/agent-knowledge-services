# knowledge_verification 2.4.0 (migration 0007): consumer notes

For application bindings (AI Engineer `aiengineer/ai-engineer-db-contract`, Biotech) and the Knowledge Services
executor. 2.3.0 installs upgrade by applying `0007_server_clock_and_required_values_digest` only; 2.3.0 rows are kept.
This release closes R1 review findings F2 (normalized values failed open) and F15 (caller-supplied clocks).

| Object | 2.4.0 contract | Consumer action |
| --- | --- | --- |
| `admit_exact_use(p_tenant, p_id, p_digest, p_epoch, p_now default now(), p_normalized_values_digest default null)` | Same signature. Raises `NORMALIZED_VALUES_REQUIRED` (SQLSTATE `22004`) when the decision binds a normalized-values digest and the caller presents none; the 4-argument call therefore fails for such decisions. Expiry and grant revocation are evaluated at the server clock; `p_now` is ignored. | Every writer passes the digest of the values it writes. AIDB `research.assert_admitted_use` / `require_admitted_use` should drop their `default null` and forward the digest (AIDB follow-up migration); until then a guard call without it is refused, not admitted. |
| `enqueue_dispatch(..., p_normalized_values_digest default null, p_marker_scheme)` | Unchanged signature; it admits through `admit_exact_use`, so a null digest for a decision with values raises `NORMALIZED_VALUES_REQUIRED`. | The PostgreSQL binding's `enqueueDispatch` now takes `normalizedValuesDigest` as a required key. The Biotech binding should pass a non-null digest. |
| `check_use_eligibility(p_tenant, p_id, p_digest, p_now)` | Unchanged: the read path compares no values. | None. |
| `consume_credential(p_tenant, p_issuer, p_jti, p_dispatch_id, p_expires_at)` | New 5-argument form at the server clock (`expired` when `p_expires_at <= now()`, `consumed_at = now()`). | New callers use it. |
| `consume_credential(..., p_expires_at, p_now)` | The 2.3.0 shape, now without a default: `p_now` is ignored and the 5-argument form decides. | Existing callers (the verification executor's `backends.ts`) keep working; move them to the 5-argument form. |
| `purge_credential_use(p_tenant)` / `purge_credential_use(p_tenant, p_now)` | Removes rows whose expiry has passed at the server clock; the 2-argument shape ignores `p_now`, so a caller clock cannot purge unexpired nonces. | As above. |

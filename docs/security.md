# Security model

Knowledge Services fails closed at four boundaries: authenticated tenant/actor context, bounded transport schemas, admitted capabilities, and guarded publication. Content is untrusted data and cannot grant tools or approval.

## Controls

- HTTP mutations require bearer authentication, tenant and actor identity, reason, expected contract/capability versions, correlation context, and an idempotency key. Responses use typed problem details without tenant-existence leaks.
- Retrieval applies tenant and visibility filters before candidate generation and caps query length, candidates, output, graph depth, and graph fan-out.
- MCP and Eve expose allow-listed workflow tools only. They never expose SQL, private object listing, credentials, arbitrary fetch, canonical vector writes, approval, or publication.
- Fetchers allow HTTP(S), resolve and validate every redirect, and reject loopback, private, link-local, metadata, rebinding, oversized, over-decompressed, or over-redirected requests.
- Parsers receive read-only content-addressed inputs in isolated temporary storage with no ambient credentials, no network, dropped privileges, and CPU/memory/time/archive limits.
- Captures and derived artifacts are immutable and digest-addressed. Logs, events, callbacks, receipts, and model context are redacted.
- A2A callback signatures bind tenant, task, operation, correlation/causation lineage, occurrence time, and payload digest. The HTTP receiver additionally binds task ID and signing-key reference to the immutable admitted operation input, then records only digest metadata in an append-only PostgreSQL replay ledger.
- Callback targets are resolved from trusted configuration. The sender rejects caller-selected target substitution, redirects, URL credentials/fragments, and public cleartext HTTP; HMAC secrets must be at least 32 bytes and never appear in request bodies or persisted rows.
- Callbacks use a timestamped HMAC over method, path, body digest, delivery ID, correlation ID, and external run ID. A bounded timestamp window plus a durable delivery-ID claim prevents replay.
- Approvals bind an exact digest, eligible role, quorum, expiry, and rationale. Self-approval and post-approval digest change fail.

Security drills cover cross-tenant guessed IDs, timing/error equivalence, prompt injection, SSRF/redirect rebinding, decompression bombs, malicious archives, callback replay, stale leases, key compromise, and false acceptance. Each finding becomes a regression fixture before closure.

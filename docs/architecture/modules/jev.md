# Jev decision workers

Status: reference implementation documentation, 2026-09-26.

The user-authorized Jev service is a separately runnable capability inside Knowledge Services. It does not consolidate existing dashboards, replace the durable knowledge worker, or complete the broader package-cleanup plan. The planned `ks jev` consolidation remains separate work; the runnable binary here is `jev`.

## Ownership and entry points

- `packages/contracts/src/jev.ts`: versioned public request, input, question, job, and result schemas, exported as `@aiengineer/knowledge-contracts/jev`.
- `packages/jev`: decision provider adapters, bounded input capture, durable local queue and child-process execution.
- `packages/application/src/jev.ts`: shared in-process application entry point for the dedicated host.
- `apps/jev`: CLI, HTTP, and MCP transports. HTTP and MCP call application; the CLI uses `KnowledgeJevClient` from the existing public client package's `/jev` subpath.

This is intentionally a single-host service with one supervisor per SQLite database. It is not a distributed queue or a multi-tenant admission service. Its database is local operational state, not a competing authority for the shared Supabase schema. The existing shared database is untouched.

## Execution and recovery

Submitting a task validates all questions, resolves the permitted input, hashes its exact captured bytes, and persists a state snapshot and normalized request digest before dispatch. An idempotency key returns the existing job for an identical request; reuse with a different request fails. Inputs are snapshotted once, so recovery does not refetch changing URLs or reread changing files.

One supervisor owns a bounded pool of actual Node child processes. Each child executes one provider request at a time. Many questions in one request share the same state; many tasks occupy distinct processes. The queue stores status, attempts, input provenance, worker PID, timing, usage, result or failure. Worker exit and provider timeouts are retried within the configured attempt limit. Completed results remain available after restart. Cancelling running work kills its worker, which is replaced; an already accepted provider request can still be billed.

Delivery is at least once. A supervisor crash after a provider accepts work but before its receipt is stored may cause another paid request. Idempotency prevents duplicate local jobs, not duplicate provider billing. A successful result's token usage describes that successful attempt, not unknown work done by failed attempts. The supervisor's request-rate limiter is per host and resets on restart; it does not coordinate other machines using the same key.

The SQLite owner row prevents two live supervisors from sharing a queue. PID liveness is a local-machine mechanism. Never share its database over a network filesystem. A stale row whose PID was reused may require operator inspection; do not remove the row while a supervisor might still own it. Start/stop with the documented CLI and use a separate database for another independent host.

## Input and trust

State is UTF-8 text or JSON object/array. Local files require configured roots, resolved through real paths. Remote artifacts require exact HTTPS origins; redirects and URL credentials are rejected. Captures have byte limits. Remote signed query parameters are omitted from returned provenance. Raw PDFs, images, audio, and office files belong to Knowledge Services acquisition and conversion first; submitting filenames or URLs as inline state does not fetch them.

Operators must configure narrow roots containing prepared public or authorized data. A permitted directory is a capability to read its files; do not permit the workspace root containing `.env` or private content. Jobs persist input state in SQLite, so apply host filesystem access and retention appropriate to the corpus. Worker processes receive only a small environment allowlist including provider keys; keys do not appear in stored requests or result receipts.

The HTTP host binds to loopback by default. Non-loopback binding requires `JEV_SERVICE_TOKEN`; remote deployments also need TLS termination. All API and MCP operations share host authorization. This is one operator trust domain, not tenant isolation. A token grants submission, job inspection, and cancellation. Raw browser-origin requests are denied. The static report contains only the explicitly public experiment data.

## Model semantics

The normalized contract uses Choice, Score, and Noul. The Gateway native evaluation adapter translates Noul to boolean and maps its probability back to Noul. The direct adapter pins `jev-1.13.0` by default. Gateway uses `typesafe-ai/jev`; missing returned version is recorded as null rather than invented. Provider response shape and option membership are checked before a job can succeed.

Confidence is provider metadata, not a guarantee. Jev cannot generate rationales or new labels. LLMs design schemas and interpret ambiguous cases; code controls escalation and side effects. The service does not automatically execute tool choices, admit evidence, or apply confidence thresholds to privileged operations. Long inputs fail visibly; callers explicitly select or prepare windows rather than silently truncating data. For taxonomy search beyond 255 options, compose multiple jobs as described in the skill and research; global confidence is not the product of uncalibrated local scores.

See [runbook](../../jev/README.md), [research](../../jev/RESEARCH.md), and [agent skill](../../../skills/jev-system-one/SKILL.md).

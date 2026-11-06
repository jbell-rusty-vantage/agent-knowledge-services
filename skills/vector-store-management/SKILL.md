---
description: Use when creating or operating official, exploratory, or user-managed vector stores through Knowledge Services.
license: Proprietary
metadata:
  version: "1.2.0"
  contract: "knowledge-service/v1"
---

# Vector-store management

Choose the store class explicitly: `official`, `internal_exploratory`, or `user_managed`. Preserve its owner, tenant, visibility, lifecycle, purpose, retention, admitted domains, embedding profile, and publication authority. Never move content or identifiers across classes implicitly.

Use idempotent API or MCP operations to create a store, add exact document-version IDs, observe ingestion, search, evaluate, and reconcile. Propagate tenant, actor, reason, expected contract/capability versions, operation/attempt/work-item, correlation/causation, and external workflow run IDs. Retry ambiguous mutations only with the same idempotency key.

## Evaluated publication, activation, and rollback

The admitted platform CLI names the two public publication submissions `ks knowledge space publish`
and `ks knowledge space rollback`. Publish submits `space_publication`; the deterministic authorized
executor verifies the independent evaluation and moves the official pointer. That completed pointer
switch is activation. Rollback submits `publication_rollback`; the authorized executor verifies the
frozen baseline and restores its pointer. Poll the returned operation using `knowledge operation
status` and retain the terminal receipt.

```text
ks knowledge space publish --context '<OperationContext>' --input '<space publication input>'
ks knowledge space rollback --context '<OperationContext>' --input '<publication rollback input>'
ks knowledge operation status --context '<OperationContext>' --input '{"operationId":"<uuid>"}'
```

The platform MCP catalog deliberately has no `publication.publish`, `publication.approve`,
`space.activate`, `space.revoke`, or `space.rollback` tool. The CLI submission does not grant a
caller authority to activate or roll back. There is also no separate public revoke command: when
support is no longer admitted, official retrieval must gate or omit it; a pointer restoration uses
the guarded rollback operation above.

Agents may submit intents and proposals but cannot approve or publish. Only an eligible deterministic executor may materialize an approved guarded digest. Never write canonical tables or vectors directly, list private storage, submit raw SQL, reveal secrets, or treat `internal_exploratory` fixtures as canonical knowledge.

# Acquisition CLI reference

The executor ships `knowledge` (and `knowledge-verify`); the platform CLI is `ks` (`@aiengineer/knowledge-cli`). Use the one your environment loaded.

## Executor (`apps/verification-executor`)

Capture and inspect sealed executor custody (`verify_capture_source`, `verify_capture_file`, `verify_read_capture`, `verify_search_capture`):

```text
knowledge-verify capture <url>
knowledge-verify capture-file <path>
knowledge-verify read <captureId> [--offset n] [--length n]
knowledge-verify search <captureId> <query>
```

Managed discovery (host-held providers, billed to the caller budget):

```text
knowledge source discover <request.json>
knowledge source import <receipt.json>
knowledge source select <request.json>
knowledge source attempt <attemptId>
knowledge source reconcile <attemptId>
```

## Platform (`apps/cli`)

```text
ks knowledge source discover --input <candidates.json> --context <context.json>
ks knowledge source fetch --input <capture.json> --context <context.json>
ks knowledge source vet --input <vetting.json> --context <context.json>
```

`source fetch` submits operation kind `capture`. HTTP body:

```json
{
  "schemaVersion": "knowledge.capture/v1",
  "source": {
    "sourceClass": "web_page",
    "canonicalUrl": "https://example.com/docs",
    "sensitivity": "public"
  },
  "request": {
    "purpose": "capture official docs",
    "target": { "kind": "http", "url": "https://example.com/docs" },
    "expectedSourceClass": "web_page",
    "preferredMediaTypes": ["text/html"],
    "egressProfile": "public-web-v1",
    "maximumBytes": 1000000,
    "renderingPolicy": "none",
    "interactionPolicy": "none",
    "classification": "public",
    "expectedOutputs": ["source-native"]
  }
}
```

Upload variant (worker-local disk, `ACQUISITION_UPLOAD_ROOT` set). Canonical URL is a declared identity, not a fetched URL:

```json
{
  "schemaVersion": "knowledge.capture/v1",
  "source": {
    "sourceClass": "other",
    "canonicalUrl": "file://operator/notes.txt",
    "sensitivity": "public"
  },
  "request": {
    "purpose": "capture operator file",
    "target": { "kind": "upload", "uploadId": "notes", "declaredOrigin": "operator" },
    "expectedSourceClass": "other",
    "preferredMediaTypes": ["text/plain"],
    "egressProfile": "public-web-v1",
    "maximumBytes": 1000000,
    "renderingPolicy": "none",
    "interactionPolicy": "none",
    "classification": "public",
    "expectedOutputs": ["source-native"]
  }
}
```

Do not invent a platform inspect command. Inspect with executor `verify_read_capture` / `verify_search_capture`.

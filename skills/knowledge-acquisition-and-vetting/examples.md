# Acquisition and inspection examples

Placeholder UUIDs are RFC-layout (`…-4000-8000-…`). Replace them with admitted IDs. Package exemplars under `packages/sources/examples` are mocked and need no paid key.

## 1. Platform HTTP capture

`ks knowledge source fetch --input capture.json --context context.json`

See [cli-reference.md](cli-reference.md) for the `knowledge.capture/v1` HTTP body. Success returns `knowledge.capture-result/v1` with one `contentDigests` entry. Seal is a later step of the same operation.

## 2. Executor file capture then read

```text
knowledge-verify capture-file ./fixture.pdf
knowledge-verify read <captureId> --offset 0 --length 400
knowledge-verify search <captureId> "exact public phrase"
```

The read payload is an excerpt. Do not copy `text` into a verification locator. Inspection does not admit the source.

## 3. Failure: private or redirected-to-private URL

A mocked DNS answer of `10.0.0.4` fails with `ADDRESS_DENIED` and does not store bytes. Runnable copy: `packages/sources/examples/06-http-policy-failure.ts`.

## 4. Paper identity

Normalize DOI / arXiv / OpenReview, pick one HTTPS representation, then HTTP-acquire. Do not call paper `execute` on the worker. Runnable copy: `packages/sources/examples/05-paper-resolve-then-http.ts`.

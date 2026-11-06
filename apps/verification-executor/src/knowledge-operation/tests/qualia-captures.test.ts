import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes } from "@aiengineer/knowledge-operation-protocol";
import {
  bindQualiaNativeCaptures,
  retainQualiaCapture,
  selectQualiaCapture,
  type CapturedSource,
} from "./qualia-captures.js";

const url = "https://fixtures.bks.test/retained-page";
const firstId = "a".repeat(32),
  secondId = "b".repeat(32);
function source(captureId: string, text: string, sourceUrl = url): CapturedSource {
  return {
    captureId,
    url: sourceUrl,
    text,
    retrievedAt: "2026-10-30T00:00:00Z",
    ref: {
      kind: "artifact",
      id: `artifact-${digestBytes(text).slice(7, 30)}`,
      version: "artifact.v1",
      digest: digestBytes(text),
      tenant: "synthetic-tenant",
      binding: "biotech-graph",
    },
  };
}

test("distinct same-URL snapshots coexist and resolve only by their exact selected identity", () => {
  const captures = new Map<string, CapturedSource>();
  const browser = source(firstId, "Browser-retained source bytes.");
  const firecrawl = source(secondId, "Firecrawl-retained different source bytes.");
  retainQualiaCapture(captures, browser);
  retainQualiaCapture(captures, firecrawl);
  assert.equal(captures.size, 2);
  assert.equal(selectQualiaCapture(captures.values(), url, firstId), browser);
  assert.equal(selectQualiaCapture(captures.values(), url, secondId), firecrawl);
  assert.throws(
    () => selectQualiaCapture(captures.values(), url),
    (error) => {
      assert.match(String(error), /ambiguous/);
      assert.match(String(error), new RegExp(firstId));
      assert.match(String(error), new RegExp(secondId));
      return true;
    },
  );
  assert.throws(() => selectQualiaCapture(captures.values(), `${url}/other`, firstId), /unavailable/);
  assert.throws(() => selectQualiaCapture(captures.values(), url, "c".repeat(32)), /unavailable/);
});

test("capture identities cannot silently overwrite existing bytes or URL, even on replay", () => {
  const captures = new Map<string, CapturedSource>();
  const original = source(firstId, "Original immutable bytes.");
  retainQualiaCapture(captures, original);
  assert.equal(retainQualiaCapture(captures, { ...original, retrievedAt: "2026-10-31T00:00:00Z" }), original);
  assert.throws(() => retainQualiaCapture(captures, source(firstId, "Changed bytes.")), /reused/);
  assert.throws(() => retainQualiaCapture(captures, source(firstId, original.text, `${url}/other`)), /reused/);
  assert.equal(captures.size, 1);
  assert.equal(captures.get(firstId), original);
});

test("legacy URL selection succeeds only with one actual retained candidate", () => {
  const original = source(firstId, "One retained snapshot.");
  const { captureId: _captureId, ...legacy } = original;
  assert.equal(selectQualiaCapture([legacy], url), legacy);
  assert.throws(() => selectQualiaCapture([legacy, original], url), /ambiguous/);
  assert.throws(() => selectQualiaCapture([legacy], url, firstId), /unavailable/);
  assert.throws(() => selectQualiaCapture([original], url, "not-a-capture-id"), /32-character/);
});

test("native binding strips the fixture selector and takes actual bytes and custody from the pinned snapshot", () => {
  const browser = source(firstId, "Browser native evidence.");
  const firecrawl = source(secondId, "Other native evidence.");
  const [native] = bindQualiaNativeCaptures(
    [browser, firecrawl],
    [
      {
        key: "snapshot",
        canonicalUri: url,
        captureId: firstId,
        contentUtf8: "Caller-supplied bytes must not become evidence.",
        storageUri: "caller-storage",
        retrievedAt: "2099-01-01T00:00:00Z",
      },
    ],
  );
  assert.ok(native);
  assert.equal("captureId" in native, false);
  assert.equal(native.contentUtf8, browser.text);
  assert.equal(native.storageUri, `ks-custody:${browser.ref.id}`);
  assert.equal(native.retrievedAt, browser.retrievedAt);
  assert.equal(native.canonicalUri, url);
  const [fixtureNative] = bindQualiaNativeCaptures(
    [browser, firecrawl],
    [{ canonicalUri: url, captureId: firstId }],
    true,
  );
  assert.equal(fixtureNative?.captureId, browser.captureId);
  assert.throws(() => bindQualiaNativeCaptures([browser, firecrawl], [{ canonicalUri: url }]), /ambiguous/);
});

test("selected capture custody is checked instead of falling back to another snapshot", () => {
  const invalid = { ...source(firstId, "Retained bytes."), text: "Tampered bytes." };
  assert.throws(() => retainQualiaCapture(new Map(), invalid), /custody digest/);
  assert.throws(
    () => selectQualiaCapture([invalid, source(secondId, "Other valid bytes.")], url, firstId),
    /bytes unavailable/,
  );
});

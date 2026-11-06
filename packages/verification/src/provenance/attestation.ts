import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { deepFreeze } from "../internal/deep-freeze.js";
import { auditBundleSignablePayload, inspectAuditBundle } from "./seal.js";
import type { AuditBundleSignatureVerifier, AuditBundleSigner, VerificationAuditBundle } from "./model.js";

export const VERIFICATION_DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const VERIFICATION_AUDIT_BUNDLE_BUILD_TYPE = "urn:aiengineer:verification:audit-bundle:v1";

const MAX_ENVELOPE_BYTES = 65_536;
const MAX_PAYLOAD_BYTES = 32_768;
const MAX_DEPENDENCIES = 256;
const sha256 = /^sha256:([a-f0-9]{64})$/;
const text = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface VerificationDsseSignature {
  readonly keyid: string;
  readonly sig: string;
}

/** Standard DSSE JSON envelope; inspection additionally accepts URL-safe base64. */
export interface VerificationDsseEnvelope {
  readonly payloadType: typeof VERIFICATION_DSSE_PAYLOAD_TYPE;
  readonly payload: string;
  readonly signatures: readonly [VerificationDsseSignature];
}

export interface VerificationDsseSlsaStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly [
    {
      readonly name: "verification-audit-payload";
      readonly digest: { readonly sha256: string };
    },
  ];
  readonly predicateType: typeof SLSA_PROVENANCE_V1_PREDICATE_TYPE;
  readonly predicate: {
    readonly buildDefinition: {
      readonly buildType: typeof VERIFICATION_AUDIT_BUNDLE_BUILD_TYPE;
      readonly externalParameters: Readonly<Record<string, `sha256:${string}`>>;
      readonly resolvedDependencies: readonly {
        readonly uri: string;
        readonly digest: { readonly sha256: string };
      }[];
    };
    readonly runDetails: { readonly builder: { readonly id: string } };
  };
}

/** A server-owned signer-to-builder trust decision, never a statement claim. */
export interface VerificationDsseTrustedBinding {
  readonly builderId: string;
  readonly keyId: string;
}

export interface VerificationDsseSlsaAttestation {
  readonly envelope: VerificationDsseEnvelope;
  readonly statement: VerificationDsseSlsaStatement;
  readonly subjectDigest: `sha256:${string}`;
  readonly signerKeyId: string;
  readonly builderId: string;
}

export interface VerificationDsseSlsaInspection {
  readonly verified: boolean;
  readonly reason?: string;
  readonly payloadType?: string;
  readonly predicateType?: string;
  readonly subjectDigest?: `sha256:${string}`;
  readonly signerKeyId?: string;
  readonly builderId?: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function publicIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
    fail(code);
  return value;
}

function derivedBuilderId(bundle: VerificationAuditBundle): string {
  return `urn:aiengineer:verification:deployment:${encodeURIComponent(publicIdentifier(bundle.manifest.runtime.deploymentId, "DSSE_DEPLOYMENT_ID_INVALID"))}`;
}

function assertTrustedBinding(binding: VerificationDsseTrustedBinding, builderId: string, keyId: string): void {
  exactKeys(
    binding as unknown as Record<string, unknown>,
    ["builderId", "keyId"],
    "DSSE_TRUSTED_BINDING_FIELDS_INVALID",
  );
  if (
    publicIdentifier(binding.builderId, "DSSE_BUILDER_ID_INVALID") !== builderId ||
    publicIdentifier(binding.keyId, "DSSE_KEY_ID_INVALID") !== keyId
  )
    fail("DSSE_TRUSTED_BINDING_MISMATCH");
}

function decodeBase64(value: unknown, maxBytes: number, code: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) ||
    /=.+[^=]/.test(value)
  )
    fail(code);
  const urlSafe = /[-_]/.test(value) || (!value.includes("=") && value.length % 4 !== 0);
  if (urlSafe && /[+/]/.test(value)) fail(code);
  const unpadded = value.replace(/=+$/, "");
  const normalized =
    (urlSafe ? unpadded.replace(/-/g, "+").replace(/_/g, "/") : unpadded) + "=".repeat((4 - (unpadded.length % 4)) % 4);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    fail(code);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) fail(code);
  const canonical = urlSafe ? bytes.toString("base64url") : bytes.toString("base64");
  if (canonical !== (urlSafe ? unpadded : value)) fail(code);
  return new Uint8Array(bytes);
}

/** DSSE pre-authentication encoding over UTF-8 byte lengths, per DSSE v1. */
export function verificationDssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = publicIdentifier(payloadType, "DSSE_PAYLOAD_TYPE_INVALID");
  if (payload.byteLength === 0 || payload.byteLength > MAX_PAYLOAD_BYTES) fail("DSSE_PAYLOAD_SIZE_INVALID");
  const prefix = text.encode(`DSSEv1 ${text.encode(type).byteLength} ${type} ${payload.byteLength} `);
  const result = new Uint8Array(prefix.byteLength + payload.byteLength);
  result.set(prefix);
  result.set(payload, prefix.byteLength);
  return result;
}

function signedBundleDigest(bundle: VerificationAuditBundle): `sha256:${string}` {
  const payload = text.encode(canonicalizeJson(auditBundleSignablePayload(bundle)));
  return sha256Digest(payload);
}

function statementFor(bundle: VerificationAuditBundle): VerificationDsseSlsaStatement {
  const subjectDigest = signedBundleDigest(bundle);
  const dependencies = [...bundle.manifest.inputArtifacts]
    .map((handle) => {
      const match = sha256.exec(handle.digest);
      if (!match) fail("DSSE_DEPENDENCY_DIGEST_INVALID");
      return {
        uri: `urn:aiengineer:verification-artifact:${publicIdentifier(handle.artifactId, "DSSE_DEPENDENCY_ARTIFACT_INVALID")}`,
        digest: { sha256: match[1]! },
      };
    })
    .sort((left, right) => {
      const a = canonicalizeJson(left),
        b = canonicalizeJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (
    dependencies.length === 0 ||
    dependencies.length > MAX_DEPENDENCIES ||
    new Set(dependencies.map((dependency) => dependency.uri)).size !== dependencies.length
  )
    fail("DSSE_DEPENDENCIES_INVALID");
  const policy = sha256.exec(bundle.policyBinding.policyArtifact.digest);
  const policyInputs = sha256.exec(bundle.policyBinding.recordedPolicyInputsArtifact.digest);
  const manifest = sha256.exec(bundle.manifest.canonicalization.manifestDigest);
  const deterministic = sha256.exec(bundle.deterministicResultDigest);
  const decision = sha256.exec(bundle.policyDecisionDigest);
  if (!policy || !policyInputs || !manifest || !deterministic || !decision) fail("DSSE_AUDIT_DIGEST_INVALID");
  return deepFreeze<VerificationDsseSlsaStatement>({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: "verification-audit-payload",
        digest: { sha256: subjectDigest.slice(7) },
      },
    ],
    predicateType: SLSA_PROVENANCE_V1_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: VERIFICATION_AUDIT_BUNDLE_BUILD_TYPE,
        externalParameters: {
          auditBundlePayloadDigest: subjectDigest,
          deterministicResultDigest: bundle.deterministicResultDigest,
          manifestDigest: bundle.manifest.canonicalization.manifestDigest as `sha256:${string}`,
          policyArtifactDigest: bundle.policyBinding.policyArtifact.digest as `sha256:${string}`,
          policyDecisionDigest: bundle.policyDecisionDigest,
          recordedPolicyInputsArtifactDigest: bundle.policyBinding.recordedPolicyInputsArtifact
            .digest as `sha256:${string}`,
        },
        resolvedDependencies: dependencies,
      },
      runDetails: { builder: { id: derivedBuilderId(bundle) } },
    },
  });
}

async function assertVerifiedAudit(
  bundle: VerificationAuditBundle,
  verifier: AuditBundleSignatureVerifier,
): Promise<void> {
  const inspection = await inspectAuditBundle(bundle, verifier);
  if (!inspection.valid || inspection.signatureStatus !== "verified") fail("DSSE_AUDIT_BUNDLE_SIGNATURE_REQUIRED");
}

export async function createVerificationDsseSlsaAttestation(input: {
  readonly auditBundle: VerificationAuditBundle;
  readonly auditBundleVerifier: AuditBundleSignatureVerifier;
  readonly signer: AuditBundleSigner;
  readonly trustedBinding: VerificationDsseTrustedBinding;
}): Promise<VerificationDsseSlsaAttestation> {
  const bundle = deepFreeze(clone(input.auditBundle));
  const trustedBinding = deepFreeze(clone(input.trustedBinding));
  const signer = {
    algorithm: input.signer.algorithm,
    keyId: input.signer.keyId,
    sign: input.signer.sign.bind(input.signer),
  };
  await assertVerifiedAudit(bundle, input.auditBundleVerifier);
  if (signer.algorithm !== "Ed25519") fail("DSSE_SIGNER_ALGORITHM_INVALID");
  const statement = statementFor(bundle);
  const builderId = statement.predicate.runDetails.builder.id;
  assertTrustedBinding(trustedBinding, builderId, signer.keyId);
  const payload = text.encode(canonicalizeJson(statement));
  if (payload.byteLength > MAX_PAYLOAD_BYTES) fail("DSSE_PAYLOAD_SIZE_INVALID");
  const signatureBase64 = await signer.sign(verificationDssePae(VERIFICATION_DSSE_PAYLOAD_TYPE, payload));
  const signature = decodeBase64(signatureBase64, 64, "DSSE_SIGNATURE_INVALID");
  if (signature.byteLength !== 64) fail("DSSE_SIGNATURE_INVALID");
  const envelope = deepFreeze<VerificationDsseEnvelope>({
    payloadType: VERIFICATION_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [{ keyid: signer.keyId, sig: signatureBase64 }],
  });
  return deepFreeze({
    envelope,
    statement,
    subjectDigest: bundle.seal.payloadDigest,
    signerKeyId: signer.keyId,
    builderId,
  });
}

function parseEnvelope(value: unknown): {
  readonly envelope: VerificationDsseEnvelope;
  readonly payload: Uint8Array;
  readonly signature: Uint8Array;
} {
  let raw: unknown;
  if (typeof value === "string" || value instanceof Uint8Array) {
    const bytes = typeof value === "string" ? text.encode(value) : value;
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) fail("DSSE_ENVELOPE_SIZE_INVALID");
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch {
      fail("DSSE_ENVELOPE_JSON_INVALID");
    }
  } else {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("DSSE_ENVELOPE_INVALID");
    let bytes: Uint8Array;
    try {
      bytes = text.encode(canonicalizeJson(value));
    } catch {
      fail("DSSE_ENVELOPE_JSON_INVALID");
    }
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) fail("DSSE_ENVELOPE_SIZE_INVALID");
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch {
      fail("DSSE_ENVELOPE_JSON_INVALID");
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("DSSE_ENVELOPE_INVALID");
  const envelope = raw as Record<string, unknown>;
  exactKeys(envelope, ["payload", "payloadType", "signatures"], "DSSE_ENVELOPE_FIELDS_INVALID");
  if (
    envelope.payloadType !== VERIFICATION_DSSE_PAYLOAD_TYPE ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1
  )
    fail("DSSE_ENVELOPE_INVALID");
  const candidate = envelope.signatures[0];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail("DSSE_SIGNATURE_INVALID");
  exactKeys(candidate as Record<string, unknown>, ["keyid", "sig"], "DSSE_SIGNATURE_FIELDS_INVALID");
  const keyid = publicIdentifier((candidate as Record<string, unknown>).keyid, "DSSE_KEY_ID_INVALID");
  const sig = (candidate as Record<string, unknown>).sig;
  const payload = decodeBase64(envelope.payload, MAX_PAYLOAD_BYTES, "DSSE_PAYLOAD_BASE64_INVALID");
  const signature = decodeBase64(sig, 64, "DSSE_SIGNATURE_INVALID");
  if (signature.byteLength !== 64) fail("DSSE_SIGNATURE_INVALID");
  return {
    envelope: deepFreeze({
      payloadType: VERIFICATION_DSSE_PAYLOAD_TYPE,
      payload: envelope.payload as string,
      signatures: [{ keyid, sig: sig as string }],
    }),
    payload,
    signature,
  };
}

function assertStatement(
  value: unknown,
  bundle: VerificationAuditBundle,
  binding: VerificationDsseTrustedBinding,
): VerificationDsseSlsaStatement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("DSSE_STATEMENT_INVALID");
  const statement = value as Record<string, unknown>;
  exactKeys(statement, ["_type", "predicate", "predicateType", "subject"], "DSSE_STATEMENT_FIELDS_INVALID");
  const expected = statementFor(bundle);
  if (canonicalizeJson(statement) !== canonicalizeJson(expected)) fail("DSSE_STATEMENT_BINDING_MISMATCH");
  assertTrustedBinding(binding, expected.predicate.runDetails.builder.id, binding.keyId);
  return expected;
}

export async function inspectVerificationDsseSlsaAttestation(input: {
  readonly auditBundle: VerificationAuditBundle;
  readonly auditBundleVerifier: AuditBundleSignatureVerifier;
  readonly envelope: unknown;
  readonly attestationVerifier: AuditBundleSignatureVerifier;
  readonly expectedBinding: VerificationDsseTrustedBinding;
}): Promise<VerificationDsseSlsaInspection> {
  try {
    const bundle = deepFreeze(clone(input.auditBundle));
    const envelopeInput = clone(input.envelope);
    const expectedBinding = deepFreeze(clone(input.expectedBinding));
    await assertVerifiedAudit(bundle, input.auditBundleVerifier);
    const parsed = parseEnvelope(envelopeInput);
    const keyId = parsed.envelope.signatures[0].keyid;
    const expected = statementFor(bundle);
    assertTrustedBinding(expectedBinding, expected.predicate.runDetails.builder.id, keyId);
    const validSignature = await input.attestationVerifier.verify({
      keyId,
      payload: verificationDssePae(parsed.envelope.payloadType, parsed.payload),
      signatureBase64: parsed.envelope.signatures[0].sig,
    });
    if (!validSignature) fail("DSSE_SIGNATURE_INVALID");
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(parsed.payload));
    } catch {
      fail("DSSE_PAYLOAD_JSON_INVALID");
    }
    const statement = assertStatement(value, bundle, expectedBinding);
    return deepFreeze({
      verified: true,
      payloadType: parsed.envelope.payloadType,
      predicateType: statement.predicateType,
      subjectDigest: bundle.seal.payloadDigest,
      signerKeyId: keyId,
      builderId: statement.predicate.runDetails.builder.id,
    });
  } catch (error) {
    const reason =
      error instanceof Error && /^DSSE_[A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : "DSSE_INSPECTION_INVALID";
    return deepFreeze({ verified: false, reason });
  }
}

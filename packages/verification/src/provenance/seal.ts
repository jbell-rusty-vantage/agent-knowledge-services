import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  VerificationBundleSchema,
  VerificationArtifactHandleSchema,
  VerificationRunManifestSchema,
  type VerificationBundle,
  type VerificationRunManifest,
} from "@aiengineer/knowledge-contracts";
import {
  ZERO_SHA256_DIGEST,
  canonicalizeJson,
  digestCanonicalJson,
  isSha256Digest,
  sha256Digest,
} from "../canonical/index.js";
import { VERIFICATION_CONTRACT_VERSION } from "../versions.js";
import type {
  AuditBundleInspection,
  AuditBundleSignatureVerifier,
  AuditBundleSigner,
  DetachedAuditSeal,
  VerificationAuditBundle,
  VerificationPolicyBinding,
} from "./model.js";
import { validateRecordedPolicyInputsArtifact } from "./policy-inputs.js";

const normalizeFieldName = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
const privateFieldNames = new Set([
  "secret",
  "password",
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "privatereasoning",
  "chainofthought",
  "hiddenreasoning",
]);
const publicTokenDiagnosticNames = new Set([
  "inputtokens",
  "outputtokens",
  "prompttokens",
  "completiontokens",
  "totaltokens",
  "cachedinputtokens",
  "reasoningtokens",
  "tokencount",
  "tokenusage",
]);

function isPrivateFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (publicTokenDiagnosticNames.has(normalized)) return false;
  return (
    privateFieldNames.has(normalized) ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("privatereasoning") ||
    normalized.endsWith("chainofthought") ||
    normalized.endsWith("hiddenreasoning")
  );
}

function assertPublicValue(value: unknown, path = "$", seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`PUBLIC_MANIFEST_CYCLE:${path}`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertPublicValue(item, `${path}[${index}]`, seen));
  else
    for (const [key, item] of Object.entries(value)) {
      if (isPrivateFieldName(key)) throw new Error(`PUBLIC_MANIFEST_PRIVATE_FIELD:${path}.${key}`);
      assertPublicValue(item, `${path}.${key}`, seen);
    }
  seen.delete(value);
}

/**
 * The manifest digest and detached signature reference this projection. The
 * projection deliberately excludes both fields, preventing a circular digest.
 */
export function verificationManifestSignablePayload(manifest: VerificationRunManifest): unknown {
  const { signatureArtifactId: _signatureArtifactId, canonicalization, ...body } = manifest;
  const { manifestDigest: _manifestDigest, ...canonicalizationDescriptor } = canonicalization;
  return { ...body, canonicalization: canonicalizationDescriptor };
}

export function verificationManifestDigest(manifest: VerificationRunManifest): `sha256:${string}` {
  return digestCanonicalJson(verificationManifestSignablePayload(manifest));
}

export function auditBundleSignablePayload(
  bundle: Omit<VerificationAuditBundle, "seal"> | VerificationAuditBundle,
): unknown {
  const { seal: _seal, ...payload } = bundle as VerificationAuditBundle;
  return payload;
}

type ArtifactHandle = VerificationRunManifest["inputArtifacts"][number];
type LineageEdge = VerificationRunManifest["lineage"][number];

/** Relations that assert a parent link, and therefore must agree with `parentArtifactIds`. */
const DERIVATION_RELATIONS: readonly string[] = ["derived_from", "generated", "quoted_from"];

function lineageHandles(bundle: VerificationAuditBundle): ArtifactHandle[] {
  return [
    ...bundle.manifest.inputArtifacts,
    ...bundle.manifest.outputArtifacts,
    bundle.policyBinding.policyArtifact,
    bundle.policyBinding.recordedPolicyInputsArtifact,
    ...bundle.verificationBundle.captures.flatMap((capture) => [
      capture.contentArtifact,
      ...(capture.canonicalProjectionArtifact ? [capture.canonicalProjectionArtifact] : []),
    ]),
  ];
}

/** Same id must mean the same handle everywhere, and every handle belongs to the bundle tenant. */
function indexHandles(handles: readonly ArtifactHandle[], tenantId: string): Map<string, ArtifactHandle> {
  const byId = new Map<string, ArtifactHandle>();
  for (const handle of handles) {
    const existing = byId.get(handle.artifactId);
    if (existing && digestCanonicalJson(existing) !== digestCanonicalJson(handle))
      throw new Error("ARTIFACT_IDENTITY_COLLISION");
    byId.set(handle.artifactId, handle);
    if (handle.tenantId !== tenantId) throw new Error(`ARTIFACT_TENANT_MISMATCH:${handle.artifactId}`);
  }
  return byId;
}

/** Every declared parent exists, is signed for, and is backed by a derivation edge. */
function assertParentsDeclared(
  handles: readonly ArtifactHandle[],
  byId: ReadonlyMap<string, ArtifactHandle>,
  lineage: readonly LineageEdge[],
): void {
  for (const handle of handles)
    for (const parentId of handle.parentArtifactIds) {
      if (!byId.has(parentId)) throw new Error(`LINEAGE_PARENT_MISSING:${handle.artifactId}:${parentId}`);
      if (!handle.transformationSignature)
        throw new Error(`LINEAGE_TRANSFORMATION_SIGNATURE_MISSING:${handle.artifactId}`);
      const backed = lineage.some(
        (edge) =>
          edge.fromArtifactId === handle.artifactId &&
          edge.toArtifactId === parentId &&
          DERIVATION_RELATIONS.includes(edge.relation),
      );
      if (!backed) throw new Error(`LINEAGE_EDGE_MISSING:${handle.artifactId}:${parentId}`);
    }
}

/** Every edge joins known handles, and derivation edges are mirrored by a parent declaration. */
function assertEdgesDeclared(lineage: readonly LineageEdge[], byId: ReadonlyMap<string, ArtifactHandle>): void {
  for (const edge of lineage) {
    const from = byId.get(edge.fromArtifactId);
    if (!from || !byId.has(edge.toArtifactId)) throw new Error(`LINEAGE_ENDPOINT_MISSING:${edge.edgeId}`);
    if (DERIVATION_RELATIONS.includes(edge.relation) && !from.parentArtifactIds.includes(edge.toArtifactId))
      throw new Error(`LINEAGE_PARENT_DECLARATION_MISSING:${edge.edgeId}`);
  }
}

function assertAcyclic(
  handles: readonly ArtifactHandle[],
  lineage: readonly LineageEdge[],
  byId: ReadonlyMap<string, ArtifactHandle>,
): void {
  const children = new Map<string, string[]>();
  const link = (from: string, to: string) => children.set(from, [...(children.get(from) ?? []), to]);
  for (const handle of handles) for (const parentId of handle.parentArtifactIds) link(handle.artifactId, parentId);
  for (const edge of lineage) link(edge.fromArtifactId, edge.toArtifactId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("LINEAGE_CYCLE");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function assertLineage(bundle: VerificationAuditBundle): void {
  const handles = lineageHandles(bundle);
  const byId = indexHandles(handles, bundle.tenantId);
  const { lineage } = bundle.manifest;
  assertParentsDeclared(handles, byId, lineage);
  assertEdgesDeclared(lineage, byId);
  assertAcyclic(handles, lineage, byId);
}

function assertExactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(code);
}

function assertAuditEnvelope(bundle: VerificationAuditBundle): void {
  assertExactKeys(
    bundle,
    [
      "verificationContractVersion",
      "tenantId",
      "verificationBundle",
      "manifest",
      "policyBinding",
      "deterministicResultDigest",
      "policyDecisionDigest",
      "seal",
    ],
    "AUDIT_BUNDLE_FIELDS_INVALID",
  );
  assertExactKeys(
    bundle.policyBinding,
    ["policyVersion", "policyArtifact", "recordedPolicyInputsArtifact"],
    "POLICY_BINDING_FIELDS_INVALID",
  );
  const sealKeys = [
    "payloadDigest",
    ...(bundle.seal.signatureAlgorithm === undefined ? [] : ["signatureAlgorithm"]),
    ...(bundle.seal.keyId === undefined ? [] : ["keyId"]),
    ...(bundle.seal.signatureBase64 === undefined ? [] : ["signatureBase64"]),
  ];
  assertExactKeys(bundle.seal, sealKeys, "AUDIT_SEAL_FIELDS_INVALID");
  if (bundle.verificationContractVersion !== VERIFICATION_CONTRACT_VERSION)
    throw new Error("AUDIT_BUNDLE_VERSION_INVALID");
  if (
    !isSha256Digest(bundle.deterministicResultDigest) ||
    !isSha256Digest(bundle.policyDecisionDigest) ||
    !isSha256Digest(bundle.seal.payloadDigest)
  )
    throw new Error("AUDIT_BUNDLE_DIGEST_INVALID");
  assertPolicyBindingConsistent(bundle.verificationBundle, bundle.manifest, bundle.policyBinding);
}

/**
 * One policy version across bundle, manifest and binding; both policy
 * artifacts present in the manifest under distinct identities.
 */
function assertPolicyBindingConsistent(
  bundle: Pick<VerificationBundle, "policyVersion">,
  manifest: VerificationRunManifest,
  binding: VerificationPolicyBinding,
): void {
  if (bundle.policyVersion !== binding.policyVersion || manifest.versions.policy !== binding.policyVersion)
    throw new Error("POLICY_VERSION_BINDING_MISMATCH");
  const declared = [...manifest.inputArtifacts, ...manifest.outputArtifacts];
  const declares = (handle: ArtifactHandle) =>
    declared.some((artifact) => digestCanonicalJson(artifact) === digestCanonicalJson(handle));
  if (!declares(binding.policyArtifact)) throw new Error("POLICY_ARTIFACT_NOT_IN_MANIFEST");
  if (!declares(binding.recordedPolicyInputsArtifact)) throw new Error("POLICY_INPUTS_ARTIFACT_NOT_IN_MANIFEST");
  if (binding.policyArtifact.artifactId === binding.recordedPolicyInputsArtifact.artifactId)
    throw new Error("POLICY_ARTIFACT_ROLES_NOT_DISTINCT");
}

export async function sealAuditBundle(input: {
  readonly tenantId: string;
  readonly verificationBundle: unknown;
  readonly manifest: unknown;
  readonly policyBinding: VerificationPolicyBinding;
  readonly recordedPolicyInputsBytes: Uint8Array;
  readonly policyDecision: unknown;
  readonly signer?: AuditBundleSigner;
}): Promise<VerificationAuditBundle> {
  const verificationBundle = VerificationBundleSchema.parse(input.verificationBundle);
  const manifest = VerificationRunManifestSchema.parse(input.manifest);
  const policyBinding = {
    policyVersion: String(input.policyBinding.policyVersion),
    policyArtifact: VerificationArtifactHandleSchema.parse(input.policyBinding.policyArtifact),
    recordedPolicyInputsArtifact: VerificationArtifactHandleSchema.parse(
      input.policyBinding.recordedPolicyInputsArtifact,
    ),
  };
  assertExactKeys(
    input.policyBinding,
    ["policyVersion", "policyArtifact", "recordedPolicyInputsArtifact"],
    "POLICY_BINDING_FIELDS_INVALID",
  );
  assertPolicyBindingConsistent(verificationBundle, manifest, policyBinding);
  if (verificationManifestDigest(manifest) !== manifest.canonicalization.manifestDigest)
    throw new Error("MANIFEST_DIGEST_MISMATCH");
  validateRecordedPolicyInputsArtifact({
    handle: policyBinding.recordedPolicyInputsArtifact,
    bytes: input.recordedPolicyInputsBytes,
    bundle: verificationBundle,
    deterministicResult: manifest.deterministicResult,
    runId: manifest.runId,
    policyVersion: policyBinding.policyVersion,
  });
  const deterministicResultDigest = digestCanonicalJson(manifest.deterministicResult);
  const policyDecisionDigest = digestCanonicalJson(input.policyDecision);
  const unsigned = {
    verificationContractVersion: VERIFICATION_CONTRACT_VERSION,
    tenantId: input.tenantId,
    verificationBundle,
    manifest,
    policyBinding,
    deterministicResultDigest,
    policyDecisionDigest,
  };
  if (
    verificationBundle.captures.some(
      (capture) =>
        capture.contentArtifact.tenantId !== input.tenantId ||
        (capture.canonicalProjectionArtifact !== undefined &&
          capture.canonicalProjectionArtifact.tenantId !== input.tenantId),
    )
  ) {
    throw new Error("CAPTURE_ARTIFACT_TENANT_MISMATCH");
  }
  assertPublicValue(unsigned);
  const candidate = {
    ...unsigned,
    seal: { payloadDigest: ZERO_SHA256_DIGEST } as DetachedAuditSeal,
  };
  assertLineage(candidate);
  const payload = new TextEncoder().encode(
    canonicalizeJson(auditBundleSignablePayload(unsigned as VerificationAuditBundle)),
  );
  const payloadDigest = sha256Digest(payload);
  const seal: DetachedAuditSeal = input.signer
    ? {
        payloadDigest,
        signatureAlgorithm: input.signer.algorithm,
        keyId: input.signer.keyId,
        signatureBase64: await input.signer.sign(payload),
      }
    : { payloadDigest };
  return { ...unsigned, seal };
}

export async function inspectAuditBundle(
  bundle: VerificationAuditBundle,
  verifier?: AuditBundleSignatureVerifier,
): Promise<AuditBundleInspection> {
  const errors: string[] = [];
  let manifestDigest: `sha256:${string}` = ZERO_SHA256_DIGEST;
  let payloadDigest: `sha256:${string}` = ZERO_SHA256_DIGEST;
  try {
    assertAuditEnvelope(bundle);
    VerificationBundleSchema.parse(bundle.verificationBundle);
    VerificationRunManifestSchema.parse(bundle.manifest);
    assertPublicValue(auditBundleSignablePayload(bundle));
    assertLineage(bundle);
    manifestDigest = verificationManifestDigest(bundle.manifest);
    if (manifestDigest !== bundle.manifest.canonicalization.manifestDigest) errors.push("MANIFEST_DIGEST_MISMATCH");
    if (digestCanonicalJson(bundle.manifest.deterministicResult) !== bundle.deterministicResultDigest)
      errors.push("DETERMINISTIC_RESULT_DIGEST_MISMATCH");
    const payload = new TextEncoder().encode(canonicalizeJson(auditBundleSignablePayload(bundle)));
    payloadDigest = sha256Digest(payload);
    if (payloadDigest !== bundle.seal.payloadDigest) errors.push("AUDIT_BUNDLE_DIGEST_MISMATCH");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "INVALID_AUDIT_BUNDLE");
  }
  const seal = await inspectSeal(bundle, verifier);
  for (const code of seal.errors) if (!errors.includes(code)) errors.push(code);
  return {
    valid: errors.length === 0,
    payloadDigest,
    manifestDigest,
    signatureStatus: seal.signatureStatus,
    errors,
  };
}

interface SealInspection {
  readonly signatureStatus: AuditBundleInspection["signatureStatus"];
  readonly errors: readonly string[];
}

const sealInspection = (signatureStatus: SealInspection["signatureStatus"], ...errors: string[]): SealInspection => ({
  signatureStatus,
  errors,
});

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SIGNATURE_BYTES = 64;

interface SignedSeal extends DetachedAuditSeal {
  readonly keyId: string;
  readonly signatureBase64: string;
}

const isSignedSeal = (seal: DetachedAuditSeal): seal is SignedSeal =>
  seal.signatureAlgorithm === "Ed25519" && Boolean(seal.keyId) && Boolean(seal.signatureBase64);

const isPartiallySigned = (seal: DetachedAuditSeal): boolean =>
  Boolean(seal.signatureAlgorithm || seal.keyId || seal.signatureBase64);

const isWellFormedSignature = (signatureBase64: string): boolean =>
  BASE64.test(signatureBase64) && Buffer.from(signatureBase64, "base64").byteLength === ED25519_SIGNATURE_BYTES;

/** A verifier that throws is treated as a failed verification, never as a crash. */
async function verifySealSignature(
  bundle: VerificationAuditBundle,
  seal: SignedSeal,
  verifier: AuditBundleSignatureVerifier,
): Promise<boolean> {
  try {
    return await verifier.verify({
      keyId: seal.keyId,
      payload: new TextEncoder().encode(canonicalizeJson(auditBundleSignablePayload(bundle))),
      signatureBase64: seal.signatureBase64,
    });
  } catch {
    return false;
  }
}

/** Unsigned seals are valid; partially signed or malformed ones are not. */
async function inspectSeal(
  bundle: VerificationAuditBundle,
  verifier: AuditBundleSignatureVerifier | undefined,
): Promise<SealInspection> {
  try {
    const seal =
      bundle !== null && typeof bundle === "object" && bundle.seal !== null && typeof bundle.seal === "object"
        ? bundle.seal
        : undefined;
    if (!seal) return sealInspection("invalid", "AUDIT_SEAL_FIELDS_INVALID");
    if (!isSignedSeal(seal))
      return isPartiallySigned(seal)
        ? sealInspection("invalid", "AUDIT_BUNDLE_SIGNATURE_INCOMPLETE")
        : sealInspection("unsigned");
    if (!isWellFormedSignature(seal.signatureBase64))
      return sealInspection("invalid", "AUDIT_BUNDLE_SIGNATURE_INVALID");
    if (!verifier) return sealInspection("unverified");
    return (await verifySealSignature(bundle, seal, verifier))
      ? sealInspection("verified")
      : sealInspection("invalid", "AUDIT_BUNDLE_SIGNATURE_INVALID");
  } catch {
    return sealInspection("invalid", "AUDIT_BUNDLE_SIGNATURE_INVALID");
  }
}

export function createEd25519Signer(privateKeyPem: string, keyId: string): AuditBundleSigner {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("ED25519_PRIVATE_KEY_REQUIRED");
  return {
    algorithm: "Ed25519",
    keyId,
    async sign(payload) {
      return sign(null, payload, key).toString("base64");
    },
  };
}

export function createEd25519Verifier(publicKeys: Readonly<Record<string, string>>): AuditBundleSignatureVerifier {
  const keys = new Map(Object.entries(publicKeys).map(([id, pem]) => [id, createPublicKey(pem)]));
  return {
    async verify(input) {
      const key = keys.get(input.keyId);
      return (
        key?.asymmetricKeyType === "ed25519" &&
        verify(null, input.payload, key, Buffer.from(input.signatureBase64, "base64"))
      );
    },
  };
}

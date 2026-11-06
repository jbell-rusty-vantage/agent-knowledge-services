import { lstat, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEd25519Signer,
  createEd25519Verifier,
  createVerificationDsseSlsaAttestation,
  inspectVerificationDsseSlsaAttestation,
  type VerificationAuditBundle,
  type VerificationDsseTrustedBinding,
} from "@aiengineer/knowledge-verification";

const MAX_AUDIT_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const MAX_TRUST_FILE_BYTES = 128 * 1024;
const MAX_KEY_COUNT = 32;

export const VERIFICATION_ATTESTATION_SIGNING_KEY_ENV = "KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM";

export class VerificationAttestationCliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface VerificationAttestationCliResult {
  readonly exitCode: 0 | 1;
  readonly output: Readonly<Record<string, unknown>>;
}
type LocalInputs = {
  readonly auditBundle: VerificationAuditBundle;
  readonly verifier: ReturnType<typeof createEd25519Verifier>;
  readonly binding: VerificationDsseTrustedBinding;
};
function fail(code: string): never {
  throw new VerificationAttestationCliError(code);
}
function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}
function string(value: unknown, code: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    fail(code);
  return value;
}
function validatePem(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 * 1024 || value.includes("\u0000")) fail(code);
  return value;
}
function parseArgs(args: readonly string[], action: "export" | "inspect"): Readonly<Record<string, string>> {
  if (args[0] !== "attestation" || args[1] !== action) fail("ATTESTATION_COMMAND_INVALID");
  const required =
    action === "export"
      ? ["--audit-bundle", "--trusted-public-keys", "--trusted-binding", "--output"]
      : ["--audit-bundle", "--trusted-public-keys", "--trusted-binding", "--attestation"];
  const allowed = new Set(required),
    values: Record<string, string> = {};
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || !allowed.has(flag)) fail("ATTESTATION_ARGUMENT_UNKNOWN");
    if (Object.hasOwn(values, flag)) fail("ATTESTATION_ARGUMENT_DUPLICATE");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail("ATTESTATION_ARGUMENT_VALUE_REQUIRED");
    values[flag] = value;
    index += 1;
  }
  for (const flag of required) if (!values[flag]) fail("ATTESTATION_ARGUMENT_REQUIRED");
  return values;
}
async function readLocalJson(pathValue: string, maxBytes: number): Promise<unknown> {
  const path = resolve(pathValue);
  let pathMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    pathMetadata = await lstat(path);
  } catch {
    fail("ATTESTATION_INPUT_UNREADABLE");
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) fail("ATTESTATION_INPUT_SIZE_INVALID");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    fail("ATTESTATION_INPUT_UNREADABLE");
  }
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maxBytes ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino
    )
      fail("ATTESTATION_INPUT_SIZE_INVALID");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      read.bytesRead !== before.size ||
      read.bytesRead > maxBytes
    )
      fail("ATTESTATION_INPUT_SIZE_INVALID");
    bytes = buffer.subarray(0, read.bytesRead);
  } catch (error) {
    if (error instanceof VerificationAttestationCliError) throw error;
    fail("ATTESTATION_INPUT_UNREADABLE");
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("ATTESTATION_INPUT_JSON_INVALID");
  }
}
async function loadInputs(flags: Readonly<Record<string, string>>): Promise<LocalInputs> {
  const [auditBundle, publicKeysRaw, bindingRaw] = await Promise.all([
    readLocalJson(flags["--audit-bundle"]!, MAX_AUDIT_BUNDLE_BYTES),
    readLocalJson(flags["--trusted-public-keys"]!, MAX_TRUST_FILE_BYTES),
    readLocalJson(flags["--trusted-binding"]!, MAX_TRUST_FILE_BYTES),
  ]);
  const publicKeys = object(publicKeysRaw, "ATTESTATION_TRUSTED_PUBLIC_KEYS_INVALID");
  const entries = Object.entries(publicKeys);
  if (entries.length < 1 || entries.length > MAX_KEY_COUNT) fail("ATTESTATION_TRUSTED_PUBLIC_KEYS_INVALID");
  for (const [keyId, pem] of entries) {
    string(keyId, "ATTESTATION_TRUSTED_PUBLIC_KEYS_INVALID", 120);
    validatePem(pem, "ATTESTATION_TRUSTED_PUBLIC_KEYS_INVALID");
  }
  const bindingValue = object(bindingRaw, "ATTESTATION_TRUSTED_BINDING_INVALID");
  exactKeys(bindingValue, ["builderId", "keyId"], "ATTESTATION_TRUSTED_BINDING_INVALID");
  const binding: VerificationDsseTrustedBinding = {
    builderId: string(bindingValue.builderId, "ATTESTATION_TRUSTED_BINDING_INVALID"),
    keyId: string(bindingValue.keyId, "ATTESTATION_TRUSTED_BINDING_INVALID", 120),
  };
  try {
    return {
      auditBundle: auditBundle as VerificationAuditBundle,
      verifier: createEd25519Verifier(publicKeys as Record<string, string>),
      binding,
    };
  } catch {
    fail("ATTESTATION_TRUSTED_PUBLIC_KEYS_INVALID");
  }
}
async function assertOutputAbsent(pathValue: string): Promise<string> {
  const path = resolve(pathValue);
  try {
    await lstat(path);
    fail("ATTESTATION_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof VerificationAttestationCliError) throw error;
  }
  return path;
}
async function writeExclusive(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(value) + "\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("ATTESTATION_OUTPUT_EXISTS");
    fail("ATTESTATION_OUTPUT_WRITE_FAILED");
  }
}
function stableCoreError(error: unknown, fallback: string): never {
  if (error instanceof VerificationAttestationCliError) throw error;
  if (error instanceof Error && /^(?:DSSE|ED25519)_[A-Z0-9_]+$/.test(error.message)) fail(error.message);
  fail(fallback);
}
export async function runVerificationAttestationExport(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VerificationAttestationCliResult> {
  const flags = parseArgs(args, "export");
  const [inputs, outputPath] = await Promise.all([loadInputs(flags), assertOutputAbsent(flags["--output"]!)]);
  const privateKey = environment[VERIFICATION_ATTESTATION_SIGNING_KEY_ENV];
  if (!privateKey) fail("ATTESTATION_SIGNING_KEY_REQUIRED");
  let signer: ReturnType<typeof createEd25519Signer>;
  try {
    signer = createEd25519Signer(privateKey, inputs.binding.keyId);
  } catch {
    fail("ATTESTATION_SIGNING_KEY_INVALID");
  }
  let result: Awaited<ReturnType<typeof createVerificationDsseSlsaAttestation>>;
  try {
    result = await createVerificationDsseSlsaAttestation({
      auditBundle: inputs.auditBundle,
      auditBundleVerifier: inputs.verifier,
      signer,
      trustedBinding: inputs.binding,
    });
  } catch (error) {
    stableCoreError(error, "ATTESTATION_EXPORT_FAILED");
  }
  const createdInspection = await inspectVerificationDsseSlsaAttestation({
    auditBundle: inputs.auditBundle,
    auditBundleVerifier: inputs.verifier,
    envelope: result.envelope,
    attestationVerifier: inputs.verifier,
    expectedBinding: inputs.binding,
  });
  if (!createdInspection.verified) fail("ATTESTATION_SIGNING_KEY_UNTRUSTED");
  const metadata = {
    schemaVersion: "verification-attestation-cli.v1",
    subjectDigest: result.subjectDigest,
    signerKeyId: result.signerKeyId,
    builderId: result.builderId,
    payloadType: result.envelope.payloadType,
    predicateType: result.statement.predicateType,
  };
  await writeExclusive(outputPath, result.envelope);
  return { exitCode: 0, output: { command: "verify attestation export", envelopePath: outputPath, ...metadata } };
}
export async function runVerificationAttestationInspect(
  args: readonly string[],
): Promise<VerificationAttestationCliResult> {
  const flags = parseArgs(args, "inspect");
  const inputs = await loadInputs(flags);
  const envelope = await readLocalJson(flags["--attestation"]!, MAX_ENVELOPE_BYTES);
  let inspection: Awaited<ReturnType<typeof inspectVerificationDsseSlsaAttestation>>;
  try {
    inspection = await inspectVerificationDsseSlsaAttestation({
      auditBundle: inputs.auditBundle,
      auditBundleVerifier: inputs.verifier,
      envelope,
      attestationVerifier: inputs.verifier,
      expectedBinding: inputs.binding,
    });
  } catch (error) {
    stableCoreError(error, "ATTESTATION_INSPECTION_FAILED");
  }
  return { exitCode: inspection.verified ? 0 : 1, output: { command: "verify attestation inspect", ...inspection } };
}
export function isVerificationAttestationCliError(error: unknown): error is VerificationAttestationCliError {
  return error instanceof VerificationAttestationCliError;
}

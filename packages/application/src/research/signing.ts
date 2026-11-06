import { type KeyObject, createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Digest } from "@aiengineer/knowledge-operation-protocol";
import {
  SEAL_ALGORITHM,
  type Seal,
  SealSchema,
  type SealSigner,
  type SealVerification,
  type SealVerifier,
  sealSigningBytes,
} from "@aiengineer/knowledge-research-core";

/**
 * K07 seal signing (design §6): Node `crypto` Ed25519 over `sealSigningBytes` (canonical `{manifestDigest, signer,
 * signedAt, keyId}`). Private keys come from a PEM key file or the NAME of an environment variable holding the PEM;
 * key material is never logged, returned or embedded in an error message.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export class SealKeyError extends Error {
  readonly code = "SEAL_KEY_UNAVAILABLE" as const;
  constructor(message: string) {
    super(`SEAL_KEY_UNAVAILABLE: ${message}`);
    this.name = "SealKeyError";
  }
}

/**
 * OVE-169 W1 D25: the executor's seal key id is not pinned `active` in the installation's
 * `knowledge_verification.seal_signing_key` registry (`unregistered`: absent; `inactive`: retiring or revoked). The
 * key ceremony (`knowledge-db seal-key`, the root installers' `seal-key` step) registers its public half.
 */
export class SealKeyRegistryError extends Error {
  constructor(
    readonly code: "SEAL_KEY_UNREGISTERED" | "SEAL_KEY_INACTIVE",
    readonly keyId: string,
    readonly status: string | null = null,
  ) {
    super(
      code === "SEAL_KEY_UNREGISTERED"
        ? `SEAL_KEY_UNREGISTERED: seal key ${keyId} is not registered in knowledge_verification.seal_signing_key`
        : `SEAL_KEY_INACTIVE: seal key ${keyId} is ${status ?? "not active"}; register an active key under a new id`,
    );
    this.name = "SealKeyRegistryError";
  }
}

function ed25519Private(key: KeyObject): KeyObject {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new SealKeyError("not an Ed25519 private key");
  return key;
}

export class Ed25519SealSigner implements SealSigner {
  private constructor(
    readonly keyId: string,
    private readonly privateKey: KeyObject,
  ) {}

  /** A PEM (PKCS#8) private key. */
  static fromPem(keyId: string, pem: string): Ed25519SealSigner {
    try {
      return new Ed25519SealSigner(keyId, ed25519Private(createPrivateKey(pem)));
    } catch (error) {
      if (error instanceof SealKeyError) throw error;
      throw new SealKeyError("the PEM does not hold an Ed25519 private key");
    }
  }

  static fromKeyFile(keyId: string, path: string): Ed25519SealSigner {
    let pem: string;
    try {
      pem = readFileSync(path, "utf8");
    } catch {
      throw new SealKeyError("the key file cannot be read");
    }
    return Ed25519SealSigner.fromPem(keyId, pem);
  }

  /** The PEM is held by the environment variable NAMED `variable` (the value is never printed). */
  static fromEnv(keyId: string, variable: string, env: NodeJS.ProcessEnv = process.env): Ed25519SealSigner {
    const pem = env[variable];
    if (pem === undefined || pem.trim() === "") throw new SealKeyError(`environment variable ${variable} is not set`);
    return Ed25519SealSigner.fromPem(keyId, pem);
  }

  /** Deterministic key from a 32-byte seed (tests and disposable fixtures only). */
  static fromSeed(keyId: string, seed: Uint8Array): Ed25519SealSigner {
    if (seed.byteLength !== 32) throw new SealKeyError("an Ed25519 seed is 32 bytes");
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
    return new Ed25519SealSigner(keyId, createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  }

  /** The raw 32-byte public key (what the installation pins in `seal_signing_key`). */
  publicKeyRaw(): Buffer {
    const spki = createPublicKey(this.privateKey).export({ format: "der", type: "spki" });
    return Buffer.from(spki.subarray(spki.length - 32));
  }

  async sign(manifestDigest: Digest, context: { readonly signer: string; readonly signedAt: string }): Promise<Seal> {
    const unsigned = { manifestDigest, signer: context.signer, signedAt: context.signedAt, keyId: this.keyId };
    const signature = sign(null, Buffer.from(sealSigningBytes(unsigned), "utf8"), this.privateKey);
    return SealSchema.parse({ ...unsigned, algorithm: SEAL_ALGORITHM, signature: base64url(signature) });
  }
}

export interface PinnedSealKey {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** `active` keys sign and verify; `retiring` keys verify existing seals only; `revoked` keys verify nothing. */
  readonly status: "active" | "retiring" | "revoked";
}

/** Verifies seals against pinned public keys by key id; unknown or revoked keys fail closed. */
export class StaticSealVerifier implements SealVerifier {
  private readonly keys = new Map<string, { key: KeyObject; status: PinnedSealKey["status"] }>();

  constructor(keys: readonly PinnedSealKey[]) {
    for (const pinned of keys) {
      if (pinned.publicKey.byteLength !== 32) throw new SealKeyError(`pinned key ${pinned.keyId} is not 32 bytes`);
      const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pinned.publicKey)]);
      this.keys.set(pinned.keyId, {
        key: createPublicKey({ key: der, format: "der", type: "spki" }),
        status: pinned.status,
      });
    }
  }

  verify(seal: Seal, recomputedManifestDigest: string): SealVerification {
    const parsed = SealSchema.safeParse(seal);
    if (!parsed.success || parsed.data.algorithm !== SEAL_ALGORITHM) {
      return { ok: false, code: "SEAL_INVALID", reason: "algorithm" };
    }
    if (parsed.data.manifestDigest !== recomputedManifestDigest) {
      return { ok: false, code: "SEAL_INVALID", reason: "digest_mismatch" };
    }
    const pinned = this.keys.get(parsed.data.keyId);
    if (pinned === undefined) return { ok: false, code: "SEAL_INVALID", reason: "unknown_key" };
    if (pinned.status === "revoked") return { ok: false, code: "SEAL_INVALID", reason: "retired_key" };
    const ok = verify(
      null,
      Buffer.from(sealSigningBytes(parsed.data), "utf8"),
      pinned.key,
      Buffer.from(parsed.data.signature, "base64url"),
    );
    return ok ? { ok: true } : { ok: false, code: "SEAL_INVALID", reason: "signature" };
  }

  /** Whether the key may sign new seals (only `active` keys). */
  canSign(keyId: string): boolean {
    return this.keys.get(keyId)?.status === "active";
  }
}

/** A deterministic signer + verifier pair for T0/T1 tests and disposable fixtures (never deployment keys). */
export function testSealKeys(
  keyId = "ks-test-seal-1",
  seedText = keyId,
): {
  signer: Ed25519SealSigner;
  verifier: StaticSealVerifier;
  publicKey: Buffer;
} {
  const seed = createHash("sha256").update(`sprint-v-test-seal:${seedText}`).digest();
  const signer = Ed25519SealSigner.fromSeed(keyId, seed);
  const publicKey = signer.publicKeyRaw();
  return { signer, verifier: new StaticSealVerifier([{ keyId, publicKey, status: "active" }]), publicKey };
}

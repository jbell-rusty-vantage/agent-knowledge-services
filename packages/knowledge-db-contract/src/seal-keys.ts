import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { InstallRefused } from "./installer.js";

/**
 * K07 seal-key registration for the installation-level `knowledge_verification.seal_signing_key` registry (OVE-169 W1
 * D25). The executor signs every run seal with its private key under `KS_KNOWLEDGE_SEAL_KEY_ID`; the component's
 * `seal_run` refuses a key id the registry does not pin as `active`. The root installers run this step (identity-gated,
 * database owner/administrator) so the registry pins the PUBLIC half of exactly that key.
 *
 * - The public key is derived from the executor's PKCS#8 PEM; the private key never leaves this function and nothing
 *   derived from it except the 32-byte public key (and its SHA-256, reported) is written or printed.
 * - Idempotent: the same key id with the same public key, algorithm and issuer is `current`; another key under the
 *   same id refuses `SEAL_KEY_CONFLICT`; a key id the registry already retired or revoked refuses `SEAL_KEY_NOT_ACTIVE`
 *   (the registry only retires; a retired id is never re-activated).
 * - `retire`: the named earlier keys move to `retiring` (they still verify old seals, sign nothing new); an unknown id
 *   refuses `SEAL_KEY_UNKNOWN`. `revoked` keys stay revoked.
 */
export interface SealKeyRegistration {
  readonly adminDsn: string;
  readonly keyId: string;
  readonly keyFile: string;
  /** The descriptor `signingIssuer` the executor reports (`KS_KNOWLEDGE_SEAL_ISSUER`, default `knowledge-services`). */
  readonly issuer?: string;
  readonly retire?: readonly string[];
}

export interface SealKeyReceipt {
  readonly status: "applied" | "current";
  readonly keyId: string;
  readonly issuer: string;
  readonly algorithm: "Ed25519";
  /** SHA-256 of the 32-byte public key (never the key, never anything private). */
  readonly publicKeySha256: string;
  readonly registered: boolean;
  readonly retired: readonly { readonly keyId: string; readonly status: "applied" | "current" }[];
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const ISSUER = /^[a-z][a-z0-9_.-]{0,119}$/;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The raw 32-byte Ed25519 public key of a PKCS#8 PEM private key file (refuses anything else). */
export function sealPublicKey(keyFile: string): Buffer {
  let spki: Buffer;
  try {
    const key = createPrivateKey(readFileSync(keyFile));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    spki = createPublicKey(key).export({ format: "der", type: "spki" });
  } catch {
    throw new InstallRefused("SEAL_KEY_FILE_INVALID", `${keyFile} is not a readable Ed25519 PKCS#8 private key`);
  }
  if (spki.length !== 44 || !spki.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) {
    throw new InstallRefused("SEAL_KEY_FILE_INVALID", `${keyFile} is not an Ed25519 key`);
  }
  return spki.subarray(12);
}

export async function registerSealKey(input: SealKeyRegistration): Promise<SealKeyReceipt> {
  if (!KEY_ID.test(input.keyId)) throw new InstallRefused("SEAL_KEY_ID_INVALID", "the key id is not a K01 id");
  const issuer = input.issuer ?? "knowledge-services";
  if (!ISSUER.test(issuer)) throw new InstallRefused("SEAL_ISSUER_INVALID", "the issuer is not a K01 name");
  const retire = [...new Set(input.retire ?? [])];
  if (retire.includes(input.keyId))
    throw new InstallRefused("SEAL_KEY_RETIRE_ACTIVE", "the key being registered cannot retire");
  for (const id of retire)
    if (!KEY_ID.test(id)) throw new InstallRefused("SEAL_KEY_ID_INVALID", "a retired key id is not a K01 id");
  const publicKey = sealPublicKey(input.keyFile);
  const client = new Client({ connectionString: input.adminDsn, application_name: "knowledge-db-seal-key" });
  await client.connect();
  try {
    await client.query("begin");
    const table = await client.query<{ present: boolean }>(
      "select to_regclass('knowledge_verification.seal_signing_key') is not null as present",
    );
    if (!table.rows[0]?.present) {
      throw new InstallRefused(
        "COMPONENT_MISSING",
        "knowledge_verification.seal_signing_key is not installed (component >= 2.2.0)",
      );
    }
    // Insert-first: a concurrent first registration of the same id waits on the other transaction, inserts nothing,
    // and then compares the committed row (current or SEAL_KEY_CONFLICT), never a unique-violation error.
    const inserted = await client.query(
      "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ($1, 'Ed25519', $2, $3) on conflict (key_id) do nothing returning key_id",
      [input.keyId, publicKey, issuer],
    );
    const registered = (inserted.rowCount ?? 0) === 1;
    if (!registered) {
      const stored = (
        await client.query<{ algorithm: string; public_key: Buffer; issuer: string; status: string }>(
          "select algorithm, public_key, issuer, status from knowledge_verification.seal_signing_key where key_id = $1 for update",
          [input.keyId],
        )
      ).rows[0];
      if (stored === undefined) throw new Error(`${input.keyId}: registry row vanished after an insert conflict`);
      if (
        stored.algorithm !== "Ed25519" ||
        !Buffer.from(stored.public_key).equals(publicKey) ||
        stored.issuer !== issuer
      ) {
        throw new InstallRefused("SEAL_KEY_CONFLICT", `${input.keyId} is pinned to another key or issuer`);
      }
      if (stored.status !== "active") {
        throw new InstallRefused(
          "SEAL_KEY_NOT_ACTIVE",
          `${input.keyId} is ${stored.status}; register the new key under a new id`,
        );
      }
    }
    const retired: { keyId: string; status: "applied" | "current" }[] = [];
    for (const id of retire) {
      const prior = (
        await client.query<{ status: string }>(
          "select status from knowledge_verification.seal_signing_key where key_id = $1 for update",
          [id],
        )
      ).rows[0];
      if (prior === undefined) throw new InstallRefused("SEAL_KEY_UNKNOWN", `${id} is not in the registry`);
      if (prior.status === "active") {
        await client.query("update knowledge_verification.seal_signing_key set status = 'retiring' where key_id = $1", [
          id,
        ]);
        retired.push({ keyId: id, status: "applied" });
      } else {
        retired.push({ keyId: id, status: "current" });
      }
    }
    await client.query("commit");
    return {
      status: registered || retired.some((item) => item.status === "applied") ? "applied" : "current",
      keyId: input.keyId,
      issuer,
      algorithm: "Ed25519",
      publicKeySha256: `sha256:${createHash("sha256").update(publicKey).digest("hex")}`,
      registered,
      retired,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

import { Client } from "pg";

/**
 * K07 key ceremony for the installation-level `knowledge_verification.seal_signing_key` registry (component 2.2.0).
 * The registry is written by the database owner/administrator only (capability roles may read it); the binding's
 * `SealVerifier` must pin the same public key under the same key id. Never pass private key material here.
 */
export interface SealSigningKeyRegistration {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  readonly issuer?: string;
}

export async function pinSealSigningKey(adminDsn: string, key: SealSigningKeyRegistration): Promise<void> {
  if (key.publicKey.byteLength !== 32) throw new Error("SEAL_KEY_INVALID: an Ed25519 public key is 32 bytes");
  const client = new Client({ connectionString: adminDsn });
  await client.connect();
  try {
    const existing = await client.query<{ public_key: Buffer }>(
      "select public_key from knowledge_verification.seal_signing_key where key_id = $1",
      [key.keyId],
    );
    const stored = existing.rows[0];
    if (stored) {
      if (!Buffer.from(stored.public_key).equals(Buffer.from(key.publicKey))) {
        throw new Error(`SEAL_KEY_CONFLICT: ${key.keyId} is pinned to another public key`);
      }
      return;
    }
    await client.query(
      "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ($1, 'Ed25519', $2, $3)",
      [key.keyId, Buffer.from(key.publicKey), key.issuer ?? "knowledge-services"],
    );
  } finally {
    await client.end();
  }
}

/** Retire (still verifies old seals, signs nothing new) or revoke (verifies nothing) a pinned key. */
export async function setSealSigningKeyStatus(
  adminDsn: string,
  keyId: string,
  status: "retiring" | "revoked",
): Promise<void> {
  const client = new Client({ connectionString: adminDsn });
  await client.connect();
  try {
    await client.query("update knowledge_verification.seal_signing_key set status = $2 where key_id = $1", [
      keyId,
      status,
    ]);
  } finally {
    await client.end();
  }
}

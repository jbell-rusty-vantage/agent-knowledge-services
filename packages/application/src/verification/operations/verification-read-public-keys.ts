import { createPublicKey } from "node:crypto";
import { z } from "zod";

const READ_PUBLIC_KEYS_MAX_BYTES = 131_072;
const PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";
const PEM_END = "-----END PUBLIC KEY-----";

const PublicKeysSchema = z
  .array(
    z.strictObject({
      keyId: z.string().trim().min(1).max(255),
      publicKeyPem: z.string().trim().min(1).max(4096),
    }),
  )
  .min(1)
  .max(32);

function isPemPublicKey(value: string): boolean {
  return value.startsWith(PEM_BEGIN) && value.endsWith(PEM_END);
}

function normalizeEd25519PublicKey(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("INVALID_KEY_ALGORITHM");
  return key.export({ type: "spki", format: "pem" }).toString();
}

function indexTrustedPublicKeys(
  rows: readonly { readonly keyId: string; readonly publicKeyPem: string }[],
): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const row of rows) {
    if (Object.hasOwn(result, row.keyId) || !isPemPublicKey(row.publicKeyPem)) throw new Error("INVALID_PUBLIC_KEY");
    result[row.keyId] = normalizeEd25519PublicKey(row.publicKeyPem);
  }
  return result;
}

/** Only operator-configured public keys establish signing trust for reads. */
export function parseBenchmarkReadPublicKeys(raw: string): Readonly<Record<string, string>> {
  try {
    if (Buffer.byteLength(raw, "utf8") > READ_PUBLIC_KEYS_MAX_BYTES) throw new Error("KEYRING_TOO_LARGE");
    const rows = PublicKeysSchema.parse(JSON.parse(raw));
    return Object.freeze(indexTrustedPublicKeys(rows));
  } catch {
    throw new Error("INVALID_VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS");
  }
}

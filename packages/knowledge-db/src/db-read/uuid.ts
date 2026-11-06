import { randomBytes } from "node:crypto";

/** RFC 9562 UUIDv7: 48-bit unix milliseconds, version nibble, 74 random bits. Executor-assigned identifiers use this. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let index = 0; index < 6; index += 1) bytes[index] = Number((ms >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

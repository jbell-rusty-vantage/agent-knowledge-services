// Profiles name the tokenizer by version so token bounds and receipts stay
// comparable across runs; a different rule is a new version, never an edit.
export const TOKENIZER_VERSION = "unicode-word-punctuation-v1" as const;

export const TOKEN_PATTERN = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

export function tokenize(text: string): readonly string[] {
  return text.normalize("NFC").match(TOKEN_PATTERN) ?? [];
}

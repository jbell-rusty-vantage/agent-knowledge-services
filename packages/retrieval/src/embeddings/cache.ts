import type { EmbeddingCache } from "./types.js";

export class MemoryEmbeddingCache implements EmbeddingCache {
  readonly #items = new Map<string, readonly number[]>();

  get(key: string) {
    return this.#items.get(key);
  }

  set(key: string, value: readonly number[]) {
    this.#items.set(key, Object.freeze([...value]));
  }
}

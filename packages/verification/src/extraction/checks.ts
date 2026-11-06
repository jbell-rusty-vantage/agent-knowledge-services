import { evaluateJsonPointer, isJsonPointerSyntax } from "../evidence-selection/json-pointer.js";
import type { ExtractionVerificationCheck } from "./field-rules.js";

/** Ordered collector of extraction checks; a result is valid only when every check passed. */
export class ExtractionChecks {
  readonly #items: ExtractionVerificationCheck[] = [];

  get items(): ExtractionVerificationCheck[] {
    return this.#items;
  }

  get allPassed(): boolean {
    return this.#items.every((item) => item.status === "passed");
  }

  record(code: string, path: string, passed: boolean, detail: string): this {
    this.#items.push({
      code,
      path,
      status: passed ? "passed" : "failed",
      detail,
    });
    return this;
  }

  fail(code: string, path: string, detail: string): this {
    return this.record(code, path, false, detail);
  }
}

const MAX_POINTER_LENGTH = 4_096;
const MAX_POINTER_DEPTH = 64;
const pointerDepth = (path: string): number => path.split("/").length - 1;

/** RFC 6901 syntax plus this verifier's work bounds on pointer length and depth. */
export const isBoundedJsonPointer = (path: string): boolean =>
  path.length <= MAX_POINTER_LENGTH && pointerDepth(path) <= MAX_POINTER_DEPTH && isJsonPointerSyntax(path);

export interface PointerLookup {
  readonly found: boolean;
  readonly value?: unknown;
}

/** Pointer evaluation that treats an out-of-bounds pointer as not found rather than traversing it. */
export const getAtBoundedPointer = (value: unknown, path: string): PointerLookup =>
  isBoundedJsonPointer(path) ? evaluateJsonPointer(path, value) : { found: false };

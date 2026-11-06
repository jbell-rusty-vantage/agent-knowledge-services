/**
 * Every knowledge-executor failure carries a stable code and the exit-lattice
 * class it belongs to: 1 = domain outcome the agent can act on, 2 = infrastructure.
 */
export type ExitClass = 1 | 2;

export class KnowledgeError extends Error {
  override readonly name = "KnowledgeError";
  constructor(
    readonly code: string,
    message: string,
    readonly exit: ExitClass,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON(): { error: string; code: string; exit: ExitClass; details?: unknown } {
    return {
      error: this.message,
      code: this.code,
      exit: this.exit,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const domainError = (code: string, message: string, details?: unknown): KnowledgeError =>
  new KnowledgeError(code, message, 1, details);
export const infrastructureError = (code: string, message: string, details?: unknown): KnowledgeError =>
  new KnowledgeError(code, message, 2, details);

export function isKnowledgeError(error: unknown): error is KnowledgeError {
  return error instanceof KnowledgeError;
}

/**
 * Owns resources acquired during host construction. Releases them once, in reverse
 * acquisition order, attempting every release even when an earlier one fails.
 */
export class HostResources {
  readonly #releases: { readonly name: string; readonly release: () => Promise<void> | void }[] = [];
  #closing: Promise<void> | undefined;

  /** Registers a release for an already-acquired resource. Rejected after close starts. */
  own<T>(name: string, resource: T, release: (resource: T) => Promise<void> | void): T {
    if (this.#closing) throw new Error(`HOST_CLOSED:${name}`);
    this.#releases.push({ name, release: () => release(resource) });
    return resource;
  }

  get closed(): boolean {
    return this.#closing !== undefined;
  }

  /** Idempotent: concurrent and later callers await the same cleanup. */
  close(): Promise<void> {
    this.#closing ??= this.#releaseAll();
    return this.#closing;
  }

  async #releaseAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const { release } of [...this.#releases].reverse()) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "HOST_CLOSE_FAILED");
  }
}

/**
 * Runs construction with a fresh resource owner. A construction failure releases
 * everything acquired so far before rethrowing the original error.
 */
export async function constructWithResources<T>(
  construct: (resources: HostResources) => Promise<T> | T,
): Promise<{ readonly value: T; readonly resources: HostResources }> {
  const resources = new HostResources();
  try {
    return { value: await construct(resources), resources };
  } catch (error) {
    await resources.close().catch(() => undefined);
    throw error;
  }
}

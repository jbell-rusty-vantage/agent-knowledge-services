import { VectorBackendError } from "../types.js";
import type { ActivePublicationPointer, PublicationEvent } from "../spaces/version.js";
import type {
  ExploratoryPublication,
  PublicationRepository,
  PublicationTransaction,
  ReconciliationFinding,
  PublicationReconciliationReport,
} from "./types.js";

/** Serializable local repository. A failed callback commits no partial publication or pointer. */
export class InMemoryPublicationRepository implements PublicationRepository {
  #publications = new Map<string, ExploratoryPublication>();
  #pointers = new Map<string, ActivePublicationPointer>();
  #events: PublicationEvent[] = [];
  #tail: Promise<void> = Promise.resolve();

  async transaction<T>(operation: (transaction: PublicationTransaction) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const predecessor = this.#tail;
    this.#tail = predecessor.then(() => turn);
    await predecessor;
    const publications = new Map(this.#publications);
    const pointers = new Map(this.#pointers);
    const events = [...this.#events];
    const transaction = transactionView(publications, pointers, events);
    try {
      const result = await operation(transaction);
      this.#publications = publications;
      this.#pointers = pointers;
      this.#events = events;
      return result;
    } finally {
      release();
    }
  }

  async getPublication(tenantId: string, publicationId: string): Promise<ExploratoryPublication | undefined> {
    return this.#publications.get(publicationKey(tenantId, publicationId));
  }

  async getActivePointer(tenantId: string, vectorStoreSpaceId: string): Promise<ActivePublicationPointer | undefined> {
    return this.#pointers.get(pointerKey(tenantId, vectorStoreSpaceId));
  }

  async listEvents(tenantId: string, vectorStoreSpaceId: string): Promise<readonly PublicationEvent[]> {
    return Object.freeze(
      this.#events.filter((event) => event.tenantId === tenantId && event.vectorStoreSpaceId === vectorStoreSpaceId),
    );
  }
}

export function transactionView(
  publications: Map<string, ExploratoryPublication>,
  pointers: Map<string, ActivePublicationPointer>,
  events: PublicationEvent[],
): PublicationTransaction {
  return {
    getPublication: (tenantId, publicationId) => publications.get(publicationKey(tenantId, publicationId)),
    getActivePointer: (tenantId, vectorStoreSpaceId) => pointers.get(pointerKey(tenantId, vectorStoreSpaceId)),
    insertPublication: (publication) => {
      const key = publicationKey(publication.tenantId, publication.id);
      if (publications.has(key))
        throw new VectorBackendError("DUPLICATE_PUBLICATION", `Publication ${publication.id} already exists`);
      publications.set(key, publication);
    },
    setActivePointer: (pointer) => pointers.set(pointerKey(pointer.tenantId, pointer.vectorStoreSpaceId), pointer),
    appendEvent: (event) => {
      if (events.some((candidate) => candidate.tenantId === event.tenantId && candidate.id === event.id))
        throw new VectorBackendError("DUPLICATE_EVENT", `Event ${event.id} already exists`);
      events.push(event);
    },
  };
}

export function publicationKey(tenantId: string, publicationId: string): string {
  return `${tenantId}\u0000${publicationId}`;
}
export function pointerKey(tenantId: string, vectorStoreSpaceId: string): string {
  return `${tenantId}\u0000${vectorStoreSpaceId}`;
}
export function freezePublication(publication: ExploratoryPublication): ExploratoryPublication {
  return Object.freeze({
    ...publication,
    manifests: Object.freeze({ ...publication.manifests }),
  });
}
export function freezeReport(
  publicationId: string | undefined,
  findings: ReconciliationFinding[],
): PublicationReconciliationReport {
  return Object.freeze({
    healthy: findings.length === 0,
    ...(publicationId === undefined ? {} : { publicationId }),
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
  });
}

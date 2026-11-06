import type { DocumentNode, VectorSpace } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { ChunkProfile } from "../types.js";
import { CHUNK_PROFILE_TABLE } from "./definitions.js";

// Bounds are checked at admission, so a chunk run can trust the profile it was
// handed and a bad profile fails before any span is cut.
export function validateProfile(profile: ChunkProfile): void {
  if (
    profile.minimumTokens < 1 ||
    profile.targetTokens < profile.minimumTokens ||
    profile.maximumTokens < profile.targetTokens
  ) {
    throw new Error(`Invalid token bounds for ${profile.name}`);
  }
  if (profile.overlapTokens >= profile.maximumTokens)
    throw new Error(`Overlap must be below maximum tokens for ${profile.name}`);
  if (profile.maximumDuplicatedTokenRatio < 0 || profile.maximumDuplicatedTokenRatio > 1)
    throw new Error("Invalid duplicated-token ratio");
}

export class ChunkProfileRegistry {
  readonly #profiles = new Map<string, ChunkProfile>();

  constructor(initial: readonly ChunkProfile[] = CHUNK_PROFILE_TABLE.profiles) {
    for (const profile of initial) this.register(profile);
  }

  register(profile: ChunkProfile): void {
    validateProfile(profile);
    const key = profileKey(profile);
    if (this.#profiles.has(key)) throw new Error(`Chunk profile already registered: ${key}`);
    this.#profiles.set(key, deepFreeze({ ...profile, spaces: [...profile.spaces], nodeKinds: [...profile.nodeKinds] }));
  }

  get(name: string, version = "1.0.0"): ChunkProfile {
    const profile = this.#profiles.get(`${name}@${version}`);
    if (profile === undefined) throw new Error(`Unknown chunk profile: ${name}@${version}`);
    return profile;
  }

  forSpace(space: VectorSpace): readonly ChunkProfile[] {
    return [...this.#profiles.values()].filter(({ spaces }) => spaces.includes(space));
  }

  // The selection rule from "Select, do not invent": admitted for the space and
  // able to feed on at least one observed node kind. A pure read over the table;
  // no host path calls it yet (F8 wires it into preparation).
  forSpaceAndNodeKinds(space: VectorSpace, observedKinds: readonly DocumentNode["kind"][]): readonly ChunkProfile[] {
    const observed = new Set(observedKinds);
    return this.forSpace(space).filter(({ nodeKinds }) => nodeKinds.some((kind) => observed.has(kind)));
  }

  list(): readonly ChunkProfile[] {
    return [...this.#profiles.values()];
  }
}

export const defaultChunkProfileRegistry = new ChunkProfileRegistry();

function profileKey({ name, version }: ChunkProfile): string {
  return `${name}@${version}`;
}

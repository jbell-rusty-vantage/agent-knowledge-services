import type { PublicationInspection, PublicationInspector, PublicationManifests } from "../../src/index.js";

export const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
export const createdAt = "2026-09-03T12:00:00Z";

export const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

export const manifests: PublicationManifests = {
  source: digest("1"),
  representation: digest("2"),
  chunkSet: digest("3"),
  projection: digest("4"),
  vectorItem: digest("5"),
  embedding: digest("6"),
  index: digest("7"),
  retrievalPolicy: digest("8"),
  evaluation: digest("9"),
};

export const vector = (entries: Readonly<Record<number, number>>) => {
  const value = Array.from({ length: 1_536 }, () => 0);
  for (const [index, component] of Object.entries(entries)) value[Number(index)] = component;
  return value;
};

export function baseInspection(
  vectorSpaceVersionId: string,
  overrides: Partial<PublicationInspection> = {},
): PublicationInspection {
  return {
    vectorSpaceVersionId,
    itemCount: 2,
    dimensions: 1_536,
    precision: "halfvec",
    manifests,
    indexReady: true,
    authorizationPassed: true,
    evaluationPassed: true,
    sampleSearchPassed: true,
    ...overrides,
  };
}

/** Stands in for a real inspector, which would read the store the publication host just wrote. */
export class StubPublicationInspector implements PublicationInspector {
  readonly inspections = new Map<string, PublicationInspection>();
  async inspect(vectorSpaceVersionId: string): Promise<PublicationInspection> {
    const inspection = this.inspections.get(vectorSpaceVersionId);
    if (inspection === undefined) throw new Error(`no stub inspection for ${vectorSpaceVersionId}`);
    return inspection;
  }
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

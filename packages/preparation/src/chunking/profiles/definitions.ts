import {
  CHUNK_PROFILE_TABLE_SCHEMA_VERSION,
  ChunkProfileTableSchema,
  type ChunkProfileTable,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";

// One table, because the host selects from it, the skill teaches from it, and a
// receipt cites `name@version` into it. A strategy that is not here is not
// admitted, whatever splitter produced it.
//
// `nodeKinds` binds each profile to the sealed node kinds it was written for
// (docs/operations/conversion-and-chunking.md, "Select, do not invent"), so a
// selector can skip a profile the tree cannot feed instead of running the table
// profile over paragraphs. Transcript, code and table profiles bind exactly the
// kind their strategy already filters on; claims bind the prose kinds a sentence
// splitter can work with; entity and tool cards accept prose plus tables because
// capability matrices usually arrive as tables. `figure`, `formula` and
// `citation` are bound to no profile: nothing admitted today slices them.
const defaults = {
  version: "1.0.0",
  tokenizer: "unicode-word-punctuation-v1" as const,
  targetTokens: 220,
  minimumTokens: 1,
  maximumTokens: 360,
  overlapTokens: 24,
  maximumDuplicatedTokenRatio: 0.2,
  boilerplateOccurrences: 3,
  contextualHeadingPrefix: true,
};

export const CHUNK_PROFILE_TABLE: ChunkProfileTable = deepFreeze(
  ChunkProfileTableSchema.parse({
    schemaVersion: CHUNK_PROFILE_TABLE_SCHEMA_VERSION,
    profiles: [
      {
        ...defaults,
        name: "transcript-topics-v1",
        strategy: "transcripts",
        spaces: ["source_native_sections", "engineering_claims"],
        nodeKinds: ["transcript_segment"],
        targetTokens: 180,
        maximumTokens: 280,
      },
      {
        ...defaults,
        name: "heading-sections-v1",
        strategy: "headings",
        spaces: ["source_native_sections", "paper_case_study_knowledge"],
        nodeKinds: ["heading", "paragraph", "list"],
      },
      {
        ...defaults,
        name: "atomic-claims-v1",
        strategy: "claims",
        spaces: ["engineering_claims"],
        nodeKinds: ["paragraph", "list", "transcript_segment"],
        targetTokens: 80,
        maximumTokens: 160,
        overlapTokens: 0,
      },
      {
        ...defaults,
        name: "entity-facets-v1",
        strategy: "entities",
        spaces: ["entity_profiles"],
        nodeKinds: ["heading", "paragraph", "list", "table"],
        targetTokens: 120,
        maximumTokens: 220,
        overlapTokens: 0,
      },
      {
        ...defaults,
        name: "tool-capabilities-v1",
        strategy: "tools",
        spaces: ["tool_capabilities", "model_capabilities"],
        nodeKinds: ["heading", "paragraph", "list", "table"],
        targetTokens: 160,
        maximumTokens: 280,
      },
      {
        ...defaults,
        name: "code-symbols-v1",
        strategy: "code",
        spaces: ["implementation_examples"],
        nodeKinds: ["code_block"],
        targetTokens: 240,
        maximumTokens: 420,
        overlapTokens: 16,
      },
      {
        ...defaults,
        name: "table-row-groups-v1",
        strategy: "tables",
        spaces: ["benchmark_intelligence", "paper_case_study_knowledge"],
        nodeKinds: ["table"],
        targetTokens: 180,
        maximumTokens: 320,
        overlapTokens: 0,
      },
    ],
  } satisfies ChunkProfileTable),
);

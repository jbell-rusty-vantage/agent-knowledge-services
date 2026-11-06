import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes } from "@aiengineer/knowledge-core";
import { observeSealedCapture, readSealedCapture, searchSealedCapture } from "../src/index.js";
import { printJson } from "./helpers.js";

export async function runInspectBytesExample() {
  const bytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "notes.txt"));
  const digest = digestBytes(bytes);
  const excerpt = readSealedCapture({ bytes, digest, offset: 0, length: 40 });
  const search = searchSealedCapture({ bytes, digest, query: "Public operator note" });
  const observation = observeSealedCapture({
    bytes,
    digest,
    declaredMediaType: "text/plain",
    acquireObservations: [
      { key: "observed_media_type", value: "text/plain" },
      { key: "rights_context", value: "operator supplied fixture" },
    ],
  });
  printJson({
    digest,
    excerpt,
    search,
    secretClasses: observation.findings
      .filter((item) => item.dimension === "secret_class")
      .map((item) => ({ status: item.status, secretClass: item.secretClass, offset: item.offset })),
    findings: observation.findings.map((item) => item.dimension),
    mocked: false,
  });
  return { excerpt, search, observation };
}

if (process.argv[1]?.includes("03-inspect-bytes")) await runInspectBytesExample();

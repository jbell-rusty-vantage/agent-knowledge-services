import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes } from "@aiengineer/knowledge-core";
import { BoundedManualUploadAdapter } from "../src/index.js";
import { exampleRequest, exampleStore, printJson } from "./helpers.js";

export async function runUploadAcquireExample() {
  const bytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "notes.txt"));
  const adapter = new BoundedManualUploadAdapter(
    exampleStore(),
    {
      get: async () => ({
        uploadId: "notes",
        relativePath: "notes.txt",
        mediaType: "text/plain",
        bytes,
        declaredDigest: digestBytes(bytes),
        attestation: {
          uploadId: "notes",
          origin: "operator",
          method: "local file",
          acquiredAt: "2026-09-16T00:00:00Z",
          accessAndRightsContext: "operator supplied fixture",
          automaticFailureReason: "",
        },
      }),
    },
    { maximumBytes: 10_000, maximumPathLength: 80 },
  );
  const plan = await adapter.plan(exampleRequest({ kind: "upload", uploadId: "notes", declaredOrigin: "operator" }));
  const result = await adapter.execute({ ...plan, admissionId: "example-upload" });
  const verification = await adapter.verify(result);
  printJson({
    adapterKey: result.captureMethod,
    artifactCount: result.artifacts.length,
    digest: result.contentDigests[0],
    path: result.observations.find((item) => item.key === "path")?.value,
    rights: result.observations.find((item) => item.key === "rights_context")?.value,
    verification,
    mocked: false,
  });
  return { result, verification };
}

if (process.argv[1]?.includes("02-upload-acquire")) await runUploadAcquireExample();

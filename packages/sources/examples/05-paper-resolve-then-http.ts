import {
  ExactHttpAcquisitionAdapter,
  normalizePaperIdentifier,
  planPaperAsHttpRequest,
  type PaperResolution,
} from "../src/index.js";
import { examplePolicy, exampleRequest, exampleStore, printJson, publicResolver } from "./helpers.js";

export async function runPaperResolveThenHttpExample() {
  const identifier = normalizePaperIdentifier("doi", "https://doi.org/10.1234/ABC");
  const resolution: PaperResolution = {
    identifierKind: "doi",
    identifier,
    title: "Fixture paper",
    authors: ["Author"],
    revision: "v1",
    publicationState: "published",
    correctionState: "none",
    representations: [{ mediaType: "application/pdf", url: "https://papers.example/p.pdf" }],
  };
  const { target: _ignored, ...defaults } = exampleRequest({
    kind: "http",
    url: "https://example.com/unused",
  });
  const httpRequest = planPaperAsHttpRequest(resolution, defaults);
  const adapter = new ExactHttpAcquisitionAdapter(
    exampleStore(),
    examplePolicy,
    publicResolver,
    async () => new Response("%PDF-1.4 fixture", { headers: { "content-type": "application/pdf" } }),
  );
  const plan = await adapter.plan(httpRequest);
  const result = await adapter.execute({ ...plan, admissionId: "example-paper" });
  printJson({
    identifier,
    httpTarget: httpRequest.target,
    artifactCount: result.artifacts.length,
    captureMethod: result.captureMethod,
    usedPaperExecute: false,
    mockedProvider: true,
  });
  return { identifier, httpRequest, result };
}

if (process.argv[1]?.includes("05-paper-resolve-then-http")) await runPaperResolveThenHttpExample();

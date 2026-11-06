import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import {
  ConversionRouter,
  DeterministicTextConversionProvider,
  HttpDoclingServeClient,
  HttpUnstructuredTransformClient,
  UnstructuredTransformProvider,
  convertTextToNodes,
  conversionRouterFromProviders,
  createDoclingServeClientFromEnvironment,
  isDeterministicTextMediaType,
  isDoclingMediaType,
  isExclusiveTextMediaType,
  type ConversionOutput,
  type ConversionRequest,
  type DocumentConversionProvider,
} from "./index.js";

const encoder = new TextEncoder();

function stubOutput(providerKey: string): ConversionOutput {
  return {
    requestDigest: "sha256:" + "1".repeat(64),
    providerKey,
    providerVersion: "1",
  } as ConversionOutput;
}

function stubProvider(
  providerKey: string,
  convert: DocumentConversionProvider["convert"] = async () => stubOutput(providerKey),
  supports: DocumentConversionProvider["supports"] = () => true,
): DocumentConversionProvider {
  return {
    providerKey,
    version: "1",
    supports,
    convert,
  };
}

function unusedTextProvider(): DocumentConversionProvider {
  return stubProvider(
    "deterministic-structural-text",
    async () => {
      throw new Error("unused");
    },
    () => false,
  );
}

async function pdfRequest(managedProcessingAllowed: boolean): Promise<ConversionRequest> {
  const store = new InMemoryArtifactStore();
  const sourceArtifact = await store.put({
    tenantId: "tenant",
    mediaType: "application/pdf",
    bytes: encoder.encode("bounded fixture"),
  });
  return {
    tenantId: "tenant",
    sourceArtifact,
    profile: {
      profileKey: "pdf",
      version: "1",
      mediaType: "application/pdf",
      managedProcessingAllowed,
    },
  };
}

describe("deterministic conversion", () => {
  it("produces stable heading and code nodes", () => {
    const text = "# Heading\n\nParagraph.\n\n```ts\nconst x = 1;\n```";
    expect(convertTextToNodes(text, "text/markdown", "rep")).toEqual(convertTextToNodes(text, "text/markdown", "rep"));
    expect(convertTextToNodes(text, "text/markdown", "rep").nodes.map((node) => node.kind)).toEqual([
      "document",
      "heading",
      "paragraph",
      "code_block",
    ]);
  });

  it("records only present ancestors when heading levels jump", () => {
    const text = "### Orphan\n\nOrphan body.\n\n# Root\n\n#### Deep\n\nDeep body.\n\n## Sibling\n\nSibling body.";
    const converted = convertTextToNodes(text, "text/markdown", "sparse-headings");
    expect(converted.nodes.slice(1).map((node) => node.locator.sectionPath)).toEqual([
      ["Orphan"],
      ["Orphan"],
      ["Root"],
      ["Root", "Deep"],
      ["Root", "Deep"],
      ["Root", "Sibling"],
      ["Root", "Sibling"],
    ]);
    for (const node of converted.nodes.slice(1)) {
      expect(converted.markdown.slice(node.locator.startOffset, node.locator.endOffset)).toBe(node.text);
    }
  });

  it("preserves transcript timestamps and seals all outputs", async () => {
    const store = new InMemoryArtifactStore();
    const bytes = encoder.encode("WEBVTT\n\n00:01.000 --> 00:03.000\nHarrison: Reliability matters.");
    const sourceArtifact = await store.put({
      tenantId: "tenant",
      mediaType: "text/vtt",
      bytes,
    });
    const provider = new DeterministicTextConversionProvider(store);
    const output = await provider.convert({
      tenantId: "tenant",
      sourceArtifact,
      profile: {
        profileKey: "transcript",
        version: "1",
        mediaType: "text/vtt",
        managedProcessingAllowed: false,
      },
    });
    expect(output.nodes[1]?.locator.startTimeMs).toBe(1000);
    expect(output.nodes[1]?.locator.speaker).toBe("Harrison");
    expect(output.fidelity.grade).toBe("high");
    expect(await store.get("tenant", output.providerNativeArtifact.digest)).toBeDefined();
  });
});

describe("conversion media types", () => {
  it("keeps markdown, VTT, and plain text exclusive to the text converter", () => {
    expect(isExclusiveTextMediaType("text/markdown")).toBe(true);
    expect(isExclusiveTextMediaType("text/vtt")).toBe(true);
    expect(isExclusiveTextMediaType("text/plain")).toBe(true);
    expect(isDoclingMediaType("text/markdown")).toBe(false);
  });

  it("does not treat Office Open XML as deterministic text", () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(isDeterministicTextMediaType(docx)).toBe(false);
    expect(isExclusiveTextMediaType(docx)).toBe(false);
    expect(isDoclingMediaType(docx)).toBe(true);
  });

  it("treats HTML as deterministic first and a Docling fallback", () => {
    expect(isDeterministicTextMediaType("text/html")).toBe(true);
    expect(isExclusiveTextMediaType("text/html")).toBe(false);
    expect(isDoclingMediaType("text/html")).toBe(true);
  });
});

describe("conversion router", () => {
  it("never calls Docling or Unstructured for exclusive text", async () => {
    const store = new InMemoryArtifactStore();
    const sourceArtifact = await store.put({
      tenantId: "tenant",
      mediaType: "text/markdown",
      bytes: encoder.encode("# Title\n\nBody."),
    });
    const request: ConversionRequest = {
      tenantId: "tenant",
      sourceArtifact,
      profile: {
        profileKey: "markdown",
        version: "1",
        mediaType: "text/markdown",
        managedProcessingAllowed: true,
      },
    };
    let binaryCalls = 0;
    const binary = stubProvider("docling-serve", async () => {
      binaryCalls += 1;
      throw new Error("unused");
    });
    const paid = stubProvider("unstructured-transform", async () => {
      binaryCalls += 1;
      throw new Error("unused");
    });
    const router = new ConversionRouter(new DeterministicTextConversionProvider(store), binary, paid);
    const routed = await router.convertWithReceipt(request);
    expect(routed.receipt.candidateRoute).toEqual(["deterministic-structural-text@1.0.0"]);
    expect(routed.receipt.selectedProviderKey).toBe("deterministic-structural-text");
    expect(routed.receipt.fallbackUsed).toBe(false);
    expect(binaryCalls).toBe(0);
  });

  it("converts a PDF on Docling without an Unstructured key", async () => {
    const request = await pdfRequest(false);
    let unstructuredCalls = 0;
    const router = new ConversionRouter(
      unusedTextProvider(),
      stubProvider("docling-serve"),
      stubProvider("unstructured-transform", async () => {
        unstructuredCalls += 1;
        throw new Error("MANAGED_PROCESSING_DENIED");
      }),
    );
    const routed = await router.convertWithReceipt(request);
    expect(routed.receipt.candidateRoute).toEqual(["docling-serve@1"]);
    expect(routed.receipt.selectedProviderKey).toBe("docling-serve");
    expect(routed.receipt.fallbackUsed).toBe(false);
    expect(unstructuredCalls).toBe(0);
  });

  it("tries Docling before gated Unstructured", async () => {
    const request = await pdfRequest(true);
    const order: string[] = [];
    const router = new ConversionRouter(
      unusedTextProvider(),
      stubProvider("docling-serve", async () => {
        order.push("docling-serve");
        throw new Error("PROVIDER_UNAVAILABLE:secret-must-not-escape");
      }),
      stubProvider("unstructured-transform", async () => {
        order.push("unstructured-transform");
        return stubOutput("unstructured-transform");
      }),
    );
    const first = await router.convertWithReceipt(request);
    const second = await router.convertWithReceipt(request);
    expect(order).toEqual(["docling-serve", "unstructured-transform", "docling-serve", "unstructured-transform"]);
    expect(first.receipt).toEqual(second.receipt);
    expect(first.receipt.fallbackUsed).toBe(true);
    expect(first.receipt.attempts[0]).toMatchObject({
      providerKey: "docling-serve",
      outcome: "failed",
      failureClass: "provider_unavailable",
    });
    expect(JSON.stringify(first.receipt)).not.toContain("secret-must-not-escape");
  });

  it("never invokes Unstructured unless managed processing is allowed", async () => {
    const store = new InMemoryArtifactStore();
    const sourceArtifact = await store.put({
      tenantId: "tenant",
      mediaType: "application/pdf",
      bytes: encoder.encode("pdf"),
    });
    const provider = new UnstructuredTransformProvider(
      "1",
      {
        createJob: async () => {
          throw new Error("should-not-run");
        },
        getJob: async () => ({ state: "failed" }),
        downloadResult: async () => ({
          native: new Uint8Array(),
          markdown: "",
          plainText: "",
        }),
      },
      store,
    );
    expect(
      provider.supports({
        profileKey: "pdf",
        version: "1",
        mediaType: "application/pdf",
        managedProcessingAllowed: false,
      }),
    ).toBe(false);
    await expect(
      provider.convert({
        tenantId: "tenant",
        sourceArtifact,
        profile: {
          profileKey: "pdf",
          version: "1",
          mediaType: "application/pdf",
          managedProcessingAllowed: false,
        },
      }),
    ).rejects.toThrow("MANAGED_PROCESSING_DENIED");
  });

  it("tries the next admitted converter when fidelity asks for alternate_conversion", async () => {
    const request = await pdfRequest(true);
    const lowFidelity = {
      ...stubOutput("docling-serve"),
      fidelity: {
        grade: "low",
        metrics: {
          inputCharacters: 100,
          outputCharacters: 10,
          characterCoverage: 0.1,
          headings: 0,
          tables: 0,
          figures: 0,
          codeBlocks: 0,
          citations: 0,
          emptyNodes: 0,
          repeatedBlockRatio: 0,
          locatorResolvability: 1,
          encodingAnomalies: 0,
        },
        checks: [],
        findings: [
          {
            disposition: "alternate_conversion",
            nodeIds: [],
            impact: "low text coverage",
            allowedAction: "route to admitted fallback",
          },
        ],
      },
    } as ConversionOutput;
    const router = new ConversionRouter(
      unusedTextProvider(),
      stubProvider("docling-serve", async () => lowFidelity),
      stubProvider("unstructured-transform"),
    );
    const routed = await router.convertWithReceipt(request);
    expect(routed.receipt.attempts[0]).toMatchObject({
      providerKey: "docling-serve",
      outcome: "failed",
      failureClass: "invalid_output",
    });
    expect(routed.receipt.selectedProviderKey).toBe("unstructured-transform");
  });

  it("respects an admitted provider subset without changing policy order", async () => {
    const request = await pdfRequest(true);
    const router = conversionRouterFromProviders([
      unusedTextProvider(),
      stubProvider("docling-serve"),
      stubProvider("unstructured-transform"),
    ]);
    const routed = await router.convertWithReceipt(request, {
      admittedKeys: ["unstructured-transform", "docling-serve"],
    });
    expect(routed.receipt.candidateRoute).toEqual(["docling-serve@1", "unstructured-transform@1"]);
    expect(routed.receipt.selectedProviderKey).toBe("docling-serve");
  });

  it("exhausts when no admitted converter remains", async () => {
    const request = await pdfRequest(false);
    const router = new ConversionRouter(
      unusedTextProvider(),
      stubProvider("docling-serve", async () => {
        throw new Error("DOCLING_CONVERSION_FAILED");
      }),
    );
    await expect(router.convertWithReceipt(request)).rejects.toThrow(
      "CONVERSION_EXHAUSTED:docling-serve:provider_failed",
    );
  });
});

describe("conversion HTTP clients", () => {
  it("configures Unstructured on-demand auth without placing keys in URLs or errors", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new HttpUnstructuredTransformClient(
      {
        baseUrl: "https://platform.unstructuredapp.io/api/v1",
        apiKey: "test-secret",
        templateId: "template",
        maximumResultBytes: 100,
      },
      async (url, init) => {
        calls.push(init === undefined ? { url } : { url, init });
        return new Response(JSON.stringify({ id: "job-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(
      await client.createJob({
        artifactDigest: "sha256:" + "a".repeat(64),
        profileDigest: "sha256:" + "b".repeat(64),
        bytes: new Uint8Array([1]),
        mediaType: "text/plain",
      }),
    ).toEqual({ jobId: "job-1" });
    expect(calls[0]!.url).not.toContain("test-secret");
    expect(new Headers(calls[0]!.init?.headers).get("unstructured-api-key")).toBe("test-secret");
  });

  it("calls the bounded Docling Serve v1 multipart API and validates its output", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const responseBody = JSON.stringify({
      status: "success",
      processing_time: 0.1,
      errors: [],
      document: {
        md_content: "# Result",
        text_content: "Result",
        json_content: { name: "fixture" },
      },
    });
    const client = new HttpDoclingServeClient(
      { baseUrl: "http://127.0.0.1:5001", apiKey: "docling-secret", maximumResultBytes: 1_000 },
      async (url, init) => {
        calls.push(init === undefined ? { url } : { url, init });
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const output = await client.convert({
      bytes: encoder.encode("fixture"),
      mediaType: "application/pdf",
      profileDigest: "sha256:" + "a".repeat(64),
    });
    expect(output.markdown).toBe("# Result");
    expect(output.plainText).toBe("Result");
    expect(calls[0]?.url).toBe("http://127.0.0.1:5001/v1/convert/file");
    expect(new Headers(calls[0]?.init?.headers).get("x-api-key")).toBe("docling-secret");
    const form = calls[0]?.init?.body as FormData;
    expect(form.getAll("to_formats")).toEqual(["md", "json", "text"]);
    expect(form.get("files")).toBeInstanceOf(File);
    expect(calls[0]?.url).not.toContain("docling-secret");
  });

  it("rejects unsafe Docling URLs and oversized or invalid conversion results", async () => {
    expect(
      () =>
        new HttpDoclingServeClient({
          baseUrl: "http://metadata.internal",
          maximumResultBytes: 100,
        }),
    ).toThrow("DOCLING_URL_DENIED");
    const oversized = new HttpDoclingServeClient(
      { baseUrl: "http://localhost:5001", maximumResultBytes: 4 },
      async () => new Response("12345", { status: 200 }),
    );
    await expect(
      oversized.convert({
        bytes: new Uint8Array([1]),
        mediaType: "application/pdf",
        profileDigest: "sha256:" + "a".repeat(64),
      }),
    ).rejects.toThrow("DOCLING_RESULT_SIZE_LIMIT");
    const failed = new HttpDoclingServeClient(
      { baseUrl: "http://localhost:5001", maximumResultBytes: 1_000 },
      async () => new Response(JSON.stringify({ status: "failure", document: {}, errors: ["bad"] }), { status: 200 }),
    );
    await expect(
      failed.convert({
        bytes: new Uint8Array([1]),
        mediaType: "application/pdf",
        profileDigest: "sha256:" + "a".repeat(64),
      }),
    ).rejects.toThrow("DOCLING_CONVERSION_FAILED");
    expect(() =>
      createDoclingServeClientFromEnvironment({
        DOCLING_MAXIMUM_RESULT_BYTES: "unbounded",
      }),
    ).toThrow("INVALID_DOCLING_MAXIMUM_RESULT_BYTES");
  });
});

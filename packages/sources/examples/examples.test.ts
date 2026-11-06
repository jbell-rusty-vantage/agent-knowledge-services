import { describe, expect, it } from "vitest";
import { runHttpAcquireExample } from "./01-http-acquire.js";
import { runUploadAcquireExample } from "./02-upload-acquire.js";
import { runInspectBytesExample } from "./03-inspect-bytes.js";
import { runHttpThenInspectExample } from "./04-http-then-inspect.js";
import { runPaperResolveThenHttpExample } from "./05-paper-resolve-then-http.js";
import { runHttpPolicyFailureExample } from "./06-http-policy-failure.js";

describe("acquisition examples", () => {
  it("covers the mocked HTTP, upload, inspect, paper, and policy sequences", async () => {
    const http = await runHttpAcquireExample();
    expect(http.result.artifacts).toHaveLength(1);
    expect(http.verification.accepted).toBe(true);
    expect(http.result.observations.find((item) => item.key === "headers")?.value).not.toContain("secret");
    const upload = await runUploadAcquireExample();
    expect(upload.result.artifacts).toHaveLength(1);
    const inspect = await runInspectBytesExample();
    expect(inspect.excerpt).not.toHaveProperty("locator");
    expect(JSON.stringify(inspect.observation)).not.toContain("super-secret-value");
    const sequence = await runHttpThenInspectExample();
    expect(sequence.excerpt.hasMore).toBe(true);
    const paper = await runPaperResolveThenHttpExample();
    expect(paper.httpRequest.target).toEqual({ kind: "http", url: "https://papers.example/p.pdf" });
    expect(paper.result.artifacts).toHaveLength(1);
    const failure = await runHttpPolicyFailureExample();
    expect(failure.denied).toBe("ADDRESS_DENIED");
    expect(failure.putCount).toBe(0);
  });
});

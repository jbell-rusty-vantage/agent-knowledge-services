import { describe, expect, it } from "vitest";
import { createKnowledgeApplication } from "./index.js";

describe("knowledge application", () => {
  it("reports the shared v1 service status", async () => {
    await expect(createKnowledgeApplication().getStatus()).resolves.toMatchObject({
      service: "knowledge-services",
      status: "ready",
      contractVersion: "v1",
    });
  });
});

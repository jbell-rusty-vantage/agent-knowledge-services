import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8")) as T;

describe("deployment contracts", () => {
  it("emits a self-contained OpenAPI document with resolvable local references", async () => {
    const document = await readJson<Record<string, unknown>>("packages/contracts/generated/openapi.json");
    const references: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(visit);
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) references.push(child);
        else visit(child);
      }
    };
    visit(document);
    for (const reference of references) {
      const resolved = reference
        .slice(2)
        .split("/")
        .reduce<unknown>(
          (current, segment) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
              : undefined,
          document,
        );
      expect(resolved, reference).not.toBeUndefined();
    }
    expect(references.length).toBeGreaterThan(100);
  });

  it.each(["apps/api/vercel.json", "apps/mcp/vercel.json"])(
    "%s describes one bounded Fluid Compute Fastify function",
    async (path) => {
      const manifest = await readJson<{
        fluid?: boolean;
        regions?: string[];
        functions?: Record<string, { maxDuration?: number; memory?: number }>;
        headers?: unknown[];
      }>(path);
      expect(manifest.fluid).toBe(true);
      expect(manifest.regions).toEqual(["iad1"]);
      expect(manifest.functions?.["src/index.ts"]).toEqual({
        maxDuration: 300,
        memory: 1024,
      });
      expect(manifest.headers).not.toHaveLength(0);
    },
  );

  it("synthesizes a private-ingress, independently scalable worker/Docling stack", async () => {
    const template = await readJson<{
      Parameters: Record<string, { Default?: unknown; AllowedPattern?: string }>;
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      Outputs: Record<string, unknown>;
    }>("infra/aws/knowledge-runtime.template.json");
    const resources = template.Resources;
    const resourceTypes = Object.values(resources).map((item) => item.Type);
    for (const requiredType of [
      "AWS::ECS::Cluster",
      "AWS::ECS::TaskDefinition",
      "AWS::ECS::Service",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "AWS::ElasticLoadBalancingV2::TargetGroup",
      "AWS::ElasticLoadBalancingV2::Listener",
      "AWS::ApplicationAutoScaling::ScalableTarget",
      "AWS::ApplicationAutoScaling::ScalingPolicy",
      "AWS::CloudWatch::Alarm",
      "AWS::Logs::LogGroup",
      "AWS::IAM::Role",
    ])
      expect(resourceTypes, requiredType).toContain(requiredType);

    expect(resources.WorkerService!.Properties).toMatchObject({
      LaunchType: "FARGATE",
      EnableExecuteCommand: false,
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
    });
    expect(resources.DoclingService!.Properties).toMatchObject({
      LaunchType: "FARGATE",
      EnableExecuteCommand: false,
      HealthCheckGracePeriodSeconds: 180,
    });
    expect(resources.DoclingLoadBalancer!.Properties).toMatchObject({
      Scheme: "internal",
      Type: "application",
    });
    expect(template.Parameters.DoclingImageUri!.Default).toBe(
      "ghcr.io/docling-project/docling-serve@sha256:f8b324448e7c9e66083049727aaa90e3e65e88f0d7796624597a29d04183198b",
    );
    expect(template.Parameters.WorkerImageUri!.AllowedPattern).toContain("@sha256:");
    expect(template.Outputs).toHaveProperty("DoclingBaseUrl");
  });

  it("keeps credentials out of committed deployment values and runs the worker as non-root", async () => {
    const parameters = await readJson<{ ParameterKey: string; ParameterValue: string }[]>(
      "infra/aws/parameters.example.json",
    );
    expect(
      parameters.every(
        ({ ParameterValue }) => ParameterValue.includes("REPLACE") || ParameterValue === "docling.knowledge.internal",
      ),
    ).toBe(true);
    const dockerfile = await readFile(resolve(repositoryRoot, "apps/worker/Dockerfile"), "utf8");
    expect(dockerfile).toContain("pnpm --filter @aiengineer/knowledge-worker deploy --prod");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toMatch(/(?:ARG|ENV)\s+.*(?:SECRET|TOKEN|PASSWORD)=/i);
  });
});

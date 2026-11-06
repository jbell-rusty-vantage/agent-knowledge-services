import { describe, expect, it } from "vitest";
import { assertCheckpointPath } from "./checkpoints.js";
describe("checkpoint path policy", () => {
  it.each([
    "notes/.env",
    "notes/.env.local",
    "notes/secrets.json",
    "notes/token.txt",
    "notes/id_rsa",
    "notes/a.pem",
    "notes/.git/config",
    "notes/.aws/config",
    "notes/.azure/token",
    "notes/__pycache__/cache",
    "notes/auth.yaml",
    "notes/keys",
    "notes/key.json",
    "notes/.envrc",
  ])("excludes secret/control path %s", (path) => {
    expect(() => assertCheckpointPath(path, ["notes"])).toThrow("CHECKPOINT_PATH_DENIED");
  });
  it("accepts exact approved handoff files and research notes", () => {
    expect(() => assertCheckpointPath("handoff.md", ["handoff.md"])).not.toThrow();
    expect(() => assertCheckpointPath("notes/auth.md", ["notes"])).not.toThrow();
    expect(() => assertCheckpointPath("notes2/work.md", ["notes"])).toThrow("CHECKPOINT_PATH_DENIED");
  });
});

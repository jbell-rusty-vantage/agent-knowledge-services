import { defineConfig } from "tsup";

// Workspace packages are inlined so each `dist/*.js` can be copied into a sandbox
// (Vercel Sandbox, Docker) and run with only the published runtime dependencies
// (@modelcontextprotocol/sdk, zod, pg). Splitting is off so the two bins stay self-contained.
export default defineConfig({
  // local-services.ts is the transitional 5D3 seam `ks` imports through ./local-verification (Unit 5C); 5D3 removes it.
  entry: [
    "src/index.ts",
    "src/knowledge.ts",
    "src/scoped-host.ts",
    "src/evidence-reader.ts",
    "src/root-host.ts",
    "src/local-services.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: false,
  metafile: true,
  noExternal: [/^@aiengineer\//],
  banner: { js: "#!/usr/bin/env node" },
});

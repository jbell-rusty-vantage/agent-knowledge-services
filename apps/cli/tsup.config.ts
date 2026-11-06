import { defineConfig } from "tsup";

// `ks` is one self-contained binary: workspace packages are inlined so the packed tarball installs outside the
// workspace with only its declared third-party runtime dependencies. Splitting keeps every lazily imported module
// (the local profile, the offline utilities) in its own chunks, so `--help` and remote commands load neither host nor
// the executor seam; src/tests/remote-profile.test.ts checks that against the metafile.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: true,
  metafile: true,
  noExternal: [/^@aiengineer\//],
});

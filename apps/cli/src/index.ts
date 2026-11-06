#!/usr/bin/env node
import { runKs } from "./ks.js";

process.exitCode = await runKs(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

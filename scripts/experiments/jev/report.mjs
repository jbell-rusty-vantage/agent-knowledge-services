import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(process.env.JEV_EXPERIMENT_OUTPUT ?? "docs/jev/results");
const receipt = JSON.parse(await readFile(resolve(directory, "receipts.json"), "utf8"));
const template = await readFile(new URL("./report.html", import.meta.url), "utf8");
await writeFile(
  resolve(directory, "index.html"),
  template.replace("__DATA__", JSON.stringify(receipt).replace(/</g, "\\u003c")),
);
console.log(resolve(directory, "index.html"));

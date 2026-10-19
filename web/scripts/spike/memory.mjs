// Memory use of the reasoner steps on PMDco, step by step.
//
// Usage: node --expose-gc scripts/spike/memory.mjs [path/to/rdf-reasoner-konclude/dist]
// The optional path points at a patched copy of the package (thread pool or memory changed).

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Parser, Store } from "n3";

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ? resolve(process.argv[2]) : join(here, "..", "..", "node_modules", "rdf-reasoner-konclude", "dist");
const { RdfReasoner } = await import(pathToFileURL(join(dist, "index.node.mjs")).href);

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";
const MB = (n) => `${(n / 1e6).toFixed(0)} MB`;

let reasoner;
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
function report(step) {
  globalThis.gc?.();
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  const wasm = reasoner?._lastHeapBytes ? MB(reasoner._lastHeapBytes) : "-";
  console.log(`| ${step} | ${MB(m.rss)} | ${MB(peakRss)} | ${MB(m.heapUsed)} | ${wasm} |`);
}

console.log(`dist: ${dist}\n`);
console.log("| Step | RSS | Peak RSS so far | JS heap (main) | WASM memory |\n|---|---|---|---|---|");
report("start");
const parse = (text) => new Store(new Parser({ format: "Turtle" }).parse(text));
const pmdcoText = await readFile(join(here, "..", "..", ".cache", "pmdco-full-3.1.1.ttl"), "utf8");
const pmdco = parse(pmdcoText);
report(`PMDco parsed (${pmdco.size} triples)`);

reasoner = new RdfReasoner();
await reasoner.ready;
report("reasoner ready");
try {
  await reasoner.classify(pmdco);
  report("classify PMDco");
  for (const name of ["simulation-data-model", "broken-c-wrong-relation"]) {
    const local = parse(await readFile(join(here, "out", `${name}.ttl`), "utf8"));
    const individuals = new Set(local.getSubjects(RDF_TYPE, OWL_NAMED_INDIVIDUAL, null).map((t) => t.value));
    const schema = new Store([...pmdco, ...[...local].filter((q) => !individuals.has(q.subject.value))]);
    await reasoner.validate(schema, { maxJustificationsPerWarning: 0 });
    report(`${name}: validate schema`);
    await reasoner.classify(schema);
    report(`${name}: classify schema`);
    const data = new Store([...pmdco, ...local]);
    await reasoner.checkConsistency(data);
    report(`${name}: checkConsistency`);
  }
} finally {
  reasoner.terminate();
  clearInterval(sampler);
}

// Phase 0 spike: can Konclude (WASM) do the mermantics reasoner checks on PMDco?
//
// Usage: node scripts/spike/spike.mjs
// Needs the fixture OWL from the Python tool in scripts/spike/out/ (run emit-owl.sh first).

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Parser, Store, DataFactory } from "n3";
import { RdfReasoner, INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");
const cacheDir = join(here, "..", "..", ".cache");
const PMDCO_VERSION = "3.1.1";
const PMDCO_URL = `https://raw.githubusercontent.com/materialdigital/core-ontology/v${PMDCO_VERSION}/pmdco-full.ttl`;

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";
const OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing";
const RDFS_SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
// A BlackBox step with no sign of life for this long counts as stalled (library default: 600 s).
const STALL_MS = Number(process.env.SPIKE_STALL_MS ?? 180_000);
// Hard limit for each explanation step (SPIKE_STEP_LIMIT_MS).
const STEP_LIMIT_MS = Number(process.env.SPIKE_STEP_LIMIT_MS ?? 120_000);
let reasoner;

const rows = [];
const log = [];
function say(line = "") {
  console.log(line);
  log.push(line);
}
function row(step, ms, result) {
  rows.push({ step, ms, result });
  say(`${step}: ${ms === null ? "-" : `${(ms / 1000).toFixed(2)} s`}  ${result}`);
}
async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return [value, performance.now() - t0];
}

async function pmdcoText() {
  const file = join(cacheDir, `pmdco-full-${PMDCO_VERSION}.ttl`);
  try {
    if ((await stat(file)).size > 0) return readFile(file, "utf8");
  } catch {}
  const resp = await fetch(PMDCO_URL);
  if (!resp.ok) throw new Error(`could not download ${PMDCO_URL}: ${resp.status}`);
  const text = await resp.text();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, text);
  return text;
}

function parseInto(store, text, graph) {
  const g = graph ? DataFactory.namedNode(graph) : DataFactory.defaultGraph();
  for (const q of new Parser({ format: "Turtle" }).parse(text)) {
    store.addQuad(q.subject, q.predicate, q.object, g);
  }
}

function withoutIndividuals(store) {
  const individuals = new Set(store.getSubjects(RDF_TYPE, OWL_NAMED_INDIVIDUAL, null).map((t) => t.value));
  const out = new Store();
  for (const q of store) if (!individuals.has(q.subject.value)) out.addQuad(q);
  return out;
}

const SHORT = [
  ["http://purl.obolibrary.org/obo/", "obo:"],
  ["https://w3id.org/pmd/co/", "pmd:"],
  ["http://example.org/diagram#", "diagram:"],
  ["http://www.w3.org/2002/07/owl#", "owl:"],
  ["http://www.w3.org/2000/01/rdf-schema#", "rdfs:"],
  ["http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf:"],
];
function term(store, t) {
  if (t.termType === "BlankNode") return `_:${t.value}`;
  if (t.termType === "Literal") return JSON.stringify(t.value);
  let s = t.value;
  for (const [ns, p] of SHORT) if (s.startsWith(ns)) { s = p + s.slice(ns.length); break; }
  const label = store.getObjects(t, RDFS_LABEL, null).find((l) => !l.language || l.language === "en");
  return label && !s.startsWith("rdf") && !s.startsWith("owl:") ? `${s} '${label.value}'` : s;
}
// A candidate axiom set for the BlackBox search, so it does not have to try all of PMDco.
// Start from the local terms and follow only what can make a class impossible or the data
// inconsistent: the class and property hierarchy, restrictions, domain and range, types and
// property assertions. Disjointness axioms are added when at least two of their classes are
// in the module. Annotations are never followed. This is a heuristic, not a locality module.
const FOLLOW = new Set([RDFS_SUBCLASS, RDF_TYPE,
  "http://www.w3.org/2002/07/owl#equivalentClass", "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
  "http://www.w3.org/2002/07/owl#inverseOf", "http://www.w3.org/2000/01/rdf-schema#domain",
  "http://www.w3.org/2000/01/rdf-schema#range", "http://www.w3.org/2002/07/owl#propertyChainAxiom",
  "http://www.w3.org/2002/07/owl#disjointUnionOf"]);
const DISJOINT = new Set(["http://www.w3.org/2002/07/owl#disjointWith", "http://www.w3.org/2002/07/owl#propertyDisjointWith"]);
const OWL_ALL_DISJOINT = "http://www.w3.org/2002/07/owl#AllDisjointClasses";
const BUILTIN = /^http:\/\/www\.w3\.org\/(1999\/02\/22-rdf-syntax-ns|2000\/01\/rdf-schema|2002\/07\/owl|2001\/XMLSchema)#/;

function moduleFilter(store, seeds) {
  const annotation = new Set([RDFS_LABEL, "http://www.w3.org/2000/01/rdf-schema#comment",
    "http://www.w3.org/2000/01/rdf-schema#seeAlso", "http://www.w3.org/2000/01/rdf-schema#isDefinedBy",
    ...store.getSubjects(RDF_TYPE, "http://www.w3.org/2002/07/owl#AnnotationProperty", null).map((t) => t.value)]);
  const keep = new Map();
  const signature = new Set();
  const queue = [];
  const addTerm = (t) => {
    if (t.termType === "NamedNode" && !BUILTIN.test(t.value) && !signature.has(t.value)) {
      signature.add(t.value);
      queue.push(t);
    }
  };
  // a quad plus the blank-node structure below its object; every named term in it joins the signature
  const take = (q) => {
    const k = quadKey(q);
    if (keep.has(k)) return;
    keep.set(k, q);
    addTerm(q.predicate);
    addTerm(q.object);
    if (q.object.termType === "BlankNode") for (const sub of store.getQuads(q.object, null, null, DataFactory.defaultGraph())) take(sub);
  };
  seeds.forEach((iri) => addTerm(DataFactory.namedNode(iri)));
  while (queue.length) {
    const t = queue.pop();
    for (const q of store.getQuads(t, null, null, DataFactory.defaultGraph())) {
      const p = q.predicate.value;
      if (annotation.has(p) || DISJOINT.has(p)) continue;
      if (FOLLOW.has(p) || !BUILTIN.test(p)) take(q); // !BUILTIN: property assertions on individuals
    }
  }
  for (const q of store.getQuads(null, null, null, DataFactory.defaultGraph())) {
    if (DISJOINT.has(q.predicate.value) && signature.has(q.subject.value) && signature.has(q.object.value)) {
      keep.set(quadKey(q), q);
    }
  }
  for (const root of store.getSubjects(RDF_TYPE, OWL_ALL_DISJOINT, null)) {
    const quads = [];
    const walk = (n) => { for (const q of store.getQuads(n, null, null, DataFactory.defaultGraph())) { quads.push(q); if (q.object.termType === "BlankNode") walk(q.object); } };
    walk(root);
    const members = quads.filter((q) => q.object.termType === "NamedNode" && signature.has(q.object.value));
    if (members.length >= 2) quads.forEach((q) => keep.set(quadKey(q), q));
  }
  return { size: keep.size, quads: [...keep.values()], filter: (q) => keep.has(quadKey(q)) };
}

// Whole axioms, not single triples: a triple with a named subject plus the blank-node
// structure below its object is one axiom; a blank-node root (AllDisjointClasses, a
// restriction used as a GCI) with everything below it is one axiom. Declarations are kept
// out of the candidates and always added back, as the library does.
const DECLARATION_TYPES = new Set(["Class", "ObjectProperty", "DatatypeProperty", "AnnotationProperty", "NamedIndividual", "Ontology"]
  .map((n) => `http://www.w3.org/2002/07/owl#${n}`));
function axioms(quads) {
  const bySubject = new Map();
  const referenced = new Set();
  for (const q of quads) {
    const k = q.subject.termType + q.subject.value;
    if (!bySubject.has(k)) bySubject.set(k, []);
    bySubject.get(k).push(q);
    if (q.object.termType === "BlankNode") referenced.add("BlankNode" + q.object.value);
  }
  const below = (node, out) => {
    for (const q of bySubject.get("BlankNode" + node.value) ?? []) {
      out.push(q);
      if (q.object.termType === "BlankNode") below(q.object, out);
    }
    return out;
  };
  const declarations = [];
  const groups = [];
  for (const q of quads) {
    if (q.subject.termType === "BlankNode") {
      if (referenced.has("BlankNode" + q.subject.value)) continue;
      const k = "BlankNode" + q.subject.value;
      if (!bySubject.has(k)) continue;
      groups.push(below(q.subject, []));
      bySubject.delete(k); // one group per root
      continue;
    }
    if (q.predicate.value === RDF_TYPE && DECLARATION_TYPES.has(q.object.value)) declarations.push(q);
    else groups.push(q.object.termType === "BlankNode" ? [q, ...below(q.object, [])] : [q]);
  }
  return { declarations, groups };
}

// QuickXplain (Junker 2004): one minimal set of axioms for which `bad` holds.
async function quickXplain(background, candidates, bad, counter) {
  const test = async (sets) => { counter.calls++; return bad(new Store(sets.flat(2))); };
  if (!(await test([background, candidates]))) return [];
  const qx = async (b, delta, c) => {
    if (delta.length && (await test([b]))) return [];
    if (c.length === 1) return c;
    const c1 = c.slice(0, c.length >> 1), c2 = c.slice(c.length >> 1);
    const d2 = await qx([...b, ...c1], c1, c2);
    const d1 = await qx([...b, ...d2], d2, c1);
    return [...d1, ...d2];
  };
  return qx(background, [], candidates);
}
function printAxioms(store, title, groups) {
  say(`  ${title}: ${groups.length} axiom(s)`);
  groups.forEach((g, i) => {
    say(`  axiom ${i + 1}:`);
    for (const q of g) say(`    ${term(store, q.subject)}  ${term(store, q.predicate)}  ${term(store, q.object)}`);
  });
}
function quadKey(q) {
  return `${q.subject.termType}:${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}`;
}

// Run one step with a hard time limit; on timeout the reasoner is replaced by a fresh one.
async function attempt(step, fn) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${STEP_LIMIT_MS / 1000} s`)), STEP_LIMIT_MS);
  });
  try {
    return await Promise.race([fn(), limit]);
  } catch (err) {
    row(step, null, `FAILED: ${err.message.split("\n")[0]}`);
    if (err.message.startsWith("gave up")) {
      reasoner.terminate();
      reasoner = new RdfReasoner({ stallTimeoutMs: STALL_MS });
      await reasoner.ready;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function printJustifications(store, title, justs) {
  say(`  ${title}: ${justs.length} justification(s)`);
  justs.forEach((j, i) => {
    say(`  justification ${i + 1} (${j.length} quads):`);
    for (const q of j) say(`    ${term(store, q.subject)}  ${term(store, q.predicate)}  ${term(store, q.object)}`);
  });
}

async function main() {
  const memStart = process.memoryUsage().rss;
  const text = await pmdcoText();
  const pmdco = new Store();
  const [, parseMs] = await timed(() => parseInto(pmdco, text));
  row("parse PMDco 3.1.1", parseMs, `${pmdco.size} triples, rss +${((process.memoryUsage().rss - memStart) / 1e6).toFixed(0)} MB`);

  reasoner = new RdfReasoner({ stallTimeoutMs: STALL_MS });
  try {
    const [, readyMs] = await timed(() => reasoner.ready);
    row("reasoner ready (WASM load)", readyMs, "ok");

    const [, classifyMs] = await timed(() => reasoner.classify(pmdco));
    const inferred = pmdco.getQuads(null, null, null, INFERRED_GRAPH_IRI).length;
    const [unsat, unsatMs] = await timed(() => reasoner.getUnsatisfiableClasses(pmdco));
    row("classify PMDco", classifyMs, `${inferred} inferred triples`);
    row("unsatisfiable PMDco classes", unsatMs, unsat.length ? unsat.join(", ") : "none");
    pmdco.removeMatches(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI));

    const cases = [
      ["simulation-data-model", "clean"],
      ["broken-b-impossible-class", "SimSystem unsatisfiable"],
      ["broken-c-wrong-relation", "example data inconsistent"],
    ];
    for (const [name, expect] of cases) {
      say();
      say(`== ${name} (expected: ${expect})`);
      const local = new Store();
      parseInto(local, await readFile(join(outDir, `${name}.ttl`), "utf8"));
      const schema = withoutIndividuals(local);

      const schemaStore = new Store([...pmdco, ...schema]);
      const [quick, quickMs] = await timed(() => reasoner.validate(schemaStore, { maxJustificationsPerWarning: 0 }));
      const localUnsat = quick.warnings.map((w) => w.classIRI).filter((c) => c.startsWith("http://example.org/diagram#"));
      row(`${name}: validate schema, no justifications`, quickMs,
        `consistent=${quick.consistent}, unsatisfiable=${quick.warnings.map((w) => w.classIRI).join(", ") || "none"}`);
      for (const cls of localUnsat) {
        const label = term(schemaStore, DataFactory.namedNode(cls));
        await attempt(`${name}: explainEntailment ${label} SubClassOf owl:Nothing (causal)`, async () => {
          const [res, ms] = await timed(() => reasoner.explainEntailment(schemaStore, cls, RDFS_SUBCLASS, OWL_NOTHING));
          row(`${name}: explainEntailment ${label} SubClassOf owl:Nothing (causal)`, ms,
            `isEntailed=${res.isEntailed}, vacuous=${res.vacuous ?? false}, ${res.justifications.length} justification(s)${res.reason ? `, reason: ${res.reason}` : ""}`);
          printJustifications(schemaStore, `causal ${label}`, res.justifications);
        });
        const mod = moduleFilter(schemaStore, schema.getSubjects(null, null, null).filter((t) => t.termType === "NamedNode").map((t) => t.value));
        say(`  module for BlackBox: ${mod.size} of ${schemaStore.size} triples`);
        await attempt(`${name}: validate schema, justifications on module`, async () => {
          const [full, ms] = await timed(() => reasoner.validate(schemaStore, { axiomFilter: mod.filter }));
          row(`${name}: validate schema, justifications on module`, ms, `${full.warnings.length} warning(s)`);
          for (const w of full.warnings) printJustifications(schemaStore, `unsatisfiable ${term(schemaStore, DataFactory.namedNode(w.classIRI))}`, w.justifications);
        });
        await attempt(`${name}: own axiom-level QuickXplain for ${label}`, async () => {
          const { declarations, groups } = axioms(mod.quads);
          const counter = { calls: 0 };
          const [just, ms] = await timed(() => quickXplain(declarations, groups, async (st) => (await reasoner.getUnsatisfiableClasses(st)).includes(cls), counter));
          row(`${name}: own axiom-level QuickXplain for ${label}`, ms, `${just.length} axiom(s) from ${groups.length} candidates, ${counter.calls} reasoner calls`);
          printAxioms(schemaStore, `why ${label} is impossible`, just);
        });
      }
      if (!localUnsat.length && quick.consistent) {
        const [, clsMs] = await timed(() => reasoner.classify(schemaStore));
        row(`${name}: classify schema (reasoned hierarchy)`, clsMs,
          `${schemaStore.getQuads(null, null, null, INFERRED_GRAPH_IRI).length} inferred triples`);
      }

      const dataStore = new Store([...pmdco, ...local]);
      const [consistent, consMs] = await timed(() => reasoner.checkConsistency(dataStore));
      row(`${name}: checkConsistency with examples`, consMs, `consistent=${consistent}`);
      if (!consistent) {
        const mod = moduleFilter(dataStore, local.getSubjects(null, null, null).filter((t) => t.termType === "NamedNode").map((t) => t.value));
        say(`  module for BlackBox: ${mod.size} of ${dataStore.size} triples`);
        await attempt(`${name}: explainInconsistency on module`, async () => {
          const [justs, ms] = await timed(() => reasoner.explainInconsistency(dataStore, { axiomFilter: mod.filter }));
          row(`${name}: explainInconsistency on module`, ms, `${justs.length} justification(s)`);
          printJustifications(dataStore, "inconsistency (module)", justs);
        });
        await attempt(`${name}: own axiom-level QuickXplain for inconsistency`, async () => {
          const { declarations, groups } = axioms(mod.quads);
          const counter = { calls: 0 };
          const [just, ms] = await timed(() => quickXplain(declarations, groups, async (st) => !(await reasoner.checkConsistency(st)), counter));
          row(`${name}: own axiom-level QuickXplain for inconsistency`, ms, `${just.length} axiom(s) from ${groups.length} candidates, ${counter.calls} reasoner calls`);
          printAxioms(dataStore, "why the example data is inconsistent", just);
        });
        await attempt(`${name}: explainInconsistency on full store`, async () => {
          const [justs, ms] = await timed(() => reasoner.explainInconsistency(dataStore));
          row(`${name}: explainInconsistency on full store`, ms, `${justs.length} justification(s)`);
          printJustifications(dataStore, "inconsistency (full)", justs);
        });
      }
    }
    row("peak rss", null, `${(process.memoryUsage().rss / 1e6).toFixed(0)} MB (Node process incl. worker)`);
  } finally {
    reasoner.terminate();
  }

  const table = ["| Step | Time | Result |", "|---|---|---|",
    ...rows.map((r) => `| ${r.step} | ${r.ms === null ? "-" : `${(r.ms / 1000).toFixed(2)} s`} | ${r.result} |`)].join("\n");
  await writeFile(join(outDir, "spike-output.md"), `${table}\n\n\`\`\`\n${log.join("\n")}\n\`\`\`\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

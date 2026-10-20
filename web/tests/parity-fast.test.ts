// Parity with the Python tool in fast mode. The golden files come from the Python CLI
// (scripts/make-golden-fast.sh): every fixture against tiny.ttl and PMDco 3.1.1.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Parser } from "n3";
import { describe, expect, test } from "vitest";

import { checks, defaultConfig, mermaid, report, type Ontology } from "../src/core/index.js";
import { FIXTURES, GOLDEN, PMDCO_ENABLED, PMDCO_FILE, fixture, loadOntology } from "./helpers.js";

const DIR = join(GOLDEN, "fast");
const diagrams = readdirSync(FIXTURES).filter((f) => f.endsWith(".mmd")).sort();

interface Golden {
  info: { ontology_files: string[] };
  findings: { level: string; check: string; where: string; message: string; details: string }[];
}

function suite(ontoName: "tiny" | "pmdco", load: () => Ontology) {
  let onto: Ontology | undefined;
  const ontology = () => (onto ??= load());

  describe.each(diagrams)(`%s against ${ontoName}`, (file) => {
    const base = join(DIR, `${file.replace(/\.mmd$/, "")}.${ontoName}`);
    const golden = JSON.parse(readFileSync(`${base}.json`, "utf8")) as Golden;
    const result = () => {
      const r = checks.run(mermaid.parse(fixture(file)), ontology(), defaultConfig(), null);
      // The Python CLI reports the ontology path it was given; use the same name.
      r.info.ontology_files = golden.info.ontology_files;
      return r;
    };

    test("findings match", () => {
      const fields = result().findings.map(({ level, check, where, message, details }) =>
        ({ level, check, where, message, details }));
      expect(fields).toEqual(golden.findings);
    });

    test("JSON, Markdown and text reports match", () => {
      const r = result();
      expect(report.toJson(r, file)).toBe(readFileSync(`${base}.json`, "utf8"));
      expect(report.toMarkdown(r, file)).toBe(readFileSync(`${base}.md`, "utf8"));
      // print() adds a newline at the end.
      expect(report.toText(r, file) + "\n").toBe(readFileSync(`${base}.txt`, "utf8"));
    });

    test("generated OWL has the same triples", () => {
      let turtle = "";
      checks.run(mermaid.parse(fixture(file)), ontology(), defaultConfig(), null, { emitOwl: (t) => (turtle = t) });
      const triples = (text: string) => new Parser().parse(text)
        .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.termType} ${q.object.value}`).sort();
      expect(triples(turtle)).toEqual(triples(readFileSync(`${base}.ttl`, "utf8")));
    });
  });
}

suite("tiny", () => loadOntology(join(FIXTURES, "tiny.ttl")));

describe.runIf(PMDCO_ENABLED)("PMDco", () => {
  suite("pmdco", () => loadOntology(PMDCO_FILE));
});


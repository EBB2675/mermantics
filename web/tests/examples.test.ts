// The example diagrams on the web page (web/examples/): the demo is clean, and each
// broken variant shows its one problem.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { checks, defaultConfig, edit, mermaid, type Ontology } from "../src/core/index.js";
import { PMDCO_ENABLED, PMDCO_FILE, WEB, fixture, loadOntology } from "./helpers.js";

const example = (name: string) => readFileSync(join(WEB, "examples", name), "utf8");
const NAMES = ["simulation-example.mmd", "broken-unknown-id.mmd", "broken-impossible-class.mmd",
               "broken-wrong-relation.mmd"];

test("examples parse without findings and use the usual styles", () => {
  const classDefs = fixture("simulation-data-model.mmd").split("\n").filter((l) => l.trim().startsWith("classDef "));
  for (const name of NAMES) {
    const text = example(name);
    expect(mermaid.parse(text).findings, name).toEqual([]);
    expect(text.split("\n").filter((l) => l.trim().startsWith("classDef ")), name).toEqual(classDefs);
    expect(edit.styleClasses(text)).toEqual(edit.styleClasses(edit.TEMPLATE));
  }
});

describe.skipIf(!PMDCO_ENABLED)("examples on PMDco", () => {
  // Loaded here, not in the describe body, which runs even when the block is skipped.
  let onto: Ontology;
  beforeAll(() => {
    onto = loadOntology(PMDCO_FILE, "pmdco-full.ttl");
  });
  const run = (name: string) => checks.run(mermaid.parse(example(name)), onto, defaultConfig(), null).findings;
  const severe = (name: string) => run(name).filter((f) => f.level === "error" || f.level === "warning")
    .map((f) => `${f.level} ${f.check}: ${f.where}: ${f.message}`);

  test("the demo has no errors or warnings", () => {
    expect(severe("simulation-example.mmd")).toEqual([]);
  });

  test("unknown ID", () => {
    expect(severe("broken-unknown-id.mmd")).toEqual(["error ids: box 'Software' (line 28): IAO_0099999 is not in the ontology"]);
  });

  test("impossible class: only the full check finds it", () => {
    expect(severe("broken-impossible-class.mmd")).toEqual([]);
  });

  test("wrong relation: the arrow does not fit the property's domain and range", () => {
    const found = severe("broken-wrong-relation.mmd");
    expect(found).toHaveLength(3);
    expect(found.every((f) => f.startsWith("warning domain-range: arrow HPC -> Simulation (line 45)"))).toBe(true);
  });
});

// Term search for the form editor, on tiny.ttl and (with PMDCO=1) on PMDco.

import { describe, expect, test } from "vitest";

import { DEFAULT_PREFIXES, terms } from "../src/core/index.js";
import { PMDCO_ENABLED, PMDCO_FILE, loadOntology, loadTiny } from "./helpers.js";

const ids = (r: terms.SearchResult) => r.terms.map((t) => t.id);

describe("tiny.ttl", () => {
  const index = terms.TermIndex.build(loadTiny(), DEFAULT_PREFIXES);

  test("terms have IDs, labels, kinds and the deprecated flag", () => {
    expect(index.get("TST_0000003")).toMatchObject({
      iri: "http://purl.obolibrary.org/obo/TST_0000003", label: "computation", labels: ["computation"], kind: "class",
      deprecated: false,
    });
    expect(index.get("TST_0000010")!.kind).toBe("object property");
    expect(index.get("TST_0000004")!.deprecated).toBe(true);
    expect(index.size).toBe(13);
  });

  test("exact matches first, then prefix matches, then word matches", () => {
    expect(ids(index.search("computation"))).toEqual(["TST_0000003", "TST_0000005"]);
    expect(ids(index.search("comp"))).toEqual(["TST_0000003", "TST_0000005"]);
    expect(ids(index.search("fast comp"))).toEqual(["TST_0000005"]);
    expect(ids(index.search("comp fast"))).toEqual(["TST_0000005"]);
    expect(ids(index.search("inp"))).toEqual(["TST_0000010", "TST_0000015", "TST_0000014"]);
    // Inside a word only after the rest
    expect(ids(index.search("put"))).toEqual(["TST_0000010", "TST_0000003", "TST_0000015", "TST_0000014",
                                              "TST_0000005"]);
  });

  test("search by ID or number", () => {
    expect(ids(index.search("TST_0000012"))).toEqual(["TST_0000012"]);
    expect(ids(index.search("tst_000001"))).toEqual(["TST_0000010", "TST_0000011", "TST_0000012", "TST_0000013",
                                                     "TST_0000014", "TST_0000015", "TST_0000016"]);
    expect(ids(index.search("0000006"))).toEqual(["TST_0000006"]);
  });

  test("only some kinds", () => {
    expect(ids(index.search("has", { kinds: ["object property"] }))).toEqual(["TST_0000010", "TST_0000014"]);
    expect(index.search("comment", { kinds: ["object property"] }).total).toBe(0);
  });

  test("deprecated terms come last", () => {
    const r = index.search("thing");
    expect(r.terms.at(-1)!.deprecated).toBe(true);
  });

  test("IDs follow the diagram conventions", () => {
    const p = DEFAULT_PREFIXES;
    expect(terms.curieOf("https://w3id.org/pmd/co/PMD_0000933", p)).toBe("PMD_0000933");
    expect(terms.curieOf("http://purl.obolibrary.org/obo/IAO_0000030", p)).toBe("IAO_0000030");
    expect(terms.curieOf("http://purl.obolibrary.org/obo/PMD_0000933", p)).toBeNull(); // would read as w3id
    expect(terms.curieOf("http://purl.obolibrary.org/obo/BFO_0000001_extra", p)).toBeNull();
    expect(terms.curieOf("http://purl.obolibrary.org/obo/obi_0000293", p)).toBeNull();
    expect(terms.curieOf("http://qudt.org/schema/qudt/Unit", p)).toBeNull();
  });
});

describe.skipIf(!PMDCO_ENABLED)("PMDco", () => {
  const start = performance.now();
  const onto = loadOntology(PMDCO_FILE, "pmdco-full.ttl");
  const parsed = performance.now();
  const index = terms.TermIndex.build(onto, DEFAULT_PREFIXES);
  const built = performance.now();

  test("index builds quickly", () => {
    console.log(`PMDco: parse ${Math.round(parsed - start)} ms, index ${Math.round(built - parsed)} ms, ` +
                `${index.size} terms, ${index.search("a").total} match "a"`);
    expect(built - parsed).toBeLessThan(5000);
  });

  test("label words find the term", () => {
    expect(ids(index.search("simulation pro", { kinds: ["class"] }))[0]).toBe("PMD_0000933");
    expect(ids(index.search("has specified input", { kinds: ["object property"] }))[0]).toBe("OBI_0000293");
    expect(ids(index.search("information content", { kinds: ["class"] }))[0]).toBe("IAO_0000030");
    expect(index.get("PMD_0000933")!.definition).not.toBe("");
  });

  test("search is fast", () => {
    const queries = ["s", "si", "sim", "simulation", "simulation pro", "has", "PMD_00009", "proc", "material"];
    const t0 = performance.now();
    for (const q of queries) index.search(q);
    const ms = (performance.now() - t0) / queries.length;
    console.log(`PMDco: ${ms.toFixed(1)} ms per search`);
    expect(ms).toBeLessThan(100);
  });

  test("some terms cannot be written as IDs and are marked", () => {
    const all = index.search("unit", { limit: 10000 }).terms;
    expect(all.some((t) => t.id === null)).toBe(true);
    // Usable terms before those without an ID
    const firstNull = all.findIndex((t) => t.id === null || t.deprecated);
    expect(all.slice(firstNull).every((t) => t.id === null || t.deprecated)).toBe(true);
  });
});

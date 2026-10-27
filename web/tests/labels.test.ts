// Label and ID helpers, ported from tests/test_labels.py.

import { expect, test } from "vitest";

import { labels } from "../src/core/index.js";

test("findCuries ignores names without digits", () => {
  const raw = "<b>X</b><br>PMD_0000933 simulation process<br>MAT_SIM_STRUCTURE<br>job_id<br>IAO_0000030";
  expect(labels.findCuries(raw)).toEqual(["PMD_0000933", "IAO_0000030"]);
});

test("findCuries dedupes and keeps order", () => {
  expect(labels.findCuries("RO_0000059 and BFO_0000050 and RO_0000059")).toEqual(["RO_0000059", "BFO_0000050"]);
});

test("curieToIri uses prefix map then OBO", () => {
  const prefixes = { PMD: "https://w3id.org/pmd/co/PMD_" };
  expect(labels.curieToIri("PMD_0000933", prefixes)).toBe("https://w3id.org/pmd/co/PMD_0000933");
  expect(labels.curieToIri("IAO_0000030", prefixes)).toBe("http://purl.obolibrary.org/obo/IAO_0000030");
});

test("segments strip tags and entities", () => {
  const raw = "<b>A &amp; B</b><br>say #quot;hi#quot;<br/>x<BR>y";
  expect(labels.segments(raw)).toEqual(["A & B", 'say "hi"', "x", "y"]);
});

test("textNear: same line and neighbours", () => {
  let [same, near] = labels.textNear("Ontology alignment:<br>IAO_0000030<br>information content entity", "IAO_0000030");
  expect(same).toEqual([]);
  expect(near).toEqual(["Ontology alignment:", "information content entity"]);
  // text before the ID that ends in a colon is a code/heading, not a label
  [same, near] = labels.textNear("MC: PMD_0000862 Monte Carlo simulation", "PMD_0000862");
  expect(same).toEqual(["Monte Carlo simulation"]);
  [same, near] = labels.textNear("Types<br>MC: PMD_0000862", "PMD_0000862");
  expect(same).toEqual([]);
  expect(near).toEqual(["Types"]);
  // but a label written before the ID still counts
  [same, near] = labels.textNear("has part BFO_0000051", "BFO_0000051");
  expect(same).toEqual(["has part"]);
});

test("labelMatches: exact, case and continuation", () => {
  expect(labels.labelMatches(["is about"], ["Is About"])).toBe(true);
  expect(labels.labelMatches(["is about"], ["is about, optional"])).toBe(true);
  expect(labels.labelMatches(["material"], ["material entity"])).toBe(false);
  expect(labels.labelMatches(["ab initio molecular dynamics simulation"], ["ab initio MD or"])).toBe(false);
});

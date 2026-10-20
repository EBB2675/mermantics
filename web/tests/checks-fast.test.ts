// Checks without a reasoner, against a tiny ontology. Ported from tests/test_checks_fast.py.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { ERROR, NOTE, OK, WARNING, checks, defaultConfig, mermaid, Ontology,
         type Config } from "../src/core/index.js";
import { FIXTURES, loadTiny } from "./helpers.js";

const tiny = loadTiny();

function run(text: string, onto: Ontology = tiny, config?: Config): checks.Result {
  return checks.run(mermaid.parse(text), onto, config ?? defaultConfig(), null);
}

function levels(result: checks.Result, check: string): string[] {
  return result.findings.filter((f) => f.check === check).map((f) => f.level);
}

function messages(result: checks.Result, level: string): string[] {
  return result.findings.filter((f) => f.level === level).map((f) => f.message);
}

const any = (items: string[], pred: (m: string) => boolean) => items.some(pred);

const GOOD = `flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]:::local
    M["<b>Machine</b><br>TST_0000006 machine"]:::local
    T["<b>Kinds</b><br>FAST: TST_0000005 fast computation"]:::vocab
    L["legend TST_0000004"]:::note
    P -. "has input<br>TST_0000010" .-> M
    P -. "kind" .-> T
`;

test("good diagram passes", () => {
  const r = run(GOOD);
  expect(checks.hasErrors(r)).toBe(false);
  expect(messages(r, WARNING)).toEqual([]);
  expect(any(messages(r, OK), (m) => m.includes("all 4 ontology IDs exist"))).toBe(true);
  expect(any(messages(r, OK), (m) => m.includes("domains and ranges"))).toBe(true);
  expect(any(messages(r, OK), (m) => m.includes("1 term in 'Kinds' is a kind of 'computation'"))).toBe(true);
  // the legend box is skipped, so its deprecated ID is not reported
  expect(any(messages(r, ERROR), (m) => m.includes("deprecated"))).toBe(false);
});

test("unknown and deprecated IDs are errors", () => {
  const r = run('flowchart TB\nA["TST_0000999"]\nB["TST_0000004 obsolete thing"]\n');
  const errs = messages(r, ERROR);
  expect(any(errs, (m) => m.includes("TST_0000999 is not in the ontology"))).toBe(true);
  expect(any(errs, (m) => m.includes("deprecated"))).toBe(true);
});

test("wrong kinds are reported", () => {
  const text = `flowchart TB
    A["TST_0000010 has input"]
    B["TST_0000002 object"]
    A -. "TST_0000001" .-> B
    B -. "comment TST_0000011" .-> A
    `;
  const r = run(text);
  const errs = messages(r, ERROR);
  expect(any(errs, (m) => m.includes("is an object property, but a box's ID should be a class"))).toBe(true);
  expect(any(errs, (m) => m.includes("is a class, but an arrow's ID should be a property"))).toBe(true);
  expect(any(messages(r, WARNING), (m) => m.includes("not an object property"))).toBe(true);
});

test("label mismatch on same line is a warning, missing label is a note", () => {
  const text = 'flowchart TB\nA["<b>A</b><br>TST_0000002 objekt"]\nB["<b>B</b><br>TST_0000002<br>something else"]\n';
  const r = run(text);
  expect(any(messages(r, WARNING), (m) => m.includes("reads 'objekt'"))).toBe(true);
  expect(any(messages(r, NOTE), (m) => m.includes("no label written next to TST_0000002"))).toBe(true);
});

test("domain and range misfit", () => {
  const text = `flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    M -. "has input<br>TST_0000010" .-> P
    `;
  const warns = messages(run(text), WARNING);
  expect(any(warns, (m) => m.includes("expects its subject to be 'process', but 'Machine' is not"))).toBe(true);
  expect(any(warns, (m) => m.includes("expects its object to be 'object', but 'Proc' is not"))).toBe(true);
});

test("union domain", () => {
  const text = `flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    M -. "runs on<br>TST_0000012" .-> P
    `;
  expect(levels(run(text), "domain-range")).toEqual([OK]);
});

test("alignment is inherited through the diagram", () => {
  const text = `flowchart TB
    Parent["<b>Parent</b><br>TST_0000001 process"]
    Child["<b>Child</b>"]
    O["<b>O</b><br>TST_0000002 object"]
    Parent --> Child
    Child -. "has input<br>TST_0000010" .-> O
    `;
  expect(levels(run(text), "domain-range")).toEqual([OK]);
});

test("child-parent direction", () => {
  const text = `flowchart TB
    Parent["<b>Parent</b><br>TST_0000001 process"]
    Child["<b>Child</b>"]
    O["<b>O</b><br>TST_0000002 object"]
    Child --> Parent
    Child -. "has input<br>TST_0000010" .-> O
    `;
  const r = run(text, tiny, defaultConfig({ inheritDirection: "child-parent" }));
  expect(levels(r, "domain-range")).toEqual([OK]);
});

test("vocabulary terms", () => {
  const text = `flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]
    T["<b>Kinds</b><br>SAME: TST_0000003 computation<br>FAST: TST_0000005 fast computation<br>BAD: TST_0000006 machine"]:::vocab
    P -. "kind" .-> T
    `;
  const r = run(text);
  expect(any(messages(r, NOTE), (m) => m.includes("SAME (TST_0000003)") && m.includes("adds no information"))).toBe(true);
  expect(any(messages(r, WARNING), (m) => m.includes("BAD (TST_0000006) 'machine'") && m.includes("is not a kind of"))).toBe(true);
  expect(any(messages(r, OK), (m) => m.includes("1 term in 'Kinds'"))).toBe(true);
});

test("arrows touching skipped boxes are ignored", () => {
  const text = `flowchart TB
    A["legend"]:::note
    B["legend"]:::note
    P["<b>Proc</b><br>TST_0000003 computation"]
    A -. "example TST_0000004" .-> B
    A -. "no id" .-> P
    `;
  const r = run(text);
  expect(checks.hasErrors(r)).toBe(false);
  expect(r.findings.some((f) => (f.check === "ids" || f.check === "labels") && f.level !== OK)).toBe(false);
});

test("style class on arrow end marks a vocabulary", () => {
  const text = `flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]
    T["<b>Kinds</b><br>BAD: TST_0000006 machine"]
    P -. "kind" .-> T:::vocab
    `;
  const r = run(text);
  expect(any(messages(r, WARNING), (m) => m.includes("BAD (TST_0000006) 'machine'") && m.includes("is not a kind of"))).toBe(true);
});

test("inverse of a sub-property", () => {
  // 'main input of' is the inverse of 'has main input', a sub-property of 'has input'
  // (process -> object), so it goes from an object to a process.
  const text = `flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    P -. "main input of<br>TST_0000015" .-> M
    `;
  const warns = messages(run(text), WARNING);
  expect(any(warns, (m) => m.includes("expects its subject to be 'object' (inherited from 'has input'), but 'Proc' is not"))).toBe(true);
  expect(any(warns, (m) => m.includes("expects its object to be 'process' (inherited from 'has input'), but 'Machine' is not"))).toBe(true);
});

test("unchecked constraints block the OK", () => {
  const text = `flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    P -. "has input<br>TST_0000010" .-> M
    M -. "made by<br>TST_0000016" .-> P
    M -. "related to<br>TST_0000013" .-> P
    `;
  const r = run(text);
  expect(levels(r, "domain-range")).not.toContain(OK);
  const notes = messages(r, NOTE);
  expect(any(notes, (m) => m.includes("could not check whether 'Proc' fits"))).toBe(true);
  expect(any(notes, (m) => m.includes("1 relation arrow uses a property without a domain or range"))).toBe(true);
});

// The Python test loads an ontology that imports tiny.ttl and checks that the import is
// followed. Core cannot fetch imports, so the caller passes the imported file too; an
// import counts as loaded when a source has its IRI as name.
const tinyUrl = pathToFileURL(join(FIXTURES, "tiny.ttl")).href;
const MAIN = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<http://example.org/main> a owl:Ontology ; owl:imports <${tinyUrl}> .
`;

test("imports are used when the imported file is passed too", () => {
  const onto = Ontology.fromTurtle([
    { name: "main.ttl", text: MAIN },
    { name: tinyUrl, text: readFileSync(join(FIXTURES, "tiny.ttl"), "utf8") },
  ]);
  const r = run('flowchart TB\nP["TST_0000003 computation"]\n', onto);
  expect(checks.hasErrors(r)).toBe(false);
  expect(r.findings.filter((f) => f.check === "ontology")).toEqual([]);
});

test("imports that are not loaded give a note", () => {
  const onto = Ontology.fromTurtle([{ name: "main.ttl", text: MAIN }]);
  const r = run('flowchart TB\nP["TST_0000003 computation"]\n', onto);
  expect(r.findings.filter((f) => f.check === "ontology").map((f) => [f.level, f.message])).toEqual([
    [NOTE, `the ontology imports ${tinyUrl}, which is not loaded, so its terms are missing from these checks`],
  ]);
  expect(checks.hasErrors(r)).toBe(true);
});

test("the local model is removed from the ontology store after a run", () => {
  const before = tiny.store.size;
  run(GOOD);
  expect(tiny.store.size).toBe(before);
});

test("findings carry the box or arrow they are about", () => {
  const r = run(`flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    M -. "has input<br>TST_0000010" .-> P
    X["TST_0000999"]
    `);
  const misfit = r.findings.find((f) => f.check === "domain-range")!;
  expect([misfit.edgeIndex, misfit.line, misfit.nodeId]).toEqual([0, 4, undefined]);
  const unknown = r.findings.find((f) => f.message.includes("TST_0000999"))!;
  expect([unknown.nodeId, unknown.line]).toEqual(["X", 5]);
});

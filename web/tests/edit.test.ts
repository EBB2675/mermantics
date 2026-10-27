// Form editor edits: every change re-parses to what the form asked for and leaves the rest
// of the text byte for byte as it was.

import { describe, expect, test } from "vitest";

import { defaultConfig, edit, labels, mermaid } from "../src/core/index.js";
import { lineSpans, splitlines } from "../src/core/py.js";
import { fixture } from "./helpers.js";

const config = defaultConfig();
const FIXTURES = [
  "simulation-data-model.mmd",
  "broken-a-unknown-id.mmd",
  "broken-b-impossible-class.mmd",
  "broken-c-wrong-relation.mmd",
];
const SIM = fixture("simulation-data-model.mmd");

const apply = (text: string, changes: edit.Change[]) => edit.applyChanges(text, changes);
const isVocab = (node: { css: Set<string> }) => [...node.css].some((c) => config.vocabClasses.has(c));

/** Lines of `after` that are not in `before` and the other way round, assuming one block
 * of lines was kept in order (a simple line diff, enough for these tests). */
function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence on lines.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] };
}

test("lineSpans agrees with splitlines", () => {
  for (const text of ["", "\n", "a", "a\n", "a\r\nb\rc\n\nd", "x y\fz\n", SIM]) {
    expect(lineSpans(text).map(({ from, to }) => text.slice(from, to))).toEqual(splitlines(text));
  }
});

describe("no-op updates leave every fixture unchanged", () => {
  test.each(FIXTURES)("%s", (name) => {
    const text = fixture(name);
    const diagram = mermaid.parse(text);
    for (const node of diagram.nodes.values()) {
      const info = edit.boxInfo(text, node.id, config)!;
      expect(info.label).toBe(node.label);
      expect(edit.updateBox(text, node.id, { id: node.id, label: info.label, kind: info.kind, parents: info.parents },
                            config)).toEqual([]);
      const fields = edit.readBoxLabel(node.label, isVocab(node));
      if (fields) {
        const label = edit.writeBoxLabel(fields);
        expect(label).toBe(node.label);
        expect(edit.updateBox(text, node.id, { ...info, label }, config)).toEqual([]);
      }
    }
    diagram.edges.forEach((e, i) => {
      expect(edit.updateArrow(text, i, { src: e.src, dst: e.dst, kind: e.kind, label: e.label })).toEqual([]);
      const fields = edit.readArrowLabel(e.label);
      if (fields) expect(edit.writeArrowLabel(fields)).toBe(e.label);
    });
  });
});

test("the form can read most fixture labels; the rest are listed", () => {
  const raw: string[] = [];
  for (const name of FIXTURES) {
    const d = mermaid.parse(fixture(name));
    for (const node of d.nodes.values()) {
      if (!edit.readBoxLabel(node.label, isVocab(node))) raw.push(`${name}: box ${node.id}`);
    }
    for (const e of d.edges) if (!edit.readArrowLabel(e.label)) raw.push(`${name}: arrow ${e.src} -> ${e.dst}`);
  }
  // Root has "Ontology anchor: BFO_0000001 entity" as an alignment with a heading: still readable.
  // Only the vocabulary line "MD: PMD_0000504 ab initio MD or" is unusual, and that reads too.
  expect(raw).toEqual([]);
});

describe("reading labels into fields", () => {
  test("box with alignment and text lines", () => {
    const f = edit.readBoxLabel(mermaid.parse(SIM).nodes.get("Simulation")!.label, false)!;
    expect(f.name).toBe("Simulation");
    expect(f.bold).toBe(true);
    expect(f.lines[0]).toEqual({ text: "Local subclass of:" });
    expect(f.lines[1]).toEqual({ code: "", curie: "PMD_0000933", label: "simulation process" });
    expect(f.lines).toContainEqual({ text: "walltime, n_cores, job_id" });
    expect(f.lines).toContainEqual({ text: "" });
  });

  test("vocabulary entries with codes", () => {
    const f = edit.readBoxLabel(mermaid.parse(SIM).nodes.get("CalcType")!.label, true)!;
    const entries = f.lines.filter((l) => "curie" in l);
    expect(entries).toContainEqual({ code: "MC", curie: "PMD_0000862", label: "Monte Carlo simulation" });
    expect(entries).toContainEqual({ code: "STRUC_OPT", curie: "PMD_0000956", label: "" });
    expect(entries).toHaveLength(5);
  });

  test("labels the fields cannot write back are left to the raw editor", () => {
    for (const raw of [
      "<b>A</b><br>see PMD_0000933 here", // text before the ID that is not a code
      "<b>A</b><br>PMD_0000933 x<br>PMD_0000583 y", // two IDs in a box that is not a vocabulary
      "<b>A</b><br><i>italic</i>",
      "<b>A</b><br/>x",
      "<b>A</b><br> spaced",
      "<b>A</b> and <b>B</b>",
      "<b>A PMD_0000933</b>",
      "PMD_0000933 x&nbsp;y",
    ]) {
      expect(edit.readBoxLabel(raw, false), raw).toBeNull();
    }
    expect(edit.readBoxLabel("<b>A</b><br>PMD_0000933 x<br>PMD_0000583 y", true)).not.toBeNull();
    expect(edit.readArrowLabel("has part BFO_0000051")).toBeNull();
    expect(edit.readArrowLabel("has part<br>BFO_0000051 has part")).toBeNull();
    expect(edit.readArrowLabel("calculation_type<br>local vocabulary field"))
      .toEqual({ name: "calculation_type", curie: "", lines: ["local vocabulary field"] });
  });
});

describe("special characters survive a round trip", () => {
  const texts = [
    'a "quoted" name', "x < y > z", "<b>not bold</b>", "a<br>b", "AT&T", "&amp; literal", "&#35; ref", "&copy",
    "#quot; literal", "#35;", "##a;", "a | b", "Ümlaut and ß", "50% & more", "tab\there", "colon: here",
  ];

  test.each(texts)("%s", (t) => {
    expect(labels.segments(edit.escapeText(t))).toEqual([t]);
    expect(labels.segments(edit.escapeText(t, true))).toEqual([t]);
    expect(edit.escapeText(t, true)).not.toContain("|");

    const label = edit.writeBoxLabel({ name: t, bold: true, lines: [{ text: t }, { code: "", curie: "PMD_0000933", label: t }] });
    const changes = edit.addBox(SIM, { id: "Odd", label, kind: "local", parents: [] }, config);
    const node = mermaid.parse(apply(SIM, changes)).nodes.get("Odd")!;
    expect(node.label).toBe(label);
    expect(edit.readBoxLabel(node.label, false)).toEqual(
      { name: t, bold: true, lines: [{ text: t }, { code: "", curie: "PMD_0000933", label: t }] });
    expect(labels.title(node.label, "")).toBe(t);

    const arrowLabel = edit.writeArrowLabel({ name: t, curie: "OBI_0000293", lines: [t] });
    const after = apply(SIM, edit.addArrow(SIM, { src: "Simulation", dst: "HPC", kind: "relation", label: arrowLabel }));
    const edge = mermaid.parse(after).edges.at(-1)!;
    expect(edit.readArrowLabel(edge.label)).toEqual({ name: t, curie: "OBI_0000293", lines: [t] });
  });

  test("raw labels with quotes and line breaks are made safe", () => {
    const changes = edit.addBox(SIM, { id: "Raw", label: 'say "hi"\nnext', kind: null, parents: [] }, config);
    const node = mermaid.parse(apply(SIM, changes)).nodes.get("Raw")!;
    expect(labels.segments(node.label)).toEqual(['say "hi"', "next"]);
  });

  test("a pipe label keeps its form and escapes |", () => {
    const text = "flowchart TB\n  A -->|old| B\n";
    const after = apply(text, edit.updateArrow(text, 0, { src: "A", dst: "B", kind: "relation", label: "x | y" }));
    expect(after).toBe('flowchart TB\n  A -->|"x #124; y"| B\n');
    expect(labels.segments(mermaid.parse(after).edges[0]!.label)).toEqual(["x | y"]);
  });
});

describe("boxes", () => {
  test("add a box with parents after the last model line", () => {
    const label = edit.writeBoxLabel({
      name: "Relaxation", bold: true,
      lines: [{ code: "", curie: "PMD_0000956", label: "structural optimization simulation" }, { text: "max_steps" }],
    });
    const after = apply(SIM, edit.addBox(SIM, { id: "Relaxation", label, kind: "local",
                                                parents: ["Simulation", "Computation"] }, config));
    const block = [
      "",
      '    Relaxation["<b>Relaxation</b><br>PMD_0000956 structural optimization simulation<br>max_steps"]:::local',
      "    Simulation --> Relaxation",
      "    Computation --> Relaxation",
    ];
    // Right after the last box (the legend), before the styles.
    const legend = mermaid.parse(SIM).nodes.get("Note")!.line;
    const lines = SIM.split("\n");
    expect(after).toBe([...lines.slice(0, legend), ...block, ...lines.slice(legend)].join("\n"));
    const d = mermaid.parse(after);
    expect(d.findings).toEqual(mermaid.parse(SIM).findings);
    expect([...d.nodes.get("Relaxation")!.css]).toEqual(["local"]);
    expect(d.edges.filter((e) => e.dst === "Relaxation").map((e) => [e.src, e.kind]))
      .toEqual([["Simulation", "inherit"], ["Computation", "inherit"]]);
  });

  test("child-parent direction writes Child --> Parent", () => {
    const cfg = defaultConfig({ inheritDirection: "child-parent" });
    const after = apply(SIM, edit.addBox(SIM, { id: "X", label: "x", kind: null, parents: ["Simulation"] }, cfg));
    expect(after).toContain("    X --> Simulation\n");
    expect(edit.boxInfo(after, "X", cfg)!.parents).toEqual(["Simulation"]);
  });

  test("new ids are valid and unique; bad ids are refused", () => {
    expect(edit.newNodeId("Simulation", SIM)).toBe("Simulation2");
    expect(edit.newNodeId("simulated system", SIM)).toBe("SimulatedSystem");
    expect(edit.newNodeId("Ab initio MD (über)", SIM)).toBe("AbInitioMDUber");
    expect(edit.newNodeId("3D grid", SIM)).toBe("N3DGrid");
    expect(edit.newNodeId("end", SIM)).toBe("EndBox");
    expect(edit.newNodeId("!!!", SIM)).toBe("Box");
    expect(() => edit.addBox(SIM, { id: "HPC", label: "x", kind: null, parents: [] }, config)).toThrow(edit.EditError);
    expect(() => edit.addBox(SIM, { id: "a b", label: "x", kind: null, parents: [] }, config)).toThrow(edit.EditError);
    expect(() => edit.addBox(SIM, { id: "end", label: "x", kind: null, parents: [] }, config)).toThrow(edit.EditError);
  });

  test("update a label, a kind and parents touches only those lines", () => {
    const info = edit.boxInfo(SIM, "HPC", config)!;
    expect(info.parents).toEqual(["MatEnt"]);
    expect(info.kind).toBe("local");
    const label = info.label.replace("computing device", "computer");
    const after = apply(SIM, edit.updateBox(SIM, "HPC", { id: "HPC", label, kind: "upper", parents: ["MatEnt", "Root"] },
                                            config));
    const { removed, added } = lineDiff(SIM, after);
    expect(removed).toEqual([`    HPC["${info.label}"]:::local`]);
    expect(added).toEqual([`    HPC["${label}"]:::upper`, "    Root --> HPC"]);
    expect(after.indexOf("    Root --> HPC")).toBe(after.indexOf("    MatEnt --> HPC") + "    MatEnt --> HPC\n".length);
  });

  test("set parents removes and adds inheritance arrows", () => {
    const after = apply(SIM, edit.setParents(SIM, "Simulation", ["Activity"], config));
    const { removed, added } = lineDiff(SIM, after);
    expect(removed).toEqual(["    Computation --> Simulation"]);
    expect(added).toEqual(["    Activity --> Simulation"]);
    expect(edit.boxInfo(after, "Simulation", config)!.parents).toEqual(["Activity"]);
  });

  test("adding and removing a kind", () => {
    const text = 'flowchart TB\n  A["a"]\n  B["b"]:::local;\n';
    const a = apply(text, edit.updateBox(text, "A", { id: "A", label: "a", kind: "vocab", parents: [] }, config));
    expect(a).toBe('flowchart TB\n  A["a"]:::vocab\n  B["b"]:::local;\n');
    const b = apply(text, edit.updateBox(text, "B", { id: "B", label: "b", kind: null, parents: [] }, config));
    expect(b).toBe('flowchart TB\n  A["a"]\n  B["b"];\n');
  });

  test("an unquoted label is quoted only when it changes", () => {
    const text = "flowchart TB\n  A[plain label]\n";
    expect(edit.updateBox(text, "A", { id: "A", label: "plain label", kind: null, parents: [] }, config)).toEqual([]);
    expect(apply(text, edit.updateBox(text, "A", { id: "A", label: "new", kind: null, parents: [] }, config)))
      .toBe('flowchart TB\n  A["new"]\n');
  });

  test("rename a box everywhere it is used", () => {
    const text = 'flowchart TB\n  A["a"]\n  B["b"]\n  A --> B\n  B -. "x" .-> A:::local\n  class A,B local\n  style A fill:#fff\n';
    const after = apply(text, edit.updateBox(text, "A", { id: "Alpha", label: "a", kind: null, parents: [] }, config));
    expect(after).toBe('flowchart TB\n  Alpha["a"]\n  B["b"]\n  Alpha --> B\n  B -. "x" .-> Alpha:::local\n' +
                       "  class Alpha,B local\n  style Alpha fill:#fff\n");
    expect(() => edit.updateBox(text, "A", { id: "B", label: "a", kind: null, parents: [] }, config)).toThrow(/already/);
  });

  test("rename and change parents at once", () => {
    const text = 'flowchart TB\n  P["p"]\n  Q["q"]\n  A["a"]\n  P --> A\n';
    const after = apply(text, edit.updateBox(text, "A", { id: "B", label: "a", kind: null, parents: ["Q"] }, config));
    expect(after).toBe('flowchart TB\n  P["p"]\n  Q["q"]\n  B["a"]\n  Q --> B\n');
  });

  test("a box that only appears in arrows gets a definition line", () => {
    const text = "flowchart TB\n  A --> B\n";
    const after = apply(text, edit.updateBox(text, "B", { id: "B", label: "<b>B</b>", kind: "local", parents: ["A"] },
                                             config));
    expect(after).toBe('flowchart TB\n  B["<b>B</b>"]:::local\n  A --> B\n');
    expect(mermaid.parse(after).findings.map((f) => f.nodeId)).toEqual(["A"]);
  });

  test("remove a box removes exactly its lines", () => {
    const d = mermaid.parse(SIM);
    const own = new Set([d.nodes.get("Simulation")!.line,
                         ...d.edges.filter((e) => e.src === "Simulation" || e.dst === "Simulation").map((e) => e.line)]);
    const { changes, lines } = edit.removeBox(SIM, "Simulation");
    expect(lines.map((l) => l.number)).toEqual([...own].sort((a, b) => a - b));
    expect(lines.every((l) => l.removed)).toBe(true);
    const expected = SIM.split("\n").filter((_, i) => !own.has(i + 1)).join("\n");
    expect(apply(SIM, changes)).toBe(expected);
    expect(mermaid.parse(expected).nodes.has("Simulation")).toBe(false);
  });

  test("remove a box from class and style statements", () => {
    const text = 'flowchart TB\n  A["a"]\n  B["b"]\n  class A, B local\n  class B vocab\n  style B fill:#fff\n  click B cb\n';
    const { changes, lines } = edit.removeBox(text, "B");
    expect(apply(text, changes)).toBe('flowchart TB\n  A["a"]\n  class A local\n');
    expect(lines).toEqual([
      { number: 3, text: 'B["b"]', removed: true },
      { number: 4, text: "class A, B local", removed: false },
      { number: 5, text: "class B vocab", removed: true },
      { number: 6, text: "style B fill:#fff", removed: true },
      { number: 7, text: "click B cb", removed: true },
    ]);
  });

  test("removing the last lines of a file without a final line break", () => {
    const text = 'flowchart TB\n  A["a"]\n  B["b"]\n  A --> B';
    expect(apply(text, edit.removeBox(text, "B").changes)).toBe('flowchart TB\n  A["a"]');
    expect(apply(text, edit.removeArrow(text, 0))).toBe('flowchart TB\n  A["a"]\n  B["b"]');
  });

  test("frontmatter is not read as diagram lines", () => {
    const text = '---\ntitle: A["x"]\n---\nflowchart TB\n  A["a"]\n';
    expect(edit.boxInfo(text, "A", config)!.line).toBe(5);
    const after = apply(text, edit.removeBox(text, "A").changes);
    expect(after).toBe('---\ntitle: A["x"]\n---\nflowchart TB\n');
  });
});

describe("arrows", () => {
  test("add an arrow after the last arrow", () => {
    const label = edit.writeArrowLabel({ name: "has participant", curie: "RO_0000057", lines: [] });
    const after = apply(SIM, edit.addArrow(SIM, { src: "Analysis", dst: "HPC", kind: "relation", label }));
    const { removed, added } = lineDiff(SIM, after);
    expect(removed).toEqual([]);
    expect(added).toEqual(['    Analysis -. "has participant<br>RO_0000057" .-> HPC']);
    const d = mermaid.parse(after);
    expect(d.edges.at(-1)).toMatchObject({ src: "Analysis", dst: "HPC", kind: "relation", label });
    const last = mermaid.parse(SIM).edges.at(-1)!.line;
    expect(d.edges.at(-1)!.line).toBe(last + 1);
  });

  test("a relation without an ID or label", () => {
    const after = apply(SIM, edit.addArrow(SIM, { src: "Analysis", dst: "CalcType", kind: "relation", label: "calculation_type" }));
    expect(mermaid.parse(after).edges.at(-1)).toMatchObject({ kind: "relation", label: "calculation_type" });
    const bare = apply(SIM, edit.addArrow(SIM, { src: "Analysis", dst: "CalcType", kind: "relation", label: "" }));
    expect(mermaid.parse(bare).edges.at(-1)).toMatchObject({ kind: "relation", label: "", arrow: "-.->" });
  });

  test("change the label, the ends and the kind", () => {
    const text = 'flowchart TB\n  A -. "old" .-> B\n  A ==> B\n  A -- "x" --> B\n';
    const one = (i: number, spec: edit.ArrowSpec) => apply(text, edit.updateArrow(text, i, spec)).split("\n")[i + 1];
    expect(one(0, { src: "A", dst: "B", kind: "relation", label: "new" })).toBe('  A -. "new" .-> B');
    expect(one(0, { src: "C", dst: "D", kind: "relation", label: "old" })).toBe('  C -. "old" .-> D');
    expect(one(0, { src: "A", dst: "B", kind: "inherit", label: "" })).toBe("  A --> B");
    expect(one(0, { src: "A", dst: "B", kind: "relation", label: "" })).toBe("  A -.-> B");
    expect(one(1, { src: "A", dst: "B", kind: "relation", label: "y" })).toBe('  A == "y" ==> B');
    expect(one(2, { src: "A", dst: "B", kind: "relation", label: "" })).toBe("  A -.-> B");
    const inherit = "flowchart TB\n  A --> B\n";
    expect(apply(inherit, edit.updateArrow(inherit, 0, { src: "A", dst: "B", kind: "relation", label: "r" })))
      .toBe('flowchart TB\n  A -. "r" .-> B\n');
  });

  test("remove an arrow", () => {
    const d = mermaid.parse(SIM);
    const i = d.edges.findIndex((e) => e.src === "CalcProp" && e.dst === "ValueSpec");
    const after = apply(SIM, edit.removeArrow(SIM, i));
    expect(lineDiff(SIM, after)).toEqual({ removed: ['    CalcProp -. "has value specification<br>OBI_0001938" .-> ValueSpec'],
                                          added: [] });
  });
});

describe("new diagram", () => {
  test("the template has the fixture's classDef lines and parses cleanly", () => {
    const fromFixture = SIM.split("\n").filter((l) => l.trim().startsWith("classDef ")).map((l) => l.trim());
    expect(edit.CLASS_DEFS).toEqual(fromFixture);
    expect(edit.styleClasses(edit.TEMPLATE)).toEqual(["base", "upper", "local", "section", "vocab", "note"]);
    const d = mermaid.parse(edit.TEMPLATE);
    expect(d.nodes.size).toBe(0);
    expect(d.findings).toEqual([]);
  });

  test("boxes go before the styles, then after each other", () => {
    let text = edit.TEMPLATE;
    text = apply(text, edit.addBox(text, { id: "A", label: "<b>A</b>", kind: "local", parents: [] }, config));
    text = apply(text, edit.addBox(text, { id: "B", label: "<b>B</b>", kind: "local", parents: ["A"] }, config));
    text = apply(text, edit.addArrow(text, { src: "B", dst: "A", kind: "relation", label: "r" }));
    const body = text.split("\n").filter((l) => !l.startsWith("%%"));
    expect(body.slice(0, 9)).toEqual([
      "flowchart TB", "", "", '    A["<b>A</b>"]:::local', "", '    B["<b>B</b>"]:::local', "    A --> B",
      '    B -. "r" .-> A', "",
    ]);
    expect(mermaid.parse(text).findings).toEqual([]);
  });

  test("an empty text gets a header", () => {
    const text = apply("", edit.addBox("", { id: "A", label: "a", kind: null, parents: [] }, config));
    expect(text).toBe('flowchart TB\n    A["a"]\n');
  });
});

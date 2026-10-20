/**
 * A small parser for the parts of Mermaid flowcharts that describe a data model.
 *
 * It reads nodes (with their labels and style classes) and arrows. Everything else that
 * Mermaid allows in a flowchart (styling, comments, subgraphs, ...) is recognised and
 * skipped. Lines it does not understand are reported, never silently dropped.
 */

import { WARNING, finding, type Edge, type Finding, type Node } from "./model.js";
import { S, W, W_MEMBERS, rstrip, splitlines, strip } from "./py.js";

const WORD = `[${W_MEMBERS}]+`; // Python \w+
const CSS = `[${W_MEMBERS}-]+`; // Python [\w-]+
const ID = `[A-Za-z_][${W_MEMBERS}-]*`;

// Statements that carry no model information.
const SKIP_RE = new RegExp(
  `^(?:%%.*|(?:flowchart|graph)(?:${S}+${WORD})?|classDef${S}.*|style${S}.*|linkStyle${S}.*|click${S}.*` +
  `|subgraph(?!${W}).*|end|direction${S}+${WORD}|accTitle${S}*:.*|accDescr(?!${W}).*)$`,
  "u",
);
const CLASS_STMT_RE = new RegExp(`^class${S}+(${ID}(?:${S}*,${S}*${ID})*)${S}+(${CSS})${S}*;?$`, "u");

// Node shapes as [opening, closing] pairs. Longer markers first.
const SHAPES: [string, string][] = [
  ["[[", "]]"], ["[(", ")]"], ["([", "])"], ["((", "))"], ["{{", "}}"],
  ["[/", "/]"], ["[\\", "\\]"], ["[/", "\\]"], ["[\\", "/]"],
  [">", "]"], ["[", "]"], ["(", ")"], ["{", "}"],
];

const EDGE_RE = new RegExp(
  `^(?<src>${ID})(?::::(?<src_css>${CSS}))?${S}*` +
  "(?:" +
    `-\\.${S}*(?<l1>"[^"]*"|[^"]*?)${S}*\\.+->` + //       A -. label .-> B
    `|-\\.+->${S}*(?:\\|(?<l2>[^|]*)\\|)?` + //            A -.-> B  or  A -.->|label| B
    `|==${S}*(?<l3>"[^"]*"|[^"]*?)${S}*=+>` + //          A == label ==> B
    `|=+>${S}*(?:\\|(?<l4>[^|]*)\\|)?` + //               A ==> B   or  A ==>|label| B
    `|--${S}*(?<l5>"[^"]*"|[^"]*?)${S}*-+>` + //          A -- label --> B
    `|-{2,}>${S}*(?:\\|(?<l6>[^|]*)\\|)?` + //            A --> B   or  A -->|label| B
  `)${S}*(?<dst>${ID})(?::::(?<dst_css>${CSS}))?${S}*;?$`,
  "du",
);
const UNDIRECTED_RE = new RegExp(
  `^${ID}${S}*(?:-{3,}|-\\.+-|={3,})${S}*(?:\\|[^|]*\\|)?${S}*${ID}${S}*;?$`, "u");
const NODE_ID_RE = new RegExp(`^(${ID})${S}*`, "u");
const NODE_TAIL_RE = new RegExp(`^(?::::(${CSS}))?$`, "u");
const ARROW_CSS_RE = new RegExp(`^:::${CSS}`, "u");
const INHERIT_ARROW_RE = /^-{2,}>$/u;

export interface Diagram {
  nodes: Map<string, Node>;
  edges: Edge[];
  findings: Finding[];
}

function unquote(text: string): string {
  text = strip(text);
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') return text.slice(1, -1);
  return text;
}

function parseNode(line: string): [string, string, string | undefined] | null {
  const m = NODE_ID_RE.exec(line);
  if (!m) return null;
  const nodeId = m[1]!;
  const rest = line.slice(m[0].length);
  for (const [opening, closing] of SHAPES) {
    if (!rest.startsWith(opening)) continue;
    const end = rest.lastIndexOf(closing);
    if (end < opening.length) continue;
    const body = rest.slice(opening.length, end);
    const tail = strip(rstrip(strip(rest.slice(end + closing.length)), ";"));
    const tm = NODE_TAIL_RE.exec(tail);
    if (tm === null) continue;
    return [nodeId, unquote(body), tm[1]];
  }
  return null;
}

/** Return the index of the first line after a YAML frontmatter block (or 0). */
function stripFrontmatter(lines: string[]): number {
  let i = 0;
  while (i < lines.length && !strip(lines[i]!)) i++;
  if (i < lines.length && strip(lines[i]!) === "---") {
    for (let j = i + 1; j < lines.length; j++) {
      if (strip(lines[j]!) === "---") return j + 1;
    }
  }
  return 0;
}

export function parse(text: string): Diagram {
  const diagram: Diagram = { nodes: new Map(), edges: [], findings: [] };
  const lines = splitlines(text);
  const start = stripFrontmatter(lines);
  const pendingCss: [string[], string, number][] = [];
  const edgeCss: [string, string][] = []; // `A:::cls --> B` styles the node A

  for (let index = start; index < lines.length; index++) {
    const number = index + 1;
    const line = strip(lines[index]!);
    if (!line || SKIP_RE.test(line)) continue;

    let m = CLASS_STMT_RE.exec(line);
    if (m) {
      const ids = m[1]!.split(",").map((x) => strip(x));
      pendingCss.push([ids, m[2]!, number]);
      continue;
    }

    m = EDGE_RE.exec(line);
    if (m) {
      const g = m.groups!;
      const label = unquote(["l1", "l2", "l3", "l4", "l5", "l6"].map((k) => g[k]).find((v) => v) ?? "");
      const indices = m.indices!.groups!;
      const arrow = strip(line.slice(indices.src![1], indices.dst![0]));
      const arrowCore = strip(arrow.replace(ARROW_CSS_RE, ""));
      const kind = INHERIT_ARROW_RE.test(arrowCore) ? "inherit" : "relation";
      diagram.edges.push({ src: g.src!, dst: g.dst!, kind, label, line: number, arrow: arrowCore });
      for (const end of ["src", "dst"] as const) {
        const css = g[`${end}_css`];
        if (css) edgeCss.push([g[end]!, css]);
      }
      continue;
    }

    const node = parseNode(line);
    if (node) {
      const [nodeId, label, css] = node;
      const existing = diagram.nodes.get(nodeId);
      if (existing && existing.defined) {
        diagram.findings.push(finding(
          WARNING, "parse",
          `node '${nodeId}' is defined twice; the later definition (line ${number}) is used`,
          `line ${number}`, "", { nodeId, line: number }));
      }
      diagram.nodes.set(nodeId, { id: nodeId, label, line: number, css: new Set(css ? [css] : []), defined: true });
      continue;
    }

    if (UNDIRECTED_RE.test(line)) {
      diagram.findings.push(finding(
        WARNING, "parse",
        "arrow without a direction is ignored (use --> or -.-> so the meaning is clear)",
        `line ${number}`, line, { line: number }));
      continue;
    }

    diagram.findings.push(finding(
      WARNING, "parse", "line not understood, ignored", `line ${number}`, line, { line: number }));
  }

  for (const [ids, css, number] of pendingCss) {
    for (const nodeId of ids) {
      const node = diagram.nodes.get(nodeId);
      if (node) {
        node.css.add(css);
      } else {
        diagram.findings.push(finding(
          WARNING, "parse", `'class' statement names unknown node '${nodeId}'`,
          `line ${number}`, "", { line: number }));
      }
    }
  }

  diagram.edges.forEach((edge, edgeIndex) => {
    for (const nodeId of [edge.src, edge.dst]) {
      if (!diagram.nodes.has(nodeId)) {
        diagram.nodes.set(nodeId, { id: nodeId, label: nodeId, line: edge.line, css: new Set(), defined: false });
        diagram.findings.push(finding(
          WARNING, "parse",
          `node '${nodeId}' only appears in an arrow and has no label`,
          `line ${edge.line}`, "", { nodeId, edgeIndex, line: edge.line }));
      }
    }
  });
  for (const [nodeId, css] of edgeCss) {
    diagram.nodes.get(nodeId)!.css.add(css);
  }
  return diagram;
}

"""A small parser for the parts of Mermaid flowcharts that describe a data model.

It reads nodes (with their labels and style classes) and arrows. Everything else that
Mermaid allows in a flowchart (styling, comments, subgraphs, ...) is recognised and
skipped. Lines it does not understand are reported, never silently dropped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .model import WARNING, Edge, Finding, Node

ID = r"[A-Za-z_][\w-]*"

# Statements that carry no model information.
_SKIP_RE = re.compile(
    r"^(?:%%.*|(?:flowchart|graph)(?:\s+\w+)?|classDef\s.*|style\s.*|linkStyle\s.*|click\s.*"
    r"|subgraph\b.*|end|direction\s+\w+|accTitle\s*:.*|accDescr\b.*)$"
)
_CLASS_STMT_RE = re.compile(rf"^class\s+({ID}(?:\s*,\s*{ID})*)\s+([\w-]+)\s*;?$")

# Node shapes as (opening, closing) pairs. Longer markers first.
_SHAPES = [
    ("[[", "]]"), ("[(", ")]"), ("([", "])"), ("((", "))"), ("{{", "}}"),
    ("[/", "/]"), ("[\\", "\\]"), ("[/", "\\]"), ("[\\", "/]"),
    (">", "]"), ("[", "]"), ("(", ")"), ("{", "}"),
]

_EDGE_RE = re.compile(
    rf"""^(?P<src>{ID})(?::::(?P<src_css>[\w-]+))?\s*
    (?:
        -\.\s*(?P<l1>"[^"]*"|[^"]*?)\s*\.+->        # A -. label .-> B
      | -\.+->\s*(?:\|(?P<l2>[^|]*)\|)?            # A -.-> B  or  A -.->|label| B
      | ==\s*(?P<l3>"[^"]*"|[^"]*?)\s*=+>          # A == label ==> B
      | =+>\s*(?:\|(?P<l4>[^|]*)\|)?               # A ==> B   or  A ==>|label| B
      | --\s*(?P<l5>"[^"]*"|[^"]*?)\s*-+>          # A -- label --> B
      | -{{2,}}>\s*(?:\|(?P<l6>[^|]*)\|)?           # A --> B   or  A -->|label| B
    )\s*(?P<dst>{ID})(?::::(?P<dst_css>[\w-]+))?\s*;?$""",
    re.VERBOSE,
)
_UNDIRECTED_RE = re.compile(rf"^{ID}\s*(?:-{{3,}}|-\.+-|={{3,}})\s*(?:\|[^|]*\|)?\s*{ID}\s*;?$")


@dataclass
class Diagram:
    nodes: dict[str, Node] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)


def _unquote(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return text[1:-1]
    return text


def _parse_node(line: str):
    m = re.match(rf"^({ID})\s*", line)
    if not m:
        return None
    node_id, rest = m.group(1), line[m.end():]
    for opening, closing in _SHAPES:
        if not rest.startswith(opening):
            continue
        end = rest.rfind(closing)
        if end < len(opening):
            continue
        body = rest[len(opening):end]
        tail = rest[end + len(closing):].strip().rstrip(";").strip()
        tm = re.fullmatch(r"(?::::([\w-]+))?", tail)
        if tm is None:
            continue
        return node_id, _unquote(body), tm.group(1)
    return None


def _strip_frontmatter(lines: list[str]) -> int:
    """Return the index of the first line after a YAML frontmatter block (or 0)."""
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and lines[i].strip() == "---":
        for j in range(i + 1, len(lines)):
            if lines[j].strip() == "---":
                return j + 1
    return 0


def parse(text: str) -> Diagram:
    diagram = Diagram()
    lines = text.splitlines()
    start = _strip_frontmatter(lines)
    pending_css: list[tuple[list[str], str, int]] = []
    edge_css: list[tuple[str, str]] = []  # `A:::cls --> B` styles the node A

    for number, raw in enumerate(lines[start:], start=start + 1):
        line = raw.strip()
        if not line or _SKIP_RE.match(line):
            continue

        m = _CLASS_STMT_RE.match(line)
        if m:
            ids = [x.strip() for x in m.group(1).split(",")]
            pending_css.append((ids, m.group(2), number))
            continue

        m = _EDGE_RE.match(line)
        if m:
            label = next((m.group(g) for g in ("l1", "l2", "l3", "l4", "l5", "l6") if m.group(g)), "")
            label = _unquote(label)
            arrow = line[m.end("src"):m.start("dst")].strip()
            arrow_core = re.sub(r"^:::[\w-]+", "", arrow).strip()
            kind = "inherit" if re.fullmatch(r"-{2,}>", arrow_core) else "relation"
            diagram.edges.append(Edge(m.group("src"), m.group("dst"), kind, label, number, arrow_core))
            for end in ("src", "dst"):
                if m.group(f"{end}_css"):
                    edge_css.append((m.group(end), m.group(f"{end}_css")))
            continue

        node = _parse_node(line)
        if node:
            node_id, label, css = node
            existing = diagram.nodes.get(node_id)
            if existing and existing.defined:
                diagram.findings.append(Finding(
                    WARNING, "parse",
                    f"node '{node_id}' is defined twice; the later definition (line {number}) is used",
                    where=f"line {number}"))
            diagram.nodes[node_id] = Node(node_id, label, number, {css} if css else set())
            continue

        if _UNDIRECTED_RE.match(line):
            diagram.findings.append(Finding(
                WARNING, "parse",
                "arrow without a direction is ignored (use --> or -.-> so the meaning is clear)",
                where=f"line {number}", details=line))
            continue

        diagram.findings.append(Finding(
            WARNING, "parse", "line not understood, ignored", where=f"line {number}", details=line))

    for ids, css, number in pending_css:
        for node_id in ids:
            if node_id in diagram.nodes:
                diagram.nodes[node_id].css.add(css)
            else:
                diagram.findings.append(Finding(
                    WARNING, "parse", f"'class' statement names unknown node '{node_id}'",
                    where=f"line {number}"))

    for edge in diagram.edges:
        for node_id in (edge.src, edge.dst):
            if node_id not in diagram.nodes:
                diagram.nodes[node_id] = Node(node_id, node_id, edge.line, set(), defined=False)
                diagram.findings.append(Finding(
                    WARNING, "parse",
                    f"node '{node_id}' only appears in an arrow and has no label",
                    where=f"line {edge.line}"))
    for node_id, css in edge_css:
        diagram.nodes[node_id].css.add(css)
    return diagram

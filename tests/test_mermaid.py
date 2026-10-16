"""Parser tests. No Java or network needed."""

from pathlib import Path

import pytest

from mermantics import mermaid

FIXTURES = Path(__file__).parent / "fixtures"


def parse(text):
    return mermaid.parse(text)


def test_frontmatter_header_comments_and_styles_are_skipped():
    d = parse(
        "---\nconfig:\n  flowchart:\n    nodeSpacing: 50\n---\n"
        "flowchart TB\n%% a comment\nA[\"x\"]\nclassDef base fill:#fff\nstyle A fill:#000\n"
        "linkStyle 0 stroke:#f00\nclick A callback\nsubgraph S\nend\ndirection LR\n"
    )
    assert list(d.nodes) == ["A"]
    assert d.findings == []


@pytest.mark.parametrize("line,label", [
    ('A["quoted <b>label</b>"]', "quoted <b>label</b>"),
    ("A[plain label]", "plain label"),
    ('A("round")', "round"),
    ('A{"rhombus"}', "rhombus"),
    ('A[["subroutine"]]', "subroutine"),
    ('A(["stadium"])', "stadium"),
    ('A(("circle"))', "circle"),
    ('A{{"hexagon"}}', "hexagon"),
    ('A[("database")]', "database"),
    ('A>"flag"]', "flag"),
    ('A["with ] bracket inside"]', "with ] bracket inside"),
])
def test_node_shapes(line, label):
    d = parse(f"flowchart TB\n{line}\n")
    assert d.nodes["A"].label == label
    assert d.findings == []


def test_node_style_class_inline_and_class_statement():
    d = parse('flowchart TB\nA["a"]:::local\nB["b"]\nC["c"]\nclass B,C vocab\n')
    assert d.nodes["A"].css == {"local"}
    assert d.nodes["B"].css == {"vocab"}
    assert d.nodes["C"].css == {"vocab"}


@pytest.mark.parametrize("line,kind,label", [
    ("A --> B", "inherit", ""),
    ("A ---> B", "inherit", ""),
    ("A -->|has part BFO_0000051| B", "relation", "has part BFO_0000051"),
    ('A -- "has part<br>BFO_0000051" --> B', "relation", "has part<br>BFO_0000051"),
    ("A -- has part --> B", "relation", "has part"),
    ("A -.-> B", "relation", ""),
    ('A -. "has part<br>BFO_0000051" .-> B', "relation", "has part<br>BFO_0000051"),
    ("A -. has part .-> B", "relation", "has part"),
    ("A -.->|has part| B", "relation", "has part"),
    ("A ==> B", "relation", ""),
    ('A == "x" ==> B', "relation", "x"),
    ("A:::cls --> B", "inherit", ""),
])
def test_arrows(line, kind, label):
    d = parse(f'flowchart TB\nA["a"]\nB["b"]\n{line}\n')
    assert len(d.edges) == 1
    e = d.edges[0]
    assert (e.src, e.dst, e.kind, e.label) == ("A", "B", kind, label)
    assert d.findings == []


def test_undirected_arrow_is_reported():
    d = parse('flowchart TB\nA["a"]\nB["b"]\nA --- B\n')
    assert d.edges == []
    assert any("without a direction" in f.message for f in d.findings)


def test_unknown_line_is_reported_with_line_number():
    d = parse('flowchart TB\nA["a"]\nthis is not mermaid ???\n')
    assert len(d.findings) == 1
    assert d.findings[0].where == "line 3"


def test_node_only_in_arrow_is_created_and_reported():
    d = parse('flowchart TB\nA["a"]\nA --> B\n')
    assert "B" in d.nodes and not d.nodes["B"].defined
    assert any("only appears in an arrow" in f.message for f in d.findings)


def test_duplicate_node_is_reported():
    d = parse('flowchart TB\nA["a"]\nA["b"]\n')
    assert d.nodes["A"].label == "b"
    assert any("defined twice" in f.message for f in d.findings)


def test_example_diagram_parses_cleanly():
    d = parse((FIXTURES / "simulation-data-model.mmd").read_text())
    assert len(d.nodes) == 25
    assert len(d.edges) == 37
    assert sum(e.kind == "inherit" for e in d.edges) == 22
    assert d.findings == []
    assert d.nodes["CalcType"].css == {"vocab"}
    assert d.nodes["Note"].css == {"note"}


def test_style_class_on_arrow_ends():
    d = parse('flowchart TB\nA["a"]\nB["b"]\nA:::local --> B:::vocab\n')
    assert d.nodes["A"].css == {"local"} and d.nodes["B"].css == {"vocab"}
    assert d.edges[0].kind == "inherit"

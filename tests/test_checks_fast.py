"""Checks without a reasoner, against a tiny ontology. No Java or network needed."""

from pathlib import Path

import pytest

from mermantics import checks, mermaid
from mermantics.model import ERROR, NOTE, OK, WARNING, Config
from mermantics.ontology import Ontology

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def tiny():
    return Ontology.load([str(FIXTURES / "tiny.ttl")])


def run(text, onto, tmp_path, config=None):
    return checks.run(mermaid.parse(text), onto, config or Config(), None, tmp_path)


def levels(result, check):
    return [f.level for f in result.findings if f.check == check]


def messages(result, level):
    return [f.message for f in result.findings if f.level == level]


GOOD = """flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]:::local
    M["<b>Machine</b><br>TST_0000006 machine"]:::local
    T["<b>Kinds</b><br>FAST: TST_0000005 fast computation"]:::vocab
    L["legend TST_0000004"]:::note
    P -. "has input<br>TST_0000010" .-> M
    P -. "kind" .-> T
"""


def test_good_diagram_passes(tiny, tmp_path):
    r = run(GOOD, tiny, tmp_path)
    assert not r.has_errors
    assert messages(r, WARNING) == []
    assert any("all 4 ontology IDs exist" in m for m in messages(r, OK))
    assert any("domains and ranges" in m for m in messages(r, OK))
    assert any("1 term in 'Kinds' is a kind of 'computation'" in m for m in messages(r, OK))
    # the legend box is skipped, so its deprecated ID is not reported
    assert not any("deprecated" in m for m in messages(r, ERROR))


def test_unknown_and_deprecated_ids_are_errors(tiny, tmp_path):
    r = run('flowchart TB\nA["TST_0000999"]\nB["TST_0000004 obsolete thing"]\n', tiny, tmp_path)
    errs = messages(r, ERROR)
    assert any("TST_0000999 is not in the ontology" in m for m in errs)
    assert any("deprecated" in m for m in errs)


def test_wrong_kinds_are_reported(tiny, tmp_path):
    text = """flowchart TB
    A["TST_0000010 has input"]
    B["TST_0000002 object"]
    A -. "TST_0000001" .-> B
    B -. "comment TST_0000011" .-> A
    """
    r = run(text, tiny, tmp_path)
    errs = messages(r, ERROR)
    assert any("is an object property, but a box's ID should be a class" in m for m in errs)
    assert any("is a class, but an arrow's ID should be a property" in m for m in errs)
    assert any("not an object property" in m for m in messages(r, WARNING))


def test_label_mismatch_on_same_line_is_warning_missing_label_is_note(tiny, tmp_path):
    text = 'flowchart TB\nA["<b>A</b><br>TST_0000002 objekt"]\nB["<b>B</b><br>TST_0000002<br>something else"]\n'
    r = run(text, tiny, tmp_path)
    assert any("reads 'objekt'" in m for m in messages(r, WARNING))
    assert any("no label written next to TST_0000002" in m for m in messages(r, NOTE))


def test_domain_and_range_misfit(tiny, tmp_path):
    text = """flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    M -. "has input<br>TST_0000010" .-> P
    """
    r = run(text, tiny, tmp_path)
    warns = messages(r, WARNING)
    assert any("expects its subject to be 'process', but 'Machine' is not" in m for m in warns)
    assert any("expects its object to be 'object', but 'Proc' is not" in m for m in warns)


def test_union_domain(tiny, tmp_path):
    text = """flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    M -. "runs on<br>TST_0000012" .-> P
    """
    r = run(text, tiny, tmp_path)
    assert levels(r, "domain-range") == [OK]


def test_alignment_is_inherited_through_the_diagram(tiny, tmp_path):
    text = """flowchart TB
    Parent["<b>Parent</b><br>TST_0000001 process"]
    Child["<b>Child</b>"]
    O["<b>O</b><br>TST_0000002 object"]
    Parent --> Child
    Child -. "has input<br>TST_0000010" .-> O
    """
    r = run(text, tiny, tmp_path)
    assert levels(r, "domain-range") == [OK]


def test_child_parent_direction(tiny, tmp_path):
    text = """flowchart TB
    Parent["<b>Parent</b><br>TST_0000001 process"]
    Child["<b>Child</b>"]
    O["<b>O</b><br>TST_0000002 object"]
    Child --> Parent
    Child -. "has input<br>TST_0000010" .-> O
    """
    r = run(text, tiny, tmp_path, Config(inherit_direction="child-parent"))
    assert levels(r, "domain-range") == [OK]


def test_vocabulary_terms(tiny, tmp_path):
    text = """flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]
    T["<b>Kinds</b><br>SAME: TST_0000003 computation<br>FAST: TST_0000005 fast computation<br>BAD: TST_0000006 machine"]:::vocab
    P -. "kind" .-> T
    """
    r = run(text, tiny, tmp_path)
    assert any("SAME (TST_0000003)" in m and "adds no information" in m for m in messages(r, NOTE))
    assert any("BAD (TST_0000006) 'machine'" in m and "is not a kind of" in m for m in messages(r, WARNING))
    assert any("1 term in 'Kinds'" in m for m in messages(r, OK))


def test_arrows_touching_skipped_boxes_are_ignored(tiny, tmp_path):
    text = """flowchart TB
    A["legend"]:::note
    B["legend"]:::note
    P["<b>Proc</b><br>TST_0000003 computation"]
    A -. "example TST_0000004" .-> B
    A -. "no id" .-> P
    """
    r = run(text, tiny, tmp_path)
    assert not r.has_errors
    assert not any(f.check in ("ids", "labels") and f.level != OK for f in r.findings)


def test_style_class_on_arrow_end_marks_a_vocabulary(tiny, tmp_path):
    text = """flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]
    T["<b>Kinds</b><br>BAD: TST_0000006 machine"]
    P -. "kind" .-> T:::vocab
    """
    r = run(text, tiny, tmp_path)
    assert any("BAD (TST_0000006) 'machine'" in m and "is not a kind of" in m for m in messages(r, WARNING))


def test_inverse_of_a_sub_property(tiny, tmp_path):
    # 'main input of' is the inverse of 'has main input', a sub-property of 'has input'
    # (process -> object), so it goes from an object to a process.
    text = """flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    P -. "main input of<br>TST_0000015" .-> M
    """
    warns = messages(run(text, tiny, tmp_path), WARNING)
    assert any("expects its subject to be 'object' (inherited from 'has input'), but 'Proc' is not" in m
               for m in warns)
    assert any("expects its object to be 'process' (inherited from 'has input'), but 'Machine' is not" in m
               for m in warns)


def test_unchecked_constraints_block_the_ok(tiny, tmp_path):
    text = """flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    P["<b>Proc</b><br>TST_0000003 computation"]
    P -. "has input<br>TST_0000010" .-> M
    M -. "made by<br>TST_0000016" .-> P
    M -. "related to<br>TST_0000013" .-> P
    """
    r = run(text, tiny, tmp_path)
    assert OK not in levels(r, "domain-range")
    notes = messages(r, NOTE)
    assert any("could not check whether 'Proc' fits" in m for m in notes)
    assert any("1 relation arrow uses a property without a domain or range" in m for m in notes)


def test_imports_are_followed(tmp_path):
    main = tmp_path / "main.ttl"
    main.write_text(f"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
<http://example.org/main> a owl:Ontology ; owl:imports <{(FIXTURES / "tiny.ttl").as_uri()}> .
""")
    onto = Ontology.load([str(main)])
    r = run('flowchart TB\nP["TST_0000003 computation"]\n', onto, tmp_path)
    assert not r.has_errors

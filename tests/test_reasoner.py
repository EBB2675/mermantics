"""Checks with the reasoner. Need Java and ROBOT; the PMDco tests also need PMDco
(set PMDCO_FILE to a local copy to avoid downloading). Run only the fast ones with
`pytest -m "reasoner and not pmdco"`, or skip all of them with `-m "not reasoner"`."""

from pathlib import Path

import pytest

from mermantics import checks, mermaid
from mermantics.model import ERROR, NOTE, OK, WARNING, Config

FIXTURES = Path(__file__).parent / "fixtures"

pytestmark = pytest.mark.reasoner


def run(text, onto, robot, tmp_path):
    return checks.run(mermaid.parse(text), onto, Config(), robot, tmp_path)


def by(result, level, check=None):
    return [f for f in result.findings if f.level == level and (check is None or f.check == check)]


# ---- tiny ontology: a few seconds each --------------------------------------------------

def test_tiny_good(tiny, robot, tmp_path):
    text = """flowchart TB
    P["<b>Proc</b><br>TST_0000003 computation"]
    M["<b>Machine</b><br>TST_0000006 machine"]
    P -. "has input<br>TST_0000010" .-> M
    """
    r = run(text, tiny, robot, tmp_path)
    assert not r.has_errors
    assert by(r, OK, "schema") and by(r, OK, "data")


def test_tiny_impossible_class(tiny, robot, tmp_path):
    text = """flowchart TB
    P["<b>Proc</b><br>TST_0000001 process"]
    X["<b>Confused</b><br>TST_0000002 object"]
    P --> X
    """
    r = run(text, tiny, robot, tmp_path)
    errors = by(r, ERROR, "schema")
    assert len(errors) == 1
    assert "Confused" in errors[0].where
    assert "DisjointWith" in errors[0].details
    # the data check is skipped when the class structure is broken
    assert any(f.check == "data" for f in by(r, NOTE))


def test_tiny_inconsistent_data(tiny, robot, tmp_path):
    text = """flowchart TB
    M["<b>Machine</b><br>TST_0000006 machine"]
    M2["<b>Other machine</b><br>TST_0000006 machine"]
    M -. "has input<br>TST_0000010" .-> M2
    """
    r = run(text, tiny, robot, tmp_path)
    assert by(r, OK, "schema")
    data_errors = by(r, ERROR, "data")
    assert len(data_errors) == 1
    assert "Nothing" in data_errors[0].details
    assert by(r, WARNING, "domain-range")


# ---- PMDco: about 40 seconds each ------------------------------------------------------

@pytest.mark.pmdco
def test_example_diagram_against_pmdco(pmdco, robot, tmp_path):
    r = checks.run(mermaid.parse((FIXTURES / "simulation-data-model.mmd").read_text()),
                   pmdco, Config(), robot, tmp_path)
    assert not r.has_errors
    assert any("all 27 ontology IDs exist" in f.message for f in by(r, OK, "ids"))
    warnings = by(r, WARNING)
    assert len(warnings) == 2
    assert all(f.check == "labels" and "MD" in f.message for f in warnings)
    assert any("SC (PMD_0000933)" in f.message for f in by(r, NOTE, "vocabulary"))
    assert by(r, OK, "schema") and by(r, OK, "data") and by(r, OK, "domain-range")


@pytest.mark.pmdco
def test_broken_a_unknown_id(pmdco, robot, tmp_path):
    r = checks.run(mermaid.parse((FIXTURES / "broken-a-unknown-id.mmd").read_text()),
                   pmdco, Config(), robot, tmp_path)
    errors = by(r, ERROR)
    assert len(errors) == 1
    assert errors[0].check == "ids" and "IAO_0099999 is not in the ontology" in errors[0].message


@pytest.mark.pmdco
def test_broken_b_impossible_class(pmdco, robot, tmp_path):
    r = checks.run(mermaid.parse((FIXTURES / "broken-b-impossible-class.mmd").read_text()),
                   pmdco, Config(), robot, tmp_path)
    errors = by(r, ERROR)
    assert len(errors) == 1
    assert errors[0].check == "schema" and "SimulatedSystem" in errors[0].where
    assert "material entity" in errors[0].details and "DisjointWith" in errors[0].details


@pytest.mark.pmdco
def test_broken_c_wrong_relation(pmdco, robot, tmp_path):
    r = checks.run(mermaid.parse((FIXTURES / "broken-c-wrong-relation.mmd").read_text()),
                   pmdco, Config(), robot, tmp_path)
    errors = by(r, ERROR)
    assert len(errors) == 1 and errors[0].check == "data"
    assert "HPC (example) has specified input Simulation (example)" in errors[0].details
    dr = by(r, WARNING, "domain-range")
    assert any("'HPC' is not" in f.message for f in dr)
    assert any("'Simulation' is not" in f.message for f in dr)

"""Command-line behaviour. No Java or network needed (fast mode, tiny ontology)."""

import json
from pathlib import Path

from mermantics.cli import main

FIXTURES = Path(__file__).parent / "fixtures"
TINY = str(FIXTURES / "tiny.ttl")


def write(tmp_path, text):
    path = tmp_path / "d.mmd"
    path.write_text(text)
    return path


def test_exit_0_and_reports(tmp_path, capsys):
    d = write(tmp_path, 'flowchart TB\nP["<b>P</b><br>TST_0000003 computation"]\n')
    md, js, owl = tmp_path / "r.md", tmp_path / "r.json", tmp_path / "m.ttl"
    code = main([str(d), "-o", TINY, "--fast", "--report", str(md), "--json", str(js), "--emit-owl", str(owl)])
    assert code == 0
    assert "PASSED" in capsys.readouterr().out
    assert md.read_text().startswith("# Check of `d.mmd`")
    data = json.loads(js.read_text())
    assert data["passed"] is True and data["counts"]["error"] == 0
    assert "P_example" in owl.read_text()


def test_exit_1_on_errors(tmp_path, capsys):
    d = write(tmp_path, 'flowchart TB\nP["TST_0000999"]\n')
    assert main([str(d), "-o", TINY, "--fast"]) == 1
    assert "FAILED" in capsys.readouterr().out


def test_exit_2_on_missing_files(tmp_path, capsys):
    d = write(tmp_path, 'flowchart TB\nP["TST_0000003"]\n')
    assert main([str(tmp_path / "nope.mmd"), "-o", TINY, "--fast"]) == 2
    assert main([str(d), "-o", str(tmp_path / "nope.ttl"), "--fast"]) == 2
    empty = write(tmp_path, "flowchart TB\n")
    assert main([str(empty), "-o", TINY, "--fast"]) == 2


def test_custom_prefix_and_classes(tmp_path):
    d = write(tmp_path, 'flowchart TB\nP["XYZ_0000003"]:::legend\nQ["XYZ_0000003 computation"]\n')
    code = main([str(d), "-o", TINY, "--fast", "--prefix", "XYZ=http://purl.obolibrary.org/obo/TST_",
                 "--skip-class", "legend"])
    assert code == 0


def test_exit_2_when_report_cannot_be_written(tmp_path, capsys):
    d = write(tmp_path, 'flowchart TB\nP["<b>P</b><br>TST_0000003 computation"]\n')
    assert main([str(d), "-o", TINY, "--fast", "--report", str(tmp_path / "no" / "r.md")]) == 2
    assert "cannot write report" in capsys.readouterr().err


def test_robot_is_not_downloaded_without_java(monkeypatch):
    import pytest

    from mermantics import robot

    def no_download(*_args, **_kwargs):
        raise AssertionError("ROBOT should not be downloaded")

    monkeypatch.setattr(robot, "find_java", lambda: None)
    monkeypatch.setattr(robot, "find_robot", no_download)
    with pytest.raises(robot.RobotError, match="Java was not found"):
        robot.Robot()

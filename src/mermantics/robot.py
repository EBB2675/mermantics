"""Running the ROBOT command-line tool (https://robot.obolibrary.org) for reasoning."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .ontology import OntologyError, cache_dir, download

ROBOT_VERSION = "1.9.11"
ROBOT_URL = f"https://github.com/ontodev/robot/releases/download/v{ROBOT_VERSION}/robot.jar"
REASONERS = {"hermit": "HermiT", "elk": "ELK", "jfact": "JFact"}

_UNSAT_LINE = re.compile(r"unsatisfiable:\s*(\S+)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


class RobotError(Exception):
    """Java or ROBOT is missing, or ROBOT failed for a reason other than the model."""


@dataclass
class ReasonResult:
    status: str  # "ok", "unsatisfiable", "inconsistent"
    unsatisfiable: list[str] = field(default_factory=list)
    log: str = ""


def find_java() -> str | None:
    java_home = os.environ.get("JAVA_HOME")
    if java_home:
        candidate = Path(java_home) / "bin" / ("java.exe" if os.name == "nt" else "java")
        if candidate.exists():
            return str(candidate)
    return shutil.which("java")


def find_robot(path: str | None = None) -> Path:
    """Use an explicit jar, $ROBOT_JAR, or download the pinned version into the cache."""
    explicit = path or os.environ.get("ROBOT_JAR")
    if explicit:
        jar = Path(explicit).expanduser()
        if not jar.exists():
            raise RobotError(f"ROBOT jar not found: {jar}")
        return jar
    try:
        return download(ROBOT_URL, cache_dir() / f"robot-{ROBOT_VERSION}.jar")
    except OntologyError as exc:
        raise RobotError(str(exc)) from exc


def _clean(text: str) -> str:
    # Java prints this whenever JAVA_TOOL_OPTIONS is set; it is noise for users.
    return "\n".join(line for line in text.splitlines() if not line.startswith("Picked up JAVA_TOOL_OPTIONS"))


def explanation_text(markdown: str) -> str:
    """Keep only the explanation tree from ROBOT's Markdown and drop the link targets."""
    body = markdown.split("# Axiom Impact", 1)[0]
    body = _MD_LINK.sub(r"\1", body)
    lines = [line.rstrip() for line in body.splitlines() if line.strip()]
    return "\n".join(line.replace("## ", "").replace(" ##", "") for line in lines)


class Robot:
    def __init__(self, jar: Path | str | None = None, java: str | None = None, memory: str = "4g",
                 reasoner: str = "hermit"):
        """`jar` as for find_robot(). Java and the reasoner name are checked first, so the
        jar is not downloaded when it could not be run anyway."""
        java = java or find_java()
        if not java:
            raise RobotError(
                "Java was not found. The reasoner (ROBOT) needs Java 11 or newer; install it or set JAVA_HOME.")
        if reasoner.lower() not in REASONERS:
            raise RobotError(f"unknown reasoner '{reasoner}', choose from: {', '.join(REASONERS)}")
        self.java = java
        self.jar = find_robot(str(jar) if jar else None)
        self.memory = memory
        self.reasoner = REASONERS[reasoner.lower()]

    def _run(self, args: list[str], timeout: int = 3600) -> subprocess.CompletedProcess:
        cmd = [self.java, f"-Xmx{self.memory}", "-jar", str(self.jar), *args]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RobotError(f"ROBOT did not finish within {timeout} s") from exc
        proc.stdout = _clean(proc.stdout or "")
        proc.stderr = _clean(proc.stderr or "")
        return proc

    @staticmethod
    def _inputs(files: list[Path]) -> list[str]:
        args = ["merge"]
        for f in files:
            args += ["--input", str(f)]
        return args

    def reason(self, files: list[Path], output: Path) -> ReasonResult:
        args = self._inputs(files) + [
            "reason", "--reasoner", self.reasoner,
            "--equivalent-classes-allowed", "all",
            "--output", str(output),
        ]
        proc = self._run(args)
        log = (proc.stdout + "\n" + proc.stderr).strip()
        if proc.returncode == 0:
            return ReasonResult("ok", log=log)
        if "ontology is inconsistent" in log:
            return ReasonResult("inconsistent", log=log)
        unsat = _UNSAT_LINE.findall(log)
        if unsat:
            return ReasonResult("unsatisfiable", unsatisfiable=unsat, log=log)
        raise RobotError("ROBOT failed:\n" + log[-3000:])

    def consistency(self, files: list[Path], output: Path) -> tuple[bool | None, str]:
        """Fast consistency check. `explain --mode inconsistency` only asks the reasoner
        whether the ontology is consistent (no full classification), which is far faster
        on ontologies with individuals. Returns (consistent, explanation); consistent is
        None if the answer could not be read, so callers can fall back to `reason`."""
        args = self._inputs(files) + [
            "explain", "--reasoner", self.reasoner, "--mode", "inconsistency",
            "--max", "1", "--explanation", str(output),
        ]
        proc = self._run(args)
        if proc.returncode != 0 or not output.exists():
            return None, ""
        text = output.read_text(encoding="utf-8")
        if text.strip().startswith("No explanations found"):
            return True, ""
        if "SubClassOf [Nothing]" in text:
            return False, explanation_text(text)
        return None, ""

    def explain(self, files: list[Path], mode: str, output: Path, max_explanations: int = 1) -> str:
        """Ask ROBOT why the model is inconsistent ('inconsistency') or why classes are
        impossible ('unsatisfiability'). Returns plain text, or "" if it fails."""
        args = self._inputs(files) + [
            "explain", "--reasoner", self.reasoner, "--mode", mode,
            "--max", str(max_explanations), "--explanation", str(output),
        ]
        if mode == "unsatisfiability":
            args += ["--unsatisfiable", "root"]
        proc = self._run(args)
        if proc.returncode != 0 or not output.exists():
            return ""
        return explanation_text(output.read_text(encoding="utf-8"))

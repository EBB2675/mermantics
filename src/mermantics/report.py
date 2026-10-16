"""Turning findings into a terminal report, Markdown or JSON."""

from __future__ import annotations

import json
import textwrap

from .checks import Result
from .model import ERROR, LEVELS, NOTE, OK, WARNING

_HEADINGS = {ERROR: "Errors", WARNING: "Warnings", NOTE: "Notes", OK: "Passed"}


def _sorted(result: Result, level: str):
    return [f for f in result.findings if f.level == level]


def summary_line(result: Result) -> str:
    verdict = "FAILED" if result.has_errors else "PASSED"
    return (f"{verdict}: {result.count(ERROR)} errors, {result.count(WARNING)} warnings, "
            f"{result.count(NOTE)} notes")


def to_text(result: Result, diagram_name: str, quiet: bool = False) -> str:
    lines = [f"Checked {diagram_name}: {result.info.get('boxes', 0)} boxes, {result.info.get('arrows', 0)} arrows"]
    files = result.info.get("ontology_files") or []
    if files:
        lines.append("Ontology: " + ", ".join(files))
    lines.append("Reasoner: " + (result.info.get("reasoner") or "not used (fast mode)"))
    for level in LEVELS:
        if quiet and level in (NOTE, OK):
            continue
        items = _sorted(result, level)
        if not items:
            continue
        lines.append("")
        lines.append(f"{_HEADINGS[level]} ({len(items)})")
        for f in items:
            where = f"{f.where}: " if f.where else ""
            lines.append(textwrap.fill(f"[{f.check}] {where}{f.message}", width=100,
                                       initial_indent="  - ", subsequent_indent="    "))
            if f.details:
                lines += ["      " + d for d in f.details.splitlines()]
    lines += ["", summary_line(result)]
    return "\n".join(lines)


def to_markdown(result: Result, diagram_name: str) -> str:
    lines = [f"# Check of `{diagram_name}`", "", f"**{summary_line(result)}**", ""]
    lines.append(f"- Boxes: {result.info.get('boxes', 0)}, arrows: {result.info.get('arrows', 0)}")
    for f in result.info.get("ontology_files") or []:
        lines.append(f"- Ontology: `{f}`")
    lines.append(f"- Reasoner: {result.info.get('reasoner') or 'not used (fast mode)'}")
    for level in LEVELS:
        items = _sorted(result, level)
        if not items:
            continue
        lines += ["", f"## {_HEADINGS[level]} ({len(items)})", ""]
        for f in items:
            where = f"{f.where}: " if f.where else ""
            lines.append(f"- **{f.check}** {where}{f.message}")
            if f.details:
                lines += ["", "  ```", *("  " + d for d in f.details.splitlines()), "  ```"]
    return "\n".join(lines) + "\n"


def to_json(result: Result, diagram_name: str) -> str:
    data = {
        "diagram": diagram_name,
        "passed": not result.has_errors,
        "counts": {level: result.count(level) for level in LEVELS},
        "info": result.info,
        "findings": [f.as_dict() for f in result.findings],
    }
    return json.dumps(data, indent=2)

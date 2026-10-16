"""Command-line interface."""

from __future__ import annotations

import argparse
import sys
import tempfile
import traceback
from pathlib import Path

from . import __version__, checks, mermaid, report
from .model import DEFAULT_LOCAL_NS, Config
from .ontology import DEFAULT_ONTOLOGY, Ontology, OntologyError
from .robot import REASONERS, Robot, RobotError

EXIT_OK, EXIT_FINDINGS, EXIT_FAILURE = 0, 1, 2


def _prefix(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("use PREFIX=IRI, e.g. PMD=https://w3id.org/pmd/co/PMD_")
    key, iri = value.split("=", 1)
    return key.strip(), iri.strip()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="mermantics",
        description="Check a Mermaid data-model diagram against an OWL ontology, with a reasoner.",
        epilog="Exit codes: 0 no errors, 1 errors found, 2 the tool could not run.",
    )
    p.add_argument("diagram", type=Path, help="Mermaid flowchart file (.mmd or .md with only the diagram)")
    p.add_argument("-o", "--ontology", action="append", metavar="SOURCE",
                   help=f"ontology file, URL, or pmdco:<version>; repeatable (default: {DEFAULT_ONTOLOGY})")
    p.add_argument("--prefix", action="append", type=_prefix, default=[], metavar="PREFIX=IRI",
                   help="map an ID prefix to an IRI base; others become OBO PURLs (default: PMD=https://w3id.org/pmd/co/PMD_)")
    p.add_argument("--skip-class", action="append", metavar="CLASS",
                   help="Mermaid style class of boxes to ignore, repeatable (default: note)")
    p.add_argument("--vocab-class", action="append", metavar="CLASS",
                   help="Mermaid style class of vocabulary boxes, repeatable (default: vocab)")
    p.add_argument("--inherit", choices=["parent-child", "child-parent"], default="parent-child",
                   help="direction of solid inheritance arrows (default: parent-child, i.e. Parent --> Child)")
    p.add_argument("--local-ns", default=DEFAULT_LOCAL_NS, help=f"namespace for the diagram's classes (default: {DEFAULT_LOCAL_NS})")
    p.add_argument("--fast", action="store_true", help="skip the reasoner (no Java needed)")
    p.add_argument("--reasoner", choices=sorted(REASONERS), default="hermit", help="reasoner to use (default: hermit)")
    p.add_argument("--robot", metavar="JAR", help="path to robot.jar (default: $ROBOT_JAR, else downloaded once)")
    p.add_argument("--java-mem", default="4g", help="Java heap size for the reasoner (default: 4g)")
    p.add_argument("--no-explain", action="store_true", help="do not ask the reasoner to explain problems")
    p.add_argument("--report", type=Path, metavar="FILE", help="also write a Markdown report")
    p.add_argument("--json", type=Path, metavar="FILE", help="also write the findings as JSON")
    p.add_argument("--emit-owl", type=Path, metavar="FILE", help="write the generated OWL (classes and example data) as Turtle")
    p.add_argument("--keep-workdir", type=Path, metavar="DIR", help="keep intermediate reasoner files in this folder")
    p.add_argument("-q", "--quiet", action="store_true", help="only show errors and warnings")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    def progress(message: str) -> None:
        if not args.quiet:
            print(f"... {message}", file=sys.stderr, flush=True)

    config = Config(
        inherit_direction=args.inherit,
        local_ns=args.local_ns,
    )
    config.prefixes.update(dict(args.prefix))
    if args.skip_class:
        config.skip_classes = set(args.skip_class)
    if args.vocab_class:
        config.vocab_classes = set(args.vocab_class)

    try:
        text = args.diagram.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot read {args.diagram}: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    diagram = mermaid.parse(text)
    if not diagram.nodes:
        print(f"error: no boxes found in {args.diagram}; is it a Mermaid flowchart?", file=sys.stderr)
        return EXIT_FAILURE

    try:
        progress("loading ontology")
        onto = Ontology.load(args.ontology or [DEFAULT_ONTOLOGY])
        robot = None
        if not args.fast:
            robot = Robot(args.robot, memory=args.java_mem, reasoner=args.reasoner)
        if args.keep_workdir:
            args.keep_workdir.mkdir(parents=True, exist_ok=True)
            result = checks.run(diagram, onto, config, robot, args.keep_workdir,
                                explain=not args.no_explain, emit_owl=args.emit_owl, progress=progress)
        else:
            with tempfile.TemporaryDirectory(prefix="mermantics-") as tmp:
                result = checks.run(diagram, onto, config, robot, Path(tmp),
                                    explain=not args.no_explain, emit_owl=args.emit_owl, progress=progress)
    except (OntologyError, RobotError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    except Exception:  # noqa: BLE001 - an unexpected crash must not look like "errors found" (exit 1)
        traceback.print_exc()
        return EXIT_FAILURE

    name = args.diagram.name
    print(report.to_text(result, name, quiet=args.quiet))
    try:
        if args.report:
            args.report.write_text(report.to_markdown(result, name), encoding="utf-8")
        if args.json:
            args.json.write_text(report.to_json(result, name), encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot write report: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    return EXIT_FINDINGS if result.has_errors else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

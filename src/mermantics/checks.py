"""The checks, in the order they run.

1. ids          every ontology ID exists, is not deprecated, and is the right kind
2. labels       the text written next to each ID matches the ontology label
3. schema       (reasoner) no box becomes an impossible class
4. domain-range relation arrows fit the property's domain and range
5. vocabulary   vocabulary terms are kinds of the class that uses them
6. data         (reasoner) one example per box, linked by every arrow, is consistent
"""

from __future__ import annotations

import difflib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import rdflib
from rdflib import URIRef

from . import labels, owlgen
from .mermaid import Diagram
from .model import ERROR, NOTE, OK, WARNING, Config, Edge, Finding, Node
from .ontology import Ontology
from .robot import Robot


@dataclass
class Result:
    findings: list[Finding] = field(default_factory=list)
    info: dict = field(default_factory=dict)

    def count(self, level: str) -> int:
        return sum(1 for f in self.findings if f.level == level)

    @property
    def has_errors(self) -> bool:
        return self.count(ERROR) > 0


def _node_where(node: Node) -> str:
    return f"box '{labels.title(node.label, node.id)}' (line {node.line})"


def _edge_where(edge: Edge) -> str:
    return f"arrow {edge.src} -> {edge.dst} (line {edge.line})"


def _a(kind: str) -> str:
    return ("an " if kind[:1] in "aeiou" else "a ") + kind


def _closest(candidates: list[str], target: str) -> str:
    return max(candidates, key=lambda c: difflib.SequenceMatcher(None, c.lower(), target.lower()).ratio())


def _checked_relations(diagram: Diagram, config: Config):
    """Relation arrows that take part in the checks: not those to or from a skipped box."""
    for edge in diagram.edges:
        if edge.kind != "relation":
            continue
        if any(diagram.nodes[n].css & config.skip_classes for n in (edge.src, edge.dst)):
            continue
        yield edge


def _occurrences(diagram: Diagram, config: Config):
    """(where, raw label, curie, role) for every ID in the diagram.
    role: 'alignment', 'extra', 'vocab-term', 'property'."""
    for node in diagram.nodes.values():
        if node.css & config.skip_classes:
            continue
        vocab = bool(node.css & config.vocab_classes)
        for i, curie in enumerate(labels.find_curies(node.label)):
            role = "vocab-term" if vocab else ("alignment" if i == 0 else "extra")
            yield _node_where(node), node.label, curie, role
    for edge in _checked_relations(diagram, config):
        for i, curie in enumerate(labels.find_curies(edge.label)):
            yield _edge_where(edge), edge.label, curie, "property" if i == 0 else "extra"


# ---- 1. IDs ----------------------------------------------------------------------------

def check_ids(diagram: Diagram, onto: Ontology, config: Config) -> list[Finding]:
    out: list[Finding] = []
    checked = 0
    distinct = set()
    for where, _raw, curie, role in _occurrences(diagram, config):
        iri = URIRef(labels.curie_to_iri(curie, config.prefixes))
        checked += 1
        distinct.add(curie)
        if not onto.exists(iri):
            out.append(Finding(ERROR, "ids", f"{curie} is not in the ontology", where, str(iri)))
            continue
        name = onto.label(iri)
        if onto.deprecated(iri):
            out.append(Finding(ERROR, "ids", f"{curie} '{name}' is deprecated in the ontology", where))
            continue
        kind = onto.kind(iri)
        if role in ("alignment", "vocab-term") and kind != "class":
            out.append(Finding(ERROR, "ids", f"{curie} '{name}' is {_a(kind)}, but a box's ID should be a class", where))
        elif role == "property":
            if kind == "class":
                out.append(Finding(ERROR, "ids", f"{curie} '{name}' is a class, but an arrow's ID should be a property", where))
            elif kind != "object property":
                out.append(Finding(WARNING, "ids", f"{curie} '{name}' is {_a(kind)}, not an object property, so this arrow is left out of reasoning", where))
        elif role == "extra":
            out.append(Finding(NOTE, "ids", f"{curie} '{name}' is not the first ID here, so it is only checked for existence (the first ID is the one used)", where))

    for edge in _checked_relations(diagram, config):
        if not labels.find_curies(edge.label):
            text = labels.plain(edge.label) or edge.arrow
            out.append(Finding(NOTE, "ids", f"arrow has no ontology ID, not checked ({text})", _edge_where(edge)))
    if checked and not any(f.level == ERROR for f in out):
        out.append(Finding(OK, "ids", f"all {len(distinct)} ontology IDs exist and none are deprecated "
                                      f"({checked} uses in the diagram)"))
    return out


# ---- 2. labels -------------------------------------------------------------------------

def check_labels(diagram: Diagram, onto: Ontology, config: Config) -> list[Finding]:
    """A label written on the same line as the ID that does not match is a warning.
    If only the neighbouring lines are there and none of them match, the label was most
    likely just not written down; that is a note."""
    out: list[Finding] = []
    matched = 0
    seen = set()
    for where, raw, curie, _role in _occurrences(diagram, config):
        iri = URIRef(labels.curie_to_iri(curie, config.prefixes))
        if not onto.exists(iri) or (where, curie) in seen:
            continue
        seen.add((where, curie))
        names = onto.labels(iri)
        same, near = labels.text_near(raw, curie)
        if not names or not (same or near):
            continue
        if labels.label_matches(names, same + near):
            matched += 1
        elif same:
            shown = _closest(same, names[0])
            out.append(Finding(WARNING, "labels",
                               f"text next to {curie} reads '{shown}', but the ontology calls it '{names[0]}'", where))
        else:
            out.append(Finding(NOTE, "labels",
                               f"no label written next to {curie} (the ontology calls it '{names[0]}')", where))
    if matched:
        out.append(Finding(OK, "labels", f"{matched} labels match the ontology"))
    return out


# ---- 4. domain and range ---------------------------------------------------------------

def check_domain_range(diagram: Diagram, model: owlgen.LocalModel, hierarchy: Ontology,
                       basis: str) -> list[Finding]:
    out: list[Finding] = []
    fits = 0
    arrows = 0
    unconstrained = 0
    for index, prop in model.properties.items():
        edge = diagram.edges[index]
        if edge.src not in model.classes or edge.dst not in model.classes:
            continue
        domains, ranges = hierarchy.property_constraints(prop)
        if not domains and not ranges:
            unconstrained += 1
            continue
        arrows += 1
        prop_name = hierarchy.label(prop)
        reported = set()
        for side, node_id, constraints in (("subject", edge.src, domains), ("object", edge.dst, ranges)):
            node = diagram.nodes[node_id]
            name = labels.title(node.label, node_id)
            supers = hierarchy.superclasses(model.classes[node_id])
            for expr, source in constraints:
                verdict = hierarchy.satisfied(expr, supers)
                wanted = hierarchy.describe(expr)
                if verdict is True:
                    fits += 1
                    continue
                key = (side, wanted)
                if key in reported:
                    continue
                reported.add(key)
                via = "" if source == prop else f" (inherited from '{hierarchy.label(source)}')"
                if verdict is False:
                    out.append(Finding(
                        WARNING, "domain-range",
                        f"'{prop_name}' expects its {side} to be {wanted}{via}, but '{name}' is not. "
                        f"OWL does not treat this as an error by itself: a reasoner would quietly "
                        f"conclude that '{name}' is one.",
                        _edge_where(edge)))
                else:
                    out.append(Finding(NOTE, "domain-range",
                                       f"could not check whether '{name}' fits {wanted}{via}", _edge_where(edge)))
    # "Could not check" notes block the OK too: the message claims that everything fits.
    if fits and not out:
        what = "the relation arrow fits its property's" if arrows == 1 else \
            f"all {arrows} relation arrows fit their properties'"
        out.append(Finding(OK, "domain-range",
                           f"{what} domains and ranges ({fits} constraints checked, {basis})"))
    if unconstrained:
        what = "1 relation arrow uses a property" if unconstrained == 1 else \
            f"{unconstrained} relation arrows use properties"
        out.append(Finding(NOTE, "domain-range", f"{what} without a domain or range, so there was nothing to check"))
    return out


# ---- 5. vocabularies -------------------------------------------------------------------

def _term_name(raw: str, curie: str) -> str:
    for seg in labels.segments(raw):
        if curie in seg:
            code = seg.split(curie, 1)[0].strip(" :")
            return f"{code} ({curie})" if code else curie
    return curie


def check_vocabularies(diagram: Diagram, model: owlgen.LocalModel, hierarchy: Ontology,
                       config: Config) -> list[Finding]:
    out: list[Finding] = []
    for edge in _checked_relations(diagram, config):
        dst = diagram.nodes.get(edge.dst)
        if dst is None or not (dst.css & config.vocab_classes):
            continue
        src = diagram.nodes[edge.src]
        src_name = labels.title(src.label, src.id)
        vocab_name = labels.title(dst.label, dst.id)
        target = owlgen.aligned_ancestor(edge.src, model)
        if target is None:
            out.append(Finding(NOTE, "vocabulary",
                               f"cannot check '{vocab_name}': '{src_name}' has no ontology alignment", _edge_where(edge)))
            continue
        target_name = hierarchy.label(target)
        good = 0
        for curie in labels.find_curies(dst.label):
            iri = URIRef(labels.curie_to_iri(curie, config.prefixes))
            if not hierarchy.exists(iri):
                continue
            term = _term_name(dst.label, curie)
            if iri == target:
                out.append(Finding(NOTE, "vocabulary",
                                   f"{term} in '{vocab_name}' is the same class as '{src_name}' itself "
                                   f"('{target_name}'), so it adds no information", _node_where(dst)))
            elif target in hierarchy.superclasses(iri):
                good += 1
            else:
                out.append(Finding(WARNING, "vocabulary",
                                   f"{term} '{hierarchy.label(iri)}' in '{vocab_name}' is not a kind of "
                                   f"'{target_name}', the class of '{src_name}'", _node_where(dst)))
        if good:
            terms = "1 term" if good == 1 else f"{good} terms"
            verb = "is a kind" if good == 1 else "are kinds"
            out.append(Finding(OK, "vocabulary",
                               f"{terms} in '{vocab_name}' {verb} of '{target_name}'"))
    return out


# ---- 3 and 6. reasoning ----------------------------------------------------------------

def _local_name(iri: str, config: Config) -> str | None:
    return iri[len(config.local_ns):] if iri.startswith(config.local_ns) else None


def reason_schema(diagram: Diagram, onto: Ontology, config: Config, robot: Robot, workdir: Path,
                  explain: bool) -> tuple[list[Finding], Ontology | None]:
    model = owlgen.build(diagram.nodes, diagram.edges, onto, config, with_examples=False)
    local = workdir / "local-schema.ttl"
    model.graph.serialize(local, format="turtle")
    files = [*onto.files, local]
    output = workdir / "reasoned-schema.ttl"
    result = robot.reason(files, output)
    out: list[Finding] = []
    if result.status == "ok":
        out.append(Finding(OK, "schema", "no box becomes an impossible class (reasoner found no contradictions)"))
        reasoned = rdflib.Graph()
        reasoned.parse(output, format="turtle")
        return out, Ontology(reasoned, onto.files)

    details = ""
    if explain:
        mode = "inconsistency" if result.status == "inconsistent" else "unsatisfiability"
        details = robot.explain(files, mode, workdir / f"explain-schema-{mode}.md")
    if result.status == "inconsistent":
        out.append(Finding(ERROR, "schema", "the class structure contradicts the ontology (inconsistent)",
                           details=details))
        return out, None
    first = True
    for iri in result.unsatisfiable:
        node_id = _local_name(iri, config)
        if node_id and node_id in diagram.nodes:
            node = diagram.nodes[node_id]
            msg = ("this box can never have any members: its place in the hierarchy and its "
                   "ontology alignment contradict each other (or it inherits such a contradiction)")
            out.append(Finding(ERROR, "schema", msg, _node_where(node), details if first else ""))
        else:
            out.append(Finding(WARNING, "schema", f"ontology class {iri} is impossible in the loaded ontology",
                               details=details if first else ""))
        first = False
    return out, None


def reason_data(diagram: Diagram, onto: Ontology, config: Config, robot: Robot, workdir: Path,
                explain: bool) -> list[Finding]:
    model = owlgen.build(diagram.nodes, diagram.edges, onto, config, with_examples=True)
    local = workdir / "local-data.ttl"
    model.graph.serialize(local, format="turtle")
    files = [*onto.files, local]
    n_links = sum(1 for i in model.properties if diagram.edges[i].src in model.examples
                  and diagram.edges[i].dst in model.examples)
    links = "1 link" if n_links == 1 else f"{n_links} links"
    instances = "1 instance" if len(model.examples) == 1 else f"{len(model.examples)} instances"
    ok = Finding(OK, "data", f"example data ({instances}, {links}) is consistent with the ontology")
    bad_msg = "example data following the diagram contradicts the ontology (inconsistent)"

    consistent, details = robot.consistency(files, workdir / "explain-data.md")
    if consistent is True:
        return [ok]
    if consistent is False:
        return [Finding(ERROR, "data", bad_msg, details=details if explain else "")]

    # Could not read the fast answer: fall back to a full reasoner run.
    result = robot.reason(files, workdir / "reasoned-data.ttl")
    if result.status == "ok":
        return [ok]
    details = robot.explain(files, "inconsistency", workdir / "explain-data-2.md") if explain else ""
    if result.status == "inconsistent":
        return [Finding(ERROR, "data", bad_msg, details=details)]
    # Classes the ontology makes impossible on its own were already reported by the
    # schema check; only the diagram's own classes count here.
    local = [iri for iri in result.unsatisfiable if _local_name(iri, config) is not None]
    if not local:
        return [ok]
    return [Finding(ERROR, "data", "example data makes some classes impossible: "
                    + ", ".join(local), details=details)]


# ---- everything ------------------------------------------------------------------------

def run(diagram: Diagram, onto: Ontology, config: Config, robot: Robot | None, workdir: Path,
        explain: bool = True, emit_owl: Path | None = None,
        progress: Callable[[str], None] = lambda _msg: None) -> Result:
    result = Result(list(diagram.findings))
    progress("checking IDs and labels")
    result.findings += check_ids(diagram, onto, config)
    result.findings += check_labels(diagram, onto, config)

    hierarchy: Ontology | None = None
    schema_ok = False
    if robot is not None:
        progress(f"reasoning over the class structure with {robot.reasoner} (can take a minute)")
        findings, hierarchy = reason_schema(diagram, onto, config, robot, workdir, explain)
        result.findings += findings
        # Impossible classes that come from the ontology itself are warnings: the diagram
        # is not at fault, so the example data is still worth checking.
        schema_ok = not any(f.level == ERROR for f in findings)

    model = owlgen.build(diagram.nodes, diagram.edges, onto, config, with_examples=True)
    if emit_owl is not None:
        model.graph.serialize(emit_owl, format="turtle")

    if hierarchy is None:
        # No reasoner, or the reasoner found errors: use the hierarchy as written.
        combined = rdflib.Graph()
        combined += onto.g
        combined += model.graph
        hierarchy = Ontology(combined, onto.files)
        basis = "based on the asserted hierarchy, without a reasoner"
    else:
        basis = "based on the reasoned hierarchy"

    progress("checking domains, ranges and vocabularies")
    result.findings += check_domain_range(diagram, model, hierarchy, basis)
    result.findings += check_vocabularies(diagram, model, hierarchy, config)

    if robot is not None and schema_ok:
        progress("reasoning over example data (can take a minute)")
        result.findings += reason_data(diagram, onto, config, robot, workdir, explain)
    elif robot is not None:
        result.findings.append(Finding(NOTE, "data", "example-data check skipped because the class structure has errors"))

    result.info = {
        "boxes": len(owlgen.model_nodes(diagram.nodes, config)),
        "arrows": len(diagram.edges),
        "ontology_files": [str(f) for f in onto.files],
        "reasoner": robot.reasoner if robot else None,
    }
    return result

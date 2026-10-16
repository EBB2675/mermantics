"""Turning a parsed diagram into OWL: one class per box, and optionally one example
instance per box with one link per relation arrow."""

from __future__ import annotations

from dataclasses import dataclass, field

import rdflib
from rdflib import OWL, RDF, RDFS, Literal, URIRef

from . import labels
from .model import Config, Edge, Node
from .ontology import Ontology


@dataclass
class LocalModel:
    """The local OWL model plus the mappings the checks need."""

    graph: rdflib.Graph
    classes: dict[str, URIRef] = field(default_factory=dict)       # node id -> local class
    alignments: dict[str, URIRef] = field(default_factory=dict)    # node id -> ontology class
    examples: dict[str, URIRef] = field(default_factory=dict)      # node id -> example individual
    properties: dict[int, URIRef] = field(default_factory=dict)    # edge index -> property
    parents: dict[str, list[str]] = field(default_factory=dict)    # node id -> parent node ids


def model_nodes(nodes: dict[str, Node], config: Config) -> dict[str, Node]:
    """Nodes that take part in reasoning (not skipped, not vocabularies)."""
    excluded = config.skip_classes | config.vocab_classes
    return {k: n for k, n in nodes.items() if not (n.css & excluded)}


def inheritance(edge: Edge, config: Config) -> tuple[str, str]:
    """(child, parent) for an inheritance arrow."""
    if config.inherit_direction == "child-parent":
        return edge.src, edge.dst
    return edge.dst, edge.src


def build(nodes: dict[str, Node], edges: list[Edge], onto: Ontology, config: Config,
          with_examples: bool) -> LocalModel:
    g = rdflib.Graph()
    ns = rdflib.Namespace(config.local_ns)
    g.bind("diagram", ns)
    g.add((URIRef(config.local_ns.rstrip("#/")), RDF.type, OWL.Ontology))
    model = LocalModel(g)
    usable = model_nodes(nodes, config)

    for node_id, node in usable.items():
        cls = ns[node_id]
        model.classes[node_id] = cls
        g.add((cls, RDF.type, OWL.Class))
        g.add((cls, RDFS.label, Literal(labels.title(node.label, node_id))))
        curies = labels.find_curies(node.label)
        if curies:
            target = URIRef(labels.curie_to_iri(curies[0], config.prefixes))
            if onto.kind(target) == "class":
                model.alignments[node_id] = target
                # Declare it, so the file means the same thing when parsed on its own.
                g.add((target, RDF.type, OWL.Class))
                g.add((cls, RDFS.subClassOf, target))

    for edge in edges:
        if edge.kind != "inherit":
            continue
        child, parent = inheritance(edge, config)
        if child in usable and parent in usable:
            g.add((ns[child], RDFS.subClassOf, ns[parent]))
            model.parents.setdefault(child, []).append(parent)

    for index, edge in enumerate(edges):
        if edge.kind != "relation":
            continue
        curies = labels.find_curies(edge.label)
        if not curies:
            continue
        prop = URIRef(labels.curie_to_iri(curies[0], config.prefixes))
        if onto.kind(prop) == "object property":
            model.properties[index] = prop

    if with_examples:
        for node_id, cls in model.classes.items():
            ind = ns[f"{node_id}_example"]
            model.examples[node_id] = ind
            g.add((ind, RDF.type, OWL.NamedIndividual))
            g.add((ind, RDF.type, cls))
            g.add((ind, RDFS.label, Literal(f"{labels.title(nodes[node_id].label, node_id)} (example)")))
        for index, prop in model.properties.items():
            edge = edges[index]
            if edge.src in model.examples and edge.dst in model.examples:
                # Declare the property explicitly: when OWLAPI parses this file on its
                # own, an undeclared predicate can be read as an annotation property.
                g.add((prop, RDF.type, OWL.ObjectProperty))
                g.add((model.examples[edge.src], prop, model.examples[edge.dst]))
    return model


def aligned_ancestor(node_id: str, model: LocalModel) -> URIRef | None:
    """The ontology class of a node, or of its nearest ancestor in the diagram."""
    seen = set()
    queue = [node_id]
    while queue:
        current = queue.pop(0)
        if current in seen:
            continue
        seen.add(current)
        if current in model.alignments:
            return model.alignments[current]
        queue += model.parents.get(current, [])
    return None

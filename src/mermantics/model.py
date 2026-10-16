"""Shared data structures: configuration, diagram elements and findings."""

from __future__ import annotations

from dataclasses import dataclass, field

OBO_BASE = "http://purl.obolibrary.org/obo/"
DEFAULT_PREFIXES = {"PMD": "https://w3id.org/pmd/co/PMD_"}
DEFAULT_LOCAL_NS = "http://example.org/diagram#"

# Finding levels, most severe first.
ERROR = "error"
WARNING = "warning"
NOTE = "note"
OK = "ok"
LEVELS = (ERROR, WARNING, NOTE, OK)


@dataclass
class Config:
    """How to read a diagram. All conventions live here so they can be changed in one place."""

    prefixes: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_PREFIXES))
    # "parent-child": `Parent --> Child` means Child subClassOf Parent.
    # "child-parent": `Child --> Parent` means Child subClassOf Parent.
    inherit_direction: str = "parent-child"
    # Nodes with these style classes are ignored completely (e.g. the legend).
    skip_classes: set[str] = field(default_factory=lambda: {"note"})
    # Nodes with these style classes are vocabularies: not reasoned over, but checked
    # against the class of the node that points at them.
    vocab_classes: set[str] = field(default_factory=lambda: {"vocab"})
    local_ns: str = DEFAULT_LOCAL_NS


@dataclass
class Node:
    id: str
    label: str  # raw label text as written in the diagram
    line: int
    css: set[str] = field(default_factory=set)
    defined: bool = True  # False if the node only appears inside an arrow


@dataclass
class Edge:
    src: str
    dst: str
    kind: str  # "inherit" (unlabelled solid arrow) or "relation"
    label: str
    line: int
    arrow: str  # the arrow as written, for messages


@dataclass
class Finding:
    level: str
    check: str
    message: str
    where: str = ""
    details: str = ""

    def as_dict(self) -> dict:
        return {
            "level": self.level,
            "check": self.check,
            "where": self.where,
            "message": self.message,
            "details": self.details,
        }

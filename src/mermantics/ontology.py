"""Loading ontologies and looking things up in them (labels, kinds, hierarchy)."""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

import rdflib
from rdflib import OWL, RDF, RDFS, BNode, Literal, URIRef
from rdflib.collection import Collection
from rdflib.namespace import SKOS

PMDCO_SHORTHAND = re.compile(r"^pmdco:(\d+\.\d+\.\d+)$")
PMDCO_URL = "https://raw.githubusercontent.com/materialdigital/core-ontology/v{version}/pmdco-full.ttl"
DEFAULT_ONTOLOGY = "pmdco:3.1.1"

_DEPRECATED_PREFIXES = ("obsolete", "deprecated")


class OntologyError(Exception):
    """Raised when an ontology cannot be found, downloaded or parsed."""


def cache_dir() -> Path:
    env = os.environ.get("MERMANTICS_CACHE")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "mermantics"


def download(url: str, target: Path) -> Path:
    """Download a URL to a file (atomically), unless it is already there."""
    if target.exists() and target.stat().st_size > 0:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "mermantics"})
    fd, tmp = tempfile.mkstemp(dir=target.parent, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(request, timeout=120) as resp:
            shutil.copyfileobj(resp, out)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except Exception as exc:  # noqa: BLE001 - report any download failure the same way
        Path(tmp).unlink(missing_ok=True)
        raise OntologyError(f"could not download {url}: {exc}") from exc
    return target


def resolve_source(source: str) -> Path:
    """Turn a path, URL or 'pmdco:<version>' shorthand into a local file."""
    m = PMDCO_SHORTHAND.match(source)
    if m:
        source = PMDCO_URL.format(version=m.group(1))
    if re.match(r"^https?://", source):
        name = re.sub(r"[^\w.-]", "_", source.split("://", 1)[1])
        return download(source, cache_dir() / "ontologies" / name)
    path = Path(source).expanduser()
    if not path.exists():
        raise OntologyError(f"ontology file not found: {source}")
    return path


def _parse_into(graph: rdflib.Graph, path: Path) -> None:
    fmt = rdflib.util.guess_format(str(path))
    tried = [fmt] if fmt else []
    tried += [f for f in ("turtle", "xml", "nt", "json-ld") if f not in tried]
    errors = []
    for f in tried:
        try:
            graph.parse(str(path), format=f)
            return
        except Exception as exc:  # noqa: BLE001 - try the next format
            errors.append(f"{f}: {exc}")
    raise OntologyError(f"could not parse {path}: " + "; ".join(errors[:2]))


def _load_imports(graph: rdflib.Graph) -> None:
    """Add the owl:imports closure to the graph. ROBOT follows imports when it reasons,
    so the ID and label checks must see the same terms."""
    done: set = set()
    while True:
        loaded = set(graph.subjects(RDF.type, OWL.Ontology)) | done
        pending = [i for i in set(graph.objects(None, OWL.imports)) if i not in loaded]
        if not pending:
            return
        for iri in pending:
            done.add(iri)
            source = str(iri)
            if source.startswith("file://"):
                source = urllib.request.url2pathname(source[len("file://"):])
            try:
                _parse_into(graph, resolve_source(source))
            except OntologyError as exc:
                raise OntologyError(f"could not load import {iri}: {exc}") from exc


class Ontology:
    """An rdflib graph with the lookups the checks need."""

    def __init__(self, graph: rdflib.Graph, files: list[Path] | None = None):
        self.g = graph
        self.files = files or []
        self._supers_cache: dict[URIRef, set[URIRef]] = {}

    @classmethod
    def load(cls, sources: list[str]) -> "Ontology":
        graph = rdflib.Graph()
        files = []
        for source in sources:
            path = resolve_source(source)
            _parse_into(graph, path)
            files.append(path)
        _load_imports(graph)
        return cls(graph, files)

    # ---- basic lookups -------------------------------------------------------------

    def exists(self, iri: URIRef) -> bool:
        return (iri, None, None) in self.g

    def labels(self, iri: URIRef) -> list[str]:
        """English (or untagged) labels; falls back to any language."""
        preferred, other = [], []
        for prop in (RDFS.label, SKOS.prefLabel):
            for value in self.g.objects(iri, prop):
                if not isinstance(value, Literal):
                    continue
                lang = (value.language or "").lower()
                (preferred if lang in ("", "en") or lang.startswith("en-") else other).append(str(value))
        return preferred or other

    def label(self, iri) -> str:
        if isinstance(iri, URIRef):
            labels = self.labels(iri)
            if labels:
                return labels[0]
            return re.split(r"[/#]", str(iri))[-1]
        return self.describe(iri)

    def deprecated(self, iri: URIRef) -> bool:
        for value in self.g.objects(iri, OWL.deprecated):
            if str(value).strip().lower() in ("true", "1"):
                return True
        all_labels = [str(v) for v in self.g.objects(iri, RDFS.label)]
        return any(lab.strip().lower().startswith(_DEPRECATED_PREFIXES) for lab in all_labels)

    def kind(self, iri: URIRef) -> str:
        types = set(self.g.objects(iri, RDF.type))
        if OWL.ObjectProperty in types:
            return "object property"
        if OWL.DatatypeProperty in types:
            return "datatype property"
        if OWL.AnnotationProperty in types:
            return "annotation property"
        if OWL.Class in types or RDFS.Class in types:
            return "class"
        if OWL.NamedIndividual in types:
            return "individual"
        if (iri, RDFS.subClassOf, None) in self.g or (None, RDFS.subClassOf, iri) in self.g:
            return "class"
        if (iri, RDFS.subPropertyOf, None) in self.g:
            return "property"
        return "unknown"

    # ---- class expressions ----------------------------------------------------------

    def _members(self, node, prop) -> list:
        head = self.g.value(node, prop)
        return list(Collection(self.g, head)) if head is not None else []

    def describe(self, expr) -> str:
        """Short plain-text rendering of a class expression."""
        if isinstance(expr, URIRef):
            return f"'{self.label(expr)}'"
        union = self._members(expr, OWL.unionOf)
        if union:
            return " or ".join(self.describe(m) for m in union)
        inter = self._members(expr, OWL.intersectionOf)
        if inter:
            return " and ".join(self.describe(m) for m in inter)
        return "a complex class expression"

    def satisfied(self, expr, supers: set[URIRef]):
        """Is a class with these superclasses inside `expr`? True, False or None (unknown)."""
        if isinstance(expr, URIRef):
            return expr == OWL.Thing or expr in supers
        union = self._members(expr, OWL.unionOf)
        if union:
            results = [self.satisfied(m, supers) for m in union]
            if any(r is True for r in results):
                return True
            return None if any(r is None for r in results) else False
        inter = self._members(expr, OWL.intersectionOf)
        if inter:
            results = [self.satisfied(m, supers) for m in inter]
            if any(r is False for r in results):
                return False
            return None if any(r is None for r in results) else True
        return None

    # ---- hierarchy ------------------------------------------------------------------

    def _named_parents(self, cls: URIRef):
        for parent in self.g.objects(cls, RDFS.subClassOf):
            if isinstance(parent, URIRef):
                yield parent
            elif isinstance(parent, BNode):
                for member in self._members(parent, OWL.intersectionOf):
                    if isinstance(member, URIRef):
                        yield member
        for eq in set(self.g.objects(cls, OWL.equivalentClass)) | set(self.g.subjects(OWL.equivalentClass, cls)):
            if isinstance(eq, URIRef):
                yield eq
            elif isinstance(eq, BNode):
                for member in self._members(eq, OWL.intersectionOf):
                    if isinstance(member, URIRef):
                        yield member

    def superclasses(self, cls: URIRef) -> set[URIRef]:
        """All named superclasses, including the class itself."""
        if cls in self._supers_cache:
            return self._supers_cache[cls]
        seen = {cls}
        stack = [cls]
        while stack:
            current = stack.pop()
            for parent in self._named_parents(current):
                if parent not in seen:
                    seen.add(parent)
                    stack.append(parent)
        self._supers_cache[cls] = seen
        return seen

    def property_constraints(self, prop: URIRef):
        """Domains and ranges that apply to a property, from the property itself, its
        super-properties, its inverses and any mix of them (e.g. a super-property of an
        inverse). Returns two lists of (expression, source)."""
        domains, ranges = [], []
        seen = set()
        # (property, flipped): flipped means we reached it through an odd number of
        # inverses, so its domain constrains our object and its range our subject.
        stack = [(prop, False)]
        while stack:
            p, flipped = stack.pop()
            if (p, flipped) in seen:
                continue
            seen.add((p, flipped))
            if isinstance(p, BNode):
                # An anonymous inverse, as in `subPropertyOf [ owl:inverseOf q ]`.
                stack += [(q, not flipped) for q in self.g.objects(p, OWL.inverseOf)]
                continue
            own_domains = [(d, p) for d in self.g.objects(p, RDFS.domain)]
            own_ranges = [(r, p) for r in self.g.objects(p, RDFS.range)]
            domains += own_ranges if flipped else own_domains
            ranges += own_domains if flipped else own_ranges
            stack += [(q, flipped) for q in self.g.objects(p, RDFS.subPropertyOf)]
            stack += [(q, flipped) for q in self.g.objects(p, OWL.equivalentProperty)]
            stack += [(q, flipped) for q in self.g.subjects(OWL.equivalentProperty, p)]
            inverses = set(self.g.objects(p, OWL.inverseOf)) | set(self.g.subjects(OWL.inverseOf, p))
            stack += [(q, not flipped) for q in inverses if isinstance(q, URIRef)]
        return domains, ranges

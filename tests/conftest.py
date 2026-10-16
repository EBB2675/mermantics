import os
from pathlib import Path

import pytest

from mermantics.ontology import Ontology, OntologyError
from mermantics.robot import Robot, RobotError, find_java

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def robot():
    """ROBOT runner, from $ROBOT_JAR or the cache (downloaded once). Skips if unavailable."""
    if not find_java():
        pytest.skip("Java not found")
    try:
        return Robot()
    except RobotError as exc:
        pytest.skip(f"ROBOT not available: {exc}")


@pytest.fixture(scope="session")
def pmdco():
    """PMDco from $PMDCO_FILE, or downloaded once into the cache. Skips if unavailable."""
    source = os.environ.get("PMDCO_FILE", "pmdco:3.1.1")
    try:
        return Ontology.load([source])
    except OntologyError as exc:
        pytest.skip(f"PMDco not available: {exc}")


@pytest.fixture(scope="session")
def tiny():
    return Ontology.load([str(FIXTURES / "tiny.ttl")])

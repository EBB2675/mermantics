"""Label and ID helpers. No Java or network needed."""

from mermantics import labels


def test_find_curies_ignores_names_without_digits():
    raw = "<b>X</b><br>PMD_0000933 simulation process<br>MAT_SIM_STRUCTURE<br>job_id<br>IAO_0000030"
    assert labels.find_curies(raw) == ["PMD_0000933", "IAO_0000030"]


def test_find_curies_dedupes_and_keeps_order():
    assert labels.find_curies("RO_0000059 and BFO_0000050 and RO_0000059") == ["RO_0000059", "BFO_0000050"]


def test_curie_to_iri_uses_prefix_map_then_obo():
    prefixes = {"PMD": "https://w3id.org/pmd/co/PMD_"}
    assert labels.curie_to_iri("PMD_0000933", prefixes) == "https://w3id.org/pmd/co/PMD_0000933"
    assert labels.curie_to_iri("IAO_0000030", prefixes) == "http://purl.obolibrary.org/obo/IAO_0000030"


def test_segments_strip_tags_and_entities():
    raw = "<b>A &amp; B</b><br>say #quot;hi#quot;<br/>x<BR>y"
    assert labels.segments(raw) == ["A & B", 'say "hi"', "x", "y"]


def test_text_near_same_line_and_neighbours():
    raw = "Ontology alignment:<br>IAO_0000030<br>information content entity"
    same, near = labels.text_near(raw, "IAO_0000030")
    assert same == []
    assert near == ["Ontology alignment:", "information content entity"]
    # text before the ID that ends in a colon is a code/heading, not a label
    same, near = labels.text_near("MC: PMD_0000862 Monte Carlo simulation", "PMD_0000862")
    assert same == ["Monte Carlo simulation"]
    same, near = labels.text_near("Types<br>MC: PMD_0000862", "PMD_0000862")
    assert same == [] and near == ["Types"]
    # but a label written before the ID still counts
    same, near = labels.text_near("has part BFO_0000051", "BFO_0000051")
    assert same == ["has part"]


def test_label_matches_exact_case_and_continuation():
    assert labels.label_matches(["is about"], ["Is About"])
    assert labels.label_matches(["is about"], ["is about, optional"])
    assert not labels.label_matches(["material"], ["material entity"])
    assert not labels.label_matches(["ab initio molecular dynamics simulation"], ["ab initio MD or"])

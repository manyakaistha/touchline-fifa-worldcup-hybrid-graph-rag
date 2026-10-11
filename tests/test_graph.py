from pathlib import Path

import pytest
from fifa_rag.graph import GraphStore, validate_cypher

ROOT = Path(__file__).resolve().parents[1]
AUDITED_GRAPH = ROOT / "data" / "backups" / "fifa_production_graphrag_db(2)"


@pytest.fixture(scope="module")
def graph():
    store = GraphStore(AUDITED_GRAPH)
    try:
        assert store.health()["available"], store.health()["error"]
        yield store
    finally:
        store.close()


def test_audited_database_is_opened_read_only_with_complete_content(graph):
    health = graph.health()
    assert health["read_only"] is True
    assert health["node_counts"] == {
        "Award": 27,
        "Team": 129,
        "Tournament": 70,
        "Chunk": 828,
        "Player": 742,
        "Match": 694,
        "Stadium": 340,
    }
    assert health["relationship_counts"] == {
        "RECEIVED_AWARD": 0,
        "SCORED_IN": 437,
        "MENTIONS": 5837,
        "DEFEATED": 525,
        "HOSTED_BY": 278,
        "WON_MATCH": 375,
        "HELD_AT": 9,
        "PLAYED_IN": 3057,
    }


def test_schema_bounded_query_and_source_chunk_content(graph):
    result = graph.query("MATCH (t:Tournament) WHERE t.id CONTAINS '1934' RETURN t.id AS tournament")
    assert result["query"].endswith("LIMIT 100")
    assert any("1934 FIFA World Cup" in row["tournament"] for row in result["rows"])

    chunks = graph.query(
        "MATCH (c:Chunk) WHERE c.text CONTAINS '1934 FIFA World Cup' "
        "RETURN c.chunk_id AS id, c.text AS text LIMIT 3"
    )["rows"]
    assert chunks
    assert all(row["text"].strip() for row in chunks)
    assert any("[Context:" in row["text"] for row in chunks)


def test_search_returns_chunk_evidence_for_requested_tournament(graph):
    evidence = graph.search("Who hosted the 1934 FIFA World Cup?", top_k=6, tournament="1934 FIFA World Cup")
    assert evidence
    assert len(evidence) <= 6
    assert all(item.text.strip() and item.source for item in evidence)
    assert all("1934 FIFA World Cup" in item.text for item in evidence)
    assert all(item.metadata["graph_linked"] is True for item in evidence)
    assert all("1934 FIFA World Cup" in item.text.split("\n", 1)[0] for item in evidence)


def test_planned_query_evidence_requires_real_chunk_ids(graph):
    result = graph.query(
        "MATCH (c:Chunk) WHERE c.text CONTAINS '1934 FIFA World Cup' RETURN c.chunk_id AS chunk_id LIMIT 1"
    )
    found = graph.planned_evidence(result, top_k=3, tournament="1934 FIFA World Cup")
    assert len(found) == 1
    assert found[0].id == result["rows"][0]["chunk_id"]
    assert "1934 FIFA World Cup" in found[0].text
    assert graph.planned_evidence({"rows": []}, top_k=3) == []
    assert graph.planned_evidence({"rows": [{"chunk_id": ["not-a-real-chunk"]}]}, top_k=3) == []


def test_entity_catalog_filters_and_exploration_preserves_links(graph):
    italy = graph.entities(q="italy", label="Team", limit=5)
    assert any(item["id"] == "Italy" for item in italy)

    explored = graph.explore("Italy", label="Team", limit=40)
    assert any(node["id"] == "Team:Italy" for node in explored["nodes"])
    assert explored["edges"]
    assert all(edge["source"] in {node["id"] for node in explored["nodes"]} for edge in explored["edges"])
    assert all(edge["target"] in {node["id"] for node in explored["nodes"]} for edge in explored["edges"])


def test_cypher_validator_adds_a_default_limit_and_accepts_safe_read_query():
    query = "MATCH (t:Tournament) RETURN t.id"
    assert validate_cypher(query) == query + " LIMIT 100"
    assert validate_cypher(query + " LIMIT 4").endswith("LIMIT 4")


@pytest.mark.parametrize(
    "query",
    [
        "CREATE (n:Team {id: 'bad'}) RETURN n",
        "MATCH (n:Team) SET n.id = 'bad' RETURN n",
        "MATCH (n:Team) DELETE n RETURN n",
        "CALL show_tables() RETURN *",
        "MATCH (n:Team) RETURN n; MATCH (m:Team) RETURN m",
        "MATCH (n:Team) RETURN n // comment",
        "MATCH (n:Team) /* comment */ RETURN n",
        "MATCH (n:Team) RETURN n -- comment",
        "MATCH p=(a:Team)-[*]->(b) RETURN p LIMIT 5",
        "MATCH p=(a:Team)-[*1..2]->(b) RETURN p LIMIT 5",
        "MATCH (a:Team)-[:PLAYED_IN*]->(b) RETURN b LIMIT 5",
        "MATCH (a:Team)-[:PLAYED_IN*1..]->(b) RETURN b LIMIT 5",
        "MATCH (n:Team) RETURN n LIMIT 0",
        "MATCH (n:Team) RETURN n LIMIT 101",
        "MATCH (n:Team) RETURN n LIMIT 4 LIMIT 4",
    ],
)
def test_cypher_validator_rejects_writes_comments_unbounded_or_invalid_limits(query):
    with pytest.raises(ValueError):
        validate_cypher(query)

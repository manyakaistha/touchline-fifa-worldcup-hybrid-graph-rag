import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from fifa_rag.api import create_app
from fifa_rag.config import ROOT, Settings
from fifa_rag.semantic import build_index

AUDITED_GRAPH = ROOT / "data" / "backups" / "fifa_production_graphrag_db(2)"


@pytest.fixture(scope="module")
def semantic_index(tmp_path_factory):
    if not AUDITED_GRAPH.exists():
        pytest.skip("audited Kuzu backup is unavailable in this checkout")
    path = tmp_path_factory.mktemp("semantic-index")
    result = build_index(AUDITED_GRAPH, path)
    assert result["documents"] == 828
    return path


def make_settings(semantic_path: Path, **overrides) -> Settings:
    values = {
        "_env_file": None,
        "graph_path": AUDITED_GRAPH,
        "semantic_path": semantic_path,
        "GROQ_API_KEY": "",
        "enable_paid_inference": False,
        "request_timeout": 5,
        "graph_timeout_ms": 5000,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def client(semantic_index):
    app = create_app(make_settings(semantic_index))
    with TestClient(app) as test_client:
        yield test_client


def test_status_reports_graph_semantic_and_generation_readiness(client):
    response = client.get("/api/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["graph"]["available"] is True
    assert payload["graph"]["read_only"] is True
    assert payload["semantic"]["available"] is True
    assert payload["semantic"]["document_count"] == 828
    assert payload["generation"]["configured"] is False
    assert payload["generation"]["enabled"] is False
    assert payload["modes"] == ["graph", "semantic", "hybrid", "auto"]


def test_query_endpoint_runs_hybrid_against_real_graph_and_local_index(client):
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "hybrid",
            "top_k": 5,
            "generate": False,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["used_mode"] == "hybrid"
    assert payload["generation"] == "evidence_only"
    assert payload["evidence"]
    assert len(payload["evidence"]) <= 5
    assert any("1934 FIFA World Cup" in item["text"] for item in payload["evidence"])
    assert {method for item in payload["evidence"] for method in item["methods"]} == {"graph", "semantic"}
    assert payload["graph"]["nodes"]
    assert "X-Content-Type-Options" in response.headers


def test_stream_endpoint_emits_evidence_before_done_without_generation(client):
    response = client.post(
        "/api/query/stream",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "graph",
            "top_k": 4,
            "generate": False,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == ["result", "done"]
    result = events[0]["result"]
    assert result["evidence"]
    assert result["generation"] == "evidence_only"
    assert any("1934 FIFA World Cup" in item["text"] for item in result["evidence"])


def test_missing_semantic_index_is_reported_and_graph_mode_remains_available(tmp_path):
    if not AUDITED_GRAPH.exists():
        pytest.skip("audited Kuzu backup is unavailable in this checkout")
    missing_index = tmp_path / "not-built"
    with TestClient(create_app(make_settings(missing_index))) as test_client:
        status = test_client.get("/api/status").json()
        assert status["graph"]["available"] is True
        assert status["semantic"]["available"] is False
        response = test_client.post(
            "/api/query",
            json={
                "question": "Who hosted the 1934 FIFA World Cup?",
                "mode": "semantic",
                "generate": True,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["used_mode"] == "none"
    assert payload["evidence"] == []
    assert payload["generation"] == "no_evidence"
    assert any("semantic retrieval unavailable" in item.lower() for item in payload["diagnostics"])
    assert not missing_index.exists()


def test_missing_graph_and_index_start_with_diagnostics_without_creating_database(tmp_path):
    missing_graph = tmp_path / "missing-graph.kuzu"
    missing_index = tmp_path / "missing-index"
    with TestClient(create_app(make_settings(missing_index, graph_path=missing_graph))) as test_client:
        status = test_client.get("/api/status").json()
        response = test_client.post(
            "/api/query",
            json={
                "question": "Who hosted the 1934 FIFA World Cup?",
                "mode": "auto",
            },
        )

    assert status["graph"]["available"] is False
    assert status["semantic"]["available"] is False
    assert response.status_code == 200
    assert response.json()["used_mode"] == "none"
    assert not missing_graph.exists()
    assert not Path(str(missing_graph) + ".lock").exists()


def test_invalid_query_bodies_and_unsafe_cypher_are_rejected(client):
    for body in (
        {"question": "x"},
        {"question": "valid question", "top_k": 13},
        {"question": "valid question", "mode": "outside"},
    ):
        assert client.post("/api/query", json=body).status_code == 422

    response = client.post(
        "/api/graph/query",
        json={
            "query": "MATCH (n:Team) DELETE n RETURN n LIMIT 1",
            "parameters": {},
        },
    )
    assert response.status_code == 422


def test_graph_endpoints_validate_entity_type_and_bounds(client):
    assert client.get("/api/entities", params={"label": "Unknown"}).status_code == 422
    assert client.get("/api/entities", params={"limit": 51}).status_code == 422
    assert client.get("/api/graph", params={"entity": "Italy", "label": "Unknown"}).status_code == 422
    assert client.get("/api/graph", params={"entity": "Italy", "limit": 41}).status_code == 422


def test_query_generation_without_key_stays_local_and_does_not_call_provider(monkeypatch, client):
    def unexpected_client(*args, **kwargs):
        pytest.fail("missing API key must prevent provider request construction")

    monkeypatch.setattr("fifa_rag.generation.httpx.AsyncClient", unexpected_client)
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "graph",
            "generate": True,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["generation"] == "unavailable"
    assert payload["evidence"]
    assert any("no paid request was made" in item for item in payload["diagnostics"])


def test_mocked_provider_failure_is_sanitized_at_query_endpoint(monkeypatch, client):
    def fail_request(*args, **kwargs):
        raise httpx.ConnectError("private-test-token")

    monkeypatch.setattr("fifa_rag.generation.httpx.AsyncClient.post", fail_request)
    # Supply explicit settings on a separate app; only the HTTP client is mocked.
    settings = make_settings(
        semantic_path=client.app.state.semantic.path,
        GROQ_API_KEY="private-test-token",
        enable_paid_inference=True,
    )
    with TestClient(create_app(settings)) as configured_client:
        response = configured_client.post(
            "/api/query",
            json={
                "question": "Who hosted the 1934 FIFA World Cup?",
                "mode": "graph",
                "generate": True,
                "tournament": "1934 FIFA World Cup",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["generation"] == "failed"
    assert "private-test-token" not in response.text
    assert any("ConnectError" in item for item in payload["diagnostics"])


def test_graph_reasoning_requires_explicit_request_and_stays_off_without_key(monkeypatch, client):
    def unexpected_client(*args, **kwargs):
        pytest.fail("disabled hosted planning must not create a provider client")

    monkeypatch.setattr("fifa_rag.generation.httpx.AsyncClient", unexpected_client)
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "graph",
            "generate": True,
            "graph_reasoning": True,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["generation"] == "unavailable"
    assert payload["graph_query"] is None
    assert payload["evidence"]
    assert any("planning is disabled" in note for note in payload["diagnostics"])


def test_valid_planned_query_can_only_return_existing_chunk_source_ids(monkeypatch, client):
    cypher = (
        "MATCH (c:Chunk) WHERE c.text CONTAINS '1934 FIFA World Cup' RETURN c.chunk_id AS chunk_id LIMIT 1"
    )

    async def planner(question, schema):
        assert "Chunk" in str(schema)
        return cypher, []

    monkeypatch.setattr(client.app.state.generator, "plan_graph", planner)
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "graph",
            "generate": True,
            "graph_reasoning": True,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["graph_query"]["query"] == cypher
    assert payload["graph_query"]["rows"]
    assert len(payload["evidence"]) == 1
    assert payload["evidence"][0]["id"] == payload["graph_query"]["rows"][0]["chunk_id"]
    assert "1934 FIFA World Cup" in payload["evidence"][0]["text"]
    assert any("validated" in note and "graph query" in note for note in payload["diagnostics"])


def test_invalid_planned_cypher_is_rejected_and_keeps_deterministic_evidence(monkeypatch, client):
    async def planner(question, schema):
        return "MATCH (n:Team) DELETE n RETURN n LIMIT 1", []

    monkeypatch.setattr(client.app.state.generator, "plan_graph", planner)
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "graph",
            "generate": True,
            "graph_reasoning": True,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["graph_query"] is None
    assert payload["evidence"]
    assert all("1934 FIFA World Cup" in item["text"] for item in payload["evidence"])
    assert any("rejected or failed" in note for note in payload["diagnostics"])


def test_planned_query_without_source_ids_keeps_deterministic_evidence(monkeypatch, client):
    async def planner(question, schema):
        return "MATCH (t:Tournament) RETURN t.id AS tournament LIMIT 3", []

    monkeypatch.setattr(client.app.state.generator, "plan_graph", planner)
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "graph",
            "generate": True,
            "graph_reasoning": True,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["graph_query"]["rows"]
    assert payload["evidence"]
    assert any("no usable source IDs" in note for note in payload["diagnostics"])


def test_semantic_mode_skips_graph_planner_even_if_reasoning_requested(monkeypatch, client):
    async def unexpected_planner(*args, **kwargs):
        pytest.fail("semantic-only mode must not plan graph queries")

    monkeypatch.setattr(client.app.state.generator, "plan_graph", unexpected_planner)
    response = client.post(
        "/api/query",
        json={
            "question": "Who hosted the 1934 FIFA World Cup?",
            "mode": "semantic",
            "generate": True,
            "graph_reasoning": True,
            "tournament": "1934 FIFA World Cup",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["graph_query"] is None
    assert payload["used_mode"] == "semantic"
    assert payload["evidence"]

from collections import Counter

import pytest
from fifa_rag.models import Evidence, QueryRequest
from fifa_rag.retrieval import Retriever, fuse


def evidence(identifier: str, *, methods: list[str], text: str | None = None, score: float = 0.8) -> Evidence:
    return Evidence(
        id=identifier,
        text=text or f"Source passage for {identifier}",
        source=f"source:{identifier}",
        score=score,
        methods=methods,
        entities=[identifier],
        metadata={"path": methods[0]},
    )


class SearchStub:
    def __init__(self, results=None, error: Exception | None = None):
        self.results = results or []
        self.error = error
        self.calls: list[tuple[str, int, str | None]] = []

    def search(self, question: str, top_k: int, tournament: str | None):
        self.calls.append((question, top_k, tournament))
        if self.error:
            raise self.error
        return list(self.results[:top_k])


def request(mode: str, *, top_k: int = 5) -> QueryRequest:
    return QueryRequest(question="Who hosted the 1934 World Cup?", mode=mode, top_k=top_k, tournament="1934")


def test_fuse_merges_same_chunk_and_records_both_methods():
    graph_item = evidence("chunk-a", methods=["graph"], score=0.92)
    semantic_item = evidence("chunk-a", methods=["semantic"], text="Merged semantic version", score=0.7)
    distinct = evidence("chunk-b", methods=["semantic"])

    result = fuse([graph_item], [semantic_item, distinct], top_k=2)

    assert [item.id for item in result] == ["chunk-a", "chunk-b"]
    merged = result[0]
    assert merged.methods == ["graph", "semantic"]
    assert merged.entities == ["chunk-a"]
    assert merged.metadata == {"path": "semantic"}
    assert merged.score == pytest.approx(1 / 61 + 1 / 61)
    # Fusion must not mutate an input evidence object.
    assert graph_item.score == 0.92
    assert graph_item.methods == ["graph"]


def test_hybrid_mode_fuses_both_successful_paths_and_passes_request_scope():
    graph = SearchStub([evidence("same", methods=["graph"]), evidence("g", methods=["graph"])])
    semantic = SearchStub([evidence("same", methods=["semantic"]), evidence("s", methods=["semantic"])])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("hybrid", top_k=3))

    assert used == "hybrid"
    assert diagnostics == []
    assert Counter(item.id for item in results) == Counter({"same": 1, "g": 1, "s": 1})
    assert results[0].methods == ["graph", "semantic"]
    assert graph.calls == [("Who hosted the 1934 World Cup?", 3, "1934")]
    assert semantic.calls == [("Who hosted the 1934 World Cup?", 3, "1934")]


def test_hybrid_survives_one_backend_exception_and_reports_degradation():
    graph = SearchStub(error=RuntimeError("graph offline"))
    semantic = SearchStub([evidence("s", methods=["semantic"])])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("hybrid"))

    assert [item.id for item in results] == ["s"]
    assert used == "semantic"
    assert any(
        "Graph retrieval unavailable" in message and "graph offline" in message for message in diagnostics
    )
    assert any("degraded" in message.lower() for message in diagnostics)


def test_hybrid_reports_empty_results_without_failing():
    graph = SearchStub([])
    semantic = SearchStub([])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("hybrid"))

    assert results == []
    assert used == "none"
    assert any("Graph retrieval returned no matching evidence" in message for message in diagnostics)
    assert any("Semantic retrieval returned no matching evidence" in message for message in diagnostics)


@pytest.mark.parametrize("graph_failure", [False, True])
def test_auto_falls_back_to_semantic_for_empty_or_failed_graph(graph_failure):
    graph = SearchStub(error=RuntimeError("graph offline") if graph_failure else None)
    if not graph_failure:
        graph.results = []
    semantic = SearchStub([evidence("s", methods=["semantic"])])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("auto"))

    assert [item.id for item in results] == ["s"]
    assert used == "semantic"
    assert len(graph.calls) == len(semantic.calls) == 1
    assert any("Automatic fallback used semantic evidence" in message for message in diagnostics)


def test_auto_uses_graph_without_calling_semantic_when_graph_succeeds():
    graph = SearchStub([evidence("g", methods=["graph"])])
    semantic = SearchStub([evidence("s", methods=["semantic"])])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("auto"))

    assert [item.id for item in results] == ["g"]
    assert used == "graph"
    assert semantic.calls == []
    assert diagnostics == []


def test_explicit_graph_mode_does_not_fall_back_to_semantic():
    graph = SearchStub(error=RuntimeError("graph offline"))
    semantic = SearchStub([evidence("s", methods=["semantic"])])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("graph"))

    assert results == []
    assert used == "none"
    assert semantic.calls == []
    assert any("Graph retrieval unavailable" in message for message in diagnostics)


def test_explicit_semantic_mode_does_not_call_graph():
    graph = SearchStub([evidence("g", methods=["graph"])])
    semantic = SearchStub([evidence("s", methods=["semantic"])])

    results, used, diagnostics = Retriever(graph, semantic).retrieve(request("semantic"))

    assert [item.id for item in results] == ["s"]
    assert used == "semantic"
    assert graph.calls == []
    assert diagnostics == []

import pytest
from fifa_rag.semantic import SemanticStore, _write_snapshot


def test_persisted_index_search_and_tournament_filter(tmp_path):
    documents = [
        {
            "id": "chunk-1930",
            "text": "[Context: 1930 FIFA World Cup | Section: Final]\nUruguay defeated Argentina 4–2 in the final.",
            "source": "chunk-1930",
            "entities": ["Uruguay", "Argentina"],
            "metadata": {
                "chunk_id": "chunk-1930",
                "tournament": "1930 FIFA World Cup",
                "section": "Final",
                "source_anchor": "1930 FIFA World Cup — Final",
                "entity_ids": ["Uruguay", "Argentina"],
            },
        },
        {
            "id": "chunk-1950",
            "text": "[Context: 1950 FIFA World Cup | Section: Final Group]\nUruguay beat Brazil at the Maracanã.",
            "source": "chunk-1950",
            "entities": ["Uruguay", "Brazil"],
            "metadata": {
                "chunk_id": "chunk-1950",
                "tournament": "1950 FIFA World Cup",
                "section": "Final Group",
                "source_anchor": "1950 FIFA World Cup — Final Group",
                "entity_ids": ["Uruguay", "Brazil"],
            },
        },
        {
            "id": "chunk-mascot",
            "text": "[Context: 1966 FIFA World Cup | Section: Culture]\nWorld Cup Willie was the tournament mascot.",
            "source": "chunk-mascot",
            "entities": ["World Cup Willie"],
            "metadata": {
                "chunk_id": "chunk-mascot",
                "tournament": "1966 FIFA World Cup",
                "section": "Culture",
                "source_anchor": "1966 FIFA World Cup — Culture",
                "entity_ids": ["World Cup Willie"],
            },
        },
    ]
    _write_snapshot(tmp_path, documents)

    # A new instance verifies that retrieval uses the persisted snapshot.
    store = SemanticStore(tmp_path)
    health = store.health()
    assert health["available"] is True
    assert health["document_count"] == 3
    assert health["method"] == "TF–IDF / latent semantic analysis"
    results = store.search("Who won the 1930 final?", top_k=3)
    assert results
    assert {result.id for result in results} == {"chunk-1930"}
    filtered = store.search("Who won the final?", top_k=3, tournament="1930 FIFA World Cup")
    assert filtered
    assert all(result.metadata["tournament"] == "1930 FIFA World Cup" for result in filtered)
    first = next(result for result in results if result.id == "chunk-1930")
    assert first.source == "1930 FIFA World Cup — Final"
    assert "Uruguay" in first.entities
    assert store.search("qzxv blorg", top_k=3) == []


def test_missing_index_is_unavailable(tmp_path):
    store = SemanticStore(tmp_path / "missing")
    assert store.health()["available"] is False
    with pytest.raises(RuntimeError, match="Semantic index unavailable"):
        store.search("World Cup final")


def test_corrupt_document_checksum_is_reported_as_unavailable(tmp_path):
    _write_snapshot(
        tmp_path,
        [{"id": "chunk", "text": "World Cup final", "source": "anchor", "entities": [], "metadata": {}}],
    )
    current = (tmp_path / "CURRENT").read_text(encoding="utf-8").strip()
    documents_path = tmp_path / "versions" / current / "documents.jsonl"
    documents_path.write_text('{"id":"tampered"}\n', encoding="utf-8")

    store = SemanticStore(tmp_path)
    assert store.health()["available"] is False
    assert "checksum" in store.health()["error"]
    with pytest.raises(RuntimeError, match="Semantic index unavailable"):
        store.search("World Cup final")


def test_empty_index_is_available_but_has_no_results(tmp_path):
    _write_snapshot(tmp_path, [])
    store = SemanticStore(tmp_path)
    assert store.health()["available"] is False
    assert store.health()["document_count"] == 0
    assert store.search("World Cup final") == []


def test_independent_jsonl_ingestion_preserves_sources_and_rejects_duplicate_ids(tmp_path):
    from fifa_rag.semantic import ingest_documents
    documents = [{"id": "test-source", "text": "[Context: Test tournament | Section: Final]\nA fixture final was decided by a penalty.", "source": "test fixture", "entities": ["fixture team"]}]
    result = ingest_documents(documents, tmp_path)
    assert result["documents"] == 1
    store = SemanticStore(tmp_path)
    assert store.search("penalty")[0].source == "test fixture"
    with pytest.raises(ValueError, match="Duplicate"):
        ingest_documents(documents * 2, tmp_path)

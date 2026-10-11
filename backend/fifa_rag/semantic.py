"""Persistent local semantic retrieval over the graph's source chunks.

The index uses TF-IDF followed by normalized latent semantic analysis. It has no
network or model-download path. Index snapshots contain JSON and NumPy arrays;
loading a snapshot never unpickles data.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

import kuzu
import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize

from .models import Evidence

_FORMAT_VERSION = 1
_TOKEN_PATTERN = r"(?u)\b\w\w+\b"
_CONTEXT_RE = re.compile(r"^\[Context:\s*(.*?)\s*\|\s*Section:\s*(.*?)\s*\]\s*$", re.M)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_text(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _anchors(text: str) -> tuple[str | None, str | None]:
    match = _CONTEXT_RE.search(text)
    if not match:
        return None, None
    return match.group(1).strip() or None, match.group(2).strip() or None


def _graph_documents(graph_path: str | Path) -> list[dict[str, Any]]:
    """Read Chunk text and MENTIONS metadata without modifying the graph."""
    database = kuzu.Database(
        str(graph_path),
        read_only=True,
        buffer_pool_size=256 * 1024 * 1024,
        max_num_threads=2,
    )
    connection = kuzu.Connection(database)
    try:
        rows = connection.execute(
            "MATCH (c:Chunk) OPTIONAL MATCH (c)-[:MENTIONS]->(e) "
            "RETURN c.chunk_id AS chunk_id, c.text AS text, "
            "e._label AS entity_type, e.id AS entity_id"
        ).get_all()
    finally:
        connection.close()
        database.close()

    documents: dict[str, dict[str, Any]] = {}
    for chunk_id, text, entity_type, entity_id in rows:
        if not chunk_id or not isinstance(text, str) or not text.strip():
            continue
        document = documents.setdefault(
            str(chunk_id),
            {
                "id": str(chunk_id),
                "text": text.strip(),
                "source": str(chunk_id),
                "metadata": {},
                "entities": [],
            },
        )
        tournament, section = _anchors(document["text"])
        document["metadata"].update(
            {
                "chunk_id": str(chunk_id),
                "tournament": tournament,
                "section": section,
                "source_anchor": f"{tournament} — {section}" if tournament and section else None,
                "document_type": "chunk",
            }
        )
        if entity_id:
            entity = str(entity_id)
            if entity not in document["entities"]:
                document["entities"].append(entity)
            links = document["metadata"].setdefault("entity_ids", [])
            if entity not in links:
                links.append(entity)
            if entity_type:
                types = document["metadata"].setdefault("entity_types", [])
                if str(entity_type) not in types:
                    types.append(str(entity_type))
    return list(documents.values())


def _write_snapshot(root: Path, documents: list[dict[str, Any]]) -> str:
    root.mkdir(parents=True, exist_ok=True)
    versions = root / "versions"
    versions.mkdir(exist_ok=True)
    version = uuid.uuid4().hex
    staging = versions / f".{version}.tmp"
    final = versions / version
    staging.mkdir()

    docs_path = staging / "documents.jsonl"
    with docs_path.open("w", encoding="utf-8") as stream:
        for document in documents:
            stream.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())

    texts = [document["text"] for document in documents]
    arrays: dict[str, np.ndarray] = {}
    vocab: dict[str, int] = {}
    dimension = 0
    if texts:
        vectorizer = TfidfVectorizer(
            lowercase=True,
            strip_accents="unicode",
            sublinear_tf=True,
            ngram_range=(1, 2),
            token_pattern=_TOKEN_PATTERN,
            max_features=60_000,
            dtype=np.float32,
        )
        try:
            matrix = vectorizer.fit_transform(texts)
        except ValueError:  # Corpus may contain no token with at least two characters.
            matrix = None
        if matrix is not None and matrix.shape[1] > 0:
            vocab = {str(term): int(index) for term, index in vectorizer.vocabulary_.items()}
            components = min(256, len(documents) - 1, matrix.shape[1] - 1)
            if components >= 1:
                reducer = TruncatedSVD(n_components=components, n_iter=7, random_state=17)
                latent = reducer.fit_transform(matrix).astype(np.float32, copy=False)
                arrays["components"] = reducer.components_.astype(np.float32, copy=False)
                arrays["idf"] = vectorizer.idf_.astype(np.float32, copy=False)
                arrays["embeddings"] = normalize(latent, norm="l2").astype(np.float32, copy=False)
                dimension = int(components)
            else:
                # A one-document or one-feature corpus has no useful SVD reduction.
                arrays["components"] = np.empty((0, matrix.shape[1]), dtype=np.float32)
                arrays["idf"] = vectorizer.idf_.astype(np.float32, copy=False)
                arrays["embeddings"] = normalize(matrix, norm="l2").toarray().astype(np.float32)
                dimension = int(matrix.shape[1])
        else:
            arrays["components"] = np.empty((0, 0), dtype=np.float32)
            arrays["idf"] = np.empty((0,), dtype=np.float32)
            arrays["embeddings"] = np.zeros((len(documents), 0), dtype=np.float32)

    vocab_path = staging / "vocabulary.json"
    vocab_path.write_text(json.dumps(vocab, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    arrays_path = staging / "index.npz"
    np.savez_compressed(arrays_path, **arrays)
    manifest = {
        "format_version": _FORMAT_VERSION,
        "version": version,
        "document_count": len(documents),
        "vocabulary_size": len(vocab),
        "dimension": dimension,
        "documents_sha256": _sha256(docs_path),
        "vocabulary_sha256": _sha256(vocab_path),
        "index_sha256": _sha256(arrays_path),
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.replace(staging, final)

    # The pointer is the only live mutable file; replacing it makes activation atomic.
    _atomic_text(root / "CURRENT", version + "\n")
    return version


def build_index(graph_path: str | Path, semantic_path: str | Path) -> dict[str, Any]:
    """Build and atomically activate an index from existing graph chunks."""
    documents = _graph_documents(graph_path)
    version = _write_snapshot(Path(semantic_path), documents)
    return {"version": version, "documents": len(documents), "path": str(semantic_path)}


class SemanticStore:
    """Read-only query interface for a persistent local semantic index."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._error: str | None = None
        self._documents: list[dict[str, Any]] = []
        self._embeddings = np.zeros((0, 0), dtype=np.float32)
        self._vocabulary: dict[str, int] = {}
        self._idf = np.empty((0,), dtype=np.float32)
        self._components = np.empty((0, 0), dtype=np.float32)
        self._vectorizer: TfidfVectorizer | None = None
        self._manifest: dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        try:
            current = (self.path / "CURRENT").read_text(encoding="utf-8").strip()
            if not re.fullmatch(r"[a-f0-9]{32}", current):
                raise ValueError("Invalid semantic index pointer")
            snapshot = self.path / "versions" / current
            self._manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
            if self._manifest.get("format_version") != _FORMAT_VERSION:
                raise ValueError("Unsupported semantic index format")
            paths = {
                "documents.jsonl": "documents_sha256",
                "vocabulary.json": "vocabulary_sha256",
                "index.npz": "index_sha256",
            }
            for filename, checksum_key in paths.items():
                if _sha256(snapshot / filename) != self._manifest.get(checksum_key):
                    raise ValueError(f"Semantic index checksum failed for {filename}")
            with (snapshot / "documents.jsonl").open(encoding="utf-8") as stream:
                self._documents = [json.loads(line) for line in stream if line.strip()]
            self._vocabulary = json.loads((snapshot / "vocabulary.json").read_text(encoding="utf-8"))
            with np.load(snapshot / "index.npz", allow_pickle=False) as arrays:
                self._embeddings = arrays["embeddings"].astype(np.float32, copy=False)
                self._idf = arrays["idf"].astype(np.float32, copy=False)
                self._components = arrays["components"].astype(np.float32, copy=False)
            if self._vocabulary:
                vectorizer = TfidfVectorizer(
                    vocabulary=self._vocabulary,
                    lowercase=True,
                    strip_accents="unicode",
                    sublinear_tf=True,
                    ngram_range=(1, 2),
                    token_pattern=_TOKEN_PATTERN,
                    dtype=np.float32,
                )
                vectorizer.vocabulary_ = self._vocabulary
                vectorizer.fixed_vocabulary_ = True
                vectorizer._tfidf.idf_ = self._idf
                self._vectorizer = vectorizer
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            self._error = str(error)
            self._documents = []

    def health(self) -> dict[str, Any]:
        return {
            "available": self._error is None and bool(self._documents),
            "document_count": len(self._documents),
            "dimension": int(self._manifest.get("dimension", 0)),
            "version": self._manifest.get("version"),
            "error": self._error,
        }

    def search(self, question: str, top_k: int = 6, tournament: str | None = None) -> list[Evidence]:
        if not question or not self._documents or self._vectorizer is None:
            return []
        query = normalize(self._vectorizer.transform([" ".join(question.split())]), norm="l2")
        if query.nnz == 0:
            return []
        if self._components.size:
            vector = normalize(query @ self._components.T, norm="l2").toarray()[0]
        else:
            vector = query.toarray()[0]
        if not np.any(vector):
            return []
        scores = self._embeddings @ vector
        filtered: list[tuple[float, dict[str, Any]]] = []
        requested = tournament.casefold() if tournament else None
        for score, document in zip(scores, self._documents):
            metadata = document.get("metadata", {})
            stored_tournament = metadata.get("tournament")
            if requested and (not stored_tournament or requested not in stored_tournament.casefold()):
                continue
            filtered.append((float(score), document))
        filtered.sort(key=lambda item: item[0], reverse=True)
        return [
            Evidence(
                id=document["id"],
                text=document["text"],
                source=document.get("metadata", {}).get("source_anchor") or document.get("source", document["id"]),
                score=score,
                methods=["semantic"],
                entities=document.get("entities", []),
                metadata=document.get("metadata", {}),
            )
            for score, document in filtered[: max(0, int(top_k))]
        ]

    def close(self) -> None:
        """No open resources are held after the snapshot is loaded."""


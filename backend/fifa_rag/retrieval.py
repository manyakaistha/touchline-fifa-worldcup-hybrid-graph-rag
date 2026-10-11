"""Independent retrieval paths and reciprocal-rank evidence fusion."""
import logging
from .models import Evidence, QueryRequest

log = logging.getLogger(__name__)


def fuse(graph: list[Evidence], semantic: list[Evidence], top_k: int) -> list[Evidence]:
    """RRF with k=60; exact chunk identifiers collapse evidence from both paths."""
    merged: dict[str, Evidence] = {}
    for results in (graph, semantic):
        for rank, item in enumerate(results, 1):
            if item.id not in merged:
                merged[item.id] = item.model_copy(deep=True)
                merged[item.id].score = 0
            entry = merged[item.id]
            entry.score += 1 / (60 + rank)
            entry.methods = sorted(set(entry.methods + item.methods))
            entry.entities = sorted(set(entry.entities + item.entities))
            entry.metadata.update(item.metadata)
    return sorted(merged.values(), key=lambda e: (-e.score, e.id))[:top_k]


class Retriever:
    def __init__(self, graph, semantic):
        self.graph = graph
        self.semantic = semantic

    def retrieve(self, request: QueryRequest) -> tuple[list[Evidence], str, list[str]]:
        diagnostics = []
        results = {"graph": [], "semantic": []}

        def run(method):
            try:
                results[method] = getattr(self, method).search(request.question, request.top_k,
                                                              request.tournament)
                if not results[method]:
                    diagnostics.append(f"{method.capitalize()} retrieval returned no matching evidence.")
            except Exception as exc:
                log.warning("%s retrieval failed: %s", method, exc)
                diagnostics.append(f"{method.capitalize()} retrieval unavailable: {exc}")

        if request.mode == "auto":
            run("graph")
            if not results["graph"]:
                run("semantic")
                if results["semantic"]:
                    diagnostics.append("Automatic fallback used semantic evidence because graph retrieval had no usable evidence.")
        else:
            for method in ("graph", "semantic"):
                if request.mode in (method, "hybrid"):
                    run(method)
        active = [method for method, values in results.items() if values]
        used = "hybrid" if len(active) == 2 else (active[0] if active else "none")
        if request.mode == "hybrid" and len(active) == 1:
            diagnostics.append(f"Hybrid retrieval is degraded; only {active[0]} evidence is available.")
        evidence = fuse(results["graph"], results["semantic"], request.top_k) if used == "hybrid" else results.get(used, [])
        return evidence, used, diagnostics

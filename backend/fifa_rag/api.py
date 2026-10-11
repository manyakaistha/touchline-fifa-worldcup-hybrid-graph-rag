"""Single-origin API and frontend with lifecycle-managed resources."""
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .config import ROOT, Settings
from .generation import Generator
from .graph import LABELS, GraphStore
from .models import QueryRequest, QueryResponse
from .retrieval import Retriever, fuse
from .semantic import SemanticStore

log = logging.getLogger(__name__)


class CypherRequest(BaseModel):
    query: str = Field(min_length=10, max_length=8000)
    parameters: dict = Field(default_factory=dict)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = (settings or Settings()).resolve_paths()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.graph = await run_in_threadpool(GraphStore, settings.graph_path, settings.graph_timeout_ms)
        app.state.semantic = await run_in_threadpool(SemanticStore, settings.semantic_path)
        app.state.retriever = Retriever(app.state.graph, app.state.semantic)
        app.state.generator = Generator(settings)
        # Bound concurrent work and queued chat tasks in this local single-worker application.
        app.state.chat_slots = asyncio.Semaphore(2)
        log.info("Application ready; graph=%s semantic=%s", app.state.graph.health()["available"],
                 app.state.semantic.health()["available"])
        try:
            yield
        finally:
            app.state.graph.close()
            close = getattr(app.state.semantic, "close", None)
            if close:
                close()

    app = FastAPI(title="Touchline — FIFA Hybrid GraphRAG", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.get("/api/status")
    async def status():
        return {"graph": app.state.graph.health(), "semantic": app.state.semantic.health(),
                "generation": app.state.generator.health(), "modes": ["graph", "semantic", "hybrid", "auto"],
                "limits": {"top_k": 12, "graph_nodes": 41, "graph_relationships": 40},
                "data_note": "Extracted graph records can be incomplete or inconsistent; verify claims against source passages."}

    async def execute_query(body: QueryRequest, prepare_only: bool = False):
        start = time.perf_counter()
        try:
            await asyncio.wait_for(app.state.chat_slots.acquire(), timeout=1)
        except TimeoutError:
            raise HTTPException(429, "Two questions are already running. Try again shortly.") from None
        try:
            async with asyncio.timeout(2 * settings.request_timeout + 2 * settings.graph_timeout_ms / 1000 + 5):
                evidence, used, diagnostics = await run_in_threadpool(app.state.retriever.retrieve, body)
                graph_query = None
                if body.generate and body.graph_reasoning and body.mode != "semantic" and app.state.graph.health()["available"]:
                    cypher, plan_notes = await app.state.generator.plan_graph(body.question, app.state.graph.schema_context())
                    diagnostics.extend(plan_notes)
                    if cypher:
                        try:
                            graph_query = await run_in_threadpool(app.state.graph.query, cypher)
                            planned = await run_in_threadpool(app.state.graph.planned_evidence, graph_query, body.top_k, body.tournament)
                            if planned:
                                if body.mode == "hybrid":
                                    semantic = [item for item in evidence if "semantic" in item.methods]
                                    evidence = fuse(planned, semantic, body.top_k) if semantic else planned
                                    used = "hybrid" if semantic else "graph"
                                else:
                                    evidence, used = planned, "graph"
                                diagnostics.append("Evidence includes sources returned by a validated Groq graph query. Graph rows are extracted records; verify them against the passages.")
                            else:
                                diagnostics.append("The planned query returned no usable source IDs; deterministic retrieval was retained.")
                        except (ValueError, RuntimeError):
                            diagnostics.append("The planned graph query was rejected or failed; deterministic retrieval was retained.")
                            graph_query = None
                answer, generation, gen_notes = await app.state.generator.answer(body.question, evidence, body.generate and not prepare_only)
                graph = {"nodes": [], "edges": []}
                if evidence and app.state.graph.health()["available"]:
                    entities = evidence[0].entities
                    match = next((e for e in app.state.graph.entity_catalog if e["id"] in entities), None)
                    if match:
                        try:
                            graph = await run_in_threadpool(app.state.graph.explore, match["id"], match["label"], 24)
                        except Exception:
                            log.warning("Query graph preview unavailable", exc_info=True)
                            diagnostics.append("The graph preview could not be loaded; source evidence remains available.")
                return QueryResponse(question=body.question, requested_mode=body.mode, used_mode=used,
                                     answer=answer, evidence=evidence, diagnostics=diagnostics + gen_notes,
                                     generation=generation, graph_query=graph_query, elapsed_ms=round((time.perf_counter()-start)*1000, 2),
                                     graph=graph)
        except TimeoutError:
            raise HTTPException(504, "The request timed out. Try a narrower question.") from None
        finally:
            app.state.chat_slots.release()

    @app.post("/api/query", response_model=QueryResponse)
    async def query(body: QueryRequest):
        return await execute_query(body)

    @app.post("/api/query/stream")
    async def stream(body: QueryRequest):
        result = await execute_query(body, prepare_only=True)

        async def events():
            def event(payload):
                return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
            yield event({"type": "result", "result": result.model_dump()})
            if body.generate:
                start = time.perf_counter()
                try:
                    await asyncio.wait_for(app.state.chat_slots.acquire(), timeout=1)
                except TimeoutError:
                    yield event({"type": "complete", "answer": result.answer, "generation": "unavailable", "diagnostics": ["Generation is busy; evidence remains available."]})
                    return
                try:
                    async with asyncio.timeout(settings.request_timeout + 5):
                        async for part in app.state.generator.stream_answer(body.question, result.evidence):
                            if part["type"] == "complete":
                                part["elapsed_ms"] = round(result.elapsed_ms + (time.perf_counter()-start)*1000, 2)
                            yield event(part)
                except TimeoutError:
                    yield event({"type": "complete", "answer": "Answer generation timed out. Source evidence remains available.", "generation": "failed", "diagnostics": ["Streaming generation timed out."]})
                finally:
                    app.state.chat_slots.release()
            yield event({"type": "done"})

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/entities")
    async def entities(q: str = Query(default="", max_length=100), label: str | None = None,
                       limit: int = Query(default=20, ge=1, le=50)):
        try:
            return {"entities": await run_in_threadpool(app.state.graph.entities, q, label, limit), "labels": LABELS}
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except RuntimeError:
            raise HTTPException(503, "Graph unavailable; see /api/status for diagnostics.") from None

    @app.get("/api/graph")
    async def explore(entity: str = Query(min_length=1, max_length=200), label: str = "Team",
                      limit: int = Query(default=40, ge=1, le=40)):
        try:
            return await run_in_threadpool(app.state.graph.explore, entity, label, limit)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except RuntimeError:
            raise HTTPException(503, "Graph unavailable; see /api/status for diagnostics.") from None

    @app.post("/api/graph/query")
    async def graph_query(body: CypherRequest):
        try:
            return await run_in_threadpool(app.state.graph.query, body.query, body.parameters)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except RuntimeError:
            raise HTTPException(400 if app.state.graph.health()["available"] else 503,
                                "Graph query failed or graph is unavailable. Check the schema and query syntax.") from None

    @app.get("/api/schema")
    async def schema():
        return {"tables": app.state.graph.schema, "nodes": app.state.graph.node_counts,
                "relationships": app.state.graph.relationship_counts, "properties": app.state.graph.properties}

    @app.get("/", include_in_schema=False)
    async def home():
        return FileResponse(ROOT / "frontend/index.html")

    app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
    return app

"""Read-only Kuzu access with bounded, schema-derived retrieval."""
import json
import logging
import re
import subprocess
import sys
import threading
from pathlib import Path

import kuzu

from .models import Evidence

log = logging.getLogger(__name__)
LABELS = ("Tournament", "Team", "Player", "Match", "Stadium", "Award")
STOPWORDS = set("who what when where why how did does is are was were the a an of in on at for and with to world cup fifa teams team players player tournament hosted host played which won win tell about me".split())


def rows(result):
    try:
        return list(result.rows_as_dict())
    finally:
        result.close()


def validate_cypher(query: str) -> str:
    if len(query) > 8000 or ";" in query or "//" in query or "/*" in query or "--" in query:
        raise ValueError("Only one bounded MATCH query is allowed; comments and separators are forbidden.")
    # Mask strings before checking keywords, allowing entities such as 'Create'.
    scrubbed = re.sub(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"", "''", query)
    if not re.match(r"^\s*MATCH\b", scrubbed, re.I) or not re.search(r"\bRETURN\b", scrubbed, re.I):
        raise ValueError("A graph query must start with MATCH and include RETURN.")
    if re.search(r"\b(CREATE|MERGE|SET|DELETE|DETACH|DROP|ALTER|COPY|CALL|LOAD|INSTALL|ATTACH|IMPORT|EXPORT|BEGIN|COMMIT|ROLLBACK|UNION|REMOVE|FOREACH)\b", scrubbed, re.I):
        raise ValueError("Only read-only graph patterns are allowed.")
    if re.search(r"\[[^\]]*\*", scrubbed):
        raise ValueError("Variable-length traversal is disabled.")
    limits = re.findall(r"\bLIMIT\s+(\d+)\b", scrubbed, re.I)
    if not limits:
        query = query.rstrip() + " LIMIT 100"
    elif len(limits) != 1 or not 1 <= int(limits[0]) <= 100:
        raise ValueError("LIMIT must be between 1 and 100.")
    return query


class GraphStore:
    def __init__(self, path: Path, timeout_ms: int = 5000):
        self.path = Path(path)
        self.timeout_ms = timeout_ms
        self.db = None
        self.conn = None
        self.error = None
        self.lock = threading.RLock()
        self.node_counts = {}
        self.relationship_counts = {}
        self.schema = []
        self.properties = {}
        self.entity_catalog = []
        try:
            if not self.path.is_file():
                raise FileNotFoundError("Configured graph database is missing; no database was created.")
            # Kuzu 0.11 needs a lock companion even for read-only opens. It contains no graph data.
            Path(str(self.path) + ".lock").touch(exist_ok=True)
            self.db = kuzu.Database(str(self.path), read_only=True, buffer_pool_size=256 * 1024**2,
                                    max_num_threads=2, auto_checkpoint=False)
            self.conn = kuzu.Connection(self.db)
            self.conn.set_query_timeout(timeout_ms)
            self.schema = self._execute("CALL show_tables() RETURN *")
            for table in self.schema:
                name = table["name"]
                if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name):
                    continue
                self.properties[name] = self._execute(f"CALL table_info('{name}') RETURN *")
                if table["type"] == "NODE":
                    self.node_counts[name] = self._execute(f"MATCH (n:`{name}`) RETURN count(n) AS count")[0]["count"]
                else:
                    self.relationship_counts[name] = self._execute(f"MATCH ()-[r:`{name}`]->() RETURN count(r) AS count")[0]["count"]
            for label in LABELS:
                if label in self.node_counts:
                    self.entity_catalog.extend({"id": r["id"], "label": label, "properties": {k: v for k, v in r["node"].items() if not k.startswith("_")}}
                                               for r in self._execute(f"MATCH (n:{label}) RETURN n.id AS id, n AS node"))
        except Exception as exc:
            self.error = str(exc)
            log.warning("Graph initialization failed: %s", self.error)
            self.close()

    def _execute(self, query: str, parameters: dict | None = None) -> list[dict]:
        if self.conn is None:
            raise RuntimeError(self.error or "Graph unavailable")
        with self.lock:
            return rows(self.conn.execute(query, parameters or {}))

    def health(self) -> dict:
        return {"available": self.conn is not None, "error": self.error, "engine": "Kuzu", "version": "0.11.3",
                "node_counts": self.node_counts, "relationship_counts": self.relationship_counts,
                "read_only": True, "warnings": ["Relationship chunk_id values are unreliable in this supplied snapshot; evidence uses MENTIONS links and original text."]}

    def schema_context(self) -> dict:
        return {"tables": self.schema, "properties": self.properties}

    def planned_evidence(self, result: dict, top_k: int, tournament: str | None = None) -> list[Evidence]:
        ids = []
        for row in result["rows"]:
            for key, value in row.items():
                if key in ("chunk_id", "chunk_ids"):
                    values = value if isinstance(value, list) else [value]
                    ids.extend(v for v in values if isinstance(v, str))
        ids = list(dict.fromkeys(ids))[:50]
        if not ids:
            return []
        chunks = self._execute("MATCH (c:Chunk) WHERE c.chunk_id IN $ids RETURN c.chunk_id AS id, c.text AS text LIMIT 50", {"ids": ids})
        return [Evidence(id=c["id"], text=c["text"], source="Kaggle FIFA World Cup Wikipedia / graph Chunk",
                         methods=["graph"], score=1/(i+1), metadata={"provenance": "existing Chunk IDs returned by validated hosted Cypher"})
                for i, c in enumerate(chunks) if not tournament or tournament.casefold() in c["text"].casefold()][:top_k]

    def query(self, query: str, parameters: dict | None = None) -> dict:
        query = validate_cypher(query)
        if not self.conn:
            raise RuntimeError(self.error or "Graph unavailable")
        payload = {"path": str(self.path), "query": query, "parameters": parameters or {}, "timeout_ms": self.timeout_ms}
        try:
            process = subprocess.run([sys.executable, "-m", "fifa_rag.graph_worker"], input=json.dumps(payload),
                                     capture_output=True, text=True, timeout=self.timeout_ms / 1000 + 3)
            if process.returncode:
                raise RuntimeError("The isolated graph query failed; the application remains available.")
            result = json.loads(process.stdout)
            if "error" in result:
                raise RuntimeError(result["error"])
            return {"query": query, "rows": result["rows"]}
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            raise RuntimeError("The isolated graph query timed out or returned an invalid result.") from exc

    def entities(self, q: str = "", label: str | None = None, limit: int = 20) -> list[dict]:
        if not self.conn:
            raise RuntimeError(self.error or "Graph unavailable")
        if label and label not in LABELS:
            raise ValueError("Unknown entity type")
        return [item for item in self.entity_catalog if (not label or item["label"] == label)
                and q.casefold() in item["id"].casefold()][:limit]

    def _matches(self, question: str) -> list[dict]:
        tokens = set(re.findall(r"\w+", question.casefold())) - STOPWORDS
        scored = []
        for entity in self.entity_catalog:
            name = entity["id"].casefold()
            etokens = set(re.findall(r"\w+", name)) - STOPWORDS
            overlap = tokens & etokens
            if not overlap:
                continue
            full = name in question.casefold()
            score = len(overlap) / max(1, len(etokens)) + (2 if full else 0)
            if overlap == etokens or (entity["label"] == "Tournament" and any(t.isdigit() for t in overlap)):
                scored.append((score, entity))
        return [e for _, e in sorted(scored, key=lambda x: (-x[0], x[1]["id"]))[:8]]

    def search(self, question: str, top_k: int = 6, tournament: str | None = None) -> list[Evidence]:
        if not self.conn:
            raise RuntimeError(self.error or "Graph unavailable")
        matches = self._matches(question)
        years = re.findall(r"\b(?:18|19|20)\d{2}\b", question)
        if not matches:
            return []
        found = {}
        for entity in matches:
            label = entity["label"]
            chunks = self._execute(f"MATCH (c:Chunk)-[:MENTIONS]->(n:{label}) WHERE n.id = $id RETURN c.chunk_id AS id, c.text AS text LIMIT 200", {"id": entity["id"]})
            for chunk in chunks:
                if years and not any(year in chunk["text"].split("\n", 1)[0] for year in years):
                    continue
                if tournament and tournament.casefold() not in chunk["text"].casefold():
                    continue
                item = found.setdefault(chunk["id"], {**chunk, "entities": []})
                if entity["id"] not in item["entities"]:
                    item["entities"].append(entity["id"])
        tokens = set(re.findall(r"\w+", question.casefold())) - STOPWORDS
        for item in found.values():
            words = set(re.findall(r"\w+", item["text"].casefold()))
            item["score"] = len(tokens & words) / max(1, len(tokens)) + len(item["entities"]) * 0.15
        ranked = sorted(found.values(), key=lambda c: (-c["score"], c["id"]))[:top_k]
        return [Evidence(id=item["id"], text=item["text"], source="Kaggle FIFA World Cup Wikipedia / graph Chunk",
                         score=item["score"], methods=["graph"], entities=item["entities"],
                         metadata={"provenance": "MENTIONS entity-to-source links", "graph_linked": True}) for item in ranked]

    def explore(self, entity: str, label: str = "Team", limit: int = 40) -> dict:
        if label not in LABELS:
            raise ValueError("Unknown entity type")
        nodes = {}
        edges = []
        # Project IDs/type only: some stored relationship string properties trigger
        # native Kuzu crashes. No raw relationship object is decoded for exploration.
        for direction in ("out", "in"):
            pattern = f"(n:{label})-[r]->(m)" if direction == "out" else f"(n:{label})<-[r]-(m)"
            result = self.query(f"MATCH {pattern} WHERE n.id = $id AND label(m) <> 'Chunk' "
                                f"RETURN n.id AS nid, label(n) AS nlabel, m.id AS mid, label(m) AS mlabel, label(r) AS rlabel LIMIT {int(limit)}", {"id": entity})["rows"]
            for row in result:
                n_uid, m_uid = f"{row['nlabel']}:{row['nid']}", f"{row['mlabel']}:{row['mid']}"
                for uid, name, node_label in ((n_uid, row["nid"], row["nlabel"]), (m_uid, row["mid"], row["mlabel"])):
                    item = next((e for e in self.entity_catalog if e["id"] == name and e["label"] == node_label), {})
                    nodes[uid] = {"id": uid, "name": name, "label": node_label, "properties": item.get("properties", {})}
                edges.append({"source": n_uid if direction == "out" else m_uid,
                              "target": m_uid if direction == "out" else n_uid,
                              "type": row["rlabel"],
                              "properties": {"note": "Relationship properties omitted because this snapshot has malformed evidence IDs."}})
                if len(edges) >= limit:
                    break
            if len(edges) >= limit:
                break
        if not nodes:
            match = next((e for e in self.entity_catalog if e["id"] == entity and e["label"] == label), None)
            if match:
                uid = f"{label}:{entity}"
                nodes[uid] = {"id": uid, "name": entity, "label": label, "properties": match["properties"]}
        return {"nodes": list(nodes.values()), "edges": edges}

    def close(self):
        if self.conn:
            self.conn.close()
            self.conn = None
        if self.db:
            self.db.close()
            self.db = None

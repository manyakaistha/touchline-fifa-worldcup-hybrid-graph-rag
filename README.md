# Touchline — FIFA Hybrid GraphRAG

Touchline is a local-first FIFA World Cup evidence workbench. Ask a question, choose graph, semantic, hybrid, or automatic retrieval, and inspect the source passages and graph context used. It serves a single-page frontend and FastAPI API from one process. Each query retrieves evidence only by default: no hosted inference is called unless you turn on generation for that request. The semantic index uses no model or embedding API.

## Run locally

Requirements: Python 3.12 and [`uv`](https://docs.astral.sh/uv/). Node.js is optional and is only used for checking frontend JavaScript syntax.

```sh
uv sync
cp .env.example .env
make run
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The launcher is also available directly:

```sh
uv run python -m fifa_rag.startup
```

Paths in `.env` are resolved from the repository root. The graph opens read-only. If it is missing or cannot be opened, the service exposes diagnostics and semantic retrieval can still work when its index is available. Startup does not build data, call an API, or create a replacement graph.

### Optional hosted Groq

Hosted Groq inference is optional. To make it available, set a private key in your local, ignored `.env` file:

```dotenv
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
ENABLE_PAID_INFERENCE=true
```

`GROQ_BASE_URL` defaults to `https://api.groq.com/openai/v1`; `groq_api` is accepted as an alternate key name. `ENABLE_PAID_INFERENCE` defaults to true, but each request defaults to `generate=false`, so startup and ordinary evidence queries do not call Groq. Set the flag to false to forbid inference even when a request asks for generation. When you enable the Groq control, retrieved passages are sent to Groq for a cited answer. If graph reasoning is also requested, the service can first ask Groq to plan a graph query and then ask it to synthesize the answer: at most two inference requests per question, with no automatic retry. Generated Cypher is validated and bounded before read-only execution. Evidence retrieval works without credentials or paid inference. For a first integration check, enable the Groq control once in graph, hybrid, or auto mode; this can make one planning request and one synthesis request. See the [Groq model catalog](https://console.groq.com/docs/models) for current model availability and [deprecations](https://console.groq.com/docs/deprecations) before changing `GROQ_MODEL`.

## Retrieval and graph reasoning

The request accepts four modes:

- `graph` looks up passages linked to matching graph entities.
- `semantic` searches a local TF–IDF/LSA index.
- `hybrid` combines both result lists with reciprocal-rank fusion and deduplicates by exact chunk ID.
- `auto` tries graph retrieval and uses semantic retrieval if graph retrieval returns no usable evidence.

Results are evidence passages, not a complete set of records. The API limits a response to 12 passages. Graph entity matching and relationships are extracted records and can be noisy; a missing match is not proof that an event did not occur. Treat aggregate totals and absence claims as unverified unless supported by a complete, independently checked source.

Groq graph planning is an explicit option available only with generation enabled, the service configured for inference, and a non-semantic retrieval mode. The planned query must use the actual schema and return chunk IDs so the service can recover source passages. Invalid or unusable plans fall back to deterministic evidence lookup. Synthesis is grounded in retrieved passages and citation indices are checked, but citation validation does not establish factual entailment. Review every claim against its cited source.

The graph schema and current audited counts are described in [`docs/database-audit.md`](docs/database-audit.md); system boundaries are in [`docs/architecture.md`](docs/architecture.md).

## Build the local semantic index

Semantic search uses TF–IDF followed by truncated singular-value decomposition (latent semantic analysis) and cosine similarity. It does not download neural models, call an embedding service, or require a paid API.

Build or refresh the index explicitly:

```sh
make index
```

This reads existing `Chunk` text and entity links from the configured graph in read-only mode, then writes a versioned snapshot below `data/semantic/`. It atomically switches the local `CURRENT` pointer when the new snapshot is ready. It does not reconstruct source text or modify the graph. Index files are local generated data and are ignored by Git.

## HTTP endpoints

The interactive frontend is served at `/`. API documentation is available at `/docs` while the app is running.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Graph, semantic index, generation configuration, and supported modes |
| `POST` | `/api/query` | Retrieve source evidence and optionally request Groq planning/synthesis |
| `GET` | `/api/entities` | Search graph entities |
| `GET` | `/api/graph` | Explore relationships around an entity |
| `POST` | `/api/graph/query` | Run a bounded, read-only `MATCH` query |
| `GET` | `/api/schema` | Inspect graph tables and counts |

A query body can include `question`, `mode`, `top_k` (1–12), `tournament`, `generate`, and `graph_reasoning`. The default is hybrid evidence retrieval without generation.

## Data and provenance

The graph’s chunk passages are the source text currently used by Touchline. The raw tournament `.txt` corpus expected by the historical notebook is not included and has not been regenerated. The notebook points to the [FIFA World Cup Wikipedia dataset on Kaggle](https://www.kaggle.com/datasets/ds22f1001123/fifa-world-cup-wikipedia-dataset); an anonymous download attempt returned HTTP 404 during project setup, so the raw source files could not be retrieved there. Existing graph chunks and processed-chunk IDs were supplied as local artifacts.

The audit found 828 chunk records in the selected graph, with evidence links on many relationships. Extraction quality is uneven: the graph has 27 Award nodes but zero `RECEIVED_AWARD` relationships, and only nine `HELD_AT` relationships. These counts describe extracted records, not complete World Cup history. See [`docs/artifact-inventory.md`](docs/artifact-inventory.md) and [`data/original-manifest.json`](data/original-manifest.json) for the root-artifact inventory and SHA-256 baseline. Hash-matched database copies are documented in the inventory and stored under ignored `data/backups/`.

The notebook and filenames identify a Wikipedia-derived corpus distributed through Kaggle. Verify the upstream dataset’s license and attribution requirements before redistributing its text or derivatives. No license has been granted here for unique supplied originals, and this repository does not add an assumed blanket license. Do not treat the absence of a top-level `LICENSE` as a grant of rights.

## Development

Install development dependencies with `uv sync`. Run tests with `make test`; run the lint, frontend syntax, and test checks with `make check`:

```sh
make test
make check
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for change and preservation practices. The static frontend has no Node package installation or build step.

# Contributing

## Local setup

Use Python 3.12 and `uv`:

```sh
uv sync
cp .env.example .env
make run
```

The frontend is plain HTML, CSS, and JavaScript served by FastAPI. It has no build step or Node dependency installation. Node is optional and `make check` uses it only for `node --check frontend/app.js`.

## Code and data boundaries

Keep graph access read-only. Do not run notebook extraction, migrations, or bulk graph writes as part of application startup. The supported launcher is `make run` (`uv run python -m fifa_rag.startup`). Indexing is separate and explicit: `make index` reads the existing graph and writes a local semantic snapshot under ignored `data/semantic/`.

Do not replace, rename, or edit supplied root database files, their WAL, notebook exports, or processed-chunk lists during routine work. The matching copies under ignored `data/backups/` are for preservation and audit. Check hashes against `data/original-manifest.json` when a change could affect original artifacts. Keep credentials in the ignored local `.env`; never add keys to source, tests, logs, or documentation.

Hosted inference requires an explicit generated-answer request from the user. `ENABLE_PAID_INFERENCE` defaults to true as an availability gate; set it to false to forbid inference even when the UI requests it. Tests should use fake transports or injected settings and must not call Groq or other paid services. Retrieval and semantic indexing must not add neural model downloads or embedding API dependencies.

## Evidence and product claims

Graph nodes and relationships are extracted data, not independently verified historical truth. Ground answers in source chunks, expose diagnostics, and avoid claiming exhaustive totals or absence from a bounded top-k result. Preserve graph query validation and the chunk-ID provenance requirement for any generated query. Treat saved notebook code as a historical experiment; do not execute it to validate application behavior.

## Checks

Before proposing a change, run the checks relevant to it. The repository provides:

```sh
make test
make check
```

`make check` runs Ruff, checks frontend JavaScript syntax with Node, and runs pytest. Report the commands and actual outcomes; do not claim checks passed unless they were run in the current work context.

## Source attribution and licensing

The supplied graph contains text attributed in the application to a Kaggle-distributed FIFA World Cup/Wikipedia corpus. The original raw `.txt` dataset is not present in the workspace; the existing graph `Chunk.text` is the available passage source. Before adding or redistributing upstream content, verify the Kaggle dataset’s current terms and preserve the attribution required by the source. No license has been granted for unique supplied originals. Do not create or imply a blanket repository license without documented authorization.

## Change descriptions

Describe the user-visible behavior and the code path changed. Include relevant validation results and note limitations that affect interpretation, especially graph extraction gaps, top-k evidence limits, or the optional hosted generation boundary.

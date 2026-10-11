"""Build the local semantic index from the configured FIFA graph database."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from fifa_rag.config import Settings
from fifa_rag.semantic import build_index, ingest_documents


def main() -> None:
    settings = Settings().resolve_paths()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", default=str(settings.graph_path), help="Existing Kuzu graph path")
    parser.add_argument("--semantic", default=str(settings.semantic_path), help="Semantic index directory")
    parser.add_argument("--documents", type=Path, help="Ingest trusted JSONL documents independently of the graph")
    args = parser.parse_args()
    if args.documents:
        documents = [json.loads(line) for line in args.documents.read_text(encoding="utf-8").splitlines() if line.strip()]
        result = ingest_documents(documents, args.semantic)
    else:
        result = build_index(args.graph, args.semantic)
    print(f"Built semantic index {result['version']}: {result['documents']} chunks at {result['path']}")


if __name__ == "__main__":
    main()

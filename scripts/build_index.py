"""Build the local semantic index from the configured FIFA graph database."""

from __future__ import annotations

import argparse

from fifa_rag.config import Settings
from fifa_rag.semantic import build_index


def main() -> None:
    settings = Settings().resolve_paths()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", default=str(settings.graph_path), help="Existing Kuzu graph path")
    parser.add_argument("--semantic", default=str(settings.semantic_path), help="Semantic index directory")
    args = parser.parse_args()
    result = build_index(args.graph, args.semantic)
    print(f"Built semantic index {result['version']}: {result['documents']} chunks at {result['path']}")


if __name__ == "__main__":
    main()

"""Safe single-process launcher. No data construction or API calls on startup."""
import logging

import uvicorn

from .api import create_app
from .config import Settings


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings().resolve_paths()
    print(f"\nTouchline — FIFA intelligence\nOpen http://{settings.host}:{settings.port}\nAPI docs: http://{settings.host}:{settings.port}/docs\n")
    if not settings.graph_path.is_file():
        print("Graph file missing. The app will start with graph diagnostics and independent semantic retrieval.")
    if not (settings.semantic_path / "CURRENT").exists():
        print("Semantic index not detected. Build it explicitly with: make index")
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()

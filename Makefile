.PHONY: run index test check audit
run:
	uv run python -m fifa_rag.startup
index:
	uv run python scripts/build_index.py
test:
	uv run pytest -q
check:
	uv run ruff check backend scripts tests
	node --check frontend/app.js
	uv run pytest -q
audit:
	uv run python scripts/audit_databases.py

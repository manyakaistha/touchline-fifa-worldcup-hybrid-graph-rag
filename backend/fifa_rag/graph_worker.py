"""Isolate arbitrary Kuzu MATCH execution from the HTTP process.

Native failures and timeouts cannot kill the web server. Input is private JSON
on stdin; no credentials are needed or included.
"""
import json
import sys

import kuzu


def bounded(value):
    if isinstance(value, str):
        return value if len(value) <= 2000 else value[:2000] + " … [truncated]"
    if isinstance(value, list):
        return [bounded(item) for item in value[:100]]
    if isinstance(value, dict):
        return {key: bounded(item) for key, item in value.items()}
    return value


def main():
    payload = json.load(sys.stdin)
    db = None
    conn = None
    try:
        db = kuzu.Database(payload["path"], read_only=True, buffer_pool_size=256 * 1024**2,
                           max_num_threads=2, auto_checkpoint=False)
        conn = kuzu.Connection(db)
        conn.set_query_timeout(payload["timeout_ms"])
        result = conn.execute(payload["query"], payload.get("parameters", {}))
        output = []
        try:
            for row in result.rows_as_dict():
                output.append(bounded(row))
                if len(output) >= 100:
                    break
        finally:
            result.close()
        print(json.dumps({"rows": output}))
    except Exception:
        print(json.dumps({"error": "Kuzu rejected the query or encountered a database error."}))
    finally:
        if conn:
            conn.close()
        if db:
            db.close()


if __name__ == "__main__":
    main()

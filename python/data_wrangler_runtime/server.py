from __future__ import annotations

import json
import sys
import threading
import traceback
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from typing import Any

from .engines import EngineError
from .protocol import ProtocolError, decode_envelope, error_response, response_envelope
from .session import SessionManager


def dispatch(manager: SessionManager, request: dict[str, Any]) -> dict[str, Any]:
    kind = request.get("kind")
    if kind == "initialize":
        return manager.initialize()
    if kind == "openSession":
        return manager.open_session(
            request["source"],
            request.get("backend"),
            int(request.get("pageSize", 200)),
            request.get("mode"),
        )
    if kind == "getPage":
        return manager.get_page(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            request.get("filterModel", {"filters": [], "sort": []}),
        )
    if kind == "getSummary":
        return manager.get_summary(
            request["sessionId"],
            int(request["revision"]),
            request.get("filterModel", {"filters": [], "sort": []}),
            request.get("columns"),
        )
    if kind == "getDatasetStats":
        return manager.get_dataset_stats(
            request["sessionId"],
            int(request["revision"]),
            request.get("filterModel", {"filters": [], "sort": []}),
        )
    if kind == "getColumnValues":
        return manager.get_column_values(
            request["sessionId"],
            int(request["revision"]),
            request["column"],
            request.get("filterModel", {"filters": [], "sort": []}),
            request.get("search"),
            int(request.get("limit", 100)),
        )
    if kind == "previewStep":
        return manager.preview_step(
            request["sessionId"],
            int(request["revision"]),
            request["step"],
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            request.get("replaceStepId"),
        )
    if kind == "applyDraft":
        return manager.apply_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
        )
    if kind == "discardDraft":
        return manager.discard_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
        )
    if kind == "undoStep":
        return manager.undo_step(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
        )
    if kind == "closeSession":
        return manager.close_session(request["sessionId"], int(request["revision"]))
    raise ProtocolError(f"Unsupported request kind: {kind}")


def main() -> None:
    manager = SessionManager()
    write_lock = threading.Lock()
    pending_lock = threading.Lock()
    pending: dict[str, Future[dict[str, Any]]] = {}
    cancelled: set[str] = set()

    def write(payload: dict[str, Any]) -> None:
        with write_lock:
            sys.stdout.write(json.dumps(payload, default=str, allow_nan=False) + "\n")
            sys.stdout.flush()

    def complete(request_id: str, future: Future[dict[str, Any]]) -> None:
        with pending_lock:
            pending.pop(request_id, None)
            was_cancelled = request_id in cancelled
            cancelled.discard(request_id)
        if was_cancelled or future.cancelled():
            write(response_envelope(request_id, {"kind": "cancelled", "targetRequestId": request_id}))
            return
        try:
            response = future.result()
        except CancelledError:
            response = {"kind": "cancelled", "targetRequestId": request_id}
        except ProtocolError as error:
            response = error_response(str(error), code="invalid_request", recoverable=False)
        except EngineError as error:
            response = error_response(str(error), code="engine_error")
        except Exception as error:
            response = error_response(str(error), detail=traceback.format_exc())
        write(response_envelope(request_id, response))

    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="data-explorer") as executor:
        for line in sys.stdin:
            if not line.strip():
                continue
            request_id = _safe_request_id(line)
            try:
                request_id, _, request = decode_envelope(json.loads(line))
                if request["kind"] == "cancelRequest":
                    target = str(request["targetRequestId"])
                    with pending_lock:
                        cancelled.add(target)
                        future = pending.get(target)
                    if future:
                        future.cancel()
                    write(response_envelope(request_id, {"kind": "cancelled", "targetRequestId": target}))
                    continue
                future = executor.submit(dispatch, manager, request)
                with pending_lock:
                    pending[request_id] = future
                future.add_done_callback(lambda done, current=request_id: complete(current, done))
            except ProtocolError as error:
                write(
                    response_envelope(request_id, error_response(str(error), code="invalid_request", recoverable=False))
                )
            except Exception as error:
                write(response_envelope(request_id, error_response(str(error), detail=traceback.format_exc())))


def _safe_request_id(line: str) -> str:
    try:
        payload = json.loads(line)
        if isinstance(payload, dict):
            return str(payload.get("requestId", "unknown"))
    except Exception:
        pass
    return "unknown"


if __name__ == "__main__":
    main()

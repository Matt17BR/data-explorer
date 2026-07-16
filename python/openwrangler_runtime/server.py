from __future__ import annotations

import json
import sys
import threading
import traceback
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor, wait
from time import monotonic
from typing import Any

from .engines import EngineError
from .protocol import ProtocolError, decode_envelope, error_response, response_envelope
from .session import SessionManager

SHUTDOWN_GRACE_SECONDS = 1.5


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
            request.get("requestedSessionId"),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "getPage":
        return _with_view_request_id(
            manager.get_page(
                request["sessionId"],
                int(request["revision"]),
                int(request.get("offset", 0)),
                int(request.get("limit", 200)),
                request.get("filterModel", {"filters": [], "sort": []}),
                int(request["columnOffset"]),
                int(request["columnLimit"]),
            ),
            request,
        )
    if kind == "getSummary":
        return _with_view_request_id(
            manager.get_summary(
                request["sessionId"],
                int(request["revision"]),
                request.get("filterModel", {"filters": [], "sort": []}),
                request.get("columns"),
            ),
            request,
        )
    if kind == "getDatasetStats":
        return _with_view_request_id(
            manager.get_dataset_stats(
                request["sessionId"],
                int(request["revision"]),
                request.get("filterModel", {"filters": [], "sort": []}),
            ),
            request,
        )
    if kind == "getColumnValues":
        return _with_view_request_id(
            manager.get_column_values(
                request["sessionId"],
                int(request["revision"]),
                request["column"],
                request.get("filterModel", {"filters": [], "sort": []}),
                request.get("search"),
                int(request.get("limit", 100)),
            ),
            request,
        )
    if kind == "previewStep":
        return manager.preview_step(
            request["sessionId"],
            int(request["revision"]),
            request["step"],
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            request.get("replaceStepId"),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "inspectStep":
        return manager.inspect_step(
            request["sessionId"],
            int(request["revision"]),
            request["stepId"],
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "applyDraft":
        return manager.apply_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "discardDraft":
        return manager.discard_draft(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "undoStep":
        return manager.undo_step(
            request["sessionId"],
            int(request["revision"]),
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            int(request["columnOffset"]),
            int(request["columnLimit"]),
        )
    if kind == "exportData":
        return manager.export_data(
            request["sessionId"],
            int(request["revision"]),
            request["path"],
            request["format"],
        )
    if kind == "closeSession":
        return manager.close_session(request["sessionId"], int(request["revision"]))
    raise ProtocolError(f"Unsupported request kind: {kind}")


def _with_view_request_id(response: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    correlated = dict(response)
    correlated["viewRequestId"] = request["viewRequestId"]
    return correlated


def main() -> None:
    manager = SessionManager()
    write_lock = threading.Lock()
    pending_lock = threading.Lock()
    pending: dict[str, Future[dict[str, Any]]] = {}

    def write(payload: dict[str, Any]) -> None:
        with write_lock:
            sys.stdout.write(json.dumps(payload, default=str, allow_nan=False) + "\n")
            sys.stdout.flush()

    def complete(request_id: str, view_request_id: str | None, future: Future[dict[str, Any]]) -> None:
        with pending_lock:
            pending.pop(request_id, None)
        if future.cancelled():
            response = {"kind": "cancelled", "targetRequestId": request_id}
            if view_request_id:
                response["viewRequestId"] = view_request_id
            write(response_envelope(request_id, response))
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
        if response.get("kind") in {"error", "cancelled"} and view_request_id:
            response["viewRequestId"] = view_request_id
        write(response_envelope(request_id, response))

    interactive_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="openwrangler-interactive")
    background_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="openwrangler-background")
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request_id = _safe_request_id(line)
            view_request_id = _safe_view_request_id(line)
            try:
                request_id, priority, request = decode_envelope(json.loads(line))
                view_request_id = request.get("viewRequestId")
                if request["kind"] == "cancelRequest":
                    target = str(request["targetRequestId"])
                    if _cancel_pending_future(pending, pending_lock, target):
                        response = {"kind": "cancelled", "targetRequestId": target}
                    else:
                        response = error_response(
                            f"Request {target} is already running, complete, or unknown and cannot be cancelled.",
                            code="cancellation_unavailable",
                        )
                    write(response_envelope(request_id, response))
                    continue
                executor = background_executor if priority == "background" else interactive_executor
                future = executor.submit(dispatch, manager, request)
                with pending_lock:
                    pending[request_id] = future
                future.add_done_callback(
                    lambda done, current=request_id, view=view_request_id: complete(current, view, done)
                )
            except ProtocolError as error:
                response = error_response(str(error), code="invalid_request", recoverable=False)
                if view_request_id:
                    response["viewRequestId"] = view_request_id
                write(response_envelope(request_id, response))
            except Exception as error:
                response = error_response(str(error), detail=traceback.format_exc())
                if view_request_id:
                    response["viewRequestId"] = view_request_id
                write(response_envelope(request_id, response))
    finally:
        _shutdown_runtime(
            manager,
            (interactive_executor, background_executor),
            pending,
            pending_lock,
        )


def _shutdown_runtime(
    manager: SessionManager,
    executors: tuple[ThreadPoolExecutor, ...],
    pending: dict[str, Future[dict[str, Any]]],
    pending_lock: threading.Lock,
) -> None:
    """Begin cleanup immediately at EOF and wait only for the shutdown grace."""
    with pending_lock:
        futures = list(pending.values())

    # Cancel work that has not acquired a worker before session cleanup can
    # dispose its engine. Running work is handled by SessionManager.close_all,
    # which interrupts only engines that explicitly advertise that ability.
    for future in futures:
        future.cancel()
    for executor in executors:
        executor.shutdown(wait=False, cancel_futures=True)

    cleanup_complete = threading.Event()

    def close_manager() -> None:
        try:
            manager.close_all()
        finally:
            cleanup_complete.set()

    cleanup_thread = threading.Thread(
        target=close_manager,
        name="openwrangler-runtime-cleanup",
        daemon=True,
    )
    cleanup_thread.start()

    deadline = monotonic() + SHUTDOWN_GRACE_SECONDS
    cleanup_complete.wait(max(0.0, deadline - monotonic()))
    wait(futures, timeout=max(0.0, deadline - monotonic()))


def _cancel_pending_future(
    pending: dict[str, Future[dict[str, Any]]],
    pending_lock: threading.Lock,
    target_request_id: str,
) -> bool:
    """Cancel only work that has not started; running results remain authoritative."""
    with pending_lock:
        future = pending.get(target_request_id)
    return bool(future is not None and future.cancel())


def _safe_request_id(line: str) -> str:
    try:
        payload = json.loads(line)
        if isinstance(payload, dict):
            return str(payload.get("requestId", "unknown"))
    except Exception:
        pass
    return "unknown"


def _safe_view_request_id(line: str) -> str | None:
    try:
        payload = json.loads(line)
        if isinstance(payload, dict) and isinstance(payload.get("request"), dict):
            view_request_id = payload["request"].get("viewRequestId")
            return view_request_id if isinstance(view_request_id, str) and view_request_id else None
    except Exception:
        pass
    return None


if __name__ == "__main__":
    main()

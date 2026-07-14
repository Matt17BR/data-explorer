from __future__ import annotations

from typing import Any

from IPython.display import display

from .session import SessionManager

MIME_TYPE = "application/vnd.data-explorer.viewer.v1+json"


def show(value: Any, label: str = "dataframe", backend: str | None = None, page_size: int = 200) -> None:
    """Display a dataframe payload that the VS Code renderer can open in Data Explorer."""
    manager = SessionManager()
    source = {"kind": "notebookOutput", "label": label, "variableName": label}
    engine = (
        manager._engine(backend)
        if backend
        else next(candidate for candidate in manager.engines.values() if candidate.detect(value))
    )
    frame = getattr(engine, "normalize", lambda item: item)(value)
    session_id = label
    filtered = engine.apply_filter_model(frame, {"filters": [], "sort": []})
    payload = {
        "metadata": {
            "sessionId": session_id,
            "backend": engine.name,
            "source": source,
            "shape": engine.shape(frame),
            "filteredShape": engine.shape(filtered),
            "schema": engine.schema(frame),
            "filterModel": {"filters": [], "sort": []},
            "stats": engine.header_stats(filtered),
        },
        "page": engine.page(filtered, 0, page_size),
        "summaries": engine.summaries(filtered),
    }
    display({MIME_TYPE: payload}, raw=True)

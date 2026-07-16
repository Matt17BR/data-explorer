from __future__ import annotations

import pytest

from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_advanced_filter_logic_matches_between_columns_and_within_a_column(tmp_path, backend):
    path = tmp_path / "logic.csv"
    path.write_text("city,value\nBerlin,2\nMilan,7\nParis,12\nRome,20\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)

    model = {
        "logic": "or",
        "filters": [
            {
                "column": "city",
                "type": "string",
                "logic": "or",
                "predicates": [
                    {"kind": "predicate", "operator": "startsWith", "value": "Ber"},
                    {"kind": "predicate", "operator": "endsWith", "value": "lan"},
                ],
            },
            {
                "column": "value",
                "type": "integer",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": 15}],
            },
        ],
        "sort": [{"column": "value", "direction": "asc", "nulls": "last"}],
    }

    response = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, model)
    assert [row["values"][0]["display"] for row in response["page"]["rows"]] == ["Berlin", "Milan", "Rome"]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_empty_value_selection_does_not_hide_every_row(tmp_path, backend):
    path = tmp_path / "empty-selection.csv"
    path.write_text("name\nalpha\nbeta\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "name",
                "type": "string",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    response = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, model)
    assert response["page"]["totalRows"] == 2

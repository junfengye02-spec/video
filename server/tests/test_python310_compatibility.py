from __future__ import annotations

import ast
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]


def test_production_server_does_not_use_python311_datetime_utc():
    paths = list((ROOT_DIR / "server" / "app").rglob("*.py"))
    paths.append(ROOT_DIR / "server" / "manage.py")
    violations: list[str] = []

    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            imports_utc = (
                isinstance(node, ast.ImportFrom)
                and node.module == "datetime"
                and any(alias.name == "UTC" for alias in node.names)
            )
            accesses_utc = (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "datetime"
                and node.attr == "UTC"
            )
            if imports_utc or accesses_utc:
                violations.append(f"{path.relative_to(ROOT_DIR)}:{node.lineno}")

    assert violations == []

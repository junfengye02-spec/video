from __future__ import annotations

import argparse
import json
import os
import threading
import time
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx


def _read_json(path: Path, default: dict[str, Any] | None = None) -> dict[str, Any]:
    if not path.is_file():
        return dict(default or {})
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    os.replace(temporary, path)


class _ProviderState:
    def __init__(self, path: Path, media_path: Path) -> None:
        self.path = path
        self.media_path = media_path
        self.lock = threading.Lock()
        with self.lock:
            state = self.load()
            state.setdefault("mode", "queued")
            state.setdefault("quote_count", 0)
            state.setdefault("execute_attempt_count", 0)
            state.setdefault("execute_count", 0)
            state.setdefault("duplicate_execute_attempt_count", 0)
            state.setdefault("quote_status_count", 0)
            state.setdefault("video_task_count", 0)
            state.setdefault("receipt_count", 0)
            state.setdefault("download_count", 0)
            state.setdefault("quotes", {})
            self.save(state)

    def load(self) -> dict[str, Any]:
        return _read_json(self.path)

    def save(self, state: dict[str, Any]) -> None:
        _write_json(self.path, state)

    def mutate(self, callback):
        with self.lock:
            state = self.load()
            result = callback(state)
            self.save(state)
            return result


def _provider(args: argparse.Namespace) -> int:
    state = _ProviderState(Path(args.provider_state), Path(args.media_path))

    class Handler(BaseHTTPRequestHandler):
        server_version = "StrictGenerationUnitFake/1.0"

        def log_message(self, _format: str, *_values: Any) -> None:
            return

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode("utf-8"))

        def _json(self, status: int, value: dict[str, Any]) -> None:
            payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._json(200, {"status": "ok"})
                return
            if self.path == "/video-content":
                payload = state.media_path.read_bytes()

                def downloaded(current: dict[str, Any]) -> None:
                    current["download_count"] += 1

                state.mutate(downloaded)
                self.send_response(200)
                self.send_header("content-type", "video/mp4")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self._json(404, {"error": "unknown fake provider route"})

        def do_POST(self) -> None:  # noqa: N802
            body = self._body()
            now = int(datetime.now(timezone.utc).timestamp())
            if self.path == "/quote":

                def quoted(current: dict[str, Any]) -> dict[str, Any]:
                    current["quote_count"] += 1
                    quote_id = f"uq_{current['quote_count']:032x}"
                    current["quotes"][quote_id] = {
                        "model": str(body.get("model") or "omni_flash-10s"),
                        "task_id": None,
                    }
                    return {"quote_id": quote_id}

                quote = state.mutate(quoted)
                self._json(
                    200,
                    {
                        **quote,
                        "token_alias": "video-v1",
                        "model": str(body.get("model") or "omni_flash-10s"),
                        "estimated_quota": 500_000,
                        "estimated_cost_amount_micro": 1_000_000,
                        "expires_at": now + 3600,
                    },
                )
                return
            if self.path == "/execute":

                def executed(current: dict[str, Any]) -> dict[str, Any]:
                    current["execute_attempt_count"] += 1
                    quote = current["quotes"].get(str(body.get("quote_id")))
                    if quote is None:
                        return {"error": "unknown quote"}
                    if quote.get("task_id"):
                        current["duplicate_execute_attempt_count"] += 1
                        return {"error": "duplicate execute forbidden"}
                    current["execute_count"] += 1
                    task_id = f"task_{current['execute_count']:032x}"
                    quote["task_id"] = task_id
                    return {"task_id": task_id}

                result = state.mutate(executed)
                if "error" in result:
                    self._json(409, result)
                else:
                    self._json(200, result)
                return
            if self.path == "/quote-status":

                def quote_status(current: dict[str, Any]) -> dict[str, Any]:
                    current["quote_status_count"] += 1
                    quote = current["quotes"].get(str(body.get("quote_id")))
                    return dict(quote or {})

                quote = state.mutate(quote_status)
                if not quote:
                    self._json(404, {"error": "unknown quote"})
                    return
                self._json(
                    200,
                    {
                        "status": "accepted" if quote.get("task_id") else "quoted",
                        "task_id": quote.get("task_id"),
                        "created_at": now,
                        "expires_at": now + 3600,
                    },
                )
                return
            if self.path == "/video-task":

                def video_task(current: dict[str, Any]) -> str:
                    current["video_task_count"] += 1
                    return str(current.get("mode") or "queued")

                mode = state.mutate(video_task)
                self._json(
                    200,
                    {
                        "id": str(body.get("task_id")),
                        "status": "completed" if mode == "completed" else "queued",
                    },
                )
                return
            if self.path == "/receipt":

                def receipt(current: dict[str, Any]) -> None:
                    current["receipt_count"] += 1

                state.mutate(receipt)
                self._json(
                    200,
                    {
                        "reference_id": str(body.get("task_id")),
                        "status": "settled",
                        "model": "omni_flash-10s",
                        "settled_at": now,
                    },
                )
                return
            self._json(404, {"error": "unknown fake provider route"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    _write_json(
        Path(args.port_file),
        {"base_url": f"http://127.0.0.1:{server.server_address[1]}"},
    )
    try:
        server.serve_forever(poll_interval=0.05)
    finally:
        server.server_close()
    return 0


class StrictProcessNewApi:
    def __init__(self, base_url: str) -> None:
        from server.tests.test_api import FakeNewApi

        self.base_url = base_url.rstrip("/")
        self.local = FakeNewApi()

    def close(self) -> None:
        self.local.close()

    def _post(self, path: str, value: dict[str, Any]) -> dict[str, Any]:
        from server.app.provider.newapi import NewApiCallError

        try:
            response = httpx.post(f"{self.base_url}{path}", json=value, timeout=5)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise NewApiCallError("strict fake provider is unavailable") from exc

    def list_models(self, kind: str, token_alias: str | None = None):
        if kind == "video":
            return ["omni_flash-10s"]
        return self.local.list_models(kind, token_alias)

    def quote(self, kind, request, token_alias=None):
        if kind != "video":
            return self.local.quote(kind, request, token_alias)
        from server.app.provider.newapi import TokenScopedQuote, UsageQuote

        value = self._post("/quote", {"model": request.model})
        return TokenScopedQuote(
            token_alias=value["token_alias"],
            quote=UsageQuote(
                quote_id=value["quote_id"],
                status="quoted",
                model=value["model"],
                fixed_group="openmontage-video",
                relay_format="task",
                estimated_quota=value["estimated_quota"],
                quota_per_unit=Decimal("500000"),
                cost_currency="USD",
                estimated_cost_amount_micro=value["estimated_cost_amount_micro"],
                pricing_version="sha256:strict-process-fake",
                billing_fingerprint="sha256:strict-process-fake",
                other_ratios={"seconds": Decimal("10")},
                expires_at=value["expires_at"],
            ),
        )

    def execute_quoted(self, kind, token_alias, request, quote_id):
        if kind != "video":
            return self.local.execute_quoted(kind, token_alias, request, quote_id)
        from server.app.provider.newapi import QuotedExecutionResult

        value = self._post("/execute", {"quote_id": quote_id})
        gate = os.environ.get("GENERATION_UNITS_EXECUTE_ARM")
        if gate:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not Path(gate).is_file():
                time.sleep(0.01)
            if not Path(gate).is_file():
                raise RuntimeError("execute crash gate was not armed")
        if os.environ.get("GENERATION_UNITS_CRASH_AFTER_ACCEPT") == "1":
            os._exit(91)
        response = httpx.Response(200, json={"id": value["task_id"]})
        return QuotedExecutionResult("task", value["task_id"], response)

    def get_quote_status(self, kind, token_alias, quote_id):
        from server.app.provider.newapi import UsageQuoteStatus

        value = self._post("/quote-status", {"quote_id": quote_id})
        return UsageQuoteStatus(
            quote_id=quote_id,
            status=value["status"],
            reference_type="task" if value.get("task_id") else None,
            reference_id=value.get("task_id"),
            created_at=value["created_at"],
            expires_at=value["expires_at"],
            consumed_at=value["created_at"] if value.get("task_id") else None,
            updated_at=value["created_at"],
        )

    def get_video_task(self, token_alias, task_id):
        from server.app.provider.newapi import VideoTaskStatus

        value = self._post("/video-task", {"task_id": task_id})
        return VideoTaskStatus(id=value["id"], status=value["status"])

    def get_task_receipt(self, kind, token_alias, task_id):
        from server.app.provider.newapi import UsageReceipt

        value = self._post("/receipt", {"task_id": task_id})
        return UsageReceipt(
            reference_type="task",
            reference_id=value["reference_id"],
            status=value["status"],
            model=value["model"],
            quota=500_000,
            refunded_quota=0,
            quota_per_unit=Decimal("500000"),
            pricing_version="sha256:strict-process-fake",
            cost_currency="USD",
            cost_amount_micro=800_000,
            settled_at=value["settled_at"],
        )

    def get_request_receipt(self, kind, token_alias, request_id):
        return self.local.get_request_receipt(kind, token_alias, request_id)

    def download_video_content(
        self,
        token_alias,
        task_id,
        destination,
        *,
        fallback_url=None,
        progress_callback=None,
    ):
        from server.app.provider.newapi import NewApiCallError

        try:
            response = httpx.get(f"{self.base_url}/video-content", timeout=10)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise NewApiCallError("strict fake provider is unavailable") from exc
        destination.write_bytes(response.content)
        if progress_callback is not None:
            progress_callback()
        return len(response.content)


def _settings():
    from server.app.core.config import AppSettings

    return AppSettings(
        _env_file=None,
        environment="test",
        database_url=os.environ["DATABASE_URL"],
        auth_hmac_secret="x" * 32,
        newapi_text_fixed_group="openmontage-text",
        newapi_image_fixed_group="openmontage-image",
        newapi_video_fixed_group="openmontage-video",
        generation_units_v2=True,
    )


def _seed_database() -> None:
    from server.app.auth.models import User
    from server.app.billing.models import BillingSetting
    from server.app.db.base import Base
    from server.app.db.session import SessionLocal, engine
    from server.app.video_model_settings.service import (
        bootstrap_verified_duration_settings,
    )
    from server.app.wallet.models import WalletAccount
    from server.tests.test_api import TEST_USER

    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.get(User, TEST_USER.id) is None:
            db.add(
                User(
                    id=TEST_USER.id,
                    email=TEST_USER.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                )
            )
        if db.get(WalletAccount, "a" * 32) is None:
            db.add(
                WalletAccount(
                    id="a" * 32,
                    user_id=TEST_USER.id,
                    balance_units=1_000_000_000,
                    held_units=0,
                )
            )
        if db.get(BillingSetting, 1) is None:
            db.add(BillingSetting(id=1, multiplier_bps=15_000, version=0))
        bootstrap_verified_duration_settings(db)
        db.commit()


def _app(args: argparse.Namespace):
    from server.app.auth.dependencies import require_csrf, require_user
    from server.app.core.config import get_settings
    from server.app.db.session import SessionLocal, get_db
    from server.app.main import (
        _require_function_user,
        create_app,
        get_newapi_client,
    )
    from server.tests.test_api import TEST_USER

    _seed_database()
    app = create_app(
        db_path=Path(args.state_dir) / "workbench.sqlite3",
        projects_root=Path(args.state_dir) / "projects",
    )

    def database_dependency():
        with SessionLocal() as db:
            yield db

    provider = StrictProcessNewApi(args.provider_url)
    settings = _settings()
    app.dependency_overrides[get_db] = database_dependency
    app.dependency_overrides[require_user] = lambda: TEST_USER
    app.dependency_overrides[require_csrf] = lambda: TEST_USER
    app.dependency_overrides[_require_function_user] = lambda: TEST_USER
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_newapi_client] = lambda: provider
    app.state.task_worker.max_concurrency = 1
    app.state.task_worker.poll_interval_seconds = 0.02
    app.state.task_worker.retry_base_seconds = 0.01
    app.state.task_worker.lease_seconds = 1

    failed_revision = int(os.environ.get("GENERATION_UNITS_FAIL_REVISION") or 0)
    if failed_revision:
        from server.app.generation_units import publication

        original = publication.extract_tail_frame

        def injected_failure(**kwargs):
            if int(kwargs.get("video_version") or 0) == failed_revision:
                raise ValueError("injected replacement publication failure")
            return original(**kwargs)

        publication.extract_tail_frame = injected_failure
    return app


def _scenario_path(args: argparse.Namespace) -> Path:
    return Path(args.state_dir) / "scenario.json"


def _snapshot(args: argparse.Namespace, label: str) -> dict[str, Any]:
    from sqlalchemy import select

    from server.app.billing.models import GenerationJob
    from server.app.db.session import SessionLocal
    from server.app.generation_units.models import VideoGenerationUnit
    from server.app.tasks.models import TaskBatch, TaskItem
    from server.app.wallet.models import WalletEntry

    scenario = _read_json(_scenario_path(args))
    project_id = scenario.get("project_id")
    with SessionLocal() as db:
        batches = list(
            db.scalars(
                select(TaskBatch)
                .where(TaskBatch.project_id == project_id)
                .order_by(TaskBatch.created_at, TaskBatch.id)
            )
        )
        items = list(
            db.scalars(
                select(TaskItem)
                .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
                .where(TaskBatch.project_id == project_id)
                .order_by(TaskItem.created_at, TaskItem.id)
            )
        )
        jobs = list(
            db.scalars(
                select(GenerationJob)
                .where(GenerationJob.project_id == project_id)
                .order_by(GenerationJob.created_at, GenerationJob.id)
            )
        )
        units = list(
            db.scalars(
                select(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
                .order_by(VideoGenerationUnit.id, VideoGenerationUnit.revision)
            )
        )
        consume_job_ids = list(
            db.scalars(
                select(WalletEntry.source_id)
                .where(WalletEntry.kind == "consume")
                .order_by(WalletEntry.created_at, WalletEntry.id)
            )
        )
        value = {
            "label": label,
            "project_id": project_id,
            "batches": [
                {
                    "id": row.id,
                    "status": row.status,
                    "idempotency_key": row.idempotency_key,
                }
                for row in batches
            ],
            "items": [
                {
                    "id": row.id,
                    "batch_id": row.batch_id,
                    "status": row.status,
                    "attempt_count": row.attempt_count,
                    "billing_job_id": row.billing_job_id,
                    "target_entity_id": row.target_entity_id,
                    "target_entity_version": row.target_entity_version,
                }
                for row in items
            ],
            "jobs": [
                {
                    "id": row.id,
                    "status": row.status,
                    "operation": row.operation,
                    "quote_id": row.quote_id,
                    "provider_reference_id": row.provider_reference_id,
                    "result_visible": row.result_visible,
                }
                for row in jobs
            ],
            "units": [
                {
                    "id": row.id,
                    "revision": row.revision,
                    "status": row.status,
                    "active": row.active,
                    "billing_job_id": row.billing_job_id,
                    "output_path": row.output_path,
                    "source_duration_seconds": row.source_duration_seconds,
                }
                for row in units
            ],
            "consume_entry_count": len(consume_job_ids),
            "consume_job_ids": consume_job_ids,
        }
    output = Path(args.state_dir) / "snapshots" / f"{label}.json"
    _write_json(output, value)
    return value


def _wait_batch(batch_id: str, expected: str, timeout: float = 30) -> None:
    from server.app.db.session import SessionLocal
    from server.app.tasks.models import TaskBatch

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with SessionLocal() as db:
            batch = db.get(TaskBatch, batch_id)
            if batch is not None and batch.status == expected:
                return
        time.sleep(0.03)
    raise TimeoutError(f"task {batch_id} did not reach {expected}")


def _submit_crash(args: argparse.Namespace) -> int:
    from fastapi.testclient import TestClient

    from server.tests.test_generation_units import _preview, _project

    app = _app(args)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        storyboard["shots"] = storyboard["shots"][:2]
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
        workflow["brief"] = {
            **(workflow.get("brief") or {}),
            "duration_seconds": 10,
        }
        app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
        preview = _preview(client, project_id, storyboard)
        if preview.status_code != 200:
            raise RuntimeError(preview.text)
        plan = preview.json()
        unit_ids = [
            unit["id"]
            for unit in plan["generation_units"]
            if unit["status"] == "planned"
        ]
        response = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": unit_ids,
                "idempotency_key": "process-crash-original",
            },
        )
        if response.status_code != 202:
            raise RuntimeError(response.text)
        _write_json(
            _scenario_path(args),
            {
                "project_id": project_id,
                "storyboard_shot_ids": [shot["id"] for shot in storyboard["shots"]],
                "unit_id": unit_ids[0],
                "initial_batch_id": response.json()["task_id"],
                "initial_idempotency_key": "process-crash-original",
            },
        )
        Path(os.environ["GENERATION_UNITS_EXECUTE_ARM"]).touch()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            time.sleep(0.1)
        raise TimeoutError("worker crash injection did not terminate the process")


def _worker_until(args: argparse.Namespace) -> int:
    from fastapi.testclient import TestClient

    scenario = _read_json(_scenario_path(args))
    batch_id = str(
        scenario[
            "replacement_batch_id"
            if args.batch == "replacement"
            else "initial_batch_id"
        ]
    )
    app = _app(args)
    with TestClient(app):
        app.state.task_worker.notify()
        _wait_batch(batch_id, args.expected)
        _snapshot(args, args.label)
    return 0


def _expire(args: argparse.Namespace) -> int:
    from sqlalchemy import select

    from server.app.billing.models import BillingReconciliation
    from server.app.db.session import SessionLocal
    from server.app.tasks.models import TaskItem

    now = datetime.now(timezone.utc) - timedelta(seconds=5)
    with SessionLocal() as db:
        for item in db.scalars(select(TaskItem).where(TaskItem.status == "running")):
            item.lease_expires_at = now
        for row in db.scalars(
            select(BillingReconciliation).where(BillingReconciliation.status == "open")
        ):
            row.next_retry_at = now
        db.commit()
    _snapshot(args, args.label)
    return 0


def _reconcile(args: argparse.Namespace) -> int:
    from server.app.billing.reconciliation import resume_reconcile_publish_job
    from server.app.db.session import SessionLocal
    from server.app.storage import WorkbenchStore

    output: dict[str, Any]
    try:
        with SessionLocal() as db:
            outcome = resume_reconcile_publish_job(
                db,
                StrictProcessNewApi(args.provider_url),
                args.job_id,
                datetime.now(timezone.utc),
                settings=_settings(),
                media_store=WorkbenchStore(
                    projects_root=Path(args.state_dir) / "projects",
                    db_path=Path(args.state_dir) / "workbench.sqlite3",
                ),
                pending_delay_seconds=0,
            )
        output = {"outcome": outcome, "error": None}
    except Exception as exc:  # Deliberately records injected provider interruption.
        output = {"outcome": "error", "error": f"{type(exc).__name__}: {exc}"}
    _write_json(Path(args.output), output)
    _snapshot(args, args.label)
    return 0


def _replacement_fail(args: argparse.Namespace) -> int:
    from fastapi.testclient import TestClient
    from sqlalchemy import select

    from server.app.db.session import SessionLocal
    from server.app.tasks.models import TaskItem

    scenario = _read_json(_scenario_path(args))
    project_id = str(scenario["project_id"])
    app = _app(args)
    with TestClient(app) as client:
        response = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": scenario["storyboard_shot_ids"],
                "regenerate_unit_ids": [scenario["unit_id"]],
            },
        )
        if response.status_code != 200:
            raise RuntimeError(response.text)
        plan = response.json()
        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": [scenario["unit_id"]],
                "idempotency_key": "process-replacement-v2",
            },
        )
        if submitted.status_code != 202:
            raise RuntimeError(submitted.text)
        batch_id = submitted.json()["task_id"]
        deadline = time.monotonic() + 10
        item = None
        while time.monotonic() < deadline and item is None:
            with SessionLocal() as db:
                item = db.scalar(select(TaskItem).where(TaskItem.batch_id == batch_id))
                if item is not None:
                    item.max_attempts = 1
                    item_id = item.id
                    db.commit()
                    break
            time.sleep(0.01)
        if item is None:
            raise RuntimeError("replacement task item was not created")
        scenario.update(
            replacement_batch_id=batch_id,
            replacement_item_id=item_id,
            replacement_idempotency_key="process-replacement-v2",
        )
        _write_json(_scenario_path(args), scenario)
        Path(os.environ["GENERATION_UNITS_EXECUTE_ARM"]).touch()
        _wait_batch(batch_id, "failed")
        _snapshot(args, args.label)
    return 0


def _retry_replacement(args: argparse.Namespace) -> int:
    from fastapi.testclient import TestClient

    scenario = _read_json(_scenario_path(args))
    project_id = str(scenario["project_id"])
    app = _app(args)
    with TestClient(app) as client:
        response = client.post(
            f"/api/projects/{project_id}/tasks/{scenario['replacement_batch_id']}"
            f"/items/{scenario['replacement_item_id']}/retry"
        )
        if response.status_code != 202:
            raise RuntimeError(response.text)
        _wait_batch(str(scenario["replacement_batch_id"]), "complete")
        _snapshot(args, args.label)
    return 0


def _inspect(args: argparse.Namespace) -> int:
    _snapshot(args, args.label)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        choices={
            "provider",
            "submit-crash",
            "worker-until",
            "expire",
            "reconcile",
            "replacement-fail",
            "retry-replacement",
            "inspect",
        },
    )
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--provider-url", default="http://127.0.0.1:1")
    parser.add_argument("--provider-state")
    parser.add_argument("--media-path")
    parser.add_argument("--port-file")
    parser.add_argument("--expected", default="complete")
    parser.add_argument(
        "--batch", choices={"initial", "replacement"}, default="initial"
    )
    parser.add_argument("--label", default="snapshot")
    parser.add_argument("--job-id")
    parser.add_argument("--output")
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.mode == "provider":
        return _provider(args)
    if args.mode == "submit-crash":
        return _submit_crash(args)
    if args.mode == "worker-until":
        return _worker_until(args)
    if args.mode == "expire":
        return _expire(args)
    if args.mode == "reconcile":
        return _reconcile(args)
    if args.mode == "replacement-fail":
        return _replacement_fail(args)
    if args.mode == "retry-replacement":
        return _retry_replacement(args)
    if args.mode == "inspect":
        return _inspect(args)
    raise AssertionError(args.mode)


if __name__ == "__main__":
    with suppress(KeyboardInterrupt):
        raise SystemExit(main())

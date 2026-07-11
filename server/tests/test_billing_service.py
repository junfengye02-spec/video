from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from threading import Barrier, Event
from types import SimpleNamespace

import pytest
from sqlalchemy import Engine, create_engine, event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.billing.models import (
    BillingReconciliation,
    BillingSetting,
    CostReceipt,
    GenerationJob,
)
from server.app.billing.money import provider_micro_to_charge_units
from server.app.billing.service import (
    BillingService,
    InvalidBillingState,
    ProviderPricingUnavailable,
    StagedArtifact,
)
from server.app.db.base import Base
from server.app.projects.models import ProjectRecord
from server.app.provider.newapi import TokenScopedQuote, UsageQuote, UsageReceipt
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold
from server.app.wallet.service import InsufficientBalance, credit


NOW = datetime(2026, 7, 12, 1, 2, 3, tzinfo=timezone.utc)
USER_ID = "u000000000000000000000000000001"
OTHER_USER_ID = "u000000000000000000000000000002"
PROJECT_ID = "p000000000000000000000000000001"
OTHER_PROJECT_ID = "p000000000000000000000000000002"


def usage_quote(
    *,
    quote_id: str = "uq_00000000000000000000000000000001",
    token_alias: str = "video-v1",
    model: str = "video-model",
    cost_micro: int = 2_898_000,
    estimated_quota: int = 1_449_000,
    quota_per_unit: Decimal = Decimal("500000.5"),
    pricing_version: str = "sha256:pricing-v1",
    other_ratios: dict[str, Decimal] | None = None,
    fixed_group: str = "openmontage-video",
    relay_format: str = "task",
) -> TokenScopedQuote:
    return TokenScopedQuote(
        token_alias=token_alias,
        quote=UsageQuote(
            quote_id=quote_id,
            status="quoted",
            model=model,
            fixed_group=fixed_group,
            relay_format=relay_format,
            estimated_quota=estimated_quota,
            quota_per_unit=quota_per_unit,
            cost_currency="USD",
            estimated_cost_amount_micro=cost_micro,
            pricing_version=pricing_version,
            billing_fingerprint="sha256:fingerprint-v1",
            other_ratios=other_ratios
            if other_ratios is not None
            else {"seconds": Decimal("10"), "resolution": Decimal("1.500")},
            expires_at=int((NOW + timedelta(seconds=120)).timestamp()),
        ),
    )


def incomplete_pricing_quote() -> TokenScopedQuote:
    valid = usage_quote()
    return TokenScopedQuote(
        token_alias=valid.token_alias,
        quote=valid.quote.model_copy(update={"pricing_version": ""}),
    )


@pytest.fixture
def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add_all(
            [
                User(
                    id=USER_ID,
                    email="billing@example.com",
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                User(
                    id=OTHER_USER_ID,
                    email="billing-other@example.com",
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
            ]
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=PROJECT_ID,
                    owner_user_id=USER_ID,
                    title="Billing project",
                    mode="short_drama",
                    project_type="single_video",
                ),
                ProjectRecord(
                    id=OTHER_PROJECT_ID,
                    owner_user_id=OTHER_USER_ID,
                    title="Other billing project",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id="w000000000000000000000000000001",
                    user_id=USER_ID,
                    balance_units=40_000_000,
                    held_units=0,
                ),
                WalletAccount(
                    id="w000000000000000000000000000002",
                    user_id=OTHER_USER_ID,
                    balance_units=40_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        yield db
    engine.dispose()


class ArtifactStore:
    def __init__(self) -> None:
        self.artifacts: dict[str, StagedArtifact] = {}

    def inspect(self, locator: str) -> StagedArtifact:
        return self.artifacts[locator]

    def add(
        self,
        *,
        locator: str,
        source_reference: str,
        capability: str = "video",
        sha256: str = "a" * 64,
    ) -> StagedArtifact:
        artifact = StagedArtifact(
            locator=locator,
            sha256=sha256,
            source_reference=source_reference,
            capability=capability,
        )
        self.artifacts[locator] = artifact
        return artifact


@pytest.fixture
def artifact_store() -> ArtifactStore:
    return ArtifactStore()


@pytest.fixture
def billing_service(db_session: Session, artifact_store: ArtifactStore) -> BillingService:
    settings = SimpleNamespace(
        billing_reference_recovery_seconds=86_400,
        billing_receipt_deadline_seconds=86_400,
        billing_hold_timeout_seconds=86_400,
    )
    return BillingService(
        db_session,
        settings,
        artifact_inspector=artifact_store.inspect,
        now=lambda: NOW,
    )


def test_parent_creation_validates_project_ownership_and_shape(
    db_session: Session, billing_service: BillingService
) -> None:
    parent = billing_service.create_parent_job(
        user_id=USER_ID, project_id=PROJECT_ID, operation="render"
    )

    assert parent.chargeable is False
    assert parent.status == "running"
    assert parent.parent_job_id is None
    assert parent.token_alias is None
    assert db_session.scalar(
        select(func.count(WalletHold.id)).where(WalletHold.job_id == parent.id)
    ) == 0
    with pytest.raises(InvalidBillingState, match="project"):
        billing_service.create_parent_job(
            user_id=USER_ID, project_id=OTHER_PROJECT_ID, operation="render"
        )


def test_reservation_snapshots_quote_and_creates_exact_hold_and_deadlines(
    db_session: Session, billing_service: BillingService
) -> None:
    parent = billing_service.create_parent_job(
        user_id=USER_ID, project_id=PROJECT_ID, operation="render"
    )
    child = billing_service.reserve_provider_call(
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=parent.id,
        capability="video",
        operation="shot:s1",
        provider_method="POST",
        provider_route="/v1/videos",
        quote=usage_quote(),
    )
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))

    assert child.status == "reserved"
    assert child.multiplier_bps == 15_000
    assert child.quote_id == "uq_00000000000000000000000000000001"
    assert child.quote_other_ratios_json == '{"resolution":1.5,"seconds":10}'
    assert child.quote_quota_per_unit == Decimal("500000.5")
    assert child.reference_deadline == NOW + timedelta(seconds=86_400)
    assert child.receipt_deadline == NOW + timedelta(seconds=86_400)
    assert hold is not None
    assert hold.amount_units == 4_347_000
    assert hold.expires_at.replace(tzinfo=timezone.utc) == NOW + timedelta(seconds=86_400)


def test_child_parent_must_be_nonchargeable_and_same_owner_project(
    billing_service: BillingService,
) -> None:
    other_parent = billing_service.create_parent_job(
        user_id=OTHER_USER_ID, project_id=OTHER_PROJECT_ID, operation="render"
    )

    with pytest.raises(InvalidBillingState, match="parent"):
        billing_service.reserve_provider_call(
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=other_parent.id,
            capability="video",
            operation="shot:s1",
            provider_method="POST",
            provider_route="/v1/videos",
            quote=usage_quote(),
        )


@pytest.mark.parametrize(
    "quote",
    [
        usage_quote(cost_micro=0),
        usage_quote(estimated_quota=0),
        usage_quote(token_alias=""),
        incomplete_pricing_quote(),
    ],
)
def test_zero_or_incomplete_quote_is_rejected_before_job_or_hold(
    db_session: Session,
    billing_service: BillingService,
    quote: TokenScopedQuote,
) -> None:
    jobs_before = db_session.scalar(select(func.count(GenerationJob.id)))

    with pytest.raises(ProviderPricingUnavailable):
        billing_service.reserve_provider_call(
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="video",
            operation="shot:s1",
            provider_method="POST",
            provider_route="/v1/videos",
            quote=quote,
        )

    assert db_session.scalar(select(func.count(GenerationJob.id))) == jobs_before
    assert db_session.scalar(select(func.count(WalletHold.id))) == 0


def test_nonfinite_or_nonpositive_quote_ratios_are_rejected_before_job(
    db_session: Session, billing_service: BillingService
) -> None:
    valid = usage_quote()
    malformed = TokenScopedQuote(
        token_alias=valid.token_alias,
        quote=valid.quote.model_copy(
            update={"other_ratios": {"seconds": Decimal("NaN")}}
        ),
    )

    with pytest.raises(ProviderPricingUnavailable):
        billing_service.reserve_provider_call(
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="video",
            operation="shot:s1",
            provider_method="POST",
            provider_route="/v1/videos",
            quote=malformed,
        )
    assert db_session.scalar(select(func.count(GenerationJob.id))) == 0


def test_reservation_rolls_back_job_when_hold_cannot_be_funded(
    db_session: Session, billing_service: BillingService
) -> None:
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == USER_ID)
    )
    assert wallet is not None
    wallet.balance_units = 1
    db_session.commit()

    with pytest.raises(InsufficientBalance):
        billing_service.reserve_provider_call(
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="video",
            operation="shot:s1",
            provider_method="POST",
            provider_route="/v1/videos",
            quote=usage_quote(),
        )

    assert db_session.scalar(select(func.count(GenerationJob.id))) == 0
    assert db_session.scalar(select(func.count(WalletHold.id))) == 0


def test_duplicate_quote_reservation_rolls_back_second_job_and_hold(
    db_session: Session, billing_service: BillingService
) -> None:
    reserve_child(billing_service)

    with pytest.raises(InvalidBillingState, match="quote"):
        reserve_child(
            billing_service,
            user_id=OTHER_USER_ID,
            project_id=OTHER_PROJECT_ID,
        )
    assert db_session.scalar(select(func.count(GenerationJob.id))) == 1
    assert db_session.scalar(select(func.count(WalletHold.id))) == 1


def reserve_child(
    billing_service: BillingService,
    *,
    user_id: str = USER_ID,
    project_id: str = PROJECT_ID,
    quote_id: str = "uq_00000000000000000000000000000001",
    cost_micro: int = 2_898_000,
) -> GenerationJob:
    return billing_service.reserve_provider_call(
        user_id=user_id,
        project_id=project_id,
        parent_job_id=None,
        capability="video",
        operation="shot:s1",
        provider_method="POST",
        provider_route="/v1/videos",
        quote=usage_quote(quote_id=quote_id, cost_micro=cost_micro),
    )


def test_load_job_returns_detached_refresh_without_surviving_transaction(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)

    loaded = billing_service.load_job(child.id)

    assert loaded.id == child.id
    assert object_session(loaded) is None
    assert db_session.in_transaction() is False


def test_quote_replacement_uses_original_multiplier_and_canonical_snapshot(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)
    setting = db_session.get(BillingSetting, 1)
    assert setting is not None
    setting.multiplier_bps = 20_000
    setting.version += 1
    db_session.commit()

    outcome = billing_service.replace_job_quote(
        child.id,
        usage_quote(
            quote_id="uq_00000000000000000000000000000002",
            cost_micro=3_000_001,
            other_ratios={"seconds": Decimal("12.00")},
        ),
        expected_quote_id=child.quote_id,
    )
    refreshed = db_session.get(GenerationJob, child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))

    assert outcome == "ready"
    assert refreshed is not None and refreshed.multiplier_bps == 15_000
    assert refreshed.quote_id == "uq_00000000000000000000000000000002"
    assert refreshed.quote_other_ratios_json == '{"seconds":12}'
    assert refreshed.status == "reserved"
    assert hold is not None and hold.amount_units == 4_500_002


def test_quote_replacement_rejects_stale_expected_quote_without_mutation(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)
    before = billing_graph_snapshot(db_session, child.id)

    with pytest.raises(InvalidBillingState, match="expected quote"):
        billing_service.replace_job_quote(
            child.id,
            usage_quote(
                quote_id="uq_00000000000000000000000000000031",
                cost_micro=3_000_000,
            ),
            expected_quote_id="uq_00000000000000000000000000000030",
        )

    assert billing_graph_snapshot(db_session, child.id) == before


def test_quote_growth_without_funds_commits_snapshot_and_keeps_original_hold(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service, cost_micro=2_000_000)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert hold is not None
    original_hold = hold.amount_units
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == USER_ID)
    )
    assert wallet is not None
    wallet.balance_units = wallet.held_units
    db_session.commit()

    outcome = billing_service.replace_job_quote(
        child.id,
        usage_quote(
            quote_id="uq_00000000000000000000000000000003",
            cost_micro=20_000_000,
        ),
        expected_quote_id=child.quote_id,
    )
    db_session.expire_all()
    refreshed = db_session.get(GenerationJob, child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))

    assert outcome == "payment_required_quote"
    assert refreshed is not None and refreshed.status == "payment_required_quote"
    assert refreshed.quote_id == "uq_00000000000000000000000000000003"
    assert refreshed.quote_estimated_provider_cost_micro == 20_000_000
    assert hold is not None and hold.status == "active"
    assert hold.amount_units == original_hold


def test_zero_replacement_releases_once_without_consumption(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)
    free_quote = usage_quote(
        quote_id="uq_00000000000000000000000000000004", cost_micro=0
    )

    first = billing_service.replace_job_quote(
        child.id, free_quote, expected_quote_id=child.quote_id
    )
    second = billing_service.replace_job_quote(
        child.id, free_quote, expected_quote_id=child.quote_id
    )
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == USER_ID)
    )

    assert first == second == "provider_pricing_unavailable_no_charge"
    assert hold is not None and hold.status == "released"
    assert wallet is not None and wallet.held_units == 0
    assert db_session.get(GenerationJob, child.id).status == "provider_pricing_unavailable_no_charge"


def test_replacement_rejects_changed_alias_or_model_without_mutation(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)

    with pytest.raises(InvalidBillingState, match="alias"):
        billing_service.replace_job_quote(
            child.id,
            usage_quote(
                quote_id="uq_00000000000000000000000000000005",
                token_alias="other-video-v1",
            ),
            expected_quote_id=child.quote_id,
        )
    with pytest.raises(InvalidBillingState, match="model"):
        billing_service.replace_job_quote(
            child.id,
            usage_quote(
                quote_id="uq_00000000000000000000000000000006",
                model="changed-video-model",
            ),
            expected_quote_id=child.quote_id,
        )

    db_session.expire_all()
    refreshed = db_session.get(GenerationJob, child.id)
    assert refreshed is not None and refreshed.quote_id == child.quote_id
    assert refreshed.status == "reserved"


def test_owned_payment_required_quote_is_detached_and_hides_cross_owner(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service, cost_micro=2_000_000)
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == USER_ID)
    )
    assert wallet is not None
    wallet.balance_units = wallet.held_units
    db_session.commit()
    billing_service.replace_job_quote(
        child.id,
        usage_quote(
            quote_id="uq_00000000000000000000000000000007",
            cost_micro=20_000_000,
        ),
        expected_quote_id=child.quote_id,
    )

    detached = billing_service.load_owned_payment_required_quote(
        child.id, user_id=USER_ID, project_id=PROJECT_ID
    )
    assert detached.id == child.id
    assert object_session(detached) is None
    with pytest.raises(InvalidBillingState, match="not found"):
        billing_service.load_owned_payment_required_quote(
            child.id, user_id=OTHER_USER_ID, project_id=PROJECT_ID
        )


def test_provider_reference_requires_capability_pair_and_exact_identifier(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)
    task_id = "task_00000000000000000000000000000001"

    with pytest.raises(InvalidBillingState, match="reference"):
        billing_service.bind_provider_reference(
            child.id, reference_type="request", reference_id="0" * 39
        )
    with pytest.raises(InvalidBillingState, match="identifier"):
        billing_service.bind_provider_reference(
            child.id, reference_type="task", reference_id="task_short"
        )
    billing_service.bind_provider_reference(
        child.id, reference_type="task", reference_id=task_id
    )
    billing_service.bind_provider_reference(
        child.id, reference_type="task", reference_id=task_id
    )

    refreshed = db_session.get(GenerationJob, child.id)
    assert refreshed is not None
    assert (refreshed.provider_reference_type, refreshed.provider_reference_id) == (
        "task",
        task_id,
    )


def test_provider_reference_replay_is_rejected_across_owner_on_same_alias(
    billing_service: BillingService,
) -> None:
    first = reserve_child(billing_service)
    second = reserve_child(
        billing_service,
        user_id=OTHER_USER_ID,
        project_id=OTHER_PROJECT_ID,
        quote_id="uq_00000000000000000000000000000008",
    )
    task_id = "task_00000000000000000000000000000002"
    billing_service.bind_provider_reference(
        first.id, reference_type="task", reference_id=task_id
    )

    with pytest.raises(InvalidBillingState, match="already bound"):
        billing_service.bind_provider_reference(
            second.id, reference_type="task", reference_id=task_id
        )


def settled_receipt(
    reference_id: str,
    *,
    status: str = "settled",
    model: str = "video-model",
    cost_micro: int = 3_100_000,
    quota: int = 1_550_000,
    refunded_quota: int = 0,
    quota_per_unit: Decimal = Decimal("500000.5"),
    pricing_version: str = "sha256:pricing-v1",
    settled_at: int | None = int(NOW.timestamp()),
    reference_type: str = "task",
) -> UsageReceipt:
    return UsageReceipt(
        reference_type=reference_type,
        reference_id=reference_id,
        status=status,
        model=model,
        quota=quota,
        refunded_quota=refunded_quota,
        quota_per_unit=quota_per_unit,
        pricing_version=pricing_version,
        cost_currency="USD",
        cost_amount_micro=cost_micro,
        settled_at=settled_at,
    )


def bind_video_child(
    billing_service: BillingService,
    *,
    task_id: str = "task_00000000000000000000000000000010",
    quote_id: str = "uq_00000000000000000000000000000010",
) -> tuple[GenerationJob, str]:
    child = reserve_child(billing_service, quote_id=quote_id)
    billing_service.bind_provider_reference(
        child.id, reference_type="task", reference_id=task_id
    )
    return child, task_id


def stage_video(
    billing_service: BillingService,
    artifact_store: ArtifactStore,
    child: GenerationJob,
    task_id: str,
) -> StagedArtifact:
    artifact = artifact_store.add(
        locator=f"hidden://{child.id}/result.mp4",
        source_reference=task_id,
    )
    billing_service.stage_result(child.id, artifact.locator, artifact.sha256)
    return artifact


def test_staged_result_requires_verified_locator_hash_capability_and_source(
    billing_service: BillingService, artifact_store: ArtifactStore
) -> None:
    child, task_id = bind_video_child(billing_service)
    valid = artifact_store.add(
        locator=f"hidden://{child.id}/result.mp4", source_reference=task_id
    )

    with pytest.raises(InvalidBillingState, match="hash"):
        billing_service.stage_result(child.id, valid.locator, "b" * 64)
    wrong_source = artifact_store.add(
        locator=f"hidden://{child.id}/wrong-source.mp4",
        source_reference="task_00000000000000000000000000000011",
    )
    with pytest.raises(InvalidBillingState, match="reference"):
        billing_service.stage_result(child.id, wrong_source.locator, wrong_source.sha256)
    wrong_kind = artifact_store.add(
        locator=f"hidden://{child.id}/wrong-kind.txt",
        source_reference=task_id,
        capability="text",
    )
    with pytest.raises(InvalidBillingState, match="capability"):
        billing_service.stage_result(child.id, wrong_kind.locator, wrong_kind.sha256)

    billing_service.stage_result(child.id, valid.locator, valid.sha256)
    staged = billing_service.load_job(child.id)
    assert staged.result_staged is True
    assert staged.result_visible is False
    assert staged.status == "receipt_pending"


def test_stage_before_receipt_charges_actual_receipt_once_and_makes_visible(
    db_session: Session,
    billing_service: BillingService,
    artifact_store: ArtifactStore,
) -> None:
    child, task_id = bind_video_child(billing_service)
    stage_video(billing_service, artifact_store, child, task_id)
    receipt = settled_receipt(task_id, cost_micro=3_100_000)

    billing_service.settle_job(child.id, receipt)
    billing_service.settle_job(child.id, receipt)
    db_session.expire_all()
    billed = db_session.get(GenerationJob, child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    entries = db_session.scalars(
        select(WalletEntry).where(WalletEntry.source_id == child.id)
    ).all()
    stored = db_session.scalar(select(CostReceipt).where(CostReceipt.job_id == child.id))

    assert billed is not None and billed.status == "billed"
    assert billed.result_visible is True
    assert hold is not None and hold.status == "captured"
    assert [entry.amount_units for entry in entries] == [-4_650_000]
    assert stored is not None
    assert stored.raw_canonical_json == (
        '{"cost_amount_micro":3100000,"cost_currency":"USD","model":"video-model",'
        '"pricing_version":"sha256:pricing-v1","quota":1550000,'
        '"quota_per_unit":500000.5,"reference_id":"' + task_id + '",'
        '"reference_type":"task","refunded_quota":0,"settled_at":1783818123,'
        '"status":"settled"}'
    )
    assert stored.raw_sha256 == hashlib.sha256(
        stored.raw_canonical_json.encode("utf-8")
    ).hexdigest()


def test_settled_receipt_waits_for_stage_then_stage_captures(
    db_session: Session,
    billing_service: BillingService,
    artifact_store: ArtifactStore,
) -> None:
    child, task_id = bind_video_child(billing_service)
    billing_service.settle_job(child.id, settled_receipt(task_id, cost_micro=1_000_000))

    waiting = billing_service.load_job(child.id)
    assert waiting.status == "result_pending"
    assert waiting.result_visible is False
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 0

    stage_video(billing_service, artifact_store, child, task_id)
    billed = billing_service.load_job(child.id)
    assert billed.status == "billed"
    assert billed.result_visible is True
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 1


def test_pending_receipt_is_state_only_and_later_terminal_settles(
    db_session: Session,
    billing_service: BillingService,
    artifact_store: ArtifactStore,
) -> None:
    child, task_id = bind_video_child(billing_service)
    stage_video(billing_service, artifact_store, child, task_id)
    pending = settled_receipt(
        task_id,
        status="pending",
        cost_micro=0,
        quota=0,
        quota_per_unit=Decimal("0"),
        pricing_version="",
        settled_at=None,
    )

    billing_service.settle_job(child.id, pending)
    state = billing_service.load_job(child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert state.status == "receipt_pending"
    assert state.result_staged is True and state.result_visible is False
    assert hold is not None and hold.status == "active"
    assert db_session.scalar(
        select(func.count(CostReceipt.id)).where(CostReceipt.job_id == child.id)
    ) == 0

    billing_service.settle_job(child.id, settled_receipt(task_id))
    assert billing_service.load_job(child.id).status == "billed"


@pytest.mark.parametrize("field", ["reference", "model", "pricing", "quota_per_unit"])
def test_terminal_receipt_must_match_job_identity_and_quote_snapshot(
    billing_service: BillingService,
    field: str,
) -> None:
    child, task_id = bind_video_child(billing_service)
    patches = {
        "reference": {"reference_id": "task_00000000000000000000000000000012"},
        "model": {"model": "other-model"},
        "pricing": {"pricing_version": "sha256:other"},
        "quota_per_unit": {"quota_per_unit": Decimal("500000.6")},
    }
    receipt = (
        settled_receipt(patches[field]["reference_id"])
        if field == "reference"
        else settled_receipt(task_id, **patches[field])
    )

    with pytest.raises(InvalidBillingState, match="receipt"):
        billing_service.settle_job(child.id, receipt)


def test_settled_receipt_requires_positive_provider_quota(
    billing_service: BillingService,
) -> None:
    child, task_id = bind_video_child(billing_service)

    with pytest.raises(InvalidBillingState, match="receipt"):
        billing_service.settle_job(
            child.id, settled_receipt(task_id, quota=0, cost_micro=1_000_000)
        )


def test_conflicting_terminal_receipt_is_rejected_after_duplicate_is_idempotent(
    billing_service: BillingService, artifact_store: ArtifactStore
) -> None:
    child, task_id = bind_video_child(billing_service)
    stage_video(billing_service, artifact_store, child, task_id)
    receipt = settled_receipt(task_id, cost_micro=1_000_000)
    billing_service.settle_job(child.id, receipt)
    billing_service.settle_job(child.id, receipt)

    with pytest.raises(InvalidBillingState, match="conflicting"):
        billing_service.settle_job(
            child.id, settled_receipt(task_id, cost_micro=1_000_001)
        )


@pytest.mark.parametrize(
    ("status", "expect_reconciliation"),
    [("refunded", False), ("refund_pending", True), ("not_chargeable", False)],
)
def test_failure_receipts_release_without_charge(
    db_session: Session,
    billing_service: BillingService,
    status: str,
    expect_reconciliation: bool,
) -> None:
    child, task_id = bind_video_child(billing_service)
    receipt = settled_receipt(
        task_id,
        status=status,
        cost_micro=0,
        refunded_quota=1_550_000 if status == "refunded" else 0,
    )

    billing_service.fail_job(child.id, receipt)
    failed = billing_service.load_job(child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    reconciliations = db_session.scalars(
        select(BillingReconciliation).where(BillingReconciliation.job_id == child.id)
    ).all()

    assert failed.status == "failed_no_charge"
    assert failed.result_visible is False
    assert hold is not None and hold.status == "released"
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 0
    assert bool(reconciliations) is expect_reconciliation


def test_missing_result_releases_once_opens_reconciliation_and_late_receipt_is_audit_only(
    db_session: Session, billing_service: BillingService
) -> None:
    child, task_id = bind_video_child(billing_service)
    billing_service.mark_receipt_pending(child.id)
    billing_service.fail_missing_result(child.id)
    billing_service.fail_missing_result(child.id)
    billing_service.settle_job(child.id, settled_receipt(task_id))

    failed = billing_service.load_job(child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert failed.status == "provider_result_missing_no_charge"
    assert failed.result_visible is False
    assert hold is not None and hold.status == "released"
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 0
    assert db_session.scalar(
        select(func.count(BillingReconciliation.id)).where(
            BillingReconciliation.job_id == child.id,
            BillingReconciliation.reason == "provider_result_missing",
        )
    ) == 1
    assert db_session.scalar(
        select(func.count(CostReceipt.id)).where(CostReceipt.job_id == child.id)
    ) == 1


def test_payment_required_retries_stored_receipt_after_topup(
    db_session: Session,
    billing_service: BillingService,
    artifact_store: ArtifactStore,
) -> None:
    child, task_id = bind_video_child(billing_service)
    stage_video(billing_service, artifact_store, child, task_id)
    billing_service.settle_job(
        child.id, settled_receipt(task_id, cost_micro=30_000_000)
    )

    assert billing_service.load_job(child.id).status == "payment_required"
    billing_service.retry_payment_required(child.id)
    assert billing_service.load_job(child.id).status == "payment_required"
    credit(
        db_session,
        USER_ID,
        10_000_000,
        kind="topup",
        source_id="topup-task8",
        idempotency_key="topup:task8",
    )
    db_session.commit()
    billing_service.retry_payment_required(child.id)
    billing_service.retry_payment_required(child.id)

    assert billing_service.load_job(child.id).status == "billed"
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 1


def test_transition_predecessors_are_enforced_and_terminal_is_idempotent(
    billing_service: BillingService,
) -> None:
    child = reserve_child(billing_service)
    billing_service.mark_reference_recovery_pending(child.id)
    billing_service.mark_reference_recovery_pending(child.id)
    billing_service.fail_unsubmitted(child.id, "provider_rejected_no_charge")
    billing_service.fail_unsubmitted(child.id, "provider_rejected_no_charge")

    with pytest.raises(InvalidBillingState, match="terminal"):
        billing_service.mark_receipt_pending(child.id)


def test_incomplete_replacement_releases_exactly_once(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)
    incomplete = incomplete_pricing_quote()
    incomplete = TokenScopedQuote(
        token_alias=incomplete.token_alias,
        quote=incomplete.quote.model_copy(
            update={"quote_id": "uq_00000000000000000000000000000020"}
        ),
    )

    assert billing_service.replace_job_quote(
        child.id, incomplete, expected_quote_id=child.quote_id
    ) == (
        "provider_pricing_unavailable_no_charge"
    )
    assert billing_service.replace_job_quote(
        child.id, incomplete, expected_quote_id=child.quote_id
    ) == (
        "provider_pricing_unavailable_no_charge"
    )
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert hold is not None and hold.status == "released"


@pytest.mark.parametrize(
    "malformed_wrapper",
    [
        None,
        object(),
        TokenScopedQuote(token_alias="video-v1", quote=SimpleNamespace()),
        TokenScopedQuote(token_alias="", quote=usage_quote().quote),
    ],
)
def test_malformed_fresh_quote_wrapper_releases_without_attribute_error(
    db_session: Session,
    billing_service: BillingService,
    malformed_wrapper: object,
) -> None:
    child = reserve_child(billing_service)

    outcome = billing_service.replace_job_quote(
        child.id,
        malformed_wrapper,
        expected_quote_id=child.quote_id,
    )

    job = billing_service.load_job(child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert outcome == "provider_pricing_unavailable_no_charge"
    assert job.status == "provider_pricing_unavailable_no_charge"
    assert job.quote_id == child.quote_id
    assert hold is not None and hold.status == "released"
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 0


def test_valid_quote_with_changed_route_metadata_is_rejected_without_release(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_child(billing_service)
    changed = usage_quote(
        quote_id="uq_00000000000000000000000000000021",
        relay_format="openai_image",
    )

    with pytest.raises(InvalidBillingState, match="route"):
        billing_service.replace_job_quote(
            child.id, changed, expected_quote_id=child.quote_id
        )
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert hold is not None and hold.status == "active"
    assert billing_service.load_job(child.id).quote_id == child.quote_id


def reserve_text_child(billing_service: BillingService) -> GenerationJob:
    return billing_service.reserve_provider_call(
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="text",
        operation="prompt:s1",
        provider_method="POST",
        provider_route="/v1/chat/completions",
        quote=usage_quote(
            quote_id="uq_00000000000000000000000000000022",
            token_alias="text-v1",
            model="text-model",
            fixed_group="openmontage-text",
            relay_format="openai",
        ),
    )


def test_undeliverable_sync_call_binds_reference_releases_and_keeps_late_receipt_audit_only(
    db_session: Session, billing_service: BillingService
) -> None:
    child = reserve_text_child(billing_service)
    request_id = "20260712010203000000000" + "A" * 16
    billing_service.fail_undeliverable_sync_call(
        child.id, reference_type="request", reference_id=request_id
    )
    billing_service.settle_job(
        child.id,
        settled_receipt(
            request_id,
            reference_type="request",
            model="text-model",
        ),
    )

    failed = billing_service.load_job(child.id)
    hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert failed.status == "provider_result_missing_no_charge"
    assert failed.provider_reference_id == request_id
    assert failed.result_visible is False
    assert hold is not None and hold.status == "released"
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 0
    before_idempotent_retry = billing_graph_snapshot(db_session, child.id)
    billing_service.fail_undeliverable_sync_call(
        child.id, reference_type="request", reference_id=request_id
    )
    assert billing_graph_snapshot(db_session, child.id) == before_idempotent_retry


def billing_graph_snapshot(db: Session, job_id: str) -> tuple[object, ...]:
    db.expire_all()
    job = db.get(GenerationJob, job_id)
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == job_id))
    receipt = db.scalar(select(CostReceipt).where(CostReceipt.job_id == job_id))
    wallet = db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == job.user_id)
    )
    snapshot = (
        job.status,
        job.provider_reference_type,
        job.provider_reference_id,
        job.result_locator,
        job.result_sha256,
        job.result_staged,
        job.result_visible,
        hold.status,
        hold.amount_units,
        hold.reason,
        wallet.balance_units,
        wallet.held_units,
        receipt.status if receipt is not None else None,
        receipt.raw_sha256 if receipt is not None else None,
        db.scalar(
            select(func.count(WalletEntry.id)).where(WalletEntry.source_id == job_id)
        ),
    )
    db.commit()
    return snapshot


@pytest.mark.parametrize(
    "settlement_state",
    ["result_pending", "payment_required", "staged", "refunded"],
)
def test_undeliverable_sync_rejects_any_post_settlement_or_staged_state_unchanged(
    db_session: Session,
    billing_service: BillingService,
    artifact_store: ArtifactStore,
    settlement_state: str,
) -> None:
    child = reserve_text_child(billing_service)
    request_id = "20260712010203000000000" + "B" * 16
    billing_service.bind_provider_reference(child.id, "request", request_id)
    if settlement_state in {"staged", "payment_required"}:
        artifact = artifact_store.add(
            locator=f"hidden://{child.id}/text-result.json",
            source_reference=request_id,
            capability="text",
        )
        billing_service.stage_result(child.id, artifact.locator, artifact.sha256)
    if settlement_state == "result_pending":
        billing_service.settle_job(
            child.id,
            settled_receipt(
                request_id,
                reference_type="request",
                model="text-model",
            ),
        )
    elif settlement_state == "payment_required":
        billing_service.settle_job(
            child.id,
            settled_receipt(
                request_id,
                reference_type="request",
                model="text-model",
                cost_micro=30_000_000,
            ),
        )
    elif settlement_state == "refunded":
        billing_service.settle_job(
            child.id,
            settled_receipt(
                request_id,
                reference_type="request",
                model="text-model",
                status="refunded",
                cost_micro=0,
            ),
        )
    before = billing_graph_snapshot(db_session, child.id)

    with pytest.raises(InvalidBillingState):
        billing_service.fail_undeliverable_sync_call(
            child.id, reference_type="request", reference_id=request_id
        )

    assert billing_graph_snapshot(db_session, child.id) == before


def test_undeliverable_sync_rejects_reserved_job_with_stored_receipt_unchanged(
    db_session: Session,
    billing_service: BillingService,
) -> None:
    child = reserve_text_child(billing_service)
    request_id = "20260712010203000000000" + "C" * 16
    billing_service.bind_provider_reference(child.id, "request", request_id)
    raw = '{"recovered":"settled"}'
    db_session.add(
        CostReceipt(
            id=uuid.uuid4().hex,
            job_id=child.id,
            reference_type="request",
            reference_id=request_id,
            status="settled",
            model="text-model",
            quota=1_550_000,
            refunded_quota=0,
            quota_per_unit=Decimal("500000.5"),
            pricing_version="sha256:pricing-v1",
            cost_currency="USD",
            cost_amount_micro=3_100_000,
            settled_at=NOW,
            raw_canonical_json=raw,
            raw_sha256=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        )
    )
    db_session.commit()
    before = billing_graph_snapshot(db_session, child.id)

    with pytest.raises(InvalidBillingState, match="receipt"):
        billing_service.fail_undeliverable_sync_call(
            child.id, reference_type="request", reference_id=request_id
        )

    assert billing_graph_snapshot(db_session, child.id) == before


def test_parent_and_sibling_funds_results_and_terminal_states_are_isolated(
    db_session: Session,
    billing_service: BillingService,
    artifact_store: ArtifactStore,
) -> None:
    parent = billing_service.create_parent_job(
        user_id=USER_ID, project_id=PROJECT_ID, operation="render"
    )
    first = billing_service.reserve_provider_call(
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=parent.id,
        capability="video",
        operation="shot:s1",
        provider_method="POST",
        provider_route="/v1/videos",
        quote=usage_quote(quote_id="uq_00000000000000000000000000000023"),
    )
    second = billing_service.reserve_provider_call(
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=parent.id,
        capability="video",
        operation="shot:s2",
        provider_method="POST",
        provider_route="/v1/videos",
        quote=usage_quote(quote_id="uq_00000000000000000000000000000024"),
    )
    first_task = "task_00000000000000000000000000000023"
    second_task = "task_00000000000000000000000000000024"
    billing_service.bind_provider_reference(first.id, "task", first_task)
    billing_service.bind_provider_reference(second.id, "task", second_task)
    stage_video(billing_service, artifact_store, first, first_task)
    billing_service.settle_job(first.id, settled_receipt(first_task, cost_micro=1_000_000))
    billing_service.fail_job(
        second.id,
        settled_receipt(second_task, status="refunded", cost_micro=0),
    )

    first_hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == first.id))
    second_hold = db_session.scalar(select(WalletHold).where(WalletHold.job_id == second.id))
    assert billing_service.load_job(first.id).status == "billed"
    assert billing_service.load_job(second.id).status == "failed_no_charge"
    assert billing_service.load_job(parent.id).status == "running"
    assert first_hold is not None and first_hold.status == "captured"
    assert second_hold is not None and second_hold.status == "released"
    assert db_session.scalar(
        select(func.count(WalletHold.id)).where(WalletHold.job_id == parent.id)
    ) == 0


def service_settings() -> SimpleNamespace:
    return SimpleNamespace(
        billing_reference_recovery_seconds=86_400,
        billing_receipt_deadline_seconds=86_400,
        billing_hold_timeout_seconds=86_400,
    )


@pytest.fixture
def postgres_engine() -> Engine:
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")
    schema_name = f"billing_task8_{uuid.uuid4().hex}"
    admin_engine = create_engine(database_url)
    engine = None
    try:
        with admin_engine.begin() as connection:
            version_num = int(connection.scalar(text("SHOW server_version_num")))
            assert version_num // 10_000 == 16
            connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
        engine = create_engine(
            database_url,
            connect_args={"options": f"-csearch_path={schema_name}"},
            pool_size=8,
            max_overflow=4,
        )
        Base.metadata.create_all(engine)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE'))
        admin_engine.dispose()


def seed_postgres_child(
    engine: Engine,
    artifact_store: ArtifactStore,
    *,
    suffix: str,
    stage: bool,
    bind_reference: bool = True,
) -> tuple[str, str, StagedArtifact]:
    user_id = f"u{suffix}"
    project_id = f"p{suffix}"
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=user_id,
                email=f"billing-pg-{suffix}@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=project_id,
                    owner_user_id=user_id,
                    title="PostgreSQL billing",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id=f"w{suffix}",
                    user_id=user_id,
                    balance_units=40_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        service = BillingService(
            db, service_settings(), artifact_store.inspect, now=lambda: NOW
        )
        child = service.reserve_provider_call(
            user_id=user_id,
            project_id=project_id,
            parent_job_id=None,
            capability="video",
            operation="shot:pg",
            provider_method="POST",
            provider_route="/v1/videos",
            quote=usage_quote(
                quote_id=f"uq_{suffix.zfill(32)}",
            ),
        )
        task_id = f"task_{suffix.zfill(32)}"
        if bind_reference:
            service.bind_provider_reference(child.id, "task", task_id)
        artifact = artifact_store.add(
            locator=f"hidden://{child.id}/pg-result.mp4",
            source_reference=task_id,
        )
        if stage:
            assert bind_reference
            service.stage_result(child.id, artifact.locator, artifact.sha256)
        return child.id, task_id, artifact


def run_concurrently(*operations):
    barrier = Barrier(len(operations))

    def synchronized(index: int):
        barrier.wait(timeout=10)
        return operations[index]()

    with ThreadPoolExecutor(max_workers=len(operations)) as executor:
        return list(executor.map(synchronized, range(len(operations))))


def test_postgres_duplicate_settlement_and_capture_create_one_entry(
    postgres_engine: Engine,
) -> None:
    artifacts = ArtifactStore()
    child_id, task_id, _artifact = seed_postgres_child(
        postgres_engine, artifacts, suffix="801", stage=True
    )
    receipt = settled_receipt(task_id, cost_micro=1_000_000)

    def settle() -> None:
        with Session(postgres_engine, expire_on_commit=False) as db:
            BillingService(db, service_settings(), artifacts.inspect).settle_job(
                child_id, receipt
            )

    run_concurrently(settle, settle)
    with Session(postgres_engine) as db:
        job = db.get(GenerationJob, child_id)
        assert job is not None and job.status == "billed" and job.result_visible
        assert db.scalar(
            select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child_id)
        ) == 1
        assert db.scalar(
            select(func.count(CostReceipt.id)).where(CostReceipt.job_id == child_id)
        ) == 1


def test_postgres_concurrent_stage_and_receipt_settle_once_in_either_order(
    postgres_engine: Engine,
) -> None:
    artifacts = ArtifactStore()
    child_id, task_id, artifact = seed_postgres_child(
        postgres_engine, artifacts, suffix="802", stage=False
    )

    def stage() -> None:
        with Session(postgres_engine, expire_on_commit=False) as db:
            BillingService(db, service_settings(), artifacts.inspect).stage_result(
                child_id, artifact.locator, artifact.sha256
            )

    def settle() -> None:
        with Session(postgres_engine, expire_on_commit=False) as db:
            BillingService(db, service_settings(), artifacts.inspect).settle_job(
                child_id, settled_receipt(task_id, cost_micro=1_000_000)
            )

    run_concurrently(stage, settle)
    with Session(postgres_engine) as db:
        job = db.get(GenerationJob, child_id)
        hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child_id))
        assert job is not None and job.status == "billed" and job.result_visible
        assert hold is not None and hold.status == "captured"
        assert db.scalar(
            select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child_id)
        ) == 1


def test_postgres_topup_serializes_with_payment_required_retry(
    postgres_engine: Engine,
) -> None:
    artifacts = ArtifactStore()
    child_id, task_id, _artifact = seed_postgres_child(
        postgres_engine, artifacts, suffix="803", stage=True
    )
    with Session(postgres_engine, expire_on_commit=False) as db:
        service = BillingService(db, service_settings(), artifacts.inspect)
        service.settle_job(
            child_id, settled_receipt(task_id, cost_micro=30_000_000)
        )
        job = service.load_job(child_id)
        user_id = job.user_id
        assert job.status == "payment_required"

    topup_locked = Event()
    retry_started = Event()

    def topup() -> None:
        with Session(postgres_engine, expire_on_commit=False) as db:
            credit(
                db,
                user_id,
                10_000_000,
                kind="topup",
                source_id="pg-topup",
                idempotency_key="topup:pg-task8",
            )
            topup_locked.set()
            assert retry_started.wait(timeout=10)
            time.sleep(0.2)
            db.commit()

    def retry() -> None:
        assert topup_locked.wait(timeout=10)
        retry_started.set()
        with Session(postgres_engine, expire_on_commit=False) as db:
            BillingService(
                db, service_settings(), artifacts.inspect
            ).retry_payment_required(child_id)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(topup), executor.submit(retry)]
        for future in futures:
            future.result(timeout=15)

    with Session(postgres_engine) as db:
        job = db.get(GenerationJob, child_id)
        wallet = db.scalar(select(WalletAccount).where(WalletAccount.user_id == user_id))
        assert job is not None and job.status == "billed" and job.result_visible
        assert wallet is not None and wallet.balance_units == 5_000_000
        assert wallet.held_units == 0
        assert db.scalar(
            select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child_id)
        ) == 1


def test_postgres_same_old_quote_allows_one_concurrent_replacement(
    postgres_engine: Engine,
) -> None:
    artifacts = ArtifactStore()
    child_id, _task_id, _artifact = seed_postgres_child(
        postgres_engine,
        artifacts,
        suffix="804",
        stage=False,
        bind_reference=False,
    )
    with Session(postgres_engine) as db:
        expected_quote_id = db.get(GenerationJob, child_id).quote_id
    fresh_quotes = (
        usage_quote(
            quote_id="uq_00000000000000000000000000000804",
            cost_micro=2_000_000,
        ),
        usage_quote(
            quote_id="uq_00000000000000000000000000001804",
            cost_micro=3_000_000,
        ),
    )

    def replace(index: int):
        try:
            with Session(postgres_engine, expire_on_commit=False) as db:
                outcome = BillingService(
                    db, service_settings(), artifacts.inspect
                ).replace_job_quote(
                    child_id,
                    fresh_quotes[index],
                    expected_quote_id=expected_quote_id,
                )
                return outcome, index
        except InvalidBillingState as exc:
            assert "expected quote" in str(exc)
            return "stale", index

    barrier = Barrier(2)

    def synchronized(index: int):
        barrier.wait(timeout=10)
        return replace(index)

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(synchronized, range(2)))
    assert sorted(outcome for outcome, _index in outcomes) == ["ready", "stale"]
    winner = next(index for outcome, index in outcomes if outcome == "ready")
    with Session(postgres_engine) as db:
        job = db.get(GenerationJob, child_id)
        hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child_id))
        assert job is not None and job.quote_id == fresh_quotes[winner].quote.quote_id
        assert hold is not None and hold.amount_units == provider_micro_to_charge_units(
            fresh_quotes[winner].quote.estimated_cost_amount_micro,
            15_000,
        )


def test_postgres_same_fresh_quote_race_maps_unique_loser_to_domain_error(
    postgres_engine: Engine,
) -> None:
    artifacts = ArtifactStore()
    suffix = "805"
    user_id = f"u{suffix}"
    project_id = f"p{suffix}"
    with Session(postgres_engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=user_id,
                email="billing-pg-805@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=project_id,
                    owner_user_id=user_id,
                    title="PostgreSQL quote uniqueness",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id=f"w{suffix}",
                    user_id=user_id,
                    balance_units=40_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        service = BillingService(
            db, service_settings(), artifacts.inspect, now=lambda: NOW
        )
        jobs = (
            service.reserve_provider_call(
                user_id=user_id,
                project_id=project_id,
                parent_job_id=None,
                capability="video",
                operation="shot:pg-unique-1",
                provider_method="POST",
                provider_route="/v1/videos",
                quote=usage_quote(
                    quote_id="uq_00000000000000000000000000000805",
                    cost_micro=2_000_000,
                ),
            ),
            service.reserve_provider_call(
                user_id=user_id,
                project_id=project_id,
                parent_job_id=None,
                capability="video",
                operation="shot:pg-unique-2",
                provider_method="POST",
                provider_route="/v1/videos",
                quote=usage_quote(
                    quote_id="uq_00000000000000000000000000001805",
                    cost_micro=3_000_000,
                ),
            ),
        )
        job_ids = tuple(job.id for job in jobs)
        expected_quote_ids = tuple(job.quote_id for job in jobs)
    fresh = usage_quote(
        quote_id="uq_00000000000000000000000000002805",
        cost_micro=4_000_000,
    )
    lookup_barrier = Barrier(2)

    def synchronize_duplicate_lookup(
        _connection,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ) -> None:
        normalized = " ".join(statement.lower().split())
        if (
            "from generation_jobs" in normalized
            and "generation_jobs.quote_id =" in normalized
            and "generation_jobs.id !=" in normalized
        ):
            lookup_barrier.wait(timeout=10)

    def replace(index: int) -> tuple[str, int]:
        try:
            with Session(postgres_engine, expire_on_commit=False) as db:
                outcome = BillingService(
                    db, service_settings(), artifacts.inspect
                ).replace_job_quote(
                    job_ids[index],
                    fresh,
                    expected_quote_id=expected_quote_ids[index],
                )
                return outcome, index
        except InvalidBillingState as exc:
            assert str(exc) == "provider quote is already bound"
            return "domain_error", index
        except IntegrityError:
            return "raw_integrity_error", index

    event.listen(postgres_engine, "after_cursor_execute", synchronize_duplicate_lookup)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(replace, range(2)))
    finally:
        event.remove(
            postgres_engine, "after_cursor_execute", synchronize_duplicate_lookup
        )

    assert sorted(outcome for outcome, _index in outcomes) == [
        "domain_error",
        "ready",
    ]
    winner = next(index for outcome, index in outcomes if outcome == "ready")
    loser = 1 - winner
    with Session(postgres_engine) as db:
        durable_jobs = tuple(db.get(GenerationJob, job_id) for job_id in job_ids)
        durable_holds = tuple(
            db.scalar(select(WalletHold).where(WalletHold.job_id == job_id))
            for job_id in job_ids
        )
        assert durable_jobs[winner].quote_id == fresh.quote.quote_id
        assert (
            durable_jobs[winner].quote_estimated_provider_cost_micro
            == fresh.quote.estimated_cost_amount_micro
        )
        assert durable_holds[winner].amount_units == 6_000_000
        assert durable_jobs[loser].quote_id == expected_quote_ids[loser]
        assert durable_jobs[loser].quote_estimated_provider_cost_micro == (
            2_000_000 if loser == 0 else 3_000_000
        )
        assert durable_holds[loser].amount_units == (
            3_000_000 if loser == 0 else 4_500_000
        )
        assert all(job.status == "reserved" for job in durable_jobs)
        assert all(hold.status == "active" for hold in durable_holds)
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == user_id)
        )
        assert wallet is not None
        assert wallet.held_units == sum(hold.amount_units for hold in durable_holds)

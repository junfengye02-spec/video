from __future__ import annotations

from typing import Protocol

from sqlalchemy.orm import Session

from server.app.billing.models import BillingSetting


class BillingBootstrapSettings(Protocol):
    billing_default_multiplier_bps: int | None


def ensure_billing_settings(
    db: Session, settings: BillingBootstrapSettings
) -> BillingSetting:
    existing = db.get(BillingSetting, 1)
    if existing is not None:
        return existing

    default_multiplier = getattr(settings, "billing_default_multiplier_bps", None)
    if default_multiplier is None:
        raise RuntimeError(
            "BILLING_DEFAULT_MULTIPLIER_BPS is required to create billing settings"
        )
    if (
        not isinstance(default_multiplier, int)
        or isinstance(default_multiplier, bool)
        or default_multiplier <= 0
    ):
        raise RuntimeError("BILLING_DEFAULT_MULTIPLIER_BPS must be a positive integer")

    setting = BillingSetting(
        id=1,
        multiplier_bps=default_multiplier,
        version=0,
    )
    db.add(setting)
    db.flush()
    return setting

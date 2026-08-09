from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.auth.dependencies import CurrentUser, require_user
from server.app.db.session import get_db
from server.app.wallet.models import WalletAccount, WalletEntry


router = APIRouter()


def _wallet_payload(wallet: WalletAccount) -> dict[str, object]:
    return {
        "balance_units": wallet.balance_units,
        "held_units": wallet.held_units,
        "available_units": wallet.balance_units - wallet.held_units,
    }


def _entry_payload(entry: WalletEntry) -> dict[str, object]:
    return {
        "id": entry.id,
        "amount_units": entry.amount_units,
        "balance_after_units": entry.balance_after_units,
        "kind": entry.kind,
        "source_type": entry.source_type,
        "source_id": entry.source_id,
        "created_at": entry.created_at,
    }


@router.get("/api/wallet")
def get_wallet(
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    wallet = db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == current.id)
    )
    if wallet is None:
        raise HTTPException(status_code=404, detail="wallet not found")
    return _wallet_payload(wallet)


@router.get("/api/wallet/entries")
def get_wallet_entries(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    entries = db.scalars(
        select(WalletEntry)
        .where(WalletEntry.user_id == current.id)
        .order_by(WalletEntry.created_at.desc(), WalletEntry.id.desc())
        .offset(offset)
        .limit(limit)
    )
    return [_entry_payload(entry) for entry in entries]

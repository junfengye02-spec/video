from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac

import fakeredis
import pytest

from server.app.auth.verification import (
    InvalidCode,
    RateLimitExceeded,
    ResendTooSoon,
    VerificationStore,
)


PREFIX = "test:"
SECRET = b"x" * 32


@pytest.fixture
def redis_client():
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def store(redis_client):
    return VerificationStore(redis_client, prefix=PREFIX, hmac_secret=SECRET)


def _allow_resend(redis_client, email):
    redis_client.delete(f"{PREFIX}verification:resend:{email}")


def test_store_rejects_short_hmac_secret(redis_client):
    with pytest.raises(ValueError, match="at least 32 bytes"):
        VerificationStore(redis_client, prefix=PREFIX, hmac_secret=b"short")


def test_code_is_six_digits_hmac_only_and_has_ten_minute_ttl(redis_client, store, monkeypatch):
    monkeypatch.setattr("server.app.auth.verification.secrets.randbelow", lambda _: 42)

    code = store.issue("  Person@Example.COM ", purpose="register", now=100)

    key = f"{PREFIX}verification:register:person@example.com"
    expected = hmac.new(
        SECRET,
        b"register:person@example.com:000042",
        hashlib.sha256,
    ).hexdigest()
    assert code == "000042"
    assert redis_client.get(key) == expected
    assert 590 <= redis_client.ttl(key) <= 600
    assert 50 <= redis_client.ttl(f"{PREFIX}verification:resend:person@example.com") <= 60


def test_code_is_single_use_after_four_failed_attempts(store):
    code = store.issue("person@example.com", purpose="register", now=100)

    for _ in range(4):
        with pytest.raises(InvalidCode):
            store.consume("person@example.com", "000000", purpose="register", now=101)
    store.consume("person@example.com", code, purpose="register", now=102)
    with pytest.raises(InvalidCode):
        store.consume("person@example.com", code, purpose="register", now=103)


def test_fifth_failed_attempt_invalidates_code(redis_client, store):
    code = store.issue("person@example.com", purpose="register", now=100)

    for _ in range(5):
        with pytest.raises(InvalidCode):
            store.consume("person@example.com", "wrong", purpose="register", now=101)

    assert redis_client.get(f"{PREFIX}verification:register:person@example.com") is None
    with pytest.raises(InvalidCode):
        store.consume("person@example.com", code, purpose="register", now=102)


def test_failed_attempt_counter_expires_with_subsecond_code_lifetime(redis_client, store):
    store.issue("person@example.com", purpose="register", now=100)
    code_key = f"{PREFIX}verification:register:person@example.com"
    attempts_key = f"{code_key}:attempts"
    redis_client.pexpire(code_key, 500)

    with pytest.raises(InvalidCode):
        store.consume("person@example.com", "wrong", purpose="register", now=101)

    code_pttl = redis_client.pttl(code_key)
    attempts_pttl = redis_client.pttl(attempts_key)
    assert 0 < code_pttl <= 500
    assert 0 < attempts_pttl <= 500
    assert abs(attempts_pttl - code_pttl) <= 50


def test_expired_code_is_rejected(redis_client, store):
    code = store.issue("person@example.com", purpose="register", now=100)
    redis_client.delete(f"{PREFIX}verification:register:person@example.com")

    with pytest.raises(InvalidCode):
        store.consume("person@example.com", code, purpose="register", now=701)


def test_resend_gate_does_not_replace_code_or_increment_quota(redis_client, store, monkeypatch):
    codes = iter([111111, 999999, 222222])
    monkeypatch.setattr("server.app.auth.verification.secrets.randbelow", lambda _: next(codes))
    first = store.issue("person@example.com", purpose="register", source_ip="192.0.2.1", now=100)
    key = f"{PREFIX}verification:register:person@example.com"
    stored = redis_client.get(key)

    with pytest.raises(ResendTooSoon):
        store.issue("person@example.com", purpose="register", source_ip="192.0.2.1", now=101)

    assert redis_client.get(key) == stored
    assert redis_client.get(f"{PREFIX}verification:rate:email:person@example.com:0") == "1"
    _allow_resend(redis_client, "person@example.com")
    second = store.issue("person@example.com", purpose="register", source_ip="192.0.2.1", now=160)
    assert (first, second) == ("111111", "222222")


def test_email_send_rate_is_five_per_hour(redis_client, store):
    for _ in range(5):
        store.issue("person@example.com", purpose="register", source_ip="192.0.2.1", now=100)
        _allow_resend(redis_client, "person@example.com")

    with pytest.raises(RateLimitExceeded, match="email") as exc_info:
        store.issue("person@example.com", purpose="register", source_ip="192.0.2.1", now=100)

    assert exc_info.value.scope == "email"


def test_ip_send_rate_is_thirty_per_hour(redis_client, store):
    for index in range(30):
        store.issue(f"person{index}@example.com", purpose="register", source_ip="192.0.2.1", now=100)

    with pytest.raises(RateLimitExceeded, match="ip") as exc_info:
        store.issue("blocked@example.com", purpose="register", source_ip="192.0.2.1", now=100)

    assert exc_info.value.scope == "ip"


def test_global_send_rate_is_three_hundred_per_minute(redis_client, store):
    for index in range(300):
        store.issue(
            f"person{index}@example.com",
            purpose="register",
            source_ip=f"192.0.2.{index}",
            now=100,
        )

    with pytest.raises(RateLimitExceeded, match="global") as exc_info:
        store.issue("blocked@example.com", purpose="register", source_ip="198.51.100.1", now=100)

    assert exc_info.value.scope == "global"


def test_purposes_are_isolated(redis_client, store, monkeypatch):
    monkeypatch.setattr("server.app.auth.verification.secrets.randbelow", lambda _: 123456)
    register_code = store.issue("person@example.com", purpose="register", now=100)
    _allow_resend(redis_client, "person@example.com")
    reset_code = store.issue("person@example.com", purpose="reset", now=160)

    store.consume("person@example.com", register_code, purpose="register", now=161)
    store.consume("person@example.com", reset_code, purpose="reset", now=161)


def test_concurrent_consumers_cannot_both_succeed(store):
    code = store.issue("person@example.com", purpose="register", now=100)

    def consume_once():
        try:
            store.consume("person@example.com", code, purpose="register", now=101)
        except InvalidCode:
            return False
        return True

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: consume_once(), range(2)))

    assert sorted(results) == [False, True]

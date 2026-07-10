from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, replace
from typing import TYPE_CHECKING, Any

from redis import Redis

from server.app.auth.security import random_token

if TYPE_CHECKING:
    from server.app.core.config import AppSettings


_CREATE_SCRIPT = """
if redis.call('EXISTS', KEYS[1]) == 1 then
    return 0
end

local created = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
if not created then
    return 0
end

if ARGV[4] ~= '' then
    redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3])
    redis.call('SADD', KEYS[3], ARGV[5])
    local index_ttl = redis.call('TTL', KEYS[3])
    if index_ttl < tonumber(ARGV[3]) then
        redis.call('EXPIRE', KEYS[3], ARGV[3])
    end
end
return 1
"""


_TOUCH_SCRIPT = """
local stored = redis.call('GET', KEYS[1])
if not stored or stored ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
"""


_CLEANUP_INVALID_SCRIPT = """
local stored = redis.call('GET', KEYS[1])
if stored and stored ~= ARGV[1] then
    return 0
end

local owner = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2])
if owner then
    redis.call('SREM', ARGV[2] .. owner, ARGV[3])
end
return 1
"""


_ROTATE_SCRIPT = """
if redis.call('EXISTS', KEYS[1]) == 0 then
    return -1
end
if redis.call('EXISTS', KEYS[3]) == 1 then
    return 0
end

local created = redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[2], 'NX')
if not created then
    return 0
end

if ARGV[5] ~= '' then
    redis.call('SREM', ARGV[7] .. ARGV[5], ARGV[4])
end
redis.call('DEL', KEYS[1], KEYS[2])

if ARGV[6] ~= '' then
    redis.call('SET', KEYS[4], ARGV[6], 'EX', ARGV[3])
    redis.call('SADD', ARGV[7] .. ARGV[6], ARGV[8])
    local index_key = ARGV[7] .. ARGV[6]
    local index_ttl = redis.call('TTL', index_key)
    if index_ttl < tonumber(ARGV[3]) then
        redis.call('EXPIRE', index_key, ARGV[3])
    end
end
return 1
"""


_REVOKE_SCRIPT = """
local owner = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2])
if owner then
    redis.call('SREM', ARGV[1] .. owner, ARGV[2])
end
return 1
"""


_REVOKE_ALL_SCRIPT = """
local digests = redis.call('SMEMBERS', KEYS[1])
for _, digest in ipairs(digests) do
    redis.call('DEL', ARGV[1] .. digest, ARGV[2] .. digest)
end
redis.call('DEL', KEYS[1])
return #digests
"""


@dataclass(frozen=True, slots=True)
class SessionRecord:
    user_id: str | None
    csrf_token: str
    created_at: int
    last_seen_at: int
    absolute_expires_at: int


class SessionStore:
    def __init__(
        self,
        redis: Redis,
        *,
        prefix: str,
        idle_seconds: int,
        absolute_seconds: int,
    ):
        if idle_seconds <= 0 or absolute_seconds <= 0:
            raise ValueError("session expiry values must be positive")
        self._redis = redis
        self._prefix = prefix
        self._idle_seconds = idle_seconds
        self._absolute_seconds = absolute_seconds

    @classmethod
    def from_settings(cls, redis: Redis, settings: AppSettings) -> SessionStore:
        return cls(
            redis,
            prefix=settings.redis_prefix,
            idle_seconds=settings.session_idle_seconds,
            absolute_seconds=settings.session_absolute_seconds,
        )

    def create(
        self,
        user_id: str | None = None,
        *,
        now: int | float | None = None,
    ) -> tuple[str, SessionRecord]:
        self._validate_user_id(user_id)
        timestamp = self._timestamp(now)
        record = SessionRecord(
            user_id=user_id,
            csrf_token=random_token(),
            created_at=timestamp,
            last_seen_at=timestamp,
            absolute_expires_at=timestamp + self._absolute_seconds,
        )
        return self._create_record(record)

    def get(
        self,
        session_id: str,
        *,
        now: int | float | None = None,
    ) -> SessionRecord | None:
        if not session_id:
            return None
        timestamp = self._timestamp(now)
        digest = self._digest(session_id)
        session_key = self._session_key(digest)
        for _ in range(4):
            raw = self._redis.get(session_key)
            if raw is None:
                self._cleanup_invalid(digest, "")
                return None

            record = self._deserialize(raw)
            if record is None:
                self._cleanup_invalid(digest, raw)
                return None
            if timestamp >= record.absolute_expires_at:
                self._cleanup_invalid(digest, raw)
                return None
            if timestamp >= record.last_seen_at + self._idle_seconds:
                self._cleanup_invalid(digest, raw)
                return None

            effective_now = max(timestamp, record.last_seen_at)
            touched = replace(record, last_seen_at=effective_now)
            ttl = min(self._idle_seconds, record.absolute_expires_at - effective_now)
            if ttl <= 0:
                self._cleanup_invalid(digest, raw)
                return None
            result = int(
                self._redis.eval(
                    _TOUCH_SCRIPT,
                    1,
                    session_key,
                    raw,
                    self._serialize(touched),
                    ttl,
                )
            )
            if result == 1:
                return touched
        return None

    def rotate(
        self,
        session_id: str,
        user_id: str | None = None,
        *,
        now: int | float | None = None,
    ) -> tuple[str, SessionRecord] | None:
        self._validate_user_id(user_id)
        timestamp = self._timestamp(now)
        previous = self.get(session_id, now=timestamp)
        if previous is None:
            return None

        bound_user_id = previous.user_id if user_id is None else user_id
        record = SessionRecord(
            user_id=bound_user_id,
            csrf_token=random_token(),
            created_at=timestamp,
            last_seen_at=timestamp,
            absolute_expires_at=timestamp + self._absolute_seconds,
        )
        old_digest = self._digest(session_id)
        for _ in range(4):
            new_session_id = random_token()
            new_digest = self._digest(new_session_id)
            result = int(
                self._redis.eval(
                    _ROTATE_SCRIPT,
                    4,
                    self._session_key(old_digest),
                    self._owner_key(old_digest),
                    self._session_key(new_digest),
                    self._owner_key(new_digest),
                    self._serialize(record),
                    self._initial_ttl(record),
                    self._absolute_seconds,
                    old_digest,
                    previous.user_id or "",
                    bound_user_id or "",
                    self._user_index_prefix,
                    new_digest,
                )
            )
            if result == 1:
                return new_session_id, record
            if result == -1:
                return None
        raise RuntimeError("could not allocate a unique session identifier")

    def revoke(self, session_id: str) -> None:
        if not session_id:
            return
        digest = self._digest(session_id)
        self._redis.eval(
            _REVOKE_SCRIPT,
            2,
            self._session_key(digest),
            self._owner_key(digest),
            self._user_index_prefix,
            digest,
        )

    def revoke_all(self, user_id: str) -> None:
        self._redis.eval(
            _REVOKE_ALL_SCRIPT,
            1,
            self._user_index_key(user_id),
            self._session_key_prefix,
            self._owner_key_prefix,
        )

    def _create_record(self, record: SessionRecord) -> tuple[str, SessionRecord]:
        for _ in range(4):
            session_id = random_token()
            digest = self._digest(session_id)
            result = int(
                self._redis.eval(
                    _CREATE_SCRIPT,
                    3,
                    self._session_key(digest),
                    self._owner_key(digest),
                    self._user_index_key(record.user_id or "anonymous"),
                    self._serialize(record),
                    self._initial_ttl(record),
                    self._absolute_seconds,
                    record.user_id or "",
                    digest,
                )
            )
            if result == 1:
                return session_id, record
        raise RuntimeError("could not allocate a unique session identifier")

    def _cleanup_invalid(self, digest: str, raw: str) -> None:
        self._redis.eval(
            _CLEANUP_INVALID_SCRIPT,
            2,
            self._session_key(digest),
            self._owner_key(digest),
            raw,
            self._user_index_prefix,
            digest,
        )

    def _initial_ttl(self, record: SessionRecord) -> int:
        return min(self._idle_seconds, record.absolute_expires_at - record.last_seen_at)

    @staticmethod
    def _timestamp(now: int | float | None) -> int:
        return int(time.time() if now is None else now)

    @staticmethod
    def _validate_user_id(user_id: str | None) -> None:
        if user_id is not None and (not isinstance(user_id, str) or not user_id):
            raise ValueError("user_id must be non-empty")

    @staticmethod
    def _digest(session_id: str) -> str:
        return hashlib.sha256(session_id.encode("utf-8")).hexdigest()

    @staticmethod
    def _serialize(record: SessionRecord) -> str:
        return json.dumps(asdict(record), sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _deserialize(raw: str) -> SessionRecord | None:
        try:
            data: Any = json.loads(raw)
        except (TypeError, ValueError):
            return None
        expected_fields = {
            "user_id",
            "csrf_token",
            "created_at",
            "last_seen_at",
            "absolute_expires_at",
        }
        if not isinstance(data, dict) or set(data) != expected_fields:
            return None
        user_id = data["user_id"]
        csrf_token = data["csrf_token"]
        timestamps = (data["created_at"], data["last_seen_at"], data["absolute_expires_at"])
        if user_id is not None and (not isinstance(user_id, str) or not user_id):
            return None
        if not isinstance(csrf_token, str) or not csrf_token:
            return None
        if any(type(value) is not int for value in timestamps):
            return None
        created_at, last_seen_at, absolute_expires_at = timestamps
        if not created_at <= last_seen_at < absolute_expires_at:
            return None
        return SessionRecord(
            user_id=user_id,
            csrf_token=csrf_token,
            created_at=created_at,
            last_seen_at=last_seen_at,
            absolute_expires_at=absolute_expires_at,
        )

    @property
    def _session_key_prefix(self) -> str:
        return f"{self._prefix}session:"

    @property
    def _owner_key_prefix(self) -> str:
        return f"{self._prefix}session-owner:"

    @property
    def _user_index_prefix(self) -> str:
        return f"{self._prefix}sessions:user:"

    def _session_key(self, digest: str) -> str:
        return f"{self._session_key_prefix}{digest}"

    def _owner_key(self, digest: str) -> str:
        return f"{self._owner_key_prefix}{digest}"

    def _user_index_key(self, user_id: str) -> str:
        return f"{self._user_index_prefix}{user_id}"

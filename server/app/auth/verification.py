import hashlib
import hmac
import secrets
import time

from redis import Redis

from server.app.auth.security import normalize_email


CODE_TTL_SECONDS = 10 * 60
RESEND_TTL_SECONDS = 60
EMAIL_LIMIT = 5
IP_LIMIT = 30
GLOBAL_LIMIT = 300
MAX_FAILURES = 5


_ISSUE_SCRIPT = """
if redis.call('EXISTS', KEYS[2]) == 1 then
    return 1
end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[2]) then
    return 2
end
if tonumber(redis.call('GET', KEYS[4]) or '0') >= tonumber(ARGV[3]) then
    return 3
end
if tonumber(redis.call('GET', KEYS[5]) or '0') >= tonumber(ARGV[4]) then
    return 4
end

local resend_set = redis.call('SET', KEYS[2], '1', 'EX', ARGV[9], 'NX')
if not resend_set then
    return 1
end

local email_count = redis.call('INCR', KEYS[3])
if email_count == 1 then
    redis.call('EXPIRE', KEYS[3], ARGV[5])
end
local ip_count = redis.call('INCR', KEYS[4])
if ip_count == 1 then
    redis.call('EXPIRE', KEYS[4], ARGV[6])
end
local global_count = redis.call('INCR', KEYS[5])
if global_count == 1 then
    redis.call('EXPIRE', KEYS[5], ARGV[7])
end

redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[8])
redis.call('DEL', KEYS[6])
return 0
"""


_CONSUME_SCRIPT = """
local stored = redis.call('GET', KEYS[1])
if not stored then
    redis.call('DEL', KEYS[2])
    return 0
end

if stored == ARGV[1] then
    redis.call('DEL', KEYS[1], KEYS[2])
    return 1
end

local failures = redis.call('INCR', KEYS[2])
if failures == 1 then
    local code_ttl = redis.call('TTL', KEYS[1])
    if code_ttl > 0 then
        redis.call('EXPIRE', KEYS[2], code_ttl)
    end
end
if failures >= tonumber(ARGV[2]) then
    redis.call('DEL', KEYS[1], KEYS[2])
end
return 0
"""


class VerificationError(Exception):
    pass


class InvalidCode(VerificationError):
    pass


class ResendTooSoon(VerificationError):
    pass


class RateLimitExceeded(VerificationError):
    def __init__(self, scope: str):
        self.scope = scope
        super().__init__(f"verification rate limit exceeded for {scope}")


class VerificationStore:
    def __init__(self, redis: Redis, *, prefix: str, hmac_secret: bytes | str):
        secret = hmac_secret.encode("utf-8") if isinstance(hmac_secret, str) else hmac_secret
        if len(secret) < 32:
            raise ValueError("hmac_secret must be at least 32 bytes")
        self._redis = redis
        self._prefix = prefix
        self._hmac_secret = secret

    def issue(
        self,
        email: str,
        *,
        purpose: str,
        source_ip: str = "unknown",
        now: int | float | None = None,
    ) -> str:
        normalized_email = normalize_email(email)
        timestamp = int(time.time() if now is None else now)
        code = f"{secrets.randbelow(1_000_000):06d}"
        digest = self._digest(purpose, normalized_email, code)

        email_window = timestamp // 3600
        global_window = timestamp // 60
        code_key = self._key("verification", purpose, normalized_email)
        resend_key = self._key("verification", "resend", normalized_email)
        email_rate_key = self._key(
            "verification", "rate", "email", normalized_email, str(email_window)
        )
        ip_rate_key = self._key("verification", "rate", "ip", source_ip, str(email_window))
        global_rate_key = self._key("verification", "rate", "global", str(global_window))
        attempts_key = f"{code_key}:attempts"

        result = int(
            self._redis.eval(
                _ISSUE_SCRIPT,
                6,
                code_key,
                resend_key,
                email_rate_key,
                ip_rate_key,
                global_rate_key,
                attempts_key,
                digest,
                EMAIL_LIMIT,
                IP_LIMIT,
                GLOBAL_LIMIT,
                self._window_ttl(timestamp, 3600),
                self._window_ttl(timestamp, 3600),
                self._window_ttl(timestamp, 60),
                CODE_TTL_SECONDS,
                RESEND_TTL_SECONDS,
            )
        )
        if result == 1:
            raise ResendTooSoon("verification code was sent recently")
        if result == 2:
            raise RateLimitExceeded("email")
        if result == 3:
            raise RateLimitExceeded("ip")
        if result == 4:
            raise RateLimitExceeded("global")
        return code

    def consume(
        self,
        email: str,
        code: str,
        *,
        purpose: str,
        now: int | float | None = None,
    ) -> None:
        del now
        normalized_email = normalize_email(email)
        code_key = self._key("verification", purpose, normalized_email)
        attempts_key = f"{code_key}:attempts"
        digest = self._digest(purpose, normalized_email, code)
        result = int(
            self._redis.eval(
                _CONSUME_SCRIPT,
                2,
                code_key,
                attempts_key,
                digest,
                MAX_FAILURES,
            )
        )
        if result != 1:
            raise InvalidCode("invalid or expired verification code")

    def _digest(self, purpose: str, email: str, code: str) -> str:
        value = f"{purpose}:{email}:{code}".encode("utf-8")
        return hmac.new(self._hmac_secret, value, hashlib.sha256).hexdigest()

    def _key(self, *parts: str) -> str:
        return self._prefix + ":".join(parts)

    @staticmethod
    def _window_ttl(timestamp: int, duration: int) -> int:
        return max(1, duration - timestamp % duration)

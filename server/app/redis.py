import redis
from redis import Redis

from server.app.core.config import get_settings


settings = get_settings()
redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)


def get_redis() -> Redis:
    return redis_client


def redis_key(*parts: str) -> str:
    return settings.redis_prefix + ":".join(parts)

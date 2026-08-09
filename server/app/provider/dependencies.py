from collections.abc import Iterator

from fastapi import Depends

from server.app.core.config import AppSettings, get_settings
from server.app.provider.newapi import NewApiClient


def get_newapi_client(
    settings: AppSettings = Depends(get_settings),
) -> Iterator[NewApiClient]:
    client = NewApiClient(settings)
    try:
        yield client
    finally:
        client.close()

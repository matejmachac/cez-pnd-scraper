"""Authenticated connection to the existing Playwright transport app."""

import asyncio
import aiohttp


class TransportError(Exception):
    """Temporary PND or transport failure."""


class TransportAuthError(TransportError):
    """Transport token or PND credentials need attention."""


class IncompleteMeasurement(TransportError):
    """A source day is not fully measured."""


class PndTransport:
    def __init__(self, session, url, token):
        self.session = session
        self.url = url.rstrip("/")
        self.token = token

    async def get(self, path, **params):
        try:
            async with self.session.get(
                f"{self.url}/v1/{path}",
                params=params,
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=aiohttp.ClientTimeout(total=240),
            ) as response:
                if response.status in (401, 403):
                    raise TransportAuthError(
                        "PND transport authentication requires attention"
                    )
                if response.status == 422:
                    raise IncompleteMeasurement("PND day is incomplete or unavailable")
                if response.status != 200:
                    raise TransportError(
                        f"PND transport returned HTTP {response.status}"
                    )
                return await response.json()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise TransportError("PND transport is unavailable") from err

    async def info(self):
        data = await self.get("info")
        if data.get("protocol") != 1 or data.get("writerMode") != "native":
            raise TransportError(
                "Transport must use native writer mode (legacy writer must be stopped)"
            )
        return data

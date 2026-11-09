"""Authenticated connection to the existing Playwright transport app."""

import asyncio
import ipaddress
import os
import re
import aiohttp


class TransportError(Exception):
    """Temporary PND or transport failure."""


class TransportAuthError(TransportError):
    """Transport token or PND credentials need attention."""


class IncompleteMeasurement(TransportError):
    """A source day is not fully measured."""


class UnavailablePeriod(IncompleteMeasurement):
    """PND explicitly has no data sources in this period."""


class PndTransport:
    def __init__(self, session, url, token):
        self.session = session
        self.url = url.rstrip("/")
        self.token = token

    async def _base_url(self):
        if not self.url.startswith("supervisor://"):
            return self.url
        match = re.fullmatch(r"supervisor://([a-z0-9_]+)", self.url)
        supervisor_token = os.environ.get("SUPERVISOR_TOKEN")
        if match is None or not supervisor_token:
            raise TransportError("Supervisor application discovery requires HAOS")
        host = os.environ.get("SUPERVISOR", "supervisor")
        async with self.session.get(
            f"http://{host}/addons/{match[1]}/info",
            headers={"Authorization": f"Bearer {supervisor_token}"},
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            if response.status != 200:
                raise TransportError("Supervisor application discovery failed")
            info = await response.json()
        try:
            address = ipaddress.ip_address(info["data"]["ip_address"])
        except (KeyError, ValueError, TypeError) as err:
            raise TransportError(
                "Supervisor returned no usable transport address"
            ) from err
        target = str(address) if address.version == 4 else f"[{address}]"
        return f"http://{target}:8099"

    async def get(self, path, **params):
        try:
            base = await self._base_url()
            async with self.session.get(
                f"{base}/v1/{path}",
                params=params,
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=aiohttp.ClientTimeout(total=240),
            ) as response:
                if response.status in (401, 403):
                    raise TransportAuthError(
                        "PND transport authentication requires attention"
                    )
                if response.status == 422:
                    detail = await response.json()
                    if detail.get("error") == "no_data_sources":
                        raise UnavailablePeriod(
                            "PND has no data sources in this period"
                        )
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

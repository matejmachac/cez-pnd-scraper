import aiohttp
from aiohttp import web
import pytest
from custom_components.cez_pnd.api import PndTransport, TransportError


@pytest.mark.asyncio
async def test_supervisor_discovery_refreshes_addresses_and_keeps_tokens_separate(
    monkeypatch,
):
    current = {"ip": "172.30.33.4"}
    seen = []

    async def info(request):
        seen.append(request.headers["Authorization"])
        return web.json_response(
            {
                "result": "ok",
                "data": {
                    "ip_address": current["ip"],
                    "options": {"password": "do-not-retain"},
                },
            }
        )

    app = web.Application()
    app.router.add_get("/addons/local_test/info", info)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    monkeypatch.setenv("SUPERVISOR", f"127.0.0.1:{port}")
    monkeypatch.setenv("SUPERVISOR_TOKEN", "core-only-secret")
    try:
        async with aiohttp.ClientSession() as session:
            api = PndTransport(
                session, "supervisor://local_test", "transport-only-secret"
            )
            assert await api._base_url() == "http://172.30.33.4:8099"
            current["ip"] = "172.30.33.7"
            assert await api._base_url() == "http://172.30.33.7:8099"
            assert seen == ["Bearer core-only-secret", "Bearer core-only-secret"]
            assert "do-not-retain" not in str(api.__dict__)
            monkeypatch.delenv("SUPERVISOR_TOKEN")
            with pytest.raises(TransportError):
                await api._base_url()
    finally:
        await runner.cleanup()

from pathlib import Path
import sys
import socket
from homeassistant.auth import auth_manager_from_config
import pytest_asyncio
from homeassistant.core import HomeAssistant
from homeassistant.bootstrap import async_load_base_functionality
from homeassistant import loader
from homeassistant.config_entries import ConfigEntries
from homeassistant.helpers.recorder import async_initialize_recorder
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest_asyncio.fixture
async def hass(tmp_path):
    (tmp_path / "custom_components").symlink_to(
        Path(__file__).resolve().parents[1] / "custom_components",
        target_is_directory=True,
    )
    instance = HomeAssistant(str(tmp_path))
    loader.async_setup(instance)
    instance.config_entries = ConfigEntries(instance, {})
    await async_load_base_functionality(instance)
    instance.config.currency = "CZK"
    dt_util.set_default_time_zone(ZoneInfo("Europe/Prague"))
    async_initialize_recorder(instance)
    assert await async_setup_component(
        instance,
        "recorder",
        {
            "recorder": {
                "db_url": f"sqlite:///{tmp_path}/recorder.db",
                "auto_purge": False,
                "auto_repack": False,
            }
        },
    )
    instance.auth = await auth_manager_from_config(instance, [], [])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    assert await async_setup_component(
        instance, "energy", {"http": {"server_host": "127.0.0.1", "server_port": port}}
    )
    await instance.async_start()
    try:
        yield instance
    finally:
        await instance.async_stop()

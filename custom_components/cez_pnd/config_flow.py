"""Native setup, options, and token reauthentication."""

from copy import deepcopy
from datetime import timedelta
import re
import probatio as vol
from homeassistant import config_entries
from homeassistant.components.energy.data import async_get_manager
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.util import dt as dt_util
from .api import PndTransport, TransportAuthError, TransportError, IncompleteMeasurement
from .const import DOMAIN, DEFAULT_PRICES
from .model import PRAGUE, parse_date, validate_prices

TOKEN = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1
    MINOR_VERSION = 0

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                info = await PndTransport(
                    async_get_clientsession(self.hass),
                    user_input["url"],
                    user_input["token"],
                ).info()
                point = user_input["supply_point"].strip()
                if not point or not re.fullmatch(r"[a-z0-9_]+", point):
                    raise ValueError("Supply point must be a stable lowercase slug")
                stat_id = (
                    user_input.get("statistic_id")
                    or info.get("statisticId")
                    or f"{DOMAIN}:{point}_import_total"
                )
                if not re.fullmatch(r"cez_pnd:[a-z0-9_]+", stat_id):
                    raise ValueError("Invalid owned statistic ID")
                first = parse_date(user_input["history_start"])
                if first >= dt_util.utcnow().astimezone(PRAGUE).date():
                    raise ValueError("History must start before today")
                await self.async_set_unique_id(point)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"ČEZ PND {point}",
                    data={**user_input, "statistic_id": stat_id},
                )
            except TransportAuthError:
                errors["base"] = "invalid_auth"
            except TransportError:
                errors["base"] = "cannot_connect"
            except (KeyError, ValueError):
                errors["base"] = "invalid_configuration"
        first = (
            dt_util.utcnow().astimezone(PRAGUE).date() - timedelta(days=1095)
        ).isoformat()
        schema = vol.Schema(
            {
                vol.Required(
                    "url", default="http://a894bec6-cez-pnd-scraper.local.hass.io:8099"
                ): str,
                vol.Required("token"): TOKEN,
                vol.Required("supply_point", default="dubnice"): str,
                vol.Optional("statistic_id", default=""): str,
                vol.Required("history_start", default=first): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_reauth(self, entry_data):
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input=None):
        errors = {}
        entry = self._get_reauth_entry()
        if user_input:
            try:
                updates = {
                    "url": user_input["url"],
                    "token": user_input.get("token") or entry.data["token"],
                }
                api = PndTransport(
                    async_get_clientsession(self.hass), updates["url"], updates["token"]
                )
                await api.info()
                try:
                    await api.get(
                        "profile",
                        date=(
                            dt_util.utcnow().astimezone(PRAGUE).date()
                            - timedelta(days=1)
                        ).isoformat(),
                    )
                except IncompleteMeasurement:
                    pass  # Login succeeded even if yesterday's export is incomplete.
                return self.async_update_reload_and_abort(entry, data_updates=updates)
            except TransportAuthError:
                errors["base"] = "invalid_auth"
            except TransportError:
                errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required("url", default=entry.data["url"]): str,
                    vol.Optional("token"): TOKEN,
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return OptionsFlow()


class OptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                first = parse_date(user_input["history_start"])
                if first >= dt_util.utcnow().astimezone(PRAGUE).date():
                    raise ValueError("History must precede today")
                options = {**self.config_entry.options, **user_input}
                if user_input.pop("update_price", False):
                    new = {
                        "version": f"ui-{dt_util.utcnow().isoformat()}",
                        "from": options.pop("price_from"),
                        "until": options.pop("price_until"),
                        "vt": str(options.pop("price_vt")),
                        "nt": str(options.pop("price_nt")),
                        "fixed": str(options.pop("price_fixed")),
                        "currency": "CZK",
                    }
                    # A deliberately entered validity interval replaces that part
                    # of the schedule, retaining prices on both sides unchanged.
                    prices = []
                    for item in deepcopy(options.get("prices", DEFAULT_PRICES)):
                        if item["until"] <= new["from"] or item["from"] >= new["until"]:
                            prices.append(item)
                        else:
                            if item["from"] < new["from"]:
                                prices.append(
                                    {
                                        **item,
                                        "until": new["from"],
                                        "version": item["version"] + "-before",
                                    }
                                )
                            if item["until"] > new["until"]:
                                prices.append(
                                    {
                                        **item,
                                        "from": new["until"],
                                        "version": item["version"] + "-after",
                                    }
                                )
                    options["prices"] = validate_prices([*prices, new])
                for key in (
                    "update_price",
                    "price_from",
                    "price_until",
                    "price_vt",
                    "price_nt",
                    "price_fixed",
                ):
                    options.pop(key, None)
                return self.async_create_entry(title="", data=options)
            except (ValueError, KeyError):
                errors["base"] = "invalid_configuration"
        options = self.config_entry.options
        price = (options.get("prices") or DEFAULT_PRICES)[-1]
        manager = await async_get_manager(self.hass)
        replace_choices = [
            "none",
            *[
                source["stat_energy_from"]
                for source in (manager.data or {}).get("energy_sources", [])
                if source.get("type") == "grid" and source.get("stat_energy_from")
            ],
        ]
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        "history_start",
                        default=options.get(
                            "history_start", self.config_entry.data["history_start"]
                        ),
                    ): str,
                    vol.Required(
                        "correction_days", default=options.get("correction_days", 7)
                    ): vol.All(vol.Coerce(int), vol.Range(min=0, max=90)),
                    vol.Optional("update_price", default=False): bool,
                    vol.Optional(
                        "replace_source", default=options.get("replace_source", "none")
                    ): vol.In(replace_choices),
                    vol.Required("price_from", default=price["from"]): str,
                    vol.Required("price_until", default=price["until"]): str,
                    vol.Required("price_vt", default=price["vt"]): str,
                    vol.Required("price_nt", default=price["nt"]): str,
                    vol.Required("price_fixed", default=price["fixed"]): str,
                }
            ),
            errors=errors,
        )

"""Native devices and entities; external statistics have a single separate writer."""

from dataclasses import dataclass
from datetime import datetime
from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorDeviceClass,
)
from homeassistant.const import EntityCategory, UnitOfEnergy
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util
from .const import DOMAIN
from .model import PRAGUE, price_for_day


@dataclass(frozen=True, kw_only=True)
class Description(SensorEntityDescription):
    kind: str = "state"


DESCRIPTIONS = [
    Description(
        key="import_total",
        name="Importovaná energie",
        kind="total",
        device_class=SensorDeviceClass.ENERGY,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
    ),
    Description(
        key="import_vt",
        name="Importovaná energie VT",
        kind="total",
        device_class=SensorDeviceClass.ENERGY,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
    ),
    Description(
        key="import_nt",
        name="Importovaná energie NT",
        kind="total",
        device_class=SensorDeviceClass.ENERGY,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
    ),
    Description(
        key="cost_total",
        name="Náklady na elektřinu",
        kind="total",
        device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="CZK",
    ),
    Description(
        key="last_success",
        name="Poslední úspěšná synchronizace",
        kind="timestamp",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    Description(
        key="last_measurement",
        name="Nejnovější měření",
        kind="timestamp",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    Description(
        key="status",
        name="Stav synchronizace",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    Description(
        key="missing_days",
        name="Chybějící měřené dny",
        kind="count",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    Description(
        key="tariff_quality",
        name="Kvalita rozdělení tarifů",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    Description(
        key="cost_quality",
        name="Kvalita nákladů",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    Description(
        key="vt",
        name="Aktuální cena VT",
        kind="price",
        native_unit_of_measurement="CZK/kWh",
    ),
    Description(
        key="nt",
        name="Aktuální cena NT",
        kind="price",
        native_unit_of_measurement="CZK/kWh",
    ),
    Description(
        key="fixed",
        name="Měsíční fixní poplatky",
        kind="price",
        device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="CZK",
    ),
]


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities(
        [PndSensor(entry.runtime_data, description) for description in DESCRIPTIONS]
    )


class PndSensor(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    # No state_class: Recorder must not compile another copy of the externally
    # imported history from current entity states after backfill/restarts.
    def __init__(self, coordinator, description):
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{coordinator.entry.unique_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.unique_id)},
            name=f"ČEZ PND {coordinator.supply_point}",
            manufacturer="ČEZ Distribuce",
            model="PND denní měření",
        )

    @property
    def native_value(self):
        data = self.coordinator.data or {}
        description = self.entity_description
        if description.kind == "total":
            if (
                description.key in ("import_vt", "import_nt")
                and data.get("tariff_quality") != "daily_measured"
            ):
                return None
            if (
                description.key == "cost_total"
                and data.get("cost_quality") != "daily_settlement"
            ):
                return None
            return data.get("totals", {}).get(description.key)
        if description.kind == "price":
            price = price_for_day(
                dt_util.utcnow().astimezone(PRAGUE).date().isoformat(),
                self.coordinator.prices,
            )
            return float(price[description.key]) if price else None
        value = data.get(description.key)
        if description.kind == "count":
            return len(value or [])
        if description.kind == "timestamp":
            return datetime.fromisoformat(value) if value else None
        return value

    @property
    def extra_state_attributes(self):
        key = self.entity_description.key
        if key in self.coordinator.ids:
            return {
                "statistic_id": self.coordinator.ids[key],
                "resolution": "hour" if key == "import_total" else "day",
                "source": "ČEZ PND",
                "delayed_measurements": True,
            }
        if key == "fixed":
            return {"billing_period": "calendar_month", "vat_included": True}
        return None

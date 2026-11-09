"""Route actionable Repairs to the integration's native options flow."""

from homeassistant.components.repairs import RepairsFlow, FlowType
from .const import DOMAIN


class PndRepairFlow(RepairsFlow):
    def __init__(self, entry_id):
        super().__init__()
        self.entry_id = entry_id

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            flow = await self.hass.config_entries.options.async_init(self.entry_id)
            return self.async_create_entry(
                data={}, next_flow=(FlowType.OPTIONS_FLOW, flow["flow_id"])
            )
        return self.async_show_form(step_id="init", data_schema=None)


async def async_create_fix_flow(hass, issue_id, data):
    entry = next(
        (
            entry
            for entry in hass.config_entries.async_entries(DOMAIN)
            if issue_id.startswith(entry.entry_id + "_")
        ),
        None,
    )
    if entry is None:
        raise ValueError("The PND entry no longer exists")
    return PndRepairFlow(entry.entry_id)

import path from "node:path";
import { loadConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import { HomeAssistantClient } from "./home-assistant.js";
import { rollbackEnergyDashboard } from "./energy-dashboard.js";

// Stop the scheduler first and disable add_to_energy_dashboard before restart.
const config = await loadConfig();
const client = new HomeAssistantClient({ url: config.homeAssistantWebSocketUrl, token: config.supervisorToken });
try {
  await client.connect();
  const result = await rollbackEnergyDashboard(client, new StateStore(path.join(config.dataDir, "energy-backup.json")));
  console.log(JSON.stringify(result));
} finally {
  client.close();
}

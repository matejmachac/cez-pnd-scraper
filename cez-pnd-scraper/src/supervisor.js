export async function getMqttService({ token = process.env.SUPERVISOR_TOKEN } = {}) {
  if (process.env.MQTT_HOST) {
    return {
      host: process.env.MQTT_HOST,
      port: process.env.MQTT_PORT ?? "1883",
      ssl: process.env.MQTT_SSL === "true",
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
    };
  }

  if (!token) throw new Error("SUPERVISOR_TOKEN is missing and MQTT_HOST was not provided");
  const response = await fetch("http://supervisor/services/mqtt", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Supervisor MQTT service lookup failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  return body.data ?? body;
}

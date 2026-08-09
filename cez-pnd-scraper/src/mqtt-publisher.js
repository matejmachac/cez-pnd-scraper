import mqtt from "mqtt";

export class MqttPublisher {
  constructor(service, { elm, staleAfterMinutes, logger }) {
    this.service = service;
    this.elm = elm || "default";
    this.deviceId = `cez_pnd_${sanitize(this.elm)}`;
    this.baseTopic = `cez_pnd/${sanitize(this.elm)}`;
    this.staleAfterMinutes = staleAfterMinutes;
    this.logger = logger;
    this.client = null;
  }

  async connect() {
    const protocol = this.service.ssl ? "mqtts" : "mqtt";
    const url = `${protocol}://${this.service.host}:${this.service.port}`;
    this.client = mqtt.connect(url, {
      username: this.service.username,
      password: this.service.password,
      clientId: `${this.deviceId}_${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      clean: true,
      will: {
        topic: `${this.baseTopic}/availability`,
        payload: "offline",
        qos: 1,
        retain: true,
      },
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MQTT connection timed out")), 15_000);
      this.client.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.client.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    await this.publishDiscovery();
    this.logger.info("Connected to Home Assistant MQTT service", { host: this.service.host });
  }

  async publishDiscovery() {
    const config = {
      name: "ČEZ PND power",
      unique_id: `${this.deviceId}_power`,
      object_id: `${this.deviceId}_power`,
      state_topic: `${this.baseTopic}/power`,
      json_attributes_topic: `${this.baseTopic}/attributes`,
      availability_topic: `${this.baseTopic}/availability`,
      payload_available: "online",
      payload_not_available: "offline",
      unit_of_measurement: "kW",
      device_class: "power",
      state_class: "measurement",
      force_update: true,
      expire_after: this.staleAfterMinutes * 60,
      suggested_display_precision: 3,
      device: {
        identifiers: [this.deviceId],
        name: this.elm === "default" ? "ČEZ PND" : `ČEZ PND ${this.elm}`,
        manufacturer: "ČEZ Distribuce",
        model: "PND virtual meter",
      },
    };
    await this.publish(`homeassistant/sensor/${this.deviceId}/power/config`, JSON.stringify(config), true);
  }

  async publishMeasurement(measurement) {
    await this.publish(`${this.baseTopic}/attributes`, JSON.stringify({
      pnd_timestamp: measurement.timestamp,
      source_column: measurement.column,
      source: measurement.source,
    }), true);
    await this.publish(`${this.baseTopic}/power`, String(measurement.powerKw), true);
    await this.publishAvailability(true);
  }

  async publishAvailability(online) {
    if (!this.client) return;
    await this.publish(`${this.baseTopic}/availability`, online ? "online" : "offline", true);
  }

  async publish(topic, payload, retain = false) {
    if (!this.client) throw new Error("MQTT client is not connected");
    await new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1, retain }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close() {
    if (!this.client) return;
    await new Promise((resolve) => this.client.end(false, {}, resolve));
    this.client = null;
  }
}

function sanitize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

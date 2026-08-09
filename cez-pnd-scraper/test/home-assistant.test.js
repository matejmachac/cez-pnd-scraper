import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { HomeAssistantClient } from "../src/home-assistant.js";

test("authenticates and imports statistics through the Home Assistant protocol", async (context) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  let imported;

  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "auth") {
        assert.equal(message.access_token, "test-token");
        socket.send(JSON.stringify({ type: "auth_ok" }));
      } else if (message.type === "recorder/import_statistics") {
        imported = message;
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
      }
    });
  });

  const port = server.address().port;
  const client = new HomeAssistantClient({ url: `ws://127.0.0.1:${port}`, token: "test-token" });
  await client.connect();
  await client.importStatistics({ statistic_id: "cez_pnd:test" }, [{ start: "2026-08-01T00:00:00Z", sum: 1 }]);
  client.close();

  assert.equal(imported.type, "recorder/import_statistics");
  assert.equal(imported.metadata.statistic_id, "cez_pnd:test");
  assert.equal(imported.stats[0].sum, 1);
});

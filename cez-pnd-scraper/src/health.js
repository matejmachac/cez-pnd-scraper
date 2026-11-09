import http from "node:http";

export function startHealthServer(port, status, bridge) {
  const server = http.createServer(async (request, response) => {
    if (bridge && request.url?.startsWith("/v1/")) {
      try {
        await bridge(request, response);
      } catch {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }).end('{"error":"transport_failure"}');
        else response.end();
      }
      return;
    }
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const healthy = !status.stopping;
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      healthy,
      running: status.running,
      lastSuccess: status.lastSuccess,
      lastError: status.lastError,
    }));
  });
  server.listen(port, "0.0.0.0");
  return server;
}

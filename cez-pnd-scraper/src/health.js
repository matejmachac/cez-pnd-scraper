import http from "node:http";

export function startHealthServer(port, status) {
  const server = http.createServer((request, response) => {
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

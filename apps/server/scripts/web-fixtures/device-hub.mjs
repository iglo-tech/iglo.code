// A pinned-package fixture implementing the hub's public HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
NodeHttp.createServer((request, response) => {
  const mode = NodeFS.readFileSync(process.env.T3_FAKE_DEVICE_MODE, "utf8").trim();
  response.setHeader("content-type", "application/json");
  if (request.url === "/readyz") return response.end("{}");
  if (request.url === "/api/devices") {
    if (mode === "error") {
      response.statusCode = 503;
      return response.end(JSON.stringify({ error: "Controlled device inventory failure" }));
    }
    return response.end(
      JSON.stringify({
        simulators: [],
        emulators:
          mode === "empty"
            ? []
            : [
                {
                  id: "fixture-emulator",
                  name: "Fixture Android",
                  version: "35",
                  platform: "android",
                  booted: false,
                  physical: false,
                },
              ],
      }),
    );
  }
  response.statusCode = request.url === "/api/devices/boot" ? 200 : 500;
  response.end(JSON.stringify({ ok: false, error: "Controlled device boot failure" }));
}).listen(port, "127.0.0.1");

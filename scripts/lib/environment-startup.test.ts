import { describe, expect, it } from "vite-plus/test";
import { DEV_WEB_READY_MESSAGE, readEnvironmentStartup } from "./environment-startup.ts";

const backend =
  "Listening on http://127.0.0.1:3773\npairingUrl: http://localhost:5173/pair#token=fixture-token\n";

describe("environment startup readiness", () => {
  it("does not start source transport checks while Vite is still warming", () => {
    expect(readEnvironmentStartup(backend, "source")).toBeUndefined();
    expect(readEnvironmentStartup(backend + DEV_WEB_READY_MESSAGE, "source")).toEqual({
      pairingUrl: "http://localhost:5173/pair#token=fixture-token",
      serverOrigin: "http://127.0.0.1:3773",
    });
  });

  it("also waits for the backend when the web milestone arrives first", () => {
    expect(readEnvironmentStartup(DEV_WEB_READY_MESSAGE, "source")).toBeUndefined();
    expect(
      readEnvironmentStartup(DEV_WEB_READY_MESSAGE + "\n" + backend, "source")?.pairingUrl,
    ).toBe("http://localhost:5173/pair#token=fixture-token");
  });

  it("keeps archive startup independent of Vite", () => {
    expect(
      readEnvironmentStartup(
        "pairingUrl: http://localhost:3773/pair?token=fixture-token\n",
        "archive",
      ),
    ).toEqual({
      pairingUrl: "http://localhost:3773/pair?token=fixture-token",
      serverOrigin: "http://localhost:3773",
    });
  });

  it.each(["source", "archive"] as const)("waits for a split token in %s startup", (kind) => {
    const partial =
      DEV_WEB_READY_MESSAGE + "\npairingUrl: http://localhost:5173/pair#token=fixture-";
    expect(readEnvironmentStartup(partial, kind)).toBeUndefined();
    expect(readEnvironmentStartup(partial + "token", kind)).toBeUndefined();
    expect(readEnvironmentStartup(partial + "token\n", kind)?.pairingUrl).toBe(
      "http://localhost:5173/pair#token=fixture-token",
    );
    expect(readEnvironmentStartup(partial + "token\r\n", kind)?.pairingUrl).toBe(
      "http://localhost:5173/pair#token=fixture-token",
    );
  });
});

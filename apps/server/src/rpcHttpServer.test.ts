// @effect-diagnostics nodeBuiltinImport:off -- Tests the production adapter in a real Bun subprocess.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { WebSocket } from "ws-rpc";

let server: NodeChildProcess.ChildProcess;
let origin: string;

beforeAll(async () => {
  server = NodeChildProcess.spawn(
    process.env.T3_BUN_EXECUTABLE ?? "bun",
    [NodeURL.fileURLToPath(new URL("./testUtils/rpcHttpServer.fixture.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = NodeReadline.createInterface({ input: server.stdout! });
  let stderr = "";
  server.stderr!.on("data", (data) => {
    stderr += data;
  });
  origin = await new Promise<string>((resolve, reject) => {
    lines.on("line", (line) => {
      if (line.startsWith("rpc-fixture:")) resolve(`http://127.0.0.1:${line.slice(12)}`);
    });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Transport fixture exited ${code}: ${stderr}`)));
  });
});

afterAll(async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exit = NodeEvents.EventEmitter.once(server, "exit");
  server.kill("SIGTERM");
  await exit;
});

async function echo(path: string, compression: boolean) {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, {
    perMessageDeflate: compression,
  });
  try {
    await NodeEvents.EventEmitter.once(socket, "open");
    expect(socket.extensions).toBe(
      compression && path.startsWith("/ws") ? "permessage-deflate" : "",
    );
    for (let id = 0; id < 100; id++) {
      const payload = `${id}:${"repeated RPC payload ".repeat(256)}`;
      const reply = NodeEvents.EventEmitter.once(socket, "message");
      socket.send(payload);
      const [message, binary] = await reply;
      expect(binary).toBe(path.startsWith("/browser"));
      expect(message.toString()).toBe(payload);
    }
    const reply = NodeEvents.EventEmitter.once(socket, "message");
    socket.send(Buffer.from([0, 255, 1, 254]));
    const [message, binary] = await reply;
    expect(binary).toBe(true);
    expect(message).toEqual(Buffer.from([0, 255, 1, 254]));
    return socket.extensions;
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      const close = NodeEvents.EventEmitter.once(socket, "close");
      socket.close();
      await close;
    } else socket.terminate();
  }
}

it("negotiates deflate for RPC and keeps a busy socket valid", async () => {
  await expect(echo("/ws?orchestrationProtocol=2", true)).resolves.toBe("permessage-deflate");
  await expect(echo("/ws", true)).resolves.toBe("permessage-deflate");
});

it("retains clients without deflate and the uncompressed Browser upgrade", async () => {
  await expect(echo("/ws", false)).resolves.toBe("");
  await expect(echo("/browser", true)).resolves.toBe("");
  expect((await httpGet("/")).bytes.toString()).toBe("HTTP retained");
  expect((await httpGet("/refuse")).status).toBe(401);
});

it("keeps rejection before upgrade and the listener usable afterwards", async () => {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws?refuse`, {
    perMessageDeflate: true,
  });
  socket.on("error", () => {});
  try {
    const [, response] = await NodeEvents.EventEmitter.once(socket, "unexpected-response");
    expect(response.statusCode).toBe(401);
  } finally {
    socket.terminate();
  }
  await expect(echo("/ws", true)).resolves.toBe("permessage-deflate");
});

it("lets middleware observe the completed HTTP response write", async () => {
  await httpGet("/");
  expect((await httpGet("/middleware-observation")).bytes.toString()).toBe("true");
});

it.each([false, true])("retains the 16 MiB message limit (deflate=%s)", async (compression) => {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, {
    perMessageDeflate: compression,
  });
  try {
    await NodeEvents.EventEmitter.once(socket, "open");
    const closed = NodeEvents.EventEmitter.once(socket, "close");
    socket.send(Buffer.alloc(16 * 1024 * 1024 + 1, 97));
    const [code] = await closed;
    expect(code).toBe(1009);
  } finally {
    socket.terminate();
  }
});

it("preserves Content-Length for raw streamed ranges and gzip bodies", async () => {
  for (const path of ["/range", "/gzip"]) {
    const response = await httpGet(path);
    expect(response.headers["content-length"]).toBe(String(response.bytes.length));
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    if (path === "/range") {
      expect(response.status).toBe(206);
      expect(response.headers["content-range"]).toBe("bytes 0-65535/1048576");
      expect(response.bytes).toEqual(Buffer.alloc(65536, 97));
    } else {
      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(response.bytes.length).toBeGreaterThan(65536);
      expect(NodeZlib.gunzipSync(response.bytes).length).toBe(65536);
    }
  }
});

it.each([false, true])(
  "finishes an open RPC handler without HTTP bytes (deflate=%s)",
  async (compression) => {
    const result = await rawSocket("/ws?end", compression, true);
    expect(result.header).toMatch(/^HTTP\/1\.1 101 /u);
    expect(result.header.includes("Sec-WebSocket-Extensions: permessage-deflate")).toBe(
      compression,
    );
    expect(result.trailing.toString(), "No HTTP response may enter the upgraded stream").toBe("");
    expect(result.frames.map((frame) => frame.opcode)).toEqual([1, 8]);
    expect(result.frames[0]!.compressed).toBe(compression);
    expect(result.frames[1]!.payload.readUInt16BE()).toBe(1000);
  },
);

it("bounds shutdown for live RPC peers including one that never acknowledges close", async () => {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, {
    perMessageDeflate: true,
  });
  await NodeEvents.EventEmitter.once(socket, "open");
  const opened = Promise.withResolvers<void>();
  const unresponsive = rawSocket("/ws", true, false, opened.resolve);
  await opened.promise;
  const closed = NodeEvents.EventEmitter.once(socket, "close");
  const exited = NodeEvents.EventEmitter.once(server, "exit");
  const start = performance.now();
  server.kill("SIGTERM");
  const [code] = await closed;
  expect(code).toBe(1001);
  const raw = await unresponsive;
  expect(raw.frames.map((frame) => frame.opcode)).toEqual([8]);
  expect(raw.frames[0]!.payload.readUInt16BE()).toBe(1001);
  expect(raw.trailing.length).toBe(0);
  await exited;
  expect(performance.now() - start).toBeLessThan(2000);
  expect(server.exitCode).toBe(130);
}, 5000);

// A raw peer lets us inspect bytes after close, which ws normally stops parsing.
function rawSocket(path: string, compression: boolean, acknowledge: boolean, onOpen?: () => void) {
  return new Promise<{
    header: string;
    frames: Array<{ opcode: number; compressed: boolean; payload: Buffer }>;
    trailing: Buffer;
  }>((resolve, reject) => {
    const url = new URL(origin);
    const socket = NodeNet.connect(Number(url.port), url.hostname);
    let buffer = Buffer.alloc(0);
    let header: string | undefined;
    const frames: Array<{ opcode: number; compressed: boolean; payload: Buffer }> = [];
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...(compression
            ? ["Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits"]
            : []),
          "",
          "",
        ].join("\r\n"),
      ),
    );
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (header === undefined) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        header = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        onOpen?.();
      }
      while (buffer.length >= 2 && !frames.some((frame) => frame.opcode === 8)) {
        const opcode = buffer[0]! & 0x0f;
        const length = buffer[1]!;
        // The fixture sends only short, final, unmasked data and close frames.
        if (![0x81, 0xc1, 0x88].includes(buffer[0]!) || length > 125) break;
        if (buffer.length < length + 2) return;
        const payload = buffer.subarray(2, length + 2);
        frames.push({ opcode, compressed: Boolean(buffer[0]! & 0x40), payload });
        buffer = buffer.subarray(length + 2);
        if (opcode === 8 && acknowledge) {
          socket.write(Buffer.concat([Buffer.from([0x88, 0x80 | length, 0, 0, 0, 0]), payload]));
        }
      }
      // Fail promptly on the HTTP corruption instead of waiting for ws's close timeout.
      if (buffer.includes(Buffer.from("HTTP/1.1"))) socket.destroy();
    });
    socket.on("close", () => resolve({ header: header ?? "", frames, trailing: buffer }));
  });
}

function httpGet(path: string) {
  return new Promise<{
    headers: NodeHttp.IncomingHttpHeaders;
    status: number | undefined;
    bytes: Buffer;
  }>((resolve, reject) => {
    const request = NodeHttp.get(`${origin}${path}`, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          headers: response.headers,
          status: response.statusCode,
          bytes: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
  });
}

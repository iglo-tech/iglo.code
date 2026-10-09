/** The source fixture shares Vite's origin, so backend readiness alone is insufficient. */
export const DEV_WEB_READY_MESSAGE = "[t3-dev-web] initial module graph warmup finished";

export function readEnvironmentStartup(output: string, kind: "source" | "archive") {
  // Pairing URLs are logged as full lines; a stream chunk can end inside the token.
  const match = /https?:\/\/[^\s"'<>]+\/pair[?#]token=[^\s"'<>]+(?=\r?\n)/.exec(output);
  if (!match || (kind === "source" && !output.includes(DEV_WEB_READY_MESSAGE))) return undefined;
  return {
    pairingUrl: match[0],
    serverOrigin: /Listening on (https?:\/\/[^\s]+)/.exec(output)?.[1] ?? new URL(match[0]).origin,
  };
}

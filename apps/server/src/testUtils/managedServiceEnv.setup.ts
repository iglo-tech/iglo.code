import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";

// Agents inside a managed T3 service inherit its home and launcher context; CI has neither.
for (const name of [
  "IGLO_CODE_HOME",
  "IGLO_CODE_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]) {
  delete process.env[name];
}

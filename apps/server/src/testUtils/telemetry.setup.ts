// Servers booted by tests would otherwise post analytics to any configured ingest host and wait on its shutdown flush.
process.env.IGLO_CODE_TELEMETRY_ENABLED = "false";

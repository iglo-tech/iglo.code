// Servers booted by tests would otherwise post analytics to the real ingest host and wait on its shutdown flush.
process.env.T3CODE_TELEMETRY_ENABLED = "false";

# iglo.code supports macOS arm64, Linux x64, and Linux arm64.
$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("iglo.code: Windows is unsupported. Supported targets: darwin-arm64, linux-x64, linux-arm64.")
exit 1

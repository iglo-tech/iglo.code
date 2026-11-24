# Fleet

**Fleet** shows the health of this machine and every other machine you reach from it, without
signing in to each one. Open it from the sidebar or the command palette.

## What it shows

Each machine gets a card with CPU, memory, disk, network, load, uptime, and its hottest sensor.
Select a card for its details: host information, current values, every mounted disk, sensors
grouped by chip, and charts of the last hour, day, week, or month.

Machines appear in two ways:

- **Connected environments** stream their health live.
- **Linked environments** (Settings → Labs → Linked environments) that this browser is not
  connected to are read through the machine that holds the link, and refresh every 10 seconds.

A machine needs a server version that includes Fleet, and your connection needs diagnostics access
to it.

## History

Each server samples its own machine every 10 seconds, whether or not anyone has Fleet open, and
keeps the history in `host-metrics.sqlite` in its data folder. It keeps raw samples for two hours,
one-minute averages for 7 days, and 15-minute averages for 30 days, so the file stays small. Gaps
in a chart are times the server was not running.

## Sensors and warnings

On Linux, Fleet lists every temperature, fan, and PWM reading the kernel's hardware monitoring
drivers expose under `/sys/class/hwmon`, such as `k10temp`, `coretemp`, `nvme`, `amdgpu`, or a
motherboard's Super I/O chip. On macOS it shows the hottest sensor of each part of the chip (CPU
cores, GPU, SSD, and so on) and each fan's speed. Neither needs root access. A machine without
sensors, like most cloud VMs, shows no sensor section.

A card turns yellow or red when memory or a disk is nearly full, a temperature passes its driver's
limit (or 80 °C / 90 °C when the driver gives none, 95 °C / 105 °C on a Mac), or a fan stops. A pump or CPU fan at 0 RPM is
critical at once; other Linux fans only warn after they were seen spinning, since unused fan headers
read 0. Mac fans stop on their own when the machine is cool, so they never warn.

## Fan and pump control

Fleet only reads sensors and never changes fan or pump speeds, so restarting or updating iglo.code
cannot leave a cooler stuck. If [CoolerControl](https://gitlab.com/coolercontrol/coolercontrol)
runs on a Linux machine, Fleet lists the devices it manages; keep adjusting curves in CoolerControl.

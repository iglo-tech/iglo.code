import { assert, describe, it } from "@effect/vitest";

import {
  evaluateHostHealthAlerts,
  parseDarwinIoregDiskIo,
  parseDarwinNetstat,
  parseDarwinSensors,
  parseDarwinSwapUsage,
  parseDarwinVmStat,
  parseDfOutput,
  parseLinuxDiskstats,
  parseLinuxHwmonDevice,
  parseLinuxMeminfo,
  parseLinuxNetDev,
  parseLinuxOsRelease,
  parseLinuxProcStat,
  parseLinuxZramStats,
} from "./HostMetricsParsers.ts";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("Linux /proc", () => {
  it("counts iowait as idle and steal as busy", () => {
    // user nice system idle iowait irq softirq steal
    assert.deepStrictEqual(parseLinuxProcStat("cpu  100 0 50 800 50 0 0 0\ncpu0 1 2 3 4\n"), {
      idle: 850,
      total: 1000,
    });
    assert.strictEqual(parseLinuxProcStat("intr 1 2 3"), null);
  });

  it("reads available memory and swap use", () => {
    const meminfo = [
      "MemTotal:       16000000 kB",
      "MemFree:         1000000 kB",
      "MemAvailable:    6000000 kB",
      "SwapTotal:       2000000 kB",
      "SwapFree:        1500000 kB",
    ].join("\n");
    assert.deepStrictEqual(parseLinuxMeminfo(meminfo), {
      totalBytes: 16_000_000 * 1024,
      availableBytes: 6_000_000 * 1024,
      swapTotalBytes: 2_000_000 * 1024,
      swapUsedBytes: 500_000 * 1024,
    });
  });

  it("sums whole disks only, so partitions are not counted twice", () => {
    const diskstats = [
      " 259       0 nvme0n1 100 0 2000 0 50 0 4000 0 0 0 0",
      " 259       1 nvme0n1p1 90 0 1800 0 40 0 3000 0 0 0 0",
      "   7       0 loop0 5 0 999 0 0 0 0 0 0 0 0",
      " 253       0 dm-0 80 0 1600 0 30 0 2000 0 0 0 0",
    ].join("\n");
    assert.deepStrictEqual(parseLinuxDiskstats(diskstats), {
      readBytes: 2000 * 512,
      writeBytes: 4000 * 512,
    });
  });

  it("leaves loopback out of network totals", () => {
    const netDev = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes",
      "    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0",
      "  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0",
      " wlan0: 500 1 0 0 0 0 0 0 250 1 0 0 0 0 0 0",
    ].join("\n");
    assert.deepStrictEqual(parseLinuxNetDev(netDev), { rxBytes: 1500, txBytes: 2250 });
  });

  it("names the distribution", () => {
    assert.strictEqual(
      parseLinuxOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'),
      "Ubuntu 24.04.1 LTS",
    );
    assert.strictEqual(parseLinuxOsRelease("NAME=Arch\n"), null);
  });

  it("reports zram by the memory it really holds", () => {
    assert.deepStrictEqual(
      parseLinuxZramStats([{ disksize: "8589934592\n", mmStat: "4000 1000 1200 0 1200 0 0 0 0" }]),
      { zramTotalBytes: 8_589_934_592, zramUsedBytes: 1200 },
    );
    assert.strictEqual(parseLinuxZramStats([{ disksize: "0", mmStat: "" }]), null);
  });
});

describe("hwmon", () => {
  it("reads whatever a driver exposes, with labels and thresholds", () => {
    const readings = parseLinuxHwmonDevice({
      hwmonId: "hwmon3",
      chipName: "nct6799",
      files: files({
        name: "nct6799\n",
        temp2_input: "41000\n",
        temp1_input: "38500\n",
        temp1_label: "SYSTIN\n",
        temp1_max: "80000\n",
        temp1_crit: "95000\n",
        fan2_input: "1210\n",
        fan2_label: "Pump\n",
        pwm2: "128\n",
      }),
    });
    assert.deepStrictEqual(
      readings.map((reading) => [reading.id, reading.label, reading.value, reading.unit]),
      [
        ["hwmon3:temp1", "SYSTIN", 38.5, "celsius"],
        ["hwmon3:temp2", "temp2", 41, "celsius"],
        ["hwmon3:fan2", "Pump", 1210, "rpm"],
        ["hwmon3:pwm2", "pwm2", 50.2, "percent"],
      ],
    );
    assert.strictEqual(readings[0]?.highThreshold, 80);
    assert.strictEqual(readings[0]?.criticalThreshold, 95);
  });

  it("drops readings a driver reports as nonsense", () => {
    const readings = parseLinuxHwmonDevice({
      hwmonId: "hwmon0",
      chipName: "acpitz",
      files: files({ temp1_input: "-273150", temp2_input: "n/a", fan1_input: "-1" }),
    });
    assert.deepStrictEqual(readings, []);
  });
});

describe("macOS sensors", () => {
  it("keeps the hottest sensor of each Apple silicon family, and every fan", () => {
    const output = JSON.stringify({
      temperatures: [
        { label: "pACC MTR Temp Sensor3", celsius: 41.2 },
        { label: "pACC MTR Temp Sensor8", celsius: 46.29 },
        { label: "eACC MTR Temp Sensor0", celsius: 26.5 },
        { label: "PMU2 tdie6", celsius: 40.8 },
        { label: "NAND CH0 temp", celsius: 31 },
        { label: "TC0P", celsius: 60, critical: 100 },
      ],
      fans: [{ index: 0, rpm: 1704.54 }],
    });
    assert.deepStrictEqual(
      parseDarwinSensors(output).map((sensor) => [
        sensor.label,
        sensor.value,
        sensor.highThreshold,
        sensor.criticalThreshold,
      ]),
      [
        ["CPU efficiency cores", 26.5, 95, 105],
        ["CPU performance cores", 46.3, 95, 105],
        ["Power management", 40.8, 95, 105],
        ["SSD", 31, 95, 105],
        ["TC0P", 60, 95, 100],
        ["Fan 1", 1705, undefined, undefined],
      ],
    );
  });

  it("shows no sensors when the monitor is missing or too old to answer", () => {
    assert.deepStrictEqual(parseDarwinSensors(""), []);
    assert.deepStrictEqual(parseDarwinSensors('{"version":3,"type":"hello"}'), []);
  });
});

describe("df", () => {
  it("lists real mounts, root first, without pseudo filesystems", () => {
    const output = [
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/nvme0n1p2   100000000  60000000  40000000      60% /",
      "tmpfs              1000000         0   1000000       0% /run/user/1000",
      "/dev/sda1        200000000 190000000  10000000      95% /mnt/data mirror",
      "/dev/nvme0n1p1      500000      5000    495000       1% /boot/efi",
    ].join("\n");
    const disks = parseDfOutput(output, "linux");
    assert.deepStrictEqual(
      disks.map((disk) => [disk.mountPoint, disk.usedPercent]),
      [
        ["/", 60],
        ["/mnt/data mirror", 95],
      ],
    );
  });

  it("shows the macOS Data volume as the root disk, whichever line comes first", () => {
    const lines = [
      "/dev/disk3s1s1 971350180 10000000 500000000 2% /",
      "/dev/disk3s5 971350180 400000000 500000000 42% /System/Volumes/Data",
      "/dev/disk3s6 971350180 2000000 500000000 1% /System/Volumes/VM",
    ];
    for (const order of [lines, [...lines].reverse()]) {
      const output = ["Filesystem 1024-blocks Used Available Capacity Mounted on", ...order];
      assert.deepStrictEqual(
        parseDfOutput(output.join("\n"), "darwin").map((disk) => [
          disk.mountPoint,
          disk.filesystem,
        ]),
        [["/", "/dev/disk3s5"]],
      );
    }
  });
});

describe("macOS tools", () => {
  it("counts free, inactive and speculative pages as available", () => {
    const vmStat = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                             90000.",
      "Pages inactive:                           20000.",
      "Pages speculative:                         5000.",
    ].join("\n");
    assert.strictEqual(parseDarwinVmStat(vmStat), 35_000 * 16_384);
  });

  it("reads swap usage in its own units", () => {
    assert.deepStrictEqual(
      parseDarwinSwapUsage("vm.swapusage: total = 2048.00M  used = 512.50M  free = 1535.50M"),
      { swapTotalBytes: 2048 * 1024 * 1024, swapUsedBytes: Math.round(512.5 * 1024 * 1024) },
    );
  });

  it("sums link-layer interfaces except loopback", () => {
    const netstat = [
      "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
      "lo0        16384 <Link#1>                        100     0      5000      100     0      5000     0",
      "en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff   200     0      8000      150     0      3000     0",
      "en0        1500  192.168.1     192.168.1.20      200     -      8000      150     -      3000     -",
    ].join("\n");
    assert.deepStrictEqual(parseDarwinNetstat(netstat), { rxBytes: 8000, txBytes: 3000 });
  });

  it("sums every block storage driver's byte counters", () => {
    const ioreg = `"Statistics" = {"Bytes (Read)"=1000,"Bytes (Write)"=500}\n"Statistics" = {"Bytes (Read)"=24,"Bytes (Write)"=6}`;
    assert.deepStrictEqual(parseDarwinIoregDiskIo(ioreg), { readBytes: 1024, writeBytes: 506 });
  });
});

describe("alerts", () => {
  const memory = { totalBytes: 100, usedBytes: 50 };
  const temperature = (value: number, thresholds: { high?: number; crit?: number } = {}) => ({
    id: "hwmon0:temp1",
    chip: "k10temp",
    kind: "temperature" as const,
    label: "Tctl",
    value,
    unit: "celsius" as const,
    ...(thresholds.high === undefined ? {} : { highThreshold: thresholds.high }),
    ...(thresholds.crit === undefined ? {} : { criticalThreshold: thresholds.crit }),
  });
  const fan = (label: string, value: number) => ({
    id: `hwmon1:${label}`,
    chip: "nct6799",
    kind: "fan" as const,
    label,
    value,
    unit: "rpm" as const,
  });
  const evaluate = (input: Partial<Parameters<typeof evaluateHostHealthAlerts>[0]>) =>
    evaluateHostHealthAlerts({
      memory,
      disks: [],
      sensors: [],
      previouslySpinningFans: new Set(),
      ...input,
    });

  it("is quiet on a healthy host", () => {
    assert.deepStrictEqual(evaluate({ sensors: [temperature(45), fan("fan1", 900)] }), []);
  });

  it("warns, then escalates, as memory and disks fill", () => {
    const alerts = evaluate({
      memory: { totalBytes: 100, usedBytes: 98 },
      disks: [
        {
          mountPoint: "/",
          filesystem: "/dev/sda1",
          totalBytes: 100,
          usedBytes: 88,
          availableBytes: 12,
          usedPercent: 88,
        },
      ],
    });
    assert.deepStrictEqual(
      alerts.map((alert) => [alert.kind, alert.severity, alert.subject, alert.value]),
      [
        ["memory", "critical", "", 98],
        ["disk", "warning", "/", 88],
      ],
    );
  });

  it("uses a sensor's own thresholds when its driver gives them", () => {
    assert.deepStrictEqual(evaluate({ sensors: [temperature(72, { high: 70, crit: 85 })] })[0], {
      id: "temp:hwmon0:temp1",
      severity: "warning",
      kind: "temperature",
      subject: "k10temp Tctl",
      value: 72,
      threshold: 70,
    });
    assert.strictEqual(
      evaluate({ sensors: [temperature(86, { high: 70, crit: 85 })] })[0]?.severity,
      "critical",
    );
  });

  it("flags a stopped pump at once, but an idle header only after it was seen spinning", () => {
    assert.deepStrictEqual(
      evaluate({ sensors: [fan("Pump", 0), fan("fan4", 0)] }).map((alert) => [
        alert.subject,
        alert.severity,
      ]),
      [["nct6799 Pump", "critical"]],
    );
    assert.deepStrictEqual(
      evaluate({
        sensors: [fan("fan4", 0)],
        previouslySpinningFans: new Set(["hwmon1:fan4"]),
      }).map((alert) => alert.severity),
      ["warning"],
    );
  });
});

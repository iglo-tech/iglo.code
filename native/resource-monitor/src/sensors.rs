//! `iglo-code-resource-monitor sensors`: one JSON line of hardware sensors, then exit.
//!
//! The server runs this once per host health sample on macOS, where no unprivileged file
//! interface like Linux's hwmon exists. Running it as its own process keeps the IOKit calls out
//! of the server: a misbehaving driver can only take this process down. It only reads.

use serde::Serialize;
use std::io::{self, Write};
use sysinfo::Components;

#[derive(Serialize)]
struct Temperature {
    label: String,
    celsius: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    critical: Option<f32>,
}

#[derive(Serialize)]
struct Fan {
    index: u8,
    rpm: f32,
}

#[derive(Serialize)]
struct Sensors {
    temperatures: Vec<Temperature>,
    fans: Vec<Fan>,
}

pub fn run() -> io::Result<()> {
    let mut temperatures: Vec<Temperature> = Components::new_with_refreshed_list()
        .iter()
        .filter_map(|component| {
            let celsius = component.temperature()?;
            // Sensors that are off report 0 or garbage; nothing real sits outside this range.
            (celsius.is_finite() && celsius > 0.0 && celsius < 150.0).then(|| Temperature {
                label: component.label().to_string(),
                celsius,
                // `max()` is only the highest this process saw, never a limit, so it is left out.
                critical: component
                    .critical()
                    .filter(|value| value.is_finite() && *value > 0.0),
            })
        })
        .collect();
    // IOKit lists services in no stable order.
    temperatures.sort_by(|left, right| left.label.cmp(&right.label));
    let sensors = Sensors {
        temperatures,
        fans: fans(),
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &sensors)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

#[cfg(target_os = "macos")]
fn fans() -> Vec<Fan> {
    smc::fans().unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn fans() -> Vec<Fan> {
    Vec::new()
}

/// Reads fan speeds from the System Management Controller through its IOKit user client, the
/// same unprivileged read-only path Activity Monitor style tools use.
#[cfg(target_os = "macos")]
mod smc {
    use super::Fan;
    use std::ffi::{c_char, c_void};

    const KERNEL_INDEX_SMC: u32 = 2;
    const CMD_READ_BYTES: u8 = 5;
    const CMD_READ_KEYINFO: u8 = 9;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Version {
        major: u8,
        minor: u8,
        build: u8,
        reserved: u8,
        release: u16,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct PowerLimits {
        version: u16,
        length: u16,
        cpu: u32,
        gpu: u32,
        mem: u32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct KeyInfo {
        data_size: u32,
        data_type: u32,
        data_attributes: u8,
    }

    /// `SMCKeyData_t` from Apple's AppleSMC user client: 80 bytes with C layout.
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct KeyData {
        key: u32,
        version: Version,
        power_limits: PowerLimits,
        key_info: KeyInfo,
        result: u8,
        status: u8,
        data8: u8,
        data32: u32,
        bytes: [u8; 32],
    }

    const _: () = assert!(std::mem::size_of::<KeyData>() == 80);

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IOServiceOpen(service: u32, owning_task: u32, kind: u32, connect: *mut u32) -> i32;
        fn IOServiceClose(connect: u32) -> i32;
        fn IOObjectRelease(object: u32) -> i32;
        fn IOConnectCallStructMethod(
            connection: u32,
            selector: u32,
            input: *const c_void,
            input_size: usize,
            output: *mut c_void,
            output_size: *mut usize,
        ) -> i32;
    }

    unsafe extern "C" {
        static mach_task_self_: u32;
    }

    const fn four_cc(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }

    struct Connection(u32);

    impl Drop for Connection {
        fn drop(&mut self) {
            // SAFETY: the connection came from a successful IOServiceOpen and is closed once.
            unsafe { IOServiceClose(self.0) };
        }
    }

    impl Connection {
        fn open() -> Option<Self> {
            // SAFETY: plain IOKit calls with a NUL-terminated class name; the matching
            // dictionary is consumed by IOServiceGetMatchingService.
            unsafe {
                let matching = IOServiceMatching(c"AppleSMC".as_ptr());
                if matching.is_null() {
                    return None;
                }
                let service = IOServiceGetMatchingService(0, matching);
                if service == 0 {
                    return None;
                }
                let mut connection = 0;
                let opened = IOServiceOpen(service, mach_task_self_, 0, &mut connection);
                IOObjectRelease(service);
                (opened == 0).then_some(Self(connection))
            }
        }

        fn call(&self, input: &KeyData) -> Option<KeyData> {
            let mut output = KeyData::default();
            let mut output_size = std::mem::size_of::<KeyData>();
            // SAFETY: both buffers are `KeyData` values of the size passed alongside them.
            let status = unsafe {
                IOConnectCallStructMethod(
                    self.0,
                    KERNEL_INDEX_SMC,
                    (input as *const KeyData).cast(),
                    std::mem::size_of::<KeyData>(),
                    (&mut output as *mut KeyData).cast(),
                    &mut output_size,
                )
            };
            (status == 0 && output.result == 0).then_some(output)
        }

        /// The key's type and raw bytes, or None when this machine has no such key.
        fn read(&self, key: [u8; 4]) -> Option<(u32, Vec<u8>)> {
            let key = four_cc(&key);
            let info = self.call(&KeyData {
                key,
                data8: CMD_READ_KEYINFO,
                ..KeyData::default()
            })?;
            let size = info.key_info.data_size.min(32);
            let value = self.call(&KeyData {
                key,
                key_info: info.key_info,
                data8: CMD_READ_BYTES,
                ..KeyData::default()
            })?;
            Some((
                info.key_info.data_type,
                value.bytes[..size as usize].to_vec(),
            ))
        }
    }

    /// Intel Macs report fan speed as unsigned 14.2 fixed point; Apple silicon as a float.
    fn decode(data_type: u32, bytes: &[u8]) -> Option<f32> {
        match (data_type, bytes) {
            (t, [a, b, c, d, ..]) if t == four_cc(b"flt ") => {
                Some(f32::from_le_bytes([*a, *b, *c, *d]))
            }
            (t, [a, b, ..]) if t == four_cc(b"fpe2") => {
                Some(u16::from_be_bytes([*a, *b]) as f32 / 4.0)
            }
            (t, [a, ..]) if t == four_cc(b"ui8 ") => Some(*a as f32),
            _ => None,
        }
    }

    pub fn fans() -> Option<Vec<Fan>> {
        let connection = Connection::open()?;
        let (data_type, bytes) = connection.read(*b"FNum")?;
        let count = decode(data_type, &bytes)? as u8;
        Some(
            (0..count.min(10))
                .filter_map(|index| {
                    let key = [b'F', b'0' + index, b'A', b'c'];
                    let (data_type, bytes) = connection.read(key)?;
                    let rpm = decode(data_type, &bytes)?;
                    (rpm.is_finite() && rpm >= 0.0).then_some(Fan { index, rpm })
                })
                .collect(),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn decodes_each_fan_speed_encoding() {
            assert_eq!(
                decode(four_cc(b"flt "), &1210.5f32.to_le_bytes()),
                Some(1210.5)
            );
            assert_eq!(decode(four_cc(b"fpe2"), &[0x12, 0xC0]), Some(1200.0));
            assert_eq!(decode(four_cc(b"ui8 "), &[2]), Some(2.0));
            assert_eq!(decode(four_cc(b"sp78"), &[0, 0]), None);
        }
    }
}

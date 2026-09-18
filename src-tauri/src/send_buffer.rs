//! Windows' default TCP send buffer, which caps every rclone connection.
//!
//! Windows grows a socket's send buffer on its own only for blocking sockets.
//! Go - and so rclone - sends with overlapped (non-blocking) I/O and never
//! sets `SO_SNDBUF`, so each of its connections keeps the system default: the
//! AFD `DefaultSendWindow`, 64 KiB out of the box. A connection cannot have
//! more than that in flight per round trip, so it tops out at roughly 64 KiB
//! divided by the round-trip time - about 25 Mbps on a 20 ms path - however
//! fast the link. Ten files in parallel get ten buffers and fly; one file
//! crawls. (curl hit the same wall and has grown `SO_SNDBUF` itself since
//! 7.61.1; Go does not, and rclone has no flag for it.)
//!
//! The default is a registry value that takes effect after a restart. The
//! preflight panel reports the live value, and can set the registry value
//! behind an elevation prompt.

use serde::Serialize;

// The registry side only exists on Windows; elsewhere these back the tests.
/// Registry key holding the AFD defaults.
#[cfg_attr(not(windows), allow(dead_code))]
pub const REGISTRY_KEY: &str = r"HKLM\SYSTEM\CurrentControlSet\Services\AFD\Parameters";
#[cfg_attr(not(windows), allow(dead_code))]
pub const VALUE_NAME: &str = "DefaultSendWindow";

/// 2 MiB in flight is 100 MB/s on a 20 ms path - 800 Mbps - so the link is
/// the limit again. AFD requires a multiple of 4096.
pub const RECOMMENDED_BYTES: u32 = 2 * 1024 * 1024;

/// Below this a single connection is still noticeably capped on a fast link.
pub const ADEQUATE_BYTES: u32 = 1024 * 1024;

/// What the system currently hands out, and what the registry says it will
/// hand out after a restart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBufferState {
    /// `SO_SNDBUF` of a fresh socket: what rclone's connections get right now.
    pub live_bytes: u32,
    /// The registry value, when one is set.
    pub registry_bytes: Option<u32>,
}

impl SendBufferState {
    pub fn live_is_adequate(&self) -> bool {
        self.live_bytes >= ADEQUATE_BYTES
    }

    /// The registry has been raised but the running system has not picked it
    /// up yet - Windows reads it at boot.
    pub fn restart_pending(&self) -> bool {
        !self.live_is_adequate() && self.registry_bytes.is_some_and(|b| b >= ADEQUATE_BYTES)
    }
}

pub fn describe_bytes(bytes: u32) -> String {
    if bytes.is_multiple_of(1024 * 1024) {
        format!("{} MiB", bytes / (1024 * 1024))
    } else if bytes.is_multiple_of(1024) {
        format!("{} KiB", bytes / 1024)
    } else {
        format!("{bytes} bytes")
    }
}

/// `SO_SNDBUF` of a socket that has never had it set: exactly what every
/// rclone connection starts with.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn live_send_buffer_bytes() -> Result<u32, String> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("Could not open a socket to read its send buffer: {e}"))?;
    let bytes = socket
        .send_buffer_size()
        .map_err(|e| format!("Could not read the socket send buffer size: {e}"))?;
    u32::try_from(bytes).map_err(|_| format!("Unexpected send buffer size {bytes}"))
}

/// Parses `reg query` output for a REG_DWORD value, which `reg.exe` prints
/// in hex: `    DefaultSendWindow    REG_DWORD    0x200000`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_reg_query_dword(output: &str, value_name: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let name = parts.next()?;
        if !name.eq_ignore_ascii_case(value_name) {
            return None;
        }
        let kind = parts.next()?;
        if !kind.eq_ignore_ascii_case("REG_DWORD") {
            return None;
        }
        let raw = parts.next()?;
        let hex = raw
            .strip_prefix("0x")
            .or_else(|| raw.strip_prefix("0X"))
            .unwrap_or(raw);
        u32::from_str_radix(hex, 16)
            .ok()
            .or_else(|| raw.parse::<u32>().ok())
    })
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// Keeps the helper console windows from flashing.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn registry_bytes() -> Result<Option<u32>, String> {
        let output = Command::new("reg.exe")
            .args(["query", REGISTRY_KEY, "/v", VALUE_NAME])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Could not run reg.exe: {e}"))?;
        // A missing value is reported as a failure by reg.exe; it is simply
        // "not set" here.
        if !output.status.success() {
            return Ok(None);
        }
        Ok(parse_reg_query_dword(
            &String::from_utf8_lossy(&output.stdout),
            VALUE_NAME,
        ))
    }

    /// Writes the registry value through an elevation prompt. Returns the
    /// value now in the registry, so the caller can tell a declined prompt
    /// from a successful write.
    pub fn raise_registry_value() -> Result<Option<u32>, String> {
        // `reg add` needs administrator rights on HKLM; `Start-Process -Verb
        // RunAs` is the supported way to ask for them from an unelevated
        // process. `-Wait` keeps this call synchronous with the prompt.
        let script = format!(
            "Start-Process -FilePath reg.exe -ArgumentList @('add','{REGISTRY_KEY}','/v','{VALUE_NAME}','/t','REG_DWORD','/d','{RECOMMENDED_BYTES}','/f') -Verb RunAs -Wait -WindowStyle Hidden"
        );
        let status = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Could not run PowerShell: {e}"))?;
        if !status.success() {
            return Err(
                "The change was not applied - the administrator prompt was declined or failed."
                    .to_string(),
            );
        }
        registry_bytes()
    }
}

/// The current state, on Windows. Other systems grow send buffers on their
/// own and never need this.
#[cfg(windows)]
pub fn inspect() -> Result<SendBufferState, String> {
    Ok(SendBufferState {
        live_bytes: live_send_buffer_bytes()?,
        registry_bytes: windows::registry_bytes()?,
    })
}

/// Sets the registry default to `RECOMMENDED_BYTES` behind an elevation
/// prompt and reports the resulting state. It takes effect after a restart.
#[cfg(windows)]
pub fn raise() -> Result<SendBufferState, String> {
    let registry_bytes = windows::raise_registry_value()?;
    Ok(SendBufferState {
        live_bytes: live_send_buffer_bytes()?,
        registry_bytes,
    })
}

#[cfg(not(windows))]
pub fn raise() -> Result<SendBufferState, String> {
    Err("Only Windows caps the send buffer of programs that never set it.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_hex_dword_reg_query_prints() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\AFD\\Parameters\r\n    DefaultSendWindow    REG_DWORD    0x200000\r\n\r\n";
        assert_eq!(
            parse_reg_query_dword(output, "DefaultSendWindow"),
            Some(2 * 1024 * 1024)
        );
        assert_eq!(parse_reg_query_dword(output, "DefaultReceiveWindow"), None);
        assert_eq!(
            parse_reg_query_dword(
                "ERROR: The system was unable to find the specified registry key or value.",
                "DefaultSendWindow"
            ),
            None
        );
    }

    #[test]
    fn a_raised_registry_value_is_pending_until_restart() {
        let state = SendBufferState {
            live_bytes: 64 * 1024,
            registry_bytes: Some(RECOMMENDED_BYTES),
        };
        assert!(!state.live_is_adequate());
        assert!(state.restart_pending());

        let applied = SendBufferState {
            live_bytes: RECOMMENDED_BYTES,
            registry_bytes: Some(RECOMMENDED_BYTES),
        };
        assert!(applied.live_is_adequate());
        assert!(!applied.restart_pending());

        let untouched = SendBufferState {
            live_bytes: 64 * 1024,
            registry_bytes: None,
        };
        assert!(!untouched.restart_pending());
    }

    #[test]
    fn the_live_default_can_be_read_on_this_system() {
        // Every platform hands a fresh socket some send buffer; the value is
        // what matters on Windows, the call must work everywhere.
        assert!(live_send_buffer_bytes().unwrap() > 0);
    }

    #[test]
    fn sizes_read_naturally() {
        assert_eq!(describe_bytes(64 * 1024), "64 KiB");
        assert_eq!(describe_bytes(RECOMMENDED_BYTES), "2 MiB");
        assert_eq!(describe_bytes(1000), "1000 bytes");
    }
}

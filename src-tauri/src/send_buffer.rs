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

// Both sides talk to Windows directly. They used to run `reg.exe` and a
// hidden PowerShell `Start-Process -Verb RunAs`, a pattern antivirus
// heuristics flag as malware.
#[cfg(windows)]
mod windows {
    use super::*;

    pub fn registry_bytes() -> Result<Option<u32>, String> {
        use std::io::ErrorKind;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;

        let subkey = REGISTRY_KEY.trim_start_matches(r"HKLM\");
        let key = match RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(subkey, KEY_READ)
        {
            Ok(key) => key,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Could not open {REGISTRY_KEY}: {e}")),
        };
        match key.get_value::<u32, _>(VALUE_NAME) {
            Ok(bytes) => Ok(Some(bytes)),
            // Absent until someone sets it; Windows then uses 64 KiB.
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Could not read {VALUE_NAME}: {e}")),
        }
    }

    /// Writes the registry value through an elevation prompt. Returns the
    /// value now in the registry, so the caller can tell a declined prompt
    /// from a successful write.
    pub fn raise_registry_value() -> Result<Option<u32>, String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, WaitForSingleObject, INFINITE,
        };
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        // `reg add` needs administrator rights on HKLM. The "runas" verb is
        // how an unelevated process asks for them: Windows shows the UAC
        // prompt and fails the call if it is declined.
        let verb = wide("runas");
        let file = wide("reg.exe");
        let parameters = wide(&format!(
            r#"add "{REGISTRY_KEY}" /v {VALUE_NAME} /t REG_DWORD /d {RECOMMENDED_BYTES} /f"#
        ));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: verb.as_ptr(),
            lpFile: file.as_ptr(),
            lpParameters: parameters.as_ptr(),
            nShow: SW_HIDE,
            ..Default::default()
        };
        let not_applied =
            "The change was not applied - the administrator prompt was declined or failed.";
        // SAFETY: every pointer in `info` borrows a NUL-terminated buffer
        // that outlives the call.
        if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
            return Err(not_applied.to_string());
        }
        let mut exit_code = 1u32;
        // SAFETY: `hProcess` is a live handle owned here until CloseHandle.
        unsafe {
            WaitForSingleObject(info.hProcess, INFINITE);
            GetExitCodeProcess(info.hProcess, &mut exit_code);
            CloseHandle(info.hProcess);
        }
        if exit_code != 0 {
            return Err(not_applied.to_string());
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

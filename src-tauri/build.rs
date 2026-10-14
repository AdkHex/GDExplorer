fn main() {
    check_remote_status_config();
    tauri_build::build()
}

/// `remote-status.json` is compiled into the app (`service.rs`). A typo in it
/// would otherwise switch the remote switch and the access password off in a
/// release without anyone noticing, so a malformed file fails the build here.
fn check_remote_status_config() {
    println!("cargo:rerun-if-changed=remote-status.json");
    let text = std::fs::read_to_string("remote-status.json")
        .expect("src-tauri/remote-status.json is missing (see docs/REMOTE-STATUS.md)");
    let value: serde_json::Value =
        serde_json::from_str(&text).expect("src-tauri/remote-status.json is not valid JSON");
    let url = value
        .get("url")
        .and_then(|u| u.as_str())
        .expect("src-tauri/remote-status.json needs a \"url\" string (\"\" turns the switch off)");
    let url = url.trim();
    assert!(
        url.is_empty() || url.starts_with("https://"),
        "src-tauri/remote-status.json: the status URL must use https://"
    );
    if let Some(require) = value.get("requireAccess") {
        assert!(
            require.is_boolean(),
            "src-tauri/remote-status.json: \"requireAccess\" must be true or false"
        );
    }
}

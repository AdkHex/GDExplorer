//! Menu bar / system tray presence, so a long upload can run with the window
//! closed and still say how far along it is.
//!
//! macOS notes: the icon is a template image (black and clear only), which is
//! what lets the system tint it for light and dark menu bars, and clicking it
//! opens a menu rather than a popover - both straight out of the HIG guidance
//! for menu bar extras. The user can turn the whole thing off in Preferences.

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager,
};

pub const TRAY_ID: &str = "main-tray";

/// Black-and-clear glyph, sized for a 24pt menu bar.
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-template.png");

/// Brings the main window back from a hide (tray click, Dock click, menu item).
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Builds the tray icon and its menu. Called on startup, and again if the user
/// turns the icon back on.
pub fn create(app: &AppHandle) -> Result<TrayIcon, String> {
    let show = MenuItemBuilder::with_id("tray-show", "Show GDrive-Upload")
        .build(app)
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;
    let preferences = MenuItemBuilder::with_id("tray-preferences", "Preferences…")
        .build(app)
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit GDrive-Upload")
        .build(app)
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &preferences])
        .separator()
        .items(&[&quit])
        .build()
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;

    let icon =
        Image::from_bytes(TRAY_ICON_PNG).map_err(|e| format!("Failed to read tray icon: {e}"))?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("GDrive-Upload")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-preferences" => {
                show_main_window(app);
                if let Err(e) = app.emit("menu-preferences", ()) {
                    log::error!("Failed to emit menu-preferences from tray: {e}");
                }
            }
            "tray-quit" => app.exit(0),
            other => log::debug!("Unhandled tray menu event: {other}"),
        });

    // The menu is the click behaviour on macOS, per the HIG. Elsewhere a left
    // click is expected to bring the window back, with the menu on right click.
    #[cfg(target_os = "macos")]
    let builder = builder.show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    builder
        .build(app)
        .map_err(|e| format!("Failed to create the tray icon: {e}"))
}

/// Creates or removes the tray icon to match the preference.
pub fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let existing = app.tray_by_id(TRAY_ID);

    match (visible, existing) {
        (true, None) => {
            create(app)?;
            Ok(())
        }
        (false, Some(_)) => {
            app.remove_tray_by_id(TRAY_ID);
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Reflects upload progress in the menu bar.
///
/// `title` is the short text beside the icon - macOS only, and kept to a few
/// characters because it competes with every other menu bar extra for space.
/// The tooltip carries the longer version for platforms that show one.
pub fn set_status(app: &AppHandle, title: Option<String>, tooltip: Option<String>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    if let Err(e) = tray.set_title(title) {
        log::debug!("Failed to set the tray title: {e}");
    }
    if let Err(e) = tray.set_tooltip(tooltip) {
        log::debug!("Failed to set the tray tooltip: {e}");
    }
}

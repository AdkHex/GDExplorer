//! Checks the whole upload path before the first byte moves.
//!
//! Every one of these used to be discovered the hard way: rclone missing, the
//! remote never configured, an empty service account folder, or a destination
//! the accounts can read but not write to - each surfacing as a failed row
//! part-way through a transfer.

use crate::upload::rclone::{self, RclonePreferences, WriteCheck};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    /// Usable, but something is worth knowing about.
    Warn,
    Fail,
    /// Not run, because an earlier check makes the answer meaningless.
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
}

impl PreflightCheck {
    fn new(id: &str, label: &str, status: CheckStatus, detail: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            status,
            detail: detail.into(),
        }
    }
}

/// Runs every check, in dependency order. Checks that cannot answer anything
/// useful are reported as skipped rather than silently dropped, so the panel
/// always shows the same list.
pub async fn run(
    prefs: &RclonePreferences,
    service_account_folder: Option<String>,
    destination_folder_id: Option<String>,
) -> Vec<PreflightCheck> {
    let mut checks = Vec::new();

    let rclone_ok = match check_rclone(prefs).await {
        Ok(check) => {
            let ok = matches!(check.status, CheckStatus::Ok);
            checks.push(check);
            ok
        }
        Err(check) => {
            checks.push(check);
            false
        }
    };

    checks.push(if rclone_ok {
        check_remote(prefs).await
    } else {
        PreflightCheck::new(
            "remote",
            "rclone remote",
            CheckStatus::Skipped,
            "Skipped because rclone could not be run.",
        )
    });

    let folder = service_account_folder.unwrap_or_default();
    let folder = folder.trim().to_string();
    checks.push(check_service_accounts(&folder));

    let destination = destination_folder_id.unwrap_or_default();
    let destination = destination.trim().to_string();
    let can_reach_drive = rclone_ok && !folder.is_empty() && !destination.is_empty();

    if !can_reach_drive {
        let reason = if destination.is_empty() {
            "Skipped because no destination folder is set."
        } else {
            "Skipped because rclone or the service accounts are not ready."
        };
        checks.push(PreflightCheck::new(
            "destination",
            "Destination folder",
            CheckStatus::Skipped,
            reason,
        ));
        checks.push(PreflightCheck::new(
            "writable",
            "Destination is writable",
            CheckStatus::Skipped,
            reason,
        ));
        return checks;
    }

    let reachable = rclone::verify_destination(prefs, &folder, &destination).await;
    match reachable {
        Ok(()) => {
            checks.push(PreflightCheck::new(
                "destination",
                "Destination folder",
                CheckStatus::Ok,
                format!("Folder {destination} is reachable."),
            ));
            checks.push(check_writable(prefs, &folder, &destination).await);
        }
        Err(error) => {
            checks.push(PreflightCheck::new(
                "destination",
                "Destination folder",
                CheckStatus::Fail,
                error,
            ));
            checks.push(PreflightCheck::new(
                "writable",
                "Destination is writable",
                CheckStatus::Skipped,
                "Skipped because the folder could not be reached.",
            ));
        }
    }

    checks
}

async fn check_rclone(prefs: &RclonePreferences) -> Result<PreflightCheck, PreflightCheck> {
    let args = vec!["version".to_string()];
    let output = rclone::run_rclone_to_completion(prefs, &args, Duration::from_secs(20)).await;

    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let version = stdout.lines().next().unwrap_or("rclone").trim().to_string();
            Ok(PreflightCheck::new(
                "rclone",
                "rclone is installed",
                CheckStatus::Ok,
                format!("{version} ({})", prefs.rclone_path),
            ))
        }
        Ok(output) => {
            let detail = rclone::describe_command_failure(&output);
            Err(PreflightCheck::new(
                "rclone",
                "rclone is installed",
                CheckStatus::Fail,
                if detail.is_empty() {
                    format!("\"{}\" did not run successfully.", prefs.rclone_path)
                } else {
                    detail
                },
            ))
        }
        Err(error) => Err(PreflightCheck::new(
            "rclone",
            "rclone is installed",
            CheckStatus::Fail,
            format!(
                "{}. Install rclone from Preferences, or set the path to an existing binary.",
                error.trim_end_matches(['.', ' '])
            ),
        )),
    }
}

async fn check_remote(prefs: &RclonePreferences) -> PreflightCheck {
    let args = vec!["listremotes".to_string()];
    let output = rclone::run_rclone_to_completion(prefs, &args, Duration::from_secs(20)).await;

    let label = "rclone remote";
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let wanted = format!("{}:", prefs.remote_name);
            let names: Vec<String> = stdout
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect();

            if names.iter().any(|name| name == &wanted) {
                PreflightCheck::new(
                    "remote",
                    label,
                    CheckStatus::Ok,
                    format!("\"{wanted}\" is configured."),
                )
            } else if names.is_empty() {
                PreflightCheck::new(
                    "remote",
                    label,
                    CheckStatus::Fail,
                    format!("No remotes are configured. Create \"{wanted}\" from Preferences."),
                )
            } else {
                PreflightCheck::new(
                    "remote",
                    label,
                    CheckStatus::Fail,
                    format!(
                        "\"{wanted}\" is not configured. Available: {}.",
                        names.join(", ")
                    ),
                )
            }
        }
        Ok(output) => {
            let detail = rclone::describe_command_failure(&output);
            PreflightCheck::new(
                "remote",
                label,
                CheckStatus::Fail,
                if detail.is_empty() {
                    "Could not list rclone remotes.".to_string()
                } else {
                    detail
                },
            )
        }
        Err(error) => PreflightCheck::new("remote", label, CheckStatus::Fail, error),
    }
}

fn check_service_accounts(folder: &str) -> PreflightCheck {
    let label = "Service accounts";
    if folder.is_empty() {
        return PreflightCheck::new(
            "service-accounts",
            label,
            CheckStatus::Fail,
            "No service account folder is set. Choose one in Preferences.",
        );
    }

    match rclone::inspect_service_account_files(folder) {
        Ok(summary) if summary.valid == 0 => PreflightCheck::new(
            "service-accounts",
            label,
            CheckStatus::Fail,
            if summary.invalid.is_empty() {
                "No service account JSON files in the selected folder.".to_string()
            } else {
                format!(
                    "None of the {} JSON file(s) there are valid service accounts.",
                    summary.invalid.len()
                )
            },
        ),
        Ok(summary) if !summary.invalid.is_empty() => PreflightCheck::new(
            "service-accounts",
            label,
            CheckStatus::Warn,
            format!(
                "{} usable. Ignoring {}: {}.",
                summary.valid,
                summary.invalid.len(),
                summary.invalid.join(", ")
            ),
        ),
        Ok(summary) => PreflightCheck::new(
            "service-accounts",
            label,
            CheckStatus::Ok,
            format!(
                "{} service account{} ready.",
                summary.valid,
                if summary.valid == 1 { "" } else { "s" }
            ),
        ),
        Err(error) => PreflightCheck::new("service-accounts", label, CheckStatus::Fail, error),
    }
}

async fn check_writable(
    prefs: &RclonePreferences,
    service_account_folder: &str,
    destination_folder_id: &str,
) -> PreflightCheck {
    let label = "Destination is writable";
    match rclone::check_destination_writable(prefs, service_account_folder, destination_folder_id)
        .await
    {
        Ok(WriteCheck::Writable) => PreflightCheck::new(
            "writable",
            label,
            CheckStatus::Ok,
            "A test folder was created and removed.",
        ),
        Ok(WriteCheck::WritableWithLeftover { folder }) => PreflightCheck::new(
            "writable",
            label,
            CheckStatus::Warn,
            format!("Uploads are allowed, but the test folder \"{folder}\" could not be removed."),
        ),
        Err(error) => PreflightCheck::new("writable", label, CheckStatus::Fail, error),
    }
}

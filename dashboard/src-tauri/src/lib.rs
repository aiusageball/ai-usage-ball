use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the spawned Python backend so it can be killed when the app exits.
struct BackendProcess(Mutex<Option<Child>>);

/// Launch the desktop app for a given provider orb (double-click on a widget).
/// Whitelisted to the three known apps so the frontend can't ask us to `open`
/// arbitrary applications.
#[tauri::command]
fn open_provider_app(provider: String) -> Result<(), String> {
    let app = match provider.as_str() {
        "claude" => "Claude",
        "codex" => "Codex",
        "antigravity" => "Antigravity",
        other => return Err(format!("unknown provider: {other}")),
    };
    Command::new("open")
        .arg("-a")
        .arg(app)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open {app}: {e}"))
}

/// Read a value from the macOS Keychain (service "AIUsageBall"). Used to store
/// the trial start date and license key somewhere harder to wipe than a config
/// file (so deleting app data doesn't simply reset the free trial). Returns None
/// if the item doesn't exist.
#[tauri::command]
fn secure_get(key: String) -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "AIUsageBall", "-a", &key, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Write a value to the macOS Keychain (service "AIUsageBall"), updating if it
/// already exists (-U).
#[tauri::command]
fn secure_set(key: String, value: String) -> Result<(), String> {
    let status = Command::new("security")
        .args(["add-generic-password", "-U", "-s", "AIUsageBall", "-a", &key, "-w", &value])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("keychain write failed".into()) }
}

/// Start the FastAPI backend that the frontend connects to on 127.0.0.1:8000.
///
/// Paths default to this repo's layout (resolved relative to the crate, not a
/// hard-coded home directory) and can be overridden with AIPULSE_PYTHON /
/// AIPULSE_SERVER. Note: a distributable bundle would need the Python runtime
/// packaged as a sidecar — this auto-start covers `tauri dev` and a machine
/// where the server's venv already exists.
fn spawn_backend() -> Option<Child> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR"); // .../dashboard/src-tauri

    // Prefer the self-contained backend under ~/Library/Application Support — the
    // repo lives in an iCloud-synced ~/Documents, and launching a venv Python
    // from there hangs in Python's startup (the iCloud file provider blocks the
    // open() of the venv path files for a GUI-spawned process). App Support is
    // not iCloud-synced, so the interpreter starts cleanly.
    let home = std::env::var("HOME").unwrap_or_default();
    let app_support = format!("{home}/Library/Application Support/AIPulse");
    let repo_python = format!("{manifest_dir}/../../server/venv/bin/python");
    let repo_server = format!("{manifest_dir}/../../server/server.py");

    let pick = |override_var: &str, app_support_path: String, repo_path: String| {
        std::env::var(override_var).unwrap_or_else(|_| {
            if Path::new(&app_support_path).exists() { app_support_path } else { repo_path }
        })
    };
    let python = pick("AIPULSE_PYTHON", format!("{app_support}/venv/bin/python"), repo_python);
    let server = pick("AIPULSE_SERVER", format!("{app_support}/server.py"), repo_server);

    if !Path::new(&python).exists() || !Path::new(&server).exists() {
        eprintln!(
            "AI Pulse backend not found (python={python}, server={server}); \
             skipping auto-start — start the server manually."
        );
        return None;
    }

    // Discard the child's stdout/stderr — an inherited, unread pipe can fill up
    // and stall the server before it finishes binding the port.
    match Command::new(&python)
        .arg(&server)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            println!("Started AI Pulse backend (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("Failed to start AI Pulse backend: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(BackendProcess(Mutex::new(spawn_backend())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_provider_app, secure_get, secure_set])
        .on_window_event(|window, event| {
            // Closing the main window only HIDES it (so a desktop widget can
            // bring it back via show()), rather than destroying it. The app
            // keeps running; use Cmd+Q to actually quit.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Tear down the backend we spawned so it doesn't outlive the app.
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    if let Some(child) = state.0.lock().unwrap().as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

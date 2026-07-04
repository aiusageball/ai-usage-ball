use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the spawned Python backend so it can be killed when the app exits.
struct BackendProcess(Mutex<Option<Child>>);

/// Kill the backend and ALL its descendants. The bundled backend is a
/// PyInstaller one-file binary: a bootloader process that spawns the real
/// server as a child. Killing just our direct child (the bootloader) orphans
/// the server, which keeps port 8000 bound forever — the next app launch then
/// can't start its own backend and shows stale data. We spawn the backend in
/// its own process group (pgid = its pid) so one group-kill takes out the
/// whole tree.
fn kill_backend(state: &BackendProcess) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.as_mut() {
            let pid = child.id();
            // Negative pid = kill the entire process group.
            let _ = Command::new("kill")
                .args(["-9", &format!("-{pid}")])
                .status();
            let _ = child.kill(); // fallback + reaps the direct child
            let _ = child.wait();
        }
        *guard = None;
    }
}

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
/// Order of preference:
///  1. The self-contained sidecar bundled as an app **resource**
///     (Contents/Resources/aipulse-server/aipulse-server) — this is what ships
///     to end users. It's a PyInstaller **onedir** build, not onefile: the
///     whole Python backend is frozen into a folder that's already unpacked
///     at build time. A onefile build has to re-extract itself (~50MB) to a
///     fresh temp dir on EVERY launch — measured ~10-13s per launch, every
///     single time. onedir needs no extraction: measured ~2s standalone.
///  2. A venv + server.py under ~/Library/Application Support (dev machines
///     that set this up), overridable via AIPULSE_PYTHON / AIPULSE_SERVER.
///  3. The repo's server/venv (running from a source checkout).
fn spawn_backend(app: &tauri::App) -> Option<Child> {
    // Sweep up any backend left over from a previous run (crash, or an older
    // version that didn't group-kill). A stale instance keeps port 8000 bound,
    // which would silently prevent this launch's backend from starting and
    // leave the orbs frozen on old data.
    let _ = Command::new("pkill")
        .args(["-f", "aipulse-server/aipulse-server"])
        .status();

    let quiet = |mut cmd: Command| {
        // Discard stdout/stderr — an inherited, unread pipe can fill up and
        // stall the server before it finishes binding the port.
        // process_group(0): run the backend in its own process group (pgid =
        // child pid) so kill_backend can take out the whole tree with one
        // group-kill (the server may itself spawn helper subprocesses).
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
    };

    // 1) Bundled sidecar resource: Contents/Resources/aipulse-server/aipulse-server.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let sidecar = resource_dir.join("backend").join("aipulse-server");
        if sidecar.exists() {
            match quiet(Command::new(&sidecar)) {
                Ok(child) => {
                    println!("Started bundled AI Usage Ball backend (pid {})", child.id());
                    return Some(child);
                }
                Err(e) => eprintln!("Failed to start bundled backend: {e}"),
            }
        }
    }

    // 2 & 3) Fall back to a Python venv + server.py (development machines).
    let manifest_dir = env!("CARGO_MANIFEST_DIR"); // .../dashboard/src-tauri
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
            "AI Usage Ball backend not found (no bundled sidecar, python={python}, \
             server={server}); skipping auto-start."
        );
        return None;
    }

    let mut cmd = Command::new(&python);
    cmd.arg(&server);
    match quiet(cmd) {
        Ok(child) => {
            println!("Started AI Usage Ball backend from venv (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("Failed to start AI Usage Ball backend: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let backend = spawn_backend(app);
            app.manage(BackendProcess(Mutex::new(backend)));
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
            // Tear down the backend (whole process group) so it doesn't outlive
            // the app. Handle BOTH exit events: in practice quitting via the
            // Apple quit event only reliably delivers RunEvent::Exit here, and
            // relying on ExitRequested alone left zombie backends holding
            // port 8000.
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<BackendProcess>() {
                        kill_backend(&state);
                    }
                }
                _ => {}
            }
        });
}

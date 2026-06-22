#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct ApiProcess(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let api_process = start_local_api();
            app.manage(ApiProcess(Mutex::new(api_process)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<ApiProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(api) = child.take() {
                            kill_process_tree(api);
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run ChenkoAI desktop app");
}

fn start_local_api() -> Option<Child> {
    let project_root = project_root();
    let workspace_root = project_root.to_string_lossy().to_string();
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new(windows_npx_command());
        command.args(["tsx", "apps/api/src/server.ts"]);
        command.creation_flags(0x08000000);
        command
    } else {
        let mut command = Command::new("sh");
        command.args(["-c", "npx tsx apps/api/src/server.ts"]);
        command
    };

    command
        .current_dir(project_root)
        .env("DATA_STORE", "memory")
        .env("EMBEDDING_PROVIDER", "mock")
        .env("MODEL_PROVIDER", "mock")
        .env("AGENT_RUN_STORE", "memory")
        .env("PROMPT_REGISTRY_STORE", "memory")
        .env("TOOL_PERMISSION_STORE", "memory")
        .env("CHENKOAI_WORKSPACE_ROOT", workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    for (key, value) in read_local_env_file() {
        command.env(key, value);
    }

    command.spawn().ok()
}

#[cfg(target_os = "windows")]
fn windows_npx_command() -> String {
    let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| {
        "C:\\Program Files".to_string()
    });
    let npx_path = PathBuf::from(program_files).join("nodejs").join("npx.cmd");

    if npx_path.exists() {
        return npx_path.to_string_lossy().to_string();
    }

    "npx.cmd".to_string()
}

fn kill_process_tree(mut child: Child) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }

    let _ = child.wait();
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .expect("src-tauri must live under apps/desktop")
        .to_path_buf()
}

fn read_local_env_file() -> HashMap<String, String> {
    let path = project_root().join(".env.chenkoai.local");
    let Ok(file) = fs::File::open(path) else {
        return HashMap::new();
    };

    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| parse_env_line(&line))
        .collect()
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let (key, value) = trimmed.split_once('=')?;
    Some((key.trim().to_string(), value.trim().to_string()))
}

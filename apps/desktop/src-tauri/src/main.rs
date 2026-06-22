use std::{
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
                        if let Some(mut api) = child.take() {
                            let _ = api.kill();
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
        let mut command = Command::new("npx.cmd");
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
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .expect("src-tauri must live under apps/desktop")
        .to_path_buf()
}

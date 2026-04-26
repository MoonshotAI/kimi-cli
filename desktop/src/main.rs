#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::RngCore;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Shared state exposed to the frontend via Tauri commands.
struct BackendInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn backend_url(state: State<'_, BackendInfo>) -> String {
    format!("http://127.0.0.1:{}", state.port)
}

#[tauri::command]
fn auth_token(state: State<'_, BackendInfo>) -> String {
    state.token.clone()
}

fn pick_ephemeral_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// Poll /healthz until a 2xx comes back or we time out.
fn wait_for_healthy(port: u16, timeout: Duration) -> bool {
    let url = format!("http://127.0.0.1:{}/healthz", port);
    let deadline = Instant::now() + timeout;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();
    while Instant::now() < deadline {
        match agent.get(&url).call() {
            Ok(resp) if (200..300).contains(&resp.status()) => return true,
            _ => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    false
}

fn main() {
    let backend_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let backend_child_for_exit = backend_child.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // 1. Reserve an ephemeral port (tiny race, standard practice).
            // 2. Generate a bearer token.
            // 3. Spawn `kimi web` as a tokio async child with stdout/stderr
            //    forwarded to stderr for debuggability.
            // 4. Health-poll /healthz; on failure show an error dialog.
            // 5. Store the { port, token } so Tauri commands can return them.
            let port = pick_ephemeral_port().map_err(|e| -> Box<dyn std::error::Error> {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("failed to pick ephemeral port: {e}"),
                ))
            })?;
            let token = generate_token();

            let handle = app.handle().clone();
            let child_slot = backend_child.clone();
            let token_for_state = token.clone();

            tauri::async_runtime::block_on(async move {
                let mut cmd = Command::new("kimi");
                cmd.arg("web")
                    .arg("--port").arg(port.to_string())
                    .arg("--host").arg("127.0.0.1")
                    .arg("--no-open")
                    .arg("--auth-token").arg(&token)
                    .arg("--lan-only")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);

                let mut child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[kimi-desktop] failed to spawn `kimi web`: {e}");
                        handle.dialog()
                            .message(format!(
                                "Failed to start the Kimi backend: {e}\n\nIs the `kimi` CLI installed and on PATH?"
                            ))
                            .kind(MessageDialogKind::Error)
                            .title("Kimi")
                            .blocking_show();
                        return;
                    }
                };

                if let Some(stdout) = child.stdout.take() {
                    tauri::async_runtime::spawn(async move {
                        let mut lines = BufReader::new(stdout).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            eprintln!("[kimi web] {line}");
                        }
                    });
                }
                if let Some(stderr) = child.stderr.take() {
                    tauri::async_runtime::spawn(async move {
                        let mut lines = BufReader::new(stderr).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            eprintln!("[kimi web] {line}");
                        }
                    });
                }

                *child_slot.lock().await = Some(child);
            });

            // Block the main thread (pre-window) on health check; cheap and simple.
            let healthy = wait_for_healthy(port, Duration::from_secs(30));
            if !healthy {
                eprintln!("[kimi-desktop] backend did not become healthy within 30s on port {port}");
                app.dialog()
                    .message(format!(
                        "The Kimi backend failed to start on port {port} within 30 seconds. Check the logs for details."
                    ))
                    .kind(MessageDialogKind::Error)
                    .title("Kimi")
                    .blocking_show();
            }

            app.manage(BackendInfo { port, token: token_for_state });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_url, auth_token])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(move |_app, event| match event {
            // Kill the backend so we don't leak a detached `kimi web`.
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                let slot = backend_child_for_exit.clone();
                tauri::async_runtime::block_on(async move {
                    if let Some(mut child) = slot.lock().await.take() {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                });
            }
            _ => {}
        });
}

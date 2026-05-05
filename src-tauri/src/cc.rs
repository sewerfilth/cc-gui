/*
 * cc-gui — Tauri commands that shell out to the cutecontainer CLI.
 *
 * The CLI binary path resolves in this order:
 *   1. CC_CLI env var (absolute path)
 *   2. sibling of the running executable (Tauri sidecar, prod bundles)
 *   3. ../../cutecontainer/build/cutecontainer-cli (playground dev layout)
 *   4. plain `cutecontainer-cli` on PATH
 */

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::io::Write;

#[derive(Serialize)]
pub struct CcResult {
    pub action: String,
    pub input: String,
    pub output: String,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

fn cli_path() -> PathBuf {
    if let Ok(p) = std::env::var("CC_CLI") {
        return PathBuf::from(p);
    }

    if let Ok(exe) = std::env::current_exe() {
        // Production: Tauri places sidecars next to the main executable
        // (e.g. <bundle>.app/Contents/MacOS/cutecontainer-cli).
        if let Some(parent) = exe.parent() {
            let sidecar = parent.join("cutecontainer-cli");
            if sidecar.exists() && sidecar != exe {
                return sidecar;
            }
        }

        // Dev: walk up looking for the playground sibling layout.
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            let candidate = d.join("cutecontainer/build/cutecontainer-cli");
            if candidate.exists() {
                return candidate;
            }
            let sibling = d.join("../cutecontainer/build/cutecontainer-cli");
            if sibling.exists() {
                return sibling;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

    PathBuf::from("cutecontainer-cli")
}

fn predicted_output(action: &str, input: &str) -> String {
    match action {
        "compress" | "lock" => format!("{}.cute", input),
        "decompress" | "unlock" => {
            if let Some(stripped) = input.strip_suffix(".cute") {
                stripped.to_string()
            } else {
                format!("{}.out", input)
            }
        }
        _ => String::new(),
    }
}

fn run_cli(action: &str, args: &[&str], input: &str, password: Option<&str>) -> CcResult {
    let cli = cli_path();
    let mut cmd = Command::new(&cli);
    cmd.args(args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return CcResult {
                action: action.to_string(),
                input: input.to_string(),
                output: String::new(),
                stdout: String::new(),
                stderr: format!("failed to launch {:?}: {}", cli, e),
                success: false,
            };
        }
    };

    if let Some(pw) = password {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "{}", pw);
        }
    }

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            return CcResult {
                action: action.to_string(),
                input: input.to_string(),
                output: String::new(),
                stdout: String::new(),
                stderr: format!("wait failed: {}", e),
                success: false,
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();
    let predicted = predicted_output(action, input);
    let resolved_output = if success && std::path::Path::new(&predicted).exists() {
        predicted
    } else {
        String::new()
    };

    CcResult {
        action: action.to_string(),
        input: input.to_string(),
        output: resolved_output,
        stdout,
        stderr,
        success,
    }
}

fn auto_action_for(path: &str) -> &'static str {
    if path.to_lowercase().ends_with(".cute") {
        "decompress"
    } else {
        "compress"
    }
}

#[tauri::command]
pub fn cc_auto(path: String) -> CcResult {
    let action = auto_action_for(&path);
    run_cli(action, &[action, &path], &path, None)
}

#[tauri::command]
pub fn cc_compress(path: String) -> CcResult {
    run_cli("compress", &["compress", &path], &path, None)
}

#[tauri::command]
pub fn cc_decompress(path: String) -> CcResult {
    run_cli("decompress", &["decompress", &path], &path, None)
}

#[tauri::command]
pub fn cc_lock(path: String, password: String) -> CcResult {
    run_cli("lock", &["lock", "-p", &password, &path], &path, None)
}

#[tauri::command]
pub fn cc_unlock(path: String, password: String) -> CcResult {
    run_cli("unlock", &["unlock", "-p", &password, &path], &path, None)
}

#[tauri::command]
pub fn cc_info(path: String) -> CcResult {
    run_cli("info", &["info", &path], &path, None)
}

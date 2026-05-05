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
        "decompress" => {
            if let Some(stripped) = input.strip_suffix(".cute") {
                stripped.to_string()
            } else {
                format!("{}.out", input)
            }
        }
        "unlock" => {
            // matches CLI: strip .cute, else append .unlocked
            if let Some(stripped) = input.strip_suffix(".cute") {
                stripped.to_string()
            } else {
                format!("{}.unlocked", input)
            }
        }
        _ => String::new(),
    }
}

#[derive(Serialize)]
pub struct OutputCheck {
    pub predicted: String,
    pub exists: bool,
}

/// Returns the predicted output path for an action+input and whether it
/// already exists. The frontend uses this to gate overwrites before invoking
/// the CLI, which silently truncates any pre-existing output file.
#[tauri::command]
pub fn cc_check_output(action: String, input: String) -> OutputCheck {
    let predicted = predicted_output(&action, &input);
    let exists = !predicted.is_empty() && std::path::Path::new(&predicted).exists();
    OutputCheck { predicted, exists }
}

/// Returns whether an arbitrary path exists. Used for archive output paths
/// that the user types or picks freely.
#[tauri::command]
pub fn cc_path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Reveal a file or folder in macOS Finder.
#[tauri::command]
pub fn cc_reveal(path: String) -> Result<(), String> {
    Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("reveal failed: {}", e))
}

/// Open a URL in the user's default browser. Uses macOS `open`.
#[tauri::command]
pub fn cc_open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open failed: {}", e))
}

/// Open a file or folder with the macOS default handler.
#[tauri::command]
pub fn cc_open(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open failed: {}", e))
}

/// Move files / folders to the macOS Trash. Reversible — user can restore
/// from Finder. Returns the first error path if any item fails.
#[tauri::command]
pub fn cc_trash(paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        trash::delete(p).map_err(|e| format!("{}: {}", p, e))?;
    }
    Ok(())
}

/// Permanently remove files / folders. Recursive on directories. Not
/// reversible — frontend must confirm beforehand.
#[tauri::command]
pub fn cc_delete(paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        let path = std::path::Path::new(p);
        let r = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        r.map_err(|e| format!("{}: {}", p, e))?;
    }
    Ok(())
}

fn run_cli(action: &str, args: &[&str], input: &str, password: Option<&str>, explicit_output: Option<&str>) -> CcResult {
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
    let resolved_output = if success {
        let candidate = explicit_output
            .map(|s| s.to_string())
            .unwrap_or_else(|| predicted_output(action, input));
        if !candidate.is_empty() && std::path::Path::new(&candidate).exists() {
            candidate
        } else {
            String::new()
        }
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
    run_cli(action, &[action, &path], &path, None, None)
}

#[tauri::command]
pub fn cc_compress(path: String, level: Option<u32>) -> CcResult {
    let level_arg = level.filter(|l| (1..=9).contains(l)).map(|l| l.to_string());
    let mut args: Vec<&str> = vec!["compress"];
    if let Some(ref l) = level_arg {
        args.push("-l");
        args.push(l);
    }
    args.push(&path);
    run_cli("compress", &args, &path, None, None)
}

#[tauri::command]
pub fn cc_decompress(path: String) -> CcResult {
    run_cli("decompress", &["decompress", &path], &path, None, None)
}

#[tauri::command]
pub fn cc_lock(path: String, password: String) -> CcResult {
    run_cli("lock", &["lock", "-p", &password, &path], &path, None, None)
}

#[tauri::command]
pub fn cc_unlock(path: String, password: String) -> CcResult {
    run_cli("unlock", &["unlock", "-p", &password, &path], &path, None, None)
}

#[tauri::command]
pub fn cc_info(path: String) -> CcResult {
    run_cli("info", &["info", &path], &path, None, None)
}

/// Multi-file archive via depo's ARCV trailer. The CLI doesn't expose
/// `archive` yet — until it does, this will fail with the CLI's own error
/// (the GUI surfaces stderr). Lock-mode flags (--fuses / --valid-epochs /
/// --delay) are passed through; the CLI is expected to reject ones it
/// doesn't recognize.
#[tauri::command]
pub fn cc_archive(
    paths: Vec<String>,
    output: String,
    password: Option<String>,
    lock_mode: Option<String>,
    lock_value: Option<u32>,
) -> CcResult {
    let mut args: Vec<String> = vec!["archive".to_string()];
    if let Some(pw) = password.as_ref().filter(|p| !p.is_empty()) {
        args.push("-p".to_string());
        args.push(pw.clone());
    }
    let lock_flag = match lock_mode.as_deref() {
        Some("fused") => Some("--fuses"),
        Some("timed") => Some("--valid-epochs"),
        Some("delayed") => Some("--delay"),
        _ => None,
    };
    if let (Some(flag), Some(n)) = (lock_flag, lock_value) {
        args.push(flag.to_string());
        args.push(n.to_string());
    }
    args.extend(paths.iter().cloned());
    args.push("-o".to_string());
    args.push(output.clone());

    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let display_input = paths.first().cloned().unwrap_or_default();
    run_cli("archive", &args_ref, &display_input, None, Some(&output))
}

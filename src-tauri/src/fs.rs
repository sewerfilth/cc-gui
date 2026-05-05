/*
 * cc-gui — filesystem queries for the file-manager UI.
 *
 * All paths are absolute. Listings skip dotfiles by default; the frontend
 * can pass `show_hidden = true` to include them. Errors propagate as
 * String so the UI can display them inline.
 */

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix epoch seconds. 0 if unavailable.
    pub modified: u64,
    /// Lowercase extension without the dot, or empty.
    pub ext: String,
}

#[derive(Serialize)]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Serialize)]
pub struct Shortcut {
    pub name: String,
    pub path: String,
}

fn modified_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    std::env::var("HOME")
        .map_err(|_| "HOME not set".to_string())
}

#[tauri::command]
pub fn common_dirs() -> Vec<Shortcut> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let candidates: &[(&str, &str)] = &[
        ("Home", ""),
        ("Desktop", "Desktop"),
        ("Documents", "Documents"),
        ("Downloads", "Downloads"),
        ("Pictures", "Pictures"),
    ];
    candidates
        .iter()
        .filter_map(|(label, sub)| {
            let p = if sub.is_empty() {
                PathBuf::from(&home)
            } else {
                PathBuf::from(&home).join(sub)
            };
            if p.exists() {
                Some(Shortcut {
                    name: label.to_string(),
                    path: p.to_string_lossy().to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub fn list_dir(path: String, show_hidden: Option<bool>) -> Result<Listing, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let p = PathBuf::from(&path);
    let canon = fs::canonicalize(&p).unwrap_or(p.clone());

    let read = fs::read_dir(&canon).map_err(|e| format!("{}: {}", canon.display(), e))?;
    let mut entries: Vec<Entry> = Vec::new();
    for r in read {
        let ent = match r {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = ent.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        entries.push(Entry {
            name: name.clone(),
            path: ent.path().to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified: modified_secs(&meta),
            ext: if is_dir { String::new() } else { ext_of(&name) },
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(Listing {
        path: canon.to_string_lossy().to_string(),
        parent: canon.parent().map(|p| p.to_string_lossy().to_string()),
        entries,
    })
}

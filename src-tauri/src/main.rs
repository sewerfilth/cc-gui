#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cc;
mod fs;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            cc::cc_auto,
            cc::cc_compress,
            cc::cc_decompress,
            cc::cc_lock,
            cc::cc_unlock,
            cc::cc_info,
            fs::home_dir,
            fs::common_dirs,
            fs::list_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running cc-gui");
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cc;
mod fs;

use tauri::menu::Menu;

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
            cc::cc_archive,
            cc::cc_check_output,
            cc::cc_path_exists,
            fs::home_dir,
            fs::common_dirs,
            fs::list_dir,
        ])
        .setup(|app| {
            // macOS uses the global menu bar — without this Cmd-Q, services,
            // copy/paste, etc. are absent. Tauri's default menu fills the
            // standard items (App / Edit / View / Window / Help).
            let menu = Menu::default(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cc-gui");
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cc;
mod fs;

use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::Emitter;

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
            cc::cc_reveal,
            cc::cc_open_url,
            cc::cc_open,
            cc::cc_trash,
            cc::cc_delete,
            cc::cc_archive_detect,
            cc::cc_archive_list,
            cc::cc_archive_extract,
            cc::cc_info_json,
            cc::cc_fuse_refresh,
            fs::home_dir,
            fs::common_dirs,
            fs::list_dir,
        ])
        .setup(|app| {
            let h = app.handle();

            // Build a real macOS menu with cc-gui-specific items. Custom items
            // emit a "menu" event with their ID; the frontend listens and
            // dispatches to the existing handlers.
            let about_meta = AboutMetadataBuilder::new()
                .name(Some("cc-gui"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .website(Some("https://github.com/sewerfilth/cc-gui"))
                .build();

            let app_menu = SubmenuBuilder::new(h, "cc-gui")
                .item(&PredefinedMenuItem::about(h, Some("About cc-gui"), Some(about_meta))?)
                .separator()
                .item(&PredefinedMenuItem::services(h, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(h, None)?)
                .item(&PredefinedMenuItem::hide_others(h, None)?)
                .item(&PredefinedMenuItem::show_all(h, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(h, None)?)
                .build()?;

            let file_menu = SubmenuBuilder::new(h, "File")
                .item(&MenuItemBuilder::with_id("file.open", "Open Folder…")
                    .accelerator("CmdOrCtrl+O").build(h)?)
                .item(&MenuItemBuilder::with_id("file.reveal", "Reveal Selection in Finder")
                    .accelerator("CmdOrCtrl+Shift+R").build(h)?)
                .item(&MenuItemBuilder::with_id("file.inspect", "Inspect Selection")
                    .accelerator("CmdOrCtrl+I").build(h)?)
                .separator()
                .item(&MenuItemBuilder::with_id("file.archive", "New Archive from Selection…")
                    .accelerator("CmdOrCtrl+Shift+N").build(h)?)
                .separator()
                .item(&MenuItemBuilder::with_id("file.trash", "Move to Trash")
                    .accelerator("CmdOrCtrl+Backspace").build(h)?)
                .item(&MenuItemBuilder::with_id("file.delete", "Delete Permanently…")
                    .accelerator("CmdOrCtrl+Shift+Backspace").build(h)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(h, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(h, "Edit")
                .item(&PredefinedMenuItem::undo(h, None)?)
                .item(&PredefinedMenuItem::redo(h, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(h, None)?)
                .item(&PredefinedMenuItem::copy(h, None)?)
                .item(&PredefinedMenuItem::paste(h, None)?)
                .item(&PredefinedMenuItem::select_all(h, None)?)
                .build()?;

            let view_menu = SubmenuBuilder::new(h, "View")
                .item(&MenuItemBuilder::with_id("view.toggle_hidden", "Show Hidden Files")
                    .accelerator("CmdOrCtrl+Shift+.").build(h)?)
                .separator()
                .item(&MenuItemBuilder::with_id("view.sort_name", "Sort by Name").build(h)?)
                .item(&MenuItemBuilder::with_id("view.sort_size", "Sort by Size").build(h)?)
                .item(&MenuItemBuilder::with_id("view.sort_modified", "Sort by Modified").build(h)?)
                .separator()
                .item(&MenuItemBuilder::with_id("view.parent", "Parent Folder")
                    .accelerator("CmdOrCtrl+Up").build(h)?)
                .item(&MenuItemBuilder::with_id("view.reload", "Reload")
                    .accelerator("CmdOrCtrl+R").build(h)?)
                .build()?;

            let actions_menu = SubmenuBuilder::new(h, "Actions")
                .item(&MenuItemBuilder::with_id("action.auto", "Auto Process")
                    .accelerator("CmdOrCtrl+Return").build(h)?)
                .separator()
                .item(&MenuItemBuilder::with_id("action.compress", "Compress").build(h)?)
                .item(&MenuItemBuilder::with_id("action.decompress", "Decompress").build(h)?)
                .separator()
                .item(&MenuItemBuilder::with_id("action.lock", "Lock…").build(h)?)
                .item(&MenuItemBuilder::with_id("action.unlock", "Unlock…").build(h)?)
                .build()?;

            let window_menu = SubmenuBuilder::new(h, "Window")
                .item(&PredefinedMenuItem::minimize(h, None)?)
                .item(&PredefinedMenuItem::maximize(h, None)?)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(h, None)?)
                .build()?;

            let help_menu = SubmenuBuilder::new(h, "Help")
                .item(&MenuItemBuilder::with_id("help.repo", "View on GitHub…").build(h)?)
                .item(&MenuItemBuilder::with_id("help.releases", "Releases…").build(h)?)
                .build()?;

            let menu = MenuBuilder::new(h)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &actions_menu, &window_menu, &help_menu])
                .build()?;

            app.set_menu(menu)?;
            app.on_menu_event(move |app, event| {
                let _ = app.emit("menu", event.id().as_ref().to_string());
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building cc-gui")
        .run(|handle, event| {
            // macOS sends an "openURLs:" Apple Event when the user opens a
            // file with the .app from Finder (or via `open file.cute`).
            // Forward each path to the frontend so it can navigate / inspect.
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    if let Ok(p) = url.to_file_path() {
                        let _ = handle.emit("file-open", p.to_string_lossy().to_string());
                    }
                }
            }
        });
}

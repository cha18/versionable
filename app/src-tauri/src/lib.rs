use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use versionable_core::store::{self, Entry, commit};
mod watcher;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
fn projects_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("projects.json"))
}

fn load_projects(app: &AppHandle) -> Vec<String> {
    let config_dir = projects_file(&app).unwrap_or_default();
    let settings = match std::fs::read_to_string(config_dir) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    settings
}

fn save_projects(app: &AppHandle, projects: &[String]) -> Result<(), String> {
    let data = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    let path = projects_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Vec<String> {
    load_projects(&app)
}

#[tauri::command]
fn get_history(path: String) -> Vec<Entry> {
    store::load_history(Path::new(&path))
}

#[tauri::command]
fn add_project(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut projects = load_projects(&app);
    if projects.contains(&path) {
        Err("Project already exists".to_string())
    } else {
        projects.push(path.clone());
        watcher::watch_folder(&app, Path::new(&path));
        versionable_core::store::snapshot(Path::new(&path)).map_err(|e| e.to_string())?;
        save_projects(&app, &projects)?;
        Ok(projects)
    }
}

#[tauri::command]
fn remove_project(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut projects = load_projects(&app);
    if !projects.contains(&path) {
        Err("Project does not exist".to_string())
    } else {
        projects.remove(projects.iter().position(|x| x == &path).unwrap());
        save_projects(&app, &projects)?;
        Ok(projects)
    }
}

#[tauri::command]
fn make_commit(path: String, msg: String) -> Result<Entry, String> {
    let entry = commit(Path::new(&path), &msg).map_err(|e| e.to_string());
    entry
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            watcher::start(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            add_project,
            remove_project,
            get_history,
            make_commit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

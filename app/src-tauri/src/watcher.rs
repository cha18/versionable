use crate::load_projects;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub struct FolderWatcher(pub Mutex<RecommendedWatcher>);

pub fn start(app: &AppHandle) -> anyhow::Result<()> {
    let (tx, rx) = mpsc::channel::<PathBuf>();

    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })?;
    app.manage(FolderWatcher(Mutex::new(watcher))); // keep it alive + reachable from commands

    for project in load_projects(app) {
        watch_folder(app, Path::new(&project));
    }

    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let projects = load_projects(&app);
            let mut changed = HashSet::from([first]);
            while let Ok(p) = rx.recv_timeout(Duration::from_secs(1)) {
                changed.insert(p);
            }
            let changed_track = changed
                .iter()
                .filter(|c| projects.contains(&c.to_string_lossy().to_string()));
            for path in changed_track {
                match versionable_core::store::snapshot(path) {
                    Ok(Some(_)) => {
                        let _ = app.emit("history-changed", path.to_string_lossy().to_string());
                    }
                    Ok(None) => {} // unchanged save
                    Err(e) => eprintln!("snapshot failed: {e}"),
                }
            }
        }
    });
    Ok(())
}

pub fn watch_folder(app: &AppHandle, als: &Path) {
    let Some(folder_dir) = als.parent() else {
        return;
    };
    app.state::<FolderWatcher>()
        .0
        .lock()
        .unwrap()
        .watch(folder_dir, RecursiveMode::NonRecursive);
}

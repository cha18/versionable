use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Commit {
    pub msg: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Entry {
    pub hash: String,
    pub created_at: u64,
    pub commit: Option<Commit>,
}

fn vc_dir(als: &Path) -> anyhow::Result<PathBuf> {
    Ok(als.parent().context("file has no folder")?.join(".vc"))
}

fn history_file(als: &Path) -> anyhow::Result<PathBuf> {
    Ok(vc_dir(als)?
        .join(als.file_name().context("no name")?)
        .join("history.json"))
}

fn snapshots_dir(als: &Path) -> anyhow::Result<PathBuf> {
    Ok(vc_dir(als)?.join("snapshots"))
}

pub fn load_history(als: &Path) -> Vec<Entry> {
    let history_path = history_file(als).unwrap_or_default();

    match std::fs::read_to_string(history_path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn save_history(als: &Path, history: &[Entry]) -> anyhow::Result<()> {
    let path = history_file(als)?;
    let data = serde_json::to_string_pretty(history)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, data)?;
    Ok(())
}

pub fn snapshot_path(als: &Path, hash: &str) -> anyhow::Result<PathBuf> {
    let snapshots_dir = snapshots_dir(als)?;
    Ok(snapshots_dir.join(format!("{}.als", hash)))
}

pub fn restore(als: &Path, hash: &str) -> anyhow::Result<PathBuf> {
    let snapshot_path = snapshot_path(als, hash)?;
    let file_name = als
        .file_stem()
        .context("invalid file name")?
        .to_str()
        .context("non-utf8 characters found")?;
    if !snapshot_path.exists() {
        bail!("snapshot file does not exist")
    }
    let restore_path = als.with_file_name(format!("{} (restored {}).als", file_name, &hash[0..7]));
    if restore_path.exists() {
        bail!(
            "{} already exists, bailing to prevent overwrite",
            restore_path.display()
        )
    }
    std::fs::copy(snapshot_path, &restore_path)?;
    Ok(restore_path)
}

pub fn snapshot(als: &Path) -> anyhow::Result<Option<Entry>> {
    let snapshots_dir = snapshots_dir(als)?;
    let bytes = std::fs::read(als)?;
    let hash = hex::encode(Sha256::digest(&bytes));
    let mut history = load_history(als);
    if history.last().map_or(false, |e| e.hash == hash) {
        return Ok(None);
    };

    let file = snapshot_path(als, &hash)?;
    if !file.exists() {
        std::fs::create_dir_all(&snapshots_dir)?;
        std::fs::write(&file, &bytes)?;
    }

    let entry = Entry {
        hash: hash,
        created_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
        commit: None,
    };
    history.push(entry.clone());
    save_history(als, &history)?;
    Ok(Some(entry))
}

pub fn commit(als: &Path, msg: &str) -> anyhow::Result<Entry> {
    if msg.trim().is_empty() {
        return Err(anyhow!("Invalid commit message"));
    };
    let mut history = load_history(als);
    let entry = history
        .last_mut()
        .ok_or(anyhow!("Nothing to commit yet."))?;
    if entry.commit.is_some() {
        anyhow::bail!("Latest save is already committed. Make a change and save first");
    }
    entry.commit = Some(Commit {
        msg: msg.trim().to_string(),
    });
    let updated_entry = entry.clone();
    save_history(als, &history)?;
    Ok(updated_entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count_snapshots(als: &Path) -> usize {
        std::fs::read_dir(snapshots_dir(&als).unwrap())
            .unwrap()
            .filter_map(|f| f.ok())
            .count()
    }

    #[test]
    fn snapshot_dedups_by_content() {
        let dir = tempfile::tempdir().unwrap();
        let als = dir.path().join("Song.als");
        let v1 = "../fixtures/song1/01-original.als";
        let v2 = "../fixtures/song1/02-original-addeddrums.als";

        //initial save, check if snapshot returned, check if history length is 1
        std::fs::copy(v1, &als).unwrap();
        assert!(snapshot(&als).unwrap().is_some());
        assert_eq!(load_history(&als).len(), 1);

        //save again without changes, check if history is unchanged
        std::fs::copy(v1, &als).unwrap();
        assert!(snapshot(&als).unwrap().is_none());
        assert_eq!(load_history(&als).len(), 1);

        //save with changes and take snapshot, check if history length is 2 and 2 snapshot files exist
        std::fs::copy(v2, &als).unwrap();
        assert!(snapshot(&als).unwrap().is_some());
        assert_eq!(load_history(&als).len(), 2);
        assert_eq!(count_snapshots(&als), 2);

        //save back to original version and take snapshot, check if history length is 3 and STILL 2 snapshot files exist only
        std::fs::copy(v1, &als).unwrap();
        assert!(snapshot(&als).unwrap().is_some());
        assert_eq!(load_history(&als).len(), 3);
        assert_eq!(count_snapshots(&als), 2);
    }

    #[test]
    fn commit_with_no_saves_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let als = dir.path().join("Song.als");
        std::fs::copy("../fixtures/song1/01-original.als", &als).unwrap();

        assert!(commit(&als, "first").is_err());
        assert!(load_history(&als).is_empty());
    }

    #[test]
    fn post_commit_history_check() {
        let dir = tempfile::tempdir().unwrap();
        let als = dir.path().join("Song.als");
        std::fs::copy("../fixtures/song1/01-original.als", &als).unwrap();

        snapshot(&als).unwrap();
        assert!(commit(&als, &"     ".to_string()).is_err());

        commit(&als, "first").unwrap();
        assert_eq!(
            load_history(&als)
                .last()
                .unwrap()
                .commit
                .as_ref()
                .unwrap()
                .msg,
            "first".to_string()
        );

        assert!(commit(&als, &"next commit".to_string()).is_err());
    }

    #[test]
    fn restore_copies_original() {
        let dir = tempfile::tempdir().unwrap();
        let als = dir.path().join("Song.als");
        std::fs::copy("../fixtures/song1/01-original.als", &als).unwrap();

        let entry = snapshot(&als).unwrap();
        let hash = &entry.as_ref().unwrap().hash;
        let b = restore(&als, hash).unwrap();
        assert_eq!(
            b,
            dir.path()
                .join(format!("Song (restored {}).als", &hash[..7]))
        );
        assert_eq!(std::fs::read(&als).unwrap(), std::fs::read(b).unwrap());
        assert!(restore(&als, hash).is_err());
    }
}

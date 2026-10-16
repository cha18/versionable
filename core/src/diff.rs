use crate::{
    diff::Status::{Modified, Unchanged},
    model::*,
    parse::parse_als,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet, hash_set::Difference};
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Unchanged,
    Modified,
    Added,
    Removed,
}

#[derive(Serialize, Debug, Default)]
pub struct DiffSummary {
    pub tracks_added: u32,
    pub tracks_removed: u32,
    pub tracks_modified: u32,
    pub clips_added: u32,
    pub clips_removed: u32,
    pub clips_modified: u32,
    pub clips_unchanged: u32,
}

#[derive(Serialize, Debug)]
pub struct DiffClip {
    pub id: u32,
    pub status: Status,
    pub before: Option<Clip>,
    pub after: Option<Clip>,
    pub changed: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct DiffTrack {
    pub id: u32,
    pub name: String,
    pub kind: TrackKind,
    pub group_id: Option<u32>,
    pub status: Status,
    pub clips: Vec<DiffClip>,
}

#[derive(Serialize, Debug)]
pub struct Diff {
    pub summary: DiffSummary,
    pub tracks: Vec<DiffTrack>,
}

pub fn diff_clips(
    old: &HashMap<u32, Clip>,
    new: &HashMap<u32, Clip>,
    summary: &mut DiffSummary,
) -> Vec<DiffClip> {
    let mut diffclips = Vec::new();
    let old_clips = old.keys().collect::<HashSet<&u32>>();
    let new_clips = new.keys().collect::<HashSet<&u32>>();
    let shared = old_clips.intersection(&new_clips);
    for clip_id in shared {
        let a = &old[*clip_id];
        let b = &new[*clip_id];
        let checks = [
            ("start", a.start != b.start),
            ("end", a.end != b.end),
            ("name", a.name != b.name),
            ("color", a.color != b.color),
            ("loop_start", a.loop_start != b.loop_start),
            ("loop_end", a.loop_end != b.loop_end),
        ];
        let changed: Vec<String> = checks
            .into_iter()
            .filter(|(_, changed)| *changed)
            .map(|(name, _)| name.to_string())
            .collect();

        let status = if changed.is_empty() {
            summary.clips_unchanged += 1;
            Status::Unchanged
        } else {
            summary.clips_modified += 1;
            Status::Modified
        };

        diffclips.push(DiffClip {
            id: **clip_id,
            status: status,
            before: old.get(*clip_id).cloned(),
            after: new.get(*clip_id).cloned(),
            changed: changed,
        })
    }

    for clip_id in old_clips.difference(&new_clips) {
        diffclips.push(DiffClip {
            id: **clip_id,
            status: Status::Removed,
            before: old.get(*clip_id).cloned(),
            after: None,
            changed: vec![],
        });
        summary.clips_removed += 1;
    }

    for clip_id in new_clips.difference(&old_clips) {
        diffclips.push(DiffClip {
            id: **clip_id,
            status: Status::Added,
            before: None,
            after: new.get(*clip_id).cloned(),
            changed: vec![],
        });
        summary.clips_added += 1;
    }

    diffclips.sort_by(|x, y| {
        let xs = x.after.as_ref().or(x.before.as_ref()).unwrap().start;
        let ys = y.after.as_ref().or(y.before.as_ref()).unwrap().start;
        xs.total_cmp(&ys).then(x.id.cmp(&y.id))
    });
    diffclips
}

pub fn diff(old: &Project, new: &Project) -> Diff {
    let mut summary = DiffSummary::default();
    let mut tracks = Vec::new();
    let old_tracks = old
        .0
        .iter()
        .map(|t| (t.id, t))
        .collect::<HashMap<u32, &Track>>();
    let new_tracks = new.0.iter().map(|t| t.id).collect::<HashSet<u32>>();
    for t in &new.0 {
        let (status, clips) = match old_tracks.get(&t.id) {
            None => (
                Status::Added,
                diff_clips(&HashMap::new(), &t.clips, &mut summary),
            ),
            Some(prev) => {
                let clips = diff_clips(&prev.clips, &t.clips, &mut summary);
                let modified = t.name != prev.name
                    || t.group_id != prev.group_id
                    || clips.iter().any(|c| c.status != Status::Unchanged);
                (
                    if modified {
                        Status::Modified
                    } else {
                        Status::Unchanged
                    },
                    clips,
                )
            }
        };
        tracks.push(DiffTrack {
            id: t.id,
            name: t.name.clone(),
            kind: t.kind.clone(),
            group_id: t.group_id,
            status: status,
            clips: clips,
        });
    }
    for t in &old.0 {
        if new_tracks.contains(&t.id) {
            continue;
        }
        let clips = diff_clips(&t.clips, &HashMap::new(), &mut summary);
        tracks.push(DiffTrack {
            id: t.id,
            name: t.name.clone(),
            kind: t.kind.clone(),
            group_id: t.group_id,
            status: Status::Removed,
            clips: clips,
        });
    }

    for t in &tracks {
        match t.status {
            Status::Added => summary.tracks_added += 1,
            Status::Removed => summary.tracks_removed += 1,
            Status::Modified => summary.tracks_modified += 1,
            Status::Unchanged => {}
        }
    }
    Diff { summary, tracks }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diff_fixtures() {
        let p1 = parse_als(Path::new("../fixtures/demo/01-demo.als")).unwrap();
        let p2 = parse_als(Path::new("../fixtures/demo/01-demo.als")).unwrap();
        let p = diff(&p1, &p2);
        println!("{:#?}", p);
    }
}

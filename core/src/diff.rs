use crate::model::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

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

fn same_shape(a: &Clip, b: &Clip) -> bool {
    a.name == b.name
        && a.color == b.color
        && a.loop_start == b.loop_start
        && a.loop_end == b.loop_end
        && ((a.end - a.start) - (b.end - b.start)).abs() < 1e-6
}

fn get_changes(a: &Clip, b: &Clip) -> Vec<String> {
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

    changed
}

pub fn diff_clips(
    old: &HashMap<u32, Clip>,
    new: &HashMap<u32, Clip>,
    summary: &mut DiffSummary,
) -> Vec<DiffClip> {
    let mut diffclips = Vec::new();
    let old_clips = old.keys().collect::<HashSet<&u32>>();
    let new_clips = new.keys().collect::<HashSet<&u32>>();
    let shared: Vec<u32> = old_clips.intersection(&new_clips).map(|id| **id).collect();
    for clip_id in shared {
        let a = &old[&clip_id];
        let b = &new[&clip_id];

        let changed = get_changes(a, b);
        let status = if changed.is_empty() {
            summary.clips_unchanged += 1;
            Status::Unchanged
        } else {
            summary.clips_modified += 1;
            Status::Modified
        };

        diffclips.push(DiffClip {
            id: clip_id.clone(),
            status: status,
            before: old.get(&clip_id).cloned(),
            after: new.get(&clip_id).cloned(),
            changed: changed,
        })
    }

    // below, essentially we check whether the removed clips have shared metadata of another clip that was considered "added", if it does then it is not actually added or removed, it is just modified so we diffclip it as modified.
    // if it is not in added, it is definitely removed, so we diffclip it as that. then we look at the rest in added and those are definitely added because we removed all the broken cases where it is in both removed AND added beforehand.

    let mut added: Vec<u32> = new_clips.difference(&old_clips).map(|id| **id).collect();
    let mut removed: Vec<u32> = old_clips.difference(&new_clips).map(|id| **id).collect();
    added.sort();
    removed.sort();

    for rid in removed {
        let b = &old[&rid];
        match added.iter().position(|aid| same_shape(b, &new[aid])) {
            Some(ix) => {
                let aid = added.remove(ix);
                let a = &new[&aid];
                let changed = get_changes(b, a);
                if !changed.is_empty() {
                    summary.clips_modified += 1;
                    diffclips.push(DiffClip {
                        id: aid,
                        status: Status::Modified,
                        before: Some(b.clone()),
                        after: Some(a.clone()),
                        changed: changed,
                    })
                } else {
                    summary.clips_unchanged += 1;
                    diffclips.push(DiffClip {
                        id: aid,
                        status: Status::Unchanged,
                        before: Some(b.clone()),
                        after: Some(a.clone()),
                        changed: changed,
                    })
                }
            }
            None => {
                summary.clips_removed += 1;
                diffclips.push(DiffClip {
                    id: rid,
                    status: Status::Removed,
                    before: Some(b.clone()),
                    after: None,
                    changed: vec![],
                });
            }
        }
    }

    for aid in added {
        // whatever wasn't crossed off
        summary.clips_added += 1;
        diffclips.push(DiffClip {
            id: aid,
            status: Status::Added,
            before: None,
            after: Some(new[&aid].clone()),
            changed: vec![],
        });
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
    use crate::{
        diff::Status::{Modified, Removed, Unchanged},
        parse::*,
    };
    use std::path::Path;

    fn clip(start: f64, end: f64) -> Clip {
        Clip {
            start,
            end,
            loop_start: 0.0,
            loop_end: end - start,
            name: "Bass".to_string(),
            color: 5,
        }
    }

    #[test]
    fn diff_against_self() {
        let p1 = parse_als(Path::new("../fixtures/song1/01-original.als")).unwrap();
        let p2 = parse_als(Path::new("../fixtures/song1/01-original.als")).unwrap();
        let diff = diff(&p1, &p2);
        let diff_summary = diff.summary;
        assert_eq!(diff_summary.clips_added, 0);
        assert_eq!(diff_summary.clips_removed, 0);
        assert_eq!(diff_summary.clips_modified, 0);
        assert_eq!(diff_summary.clips_unchanged, 3);
        assert_eq!(diff_summary.tracks_added, 0);
        assert_eq!(diff_summary.tracks_removed, 0);
        assert_eq!(diff_summary.tracks_modified, 0);
    }

    #[test]
    fn renumbered_clip_is_unchanged() {
        let mut summary = DiffSummary::default();
        let result = diff_clips(
            &HashMap::from([(3, clip(0.0, 16.0))]),
            &HashMap::from([(7, clip(0.0, 16.0))]),
            &mut summary,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, Unchanged);
        assert!(result[0].changed.is_empty());
        assert_eq!(summary.clips_unchanged, 1);
        assert_eq!(summary.clips_added, 0);
        assert_eq!(summary.clips_modified, 0);
        assert_eq!(summary.clips_removed, 0);
    }

    #[test]
    fn renumbered_and_moved_clip_is_modified() {
        let mut summary = DiffSummary::default();
        let result = diff_clips(
            &HashMap::from([(3, clip(0.0, 16.0))]),
            &HashMap::from([(7, clip(32.0, 48.0))]),
            &mut summary,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, Modified);
        assert_eq!(result[0].changed, vec!["start", "end"]);
        assert_eq!(summary.clips_unchanged, 0);
        assert_eq!(summary.clips_added, 0);
        assert_eq!(summary.clips_modified, 1);
        assert_eq!(summary.clips_removed, 0);
    }

    #[test]
    fn renumbered_different_clip_is_not_matched() {
        let mut summary = DiffSummary::default();
        let result = diff_clips(
            &HashMap::from([(3, clip(0.0, 16.0))]),
            &HashMap::from([(
                7,
                Clip {
                    name: "Lead".into(),
                    ..clip(0.0, 16.0)
                },
            )]),
            &mut summary,
        );

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].status, Removed);
        assert!(result[0].changed.is_empty());
        assert_eq!(summary.clips_unchanged, 0);
        assert_eq!(summary.clips_added, 1);
        assert_eq!(summary.clips_modified, 0);
        assert_eq!(summary.clips_removed, 1);
    }
}

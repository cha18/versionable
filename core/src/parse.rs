use crate::model::*;
use anyhow;
use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::fs::File;
use std::io::prelude::*;
use std::path::Path;

fn value<'a>(node: roxmltree::Node<'a, '_>, path: &[&str]) -> Option<&'a str> {
    let mut curr_node = node;
    for tag in path {
        curr_node = curr_node.children().find(|n| n.has_tag_name(*tag))?;
    }
    curr_node.attribute("Value")
}

pub fn parse_xml(xml: &str) -> anyhow::Result<Project> {
    let mut tracks: Vec<Track> = Vec::new();
    let document = roxmltree::Document::parse(xml)?;
    let root = document
        .root_element()
        .children()
        .find(|n| n.has_tag_name("LiveSet"))
        .ok_or_else(|| anyhow::anyhow!("Failed to find <LiveSet>"))?
        .children()
        .find(|n| n.has_tag_name("Tracks"))
        .ok_or_else(|| anyhow::anyhow!("Failed to find <Tracks>"))?;
    for child in root.children().filter(|n| n.is_element()) {
        //groupid
        let group_raw: i64 = value(child, &["TrackGroupId"]).unwrap_or("-1").parse()?;
        let group_id: Option<u32> = if group_raw == -1 {
            None
        } else {
            Some(group_raw as u32)
        };

        //clips
        let mut clips = HashMap::new();
        for automation in child
            .descendants()
            .filter(|n| n.has_tag_name("ArrangerAutomation"))
        {
            let events = match automation.children().find(|n| n.has_tag_name("Events")) {
                Some(e) => e,
                None => continue,
            };

            for clip_el in events.children() {
                if !(clip_el.has_tag_name("MidiClip") || clip_el.has_tag_name("AudioClip")) {
                    continue;
                }
                let id = clip_el
                    .attribute("Id")
                    .ok_or_else(|| anyhow::anyhow!("Clip without Id"))?
                    .parse::<u32>()?;
                let start = value(clip_el, &["CurrentStart"])
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0.0);
                let end = value(clip_el, &["CurrentEnd"])
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0.0);
                let loop_start = value(clip_el, &["Loop", "LoopStart"])
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0.0);
                let loop_end = value(clip_el, &["Loop", "LoopEnd"])
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0.0);
                let name = value(clip_el, &["Name"]).unwrap_or("").to_string();
                let color = value(clip_el, &["Color"]).unwrap_or("0").parse::<u8>()?;
                clips.insert(
                    id,
                    Clip {
                        start: start,
                        end: end,
                        loop_start: loop_start,
                        loop_end: loop_end,
                        name: name,
                        color: color,
                    },
                );
            }
        }
        let track = Track {
            kind: match child.tag_name().name() {
                "MidiTrack" => TrackKind::Midi,
                "AudioTrack" => TrackKind::Audio,
                "ReturnTrack" => TrackKind::Return,
                "GroupTrack" => TrackKind::Group,
                _ => continue,
            },
            name: value(child, &["Name", "EffectiveName"])
                .unwrap_or("")
                .to_string(),
            id: child
                .attribute("Id")
                .ok_or_else(|| anyhow::anyhow!("No attribute called 'Id'"))?
                .parse::<u32>()?,
            group_id: group_id,
            clips: clips,
        };
        tracks.push(track);
    }
    Ok(Project(tracks))
}

pub fn parse_als(path: &Path) -> anyhow::Result<Project> {
    let file = File::open(path)?;
    let mut gz = GzDecoder::new(file);
    let mut file_string = String::new();
    gz.read_to_string(&mut file_string)?;
    parse_xml(&file_string)
}

#[cfg(test)]
mod tests {

    use crate::model::TrackKind::{Audio, Group, Midi, Return};

    use super::*;

    fn track(p: &Project, id: u32) -> &Track {
        p.0.iter().find(|t| t.id == id).expect("track not found")
    }

    #[test]
    fn parses_tracks_in_order() {
        let p = parse_als(Path::new("../fixtures/song1/01-original.als")).unwrap();

        assert_eq!(
            p.0.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec![
                "1-Basic Analog Bass",
                "2-Saw Complex Bass",
                "3-Audio",
                "4-Audio",
                "5-Badass Lead",
                "A-Reverb",
                "B-Delay"
            ]
        );
        //assert track kinds
        assert_eq!(
            p.0.iter().map(|t| &t.kind).collect::<Vec<_>>(),
            vec![&Midi, &Midi, &Audio, &Audio, &Midi, &Return, &Return]
        );
        //assert no groups in project
        assert_eq!(
            p.0.iter()
                .filter(|t| t.group_id.is_some())
                .collect::<Vec<_>>()
                .len(),
            0
        )
    }

    #[test]
    fn parses_clip_positions() {
        let p = parse_als(Path::new("../fixtures/song1/01-original.als")).unwrap();

        //assert track with id 12 has exactly one clip with the following features
        let bass_track = track(&p, 12);
        assert_eq!(bass_track.clips.len(), 1);
        let clip = &bass_track.clips[&9];
        assert_eq!(clip.name, "Basic Analog Bass");
        assert_eq!(clip.start, 0.0);
        assert_eq!(clip.end, 32.0);
        assert_eq!(clip.color, 24);

        //assert track with id 8 has no clips
        assert!(track(&p, 8).clips.is_empty());
        //assert two tracks can have the same clip id
        assert!(track(&p, 13).clips.contains_key(&1) && track(&p, 15).clips.contains_key(&1))
    }

    #[test]
    fn parses_group_membership() {
        let p = parse_als(Path::new("../fixtures/song1/04-original-recoloured.als")).unwrap();

        //assert track with id 19 is of type group
        assert!(matches!(track(&p, 19).kind, Group));

        //assert track with id 8 has a group id of None
        assert!(matches!(track(&p, 8).group_id, None));

        assert_eq!(track(&p, 12).group_id, Some(19));
        assert_eq!(track(&p, 13).group_id, Some(19));
    }
}

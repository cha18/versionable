use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Debug)]
pub struct Project(pub Vec<Track>);

#[derive(Serialize, Debug)]
pub struct Track {
    pub id: u32,
    pub name: String,
    pub kind: TrackKind,
    pub group_id: Option<u32>,
    pub clips: HashMap<u32, Clip>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Midi,
    Audio,
    Return,
    Group,
}

#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct Clip {
    pub start: f64,
    pub end: f64,
    pub loop_start: f64,
    pub loop_end: f64,
    pub name: String,
    pub color: u8,
}

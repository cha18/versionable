import gzip
import json
import os
import shutil
from datetime import datetime
from watchfiles import Change, watch
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, asdict
from typing import Optional

PROJECT_FOLDER = "./UntitledProject1 Project"
TRACK_TAGS = {"MidiTrack": "midi", "AudioTrack": "audio", "ReturnTrack": "return"}
CLIP_TAGS = {"MidiClip", "AudioClip"}

@dataclass
class ClipData:
    start: float
    end: float
    name: str
    color: int
    loop_start: float
    loop_end: float

@dataclass
class ClipDiff:
    id: str
    status: str  # "added" | "removed" | "modified" | "unchanged"
    current: Optional[dict] = None
    previous: Optional[dict] = None
    changes: dict = field(default_factory=dict)
 
@dataclass
class TrackDiff:
    id: str
    status: str
    name: str
    type: str
    clips: list = field(default_factory=list)


def get_xml(file):
    with gzip.open(file, 'rb') as f_in:
        with open(f"{os.path.splitext(file)[0]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xml", 'wb') as f_out:
            shutil.copyfileobj(f_in, f_out)

def _val(el, tag, default=None, cast=str):
    child = el.find(tag)
    if child is None or "Value" not in child.attrib:
        return default
    try:
        return cast(child.attrib["Value"])
    except (TypeError, ValueError):
        return default

def parse_clip(clip_el) -> ClipData:
    loop = clip_el.find("Loop")
    return ClipData(
        start=_val(clip_el, "CurrentStart", 0.0, float),
        end=_val(clip_el, "CurrentEnd", 0.0, float),
        name=_val(clip_el, "Name", "", str),
        color=_val(clip_el, "Color", -1, int),
        loop_start=_val(loop, "LoopStart", 0.0, float) if loop is not None else 0.0,
        loop_end=_val(loop, "LoopEnd", 0.0, float) if loop is not None else 0.0,
    )

def parse_tracks(xml):
    tree = ET.parse(xml)
    tracks = tree.find("LiveSet/Tracks")
    result = {}

    for track_el in tracks:
        track_tag = TRACK_TAGS.get(track_el.tag)
        if not track_tag: continue
        track_id = track_el.attrib["Id"]
        track_name = _val(track_el, "Name/EffectiveName", "", str)
        track_clips = {}
        for automation in track_el.iter("ArrangerAutomation"):
            events = automation.find("Events")
            if events is None: continue
            for clip_el in events:
                if clip_el.tag in CLIP_TAGS:
                    track_clips[clip_el.attrib["Id"]] = parse_clip(clip_el)

        result[track_id] = {"name": track_name, "type": track_tag, "clips": track_clips}
    return result

def _diff_clips(oldproj, newproj):
    oldtracks = [oldproj[i] for i in oldproj]
    newtracks = [newproj[j] for j in newproj]



def clip_dict(c):
    return asdict(c)

def create_diff(xml1, xml2, out="diff.json"):
    a, b = parse_tracks(xml1), parse_tracks(xml2)
    tracks = []
    stats = {k: 0 for k in ("tracksAdded", "tracksRemoved", "tracksModified", "clipsAdded", "clipsRemoved", "clipsModified", "clipsUnchanged")}

    for tid in sorted(a.keys() | b.keys(), key=int):
        ta, tb = a.get(tid), b.get(tid)
        if tb is None:
            stats["tracksRemoved"] += 1
            tracks.append({"id": tid, "status": "removed", "name": ta["name"], "type": ta["type"], "clips": []})
        elif ta is None:
            clips = [{"id": cid, "status": "added", "current": clip_dict(c), "previous": None, "changes": {}}
                     for cid, c in tb["clips"].items()]
            stats["tracksAdded"] += 1
            stats["clipsAdded"] += len(clips)
            tracks.append({"id": tid, "status": "added", "name": tb["name"], "type": tb["type"], "clips": clips})
        else:
            clips = []
            modified = False
            for cid in sorted(ta["clips"].keys() | tb["clips"].keys(), key=int):
                ca, cb = ta["clips"].get(cid), tb["clips"].get(cid)
                if cb is None:
                    stats["clipsRemoved"] += 1
                    modified = True
                    clips.append({"id": cid, "status": "removed", "current": None, "previous": clip_dict(ca), "changes": {}})
                elif ca is None:
                    stats["clipsAdded"] += 1
                    modified = True
                    clips.append({"id": cid, "status": "added", "current": clip_dict(cb), "previous": None, "changes": {}})
                else:
                    da, db = clip_dict(ca), clip_dict(cb)
                    changes = {k: {"from": da[k], "to": db[k]} for k in da if da[k] != db[k]}
                    if changes:
                        stats["clipsModified"] += 1
                        modified = True
                        clips.append({"id": cid, "status": "modified", "current": db, "previous": da, "changes": changes})
                    else:
                        stats["clipsUnchanged"] += 1
                        clips.append({"id": cid, "status": "unchanged", "current": db, "previous": None, "changes": {}})
            if modified:
                stats["tracksModified"] += 1
            tracks.append({"id": tid, "status": "modified" if modified else "unchanged",
                           "name": tb["name"], "type": tb["type"], "clips": clips})

    doc = {"meta": {"source": {"file": xml1}, "target": {"file": xml2}, "summary": stats}, "tracks": tracks}
    return doc

def main():
    # for changes in watch(PROJECT_FOLDER):
    #     for change_type, file_path in changes:
    #         if file_path.endswith('.als'):
    #             get_xml(file_path)
    print(create_diff("UntitledProject1 Project/UntitledProject1.xml_20260814_153644", "UntitledProject1 Project/UntitledProject1_20260816_164410.xml"))






if __name__ == "__main__":
    main()
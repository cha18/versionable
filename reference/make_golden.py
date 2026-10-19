"""Test oracle: generates expected diff JSON for the Rust golden tests.

Usage:  python3 reference/make_golden.py
Reads   fixtures/<song>/*.als   (sorted by filename = chronological order)
Writes  fixtures/<song>/expected/<a>__<b>.json   for each consecutive pair.

The diff rules here define the expected behaviour of the Rust diff engine.
"""
import gzip
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

TRACK_KINDS = {"MidiTrack": "midi", "AudioTrack": "audio", "ReturnTrack": "return", "GroupTrack": "group"}
CLIP_TAGS = {"MidiClip", "AudioClip"}
CLIP_FIELDS = ["start", "end", "name", "color", "loop_start", "loop_end"]


def val(el, path, default, cast):
    child = el.find(path) if el is not None else None
    if child is None or "Value" not in child.attrib:
        return default
    try:
        return cast(child.attrib["Value"])
    except ValueError:
        return default


def parse(als_path):
    with gzip.open(als_path, "rb") as f:
        root = ET.parse(f).getroot()
    tracks = []
    for el in root.find("LiveSet/Tracks"):
        kind = TRACK_KINDS.get(el.tag)
        if kind is None:
            continue
        group = val(el, "TrackGroupId", -1, int)
        clips = {}
        for auto in el.iter("ArrangerAutomation"):
            events = auto.find("Events")
            if events is None:
                continue
            for c in events:
                if c.tag not in CLIP_TAGS:
                    continue
                loop = c.find("Loop")
                clips[int(c.attrib["Id"])] = {
                    "start": val(c, "CurrentStart", 0.0, float),
                    "end": val(c, "CurrentEnd", 0.0, float),
                    "name": val(c, "Name", "", str),
                    "color": val(c, "Color", 0, int),
                    "loop_start": val(loop, "LoopStart", 0.0, float),
                    "loop_end": val(loop, "LoopEnd", 0.0, float),
                }
        tracks.append({
            "id": int(el.attrib["Id"]),
            "name": val(el, "Name/EffectiveName", "", str),
            "kind": kind,
            "group_id": None if group == -1 else group,
            "clips": clips,
        })
    return tracks


def same_shape(b, a):
    """Same clip content at a different position: Ableton gives dragged clips a new Id."""
    return (b["name"] == a["name"] and b["color"] == a["color"]
            and abs((b["end"] - b["start"]) - (a["end"] - a["start"])) < 1e-6  # float noise
            and b["loop_start"] == a["loop_start"] and b["loop_end"] == a["loop_end"])


def diff_clips(before, after, summary):
    out = []
    for cid in before.keys() & after.keys():
        b, a = before[cid], after[cid]
        changed = [f for f in CLIP_FIELDS if b[f] != a[f]]
        status = "modified" if changed else "unchanged"
        summary["clips_" + status] += 1
        out.append({"id": cid, "status": status, "before": b, "after": a, "changed": changed})

    # Move detection: pair each removed clip (ascending id) with the first unpaired
    # added clip (ascending id) of the same shape; report the pair as one modified clip
    # under the NEW id.
    removed = sorted(before.keys() - after.keys())
    added = sorted(after.keys() - before.keys())
    for rid in removed:
        b = before[rid]
        match = next((aid for aid in added if same_shape(b, after[aid])), None)
        if match is None:
            summary["clips_removed"] += 1
            out.append({"id": rid, "status": "removed", "before": b, "after": None, "changed": []})
        else:
            added.remove(match)
            a = after[match]
            summary["clips_modified"] += 1
            out.append({"id": match, "status": "modified", "before": b, "after": a,
                        "changed": [f for f in CLIP_FIELDS if b[f] != a[f]]})
    for aid in added:
        summary["clips_added"] += 1
        out.append({"id": aid, "status": "added", "before": None, "after": after[aid], "changed": []})
    # sort by start time (after if present, else before), then numeric id
    out.sort(key=lambda c: ((c["after"] or c["before"])["start"], int(c["id"])))
    return out


def diff(old, new):
    summary = {k: 0 for k in ("tracks_added", "tracks_removed", "tracks_modified",
                              "clips_added", "clips_removed", "clips_modified", "clips_unchanged")}
    old_by_id = {t["id"]: t for t in old}
    new_ids = {t["id"] for t in new}
    tracks = []

    # 1. every track in the NEW version, in document order
    for t in new:
        prev = old_by_id.get(t["id"])
        if prev is None:
            status = "added"
            clips = diff_clips({}, t["clips"], summary)
        else:
            clips = diff_clips(prev["clips"], t["clips"], summary)
            touched = (prev["name"] != t["name"] or prev["group_id"] != t["group_id"]
                       or any(c["status"] != "unchanged" for c in clips))
            status = "modified" if touched else "unchanged"
        tracks.append({"id": t["id"], "name": t["name"], "kind": t["kind"],
                       "group_id": t["group_id"], "status": status, "clips": clips})

    # 2. removed tracks appended at the end, in OLD document order
    for t in old:
        if t["id"] not in new_ids:
            status = "removed"
            clips = diff_clips(t["clips"], {}, summary)
            tracks.append({"id": t["id"], "name": t["name"], "kind": t["kind"],
                           "group_id": t["group_id"], "status": status, "clips": clips})

    for t in tracks:
        if t["status"] != "unchanged":
            summary["tracks_" + t["status"]] += 1
    return {"summary": summary, "tracks": tracks}


def main():
    root = Path(__file__).resolve().parent.parent / "fixtures"
    songs = [d for d in sorted(root.iterdir()) if d.is_dir()]
    if not songs:
        sys.exit("no fixtures: put versions in fixtures/<song>/01-*.als, 02-*.als, ...")
    for song in songs:
        versions = sorted(song.glob("*.als"))
        out_dir = song / "expected"
        out_dir.mkdir(exist_ok=True)
        for a, b in zip(versions, versions[1:]):
            doc = diff(parse(a), parse(b))
            out = out_dir / f"{a.stem}__{b.stem}.json"
            out.write_text(json.dumps(doc, indent=2))
            s = doc["summary"]
            print(f"{out.relative_to(root)}  tracks +{s['tracks_added']} ~{s['tracks_modified']} "
                  f"-{s['tracks_removed']}  clips +{s['clips_added']} ~{s['clips_modified']} -{s['clips_removed']}")


if __name__ == "__main__":
    main()

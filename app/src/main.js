const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

const listEl = document.querySelector("#project-list");
const errorEl = document.querySelector("#error");
const detailEl = document.querySelector("#detail");

let selectedPath = null;
const commitDrafts = new Map(); // project path → unsent commit message

// Compare mode: up to two picked history positions (indices into the history array).
// Indices rather than hashes, because the same content can be saved twice.
let picks = [];
let currentHistory = [];
// Snapshots are content-addressed, so a diff between two hashes never goes stale.
const diffCache = new Map();
let diffToken = 0; // ignores a slow diff that finishes after the user picked again

function fileName(path) {
  return path.split(/[\\/]/).pop().replace(/\.als$/i, "");
}

function baseName(path) {
  return path.split(/[\\/]/).pop();
}

// Display names and pane widths are UI preferences, so they live in localStorage.
// Storage can be unavailable or empty; everything falls back to defaults.
function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not fatal: the preference just won't survive a restart
  }
}

const customNames = loadPref("projectNames", {}); // project path → display name

function displayName(path) {
  return customNames[path] || fileName(path);
}

function setDisplayName(path, name) {
  const trimmed = name.trim();
  if (trimmed && trimmed !== fileName(path)) customNames[path] = trimmed;
  else delete customNames[path]; // empty or same as the file: back to the default
  savePref("projectNames", customNames);
  render(lastProjects);
  if (path === selectedPath) renderHistory();
}

// Swap a name element for a text box. Enter or clicking away saves; Escape cancels.
function startRename(nameEl, path) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = displayName(path);
  input.placeholder = fileName(path);
  input.maxLength = 80;

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    if (save) setDisplayName(path, input.value);
    else input.replaceWith(nameEl);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());

  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

// Every Rust command returns the full, current list, so the UI just re-renders it.
async function call(command, args) {
  try {
    showError("");
    return await invoke(command, args);
  } catch (e) {
    showError(String(e));
    return null;
  }
}

let lastProjects = [];

function render(projects) {
  if (projects === null) return;
  lastProjects = projects;
  listEl.innerHTML = "";

  if (projects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No projects yet";
    listEl.appendChild(empty);
  }

  for (const path of projects) {
    const item = document.createElement("li");
    item.className = "project" + (path === selectedPath ? " selected" : "");
    item.title = path;

    const label = document.createElement("div");
    label.className = "project-label";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = displayName(path);
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(name, path);
    });
    const dir = document.createElement("span");
    dir.className = "project-dir";
    dir.textContent = baseName(path);
    label.append(name, dir);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Stop tracking (history on disk is kept)";
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (path === selectedPath) select(null);
      render(await call("remove_project", { path }));
    });

    // Update the highlight in place rather than re-rendering, so the row under the
    // pointer survives and a double-click on the name still registers.
    item.addEventListener("click", () => {
      if (path === selectedPath) return;
      for (const other of listEl.children) other.classList.toggle("selected", other === item);
      select(path);
    });

    item.append(label, remove);
    listEl.appendChild(item);
  }
}

function select(path) {
  selectedPath = path;
  picks = [];
  renderHistory();
}

function formatTime(ms) {
  const date = new Date(ms);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

async function renderHistory() {
  detailEl.innerHTML = "";
  if (!selectedPath) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Select a project";
    detailEl.appendChild(p);
    return;
  }

  const path = selectedPath;
  const history = (await call("get_history", { path })) ?? [];
  if (path !== selectedPath) return; // user switched project while we were loading
  currentHistory = history;
  picks = picks.filter((i) => i < history.length);

  const header = document.createElement("header");
  header.className = "detail-header";
  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  const title = document.createElement("h2");
  title.textContent = displayName(path);
  title.className = "editable-title";
  title.title = "Click to rename";
  title.addEventListener("click", () => startRename(title, path));
  const count = document.createElement("span");
  count.className = "muted";
  const commits = history.filter((e) => e.commit).length;
  count.textContent =
    `${baseName(path)} · ${history.length} save${history.length === 1 ? "" : "s"} · ` +
    `${commits} commit${commits === 1 ? "" : "s"}`;
  titleRow.append(title, count);
  const notice = document.createElement("p");
  notice.id = "notice";
  notice.className = "notice";
  notice.hidden = true;
  header.append(titleRow, buildCommitForm(path, history), notice);

  const list = document.createElement("ol");
  list.className = "history";

  if (history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No saves recorded yet. Save the set in Ableton.";
    list.appendChild(empty);
  }

  // Newest first. The latest save is always shown (it's what a commit would label);
  // older autosaves between commits collapse into one expandable row.
  const newestFirst = [...history].reverse();
  let run = [];
  const flushRun = () => {
    if (run.length > 0) list.appendChild(buildRun(run));
    run = [];
  };
  newestFirst.forEach((entry, i) => {
    const index = history.length - 1 - i;
    if (i === 0 || entry.commit) {
      flushRun();
      list.appendChild(buildEntry(entry, index, i === 0));
    } else {
      run.push([entry, index]);
    }
  });
  flushRun();

  const historyPane = document.createElement("div");
  historyPane.className = "history-pane";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Click a save to see what changed. Click a second save to compare the two.";
  historyPane.append(hint, list);

  const diffPane = document.createElement("section");
  diffPane.id = "diff-pane";
  diffPane.className = "diff-pane";

  const workspace = document.createElement("div");
  workspace.className = "workspace";
  workspace.append(historyPane, makeResizer("--history-w", 200, 520, 280), diffPane);

  detailEl.append(header, workspace);
  updatePicks();
}

function buildEntry(entry, index, isLatest) {
  const item = document.createElement("li");
  item.className = "entry" + (entry.commit ? " committed" : "") + (isLatest ? " latest" : "");
  item.dataset.index = index;
  item.addEventListener("click", () => togglePick(index));

  const dot = document.createElement("span");
  dot.className = "dot";

  const body = document.createElement("div");
  body.className = "entry-body";
  const label = document.createElement("span");
  label.className = "entry-label";
  label.textContent = entry.commit ? entry.commit.msg : isLatest ? "Latest save" : "Autosave";
  const meta = document.createElement("span");
  meta.className = "entry-meta";
  meta.textContent = `${formatTime(entry.created_at)} · ${entry.hash.slice(0, 7)}`;
  body.append(label, meta);

  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "restore";
  restore.textContent = "Restore";
  restore.title = "Copy this save to a new .als next to your project (nothing is overwritten)";
  restore.addEventListener("click", async (e) => {
    e.stopPropagation();
    const restored = await call("restore_snapshot", { path: selectedPath, hash: entry.hash });
    if (restored !== null) showNotice(restored);
  });

  item.append(dot, body, restore);
  return item;
}

function showNotice(restoredPath) {
  const notice = document.querySelector("#notice");
  if (!notice) return;
  notice.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = `Restored as “${restoredPath.split(/[\\/]/).pop()}” next to your project.`;
  notice.append(text);
  const reveal = window.__TAURI__.opener?.revealItemInDir;
  if (reveal) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Show in folder";
    button.addEventListener("click", () => reveal(restoredPath).catch((e) => showError(String(e))));
    notice.append(button);
  }
  notice.hidden = false;
}

// A collapsed run of uncommitted autosaves; click to expand in place.
function buildRun(entries) {
  // A run starts open if it holds a picked save, so a re-render doesn't hide the pick.
  const holdsPick = entries.some(([, index]) => picks.includes(index));
  const item = document.createElement("li");
  item.className = "run";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "run-toggle";
  toggle.textContent = `··· ${entries.length} autosave${entries.length === 1 ? "" : "s"} ···`;

  const inner = document.createElement("ol");
  inner.className = "run-entries";
  inner.hidden = !holdsPick;
  item.classList.toggle("open", holdsPick);
  for (const [entry, index] of entries) inner.appendChild(buildEntry(entry, index, false));

  toggle.addEventListener("click", () => {
    inner.hidden = !inner.hidden;
    item.classList.toggle("open", !inner.hidden);
  });

  item.append(toggle, inner);
  return item;
}

function buildCommitForm(path, history) {
  const form = document.createElement("form");
  form.className = "commit-form";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Name this moment, e.g. “drums locked in”";
  input.maxLength = 120;
  // Keep what the user typed if a new save re-renders the panel mid-sentence.
  input.value = commitDrafts.get(path) ?? "";
  input.addEventListener("input", () => commitDrafts.set(path, input.value));

  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Commit";

  const latest = history[history.length - 1];
  if (!latest) {
    input.disabled = button.disabled = true;
    input.placeholder = "Save the set in Ableton to start its history";
  } else if (latest.commit) {
    input.disabled = button.disabled = true;
    input.placeholder = "Latest save is committed. Make a change in Ableton and save";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = await call("make_commit", { path, msg: input.value });
    if (result !== null) {
      commitDrafts.delete(path);
      renderHistory();
    }
  });

  form.append(input, button);
  return form;
}

function togglePick(index) {
  if (picks.includes(index)) picks = picks.filter((i) => i !== index);
  else picks = [...picks, index].slice(-2); // a third click replaces the oldest pick
  updatePicks();
}

function entryLabel(index) {
  const entry = currentHistory[index];
  if (entry.commit) return `“${entry.commit.msg}”`;
  return `${index === currentHistory.length - 1 ? "Latest save" : "Autosave"} ${formatTime(entry.created_at)}`;
}

// One pick: compare with the commit before it (or the save before, if there's no
// earlier commit). Two picks: older → newer, whichever order they were clicked in.
function comparison() {
  if (picks.length === 2) {
    const [a, b] = [...picks].sort((x, y) => x - y);
    return { old: a, new: b };
  }
  if (picks.length === 1) {
    const target = picks[0];
    for (let i = target - 1; i >= 0; i--) {
      if (currentHistory[i].commit) return { old: i, new: target };
    }
    return target > 0 ? { old: target - 1, new: target } : { old: null, new: target };
  }
  return null;
}

function updatePicks() {
  const pair = comparison();
  for (const item of detailEl.querySelectorAll(".entry")) {
    const index = Number(item.dataset.index);
    item.classList.toggle("picked", picks.includes(index));
    item.classList.toggle("base", pair !== null && pair.old === index && !picks.includes(index));
  }
  renderDiff(pair);
}

async function renderDiff(pair) {
  const pane = document.querySelector("#diff-pane");
  if (!pane) return;
  const token = ++diffToken;

  const placeholder = (text) => {
    pane.innerHTML = "";
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = text;
    pane.appendChild(p);
  };

  if (pair === null) return placeholder("Pick a save to see what changed");
  if (pair.old === null) {
    return placeholder("This is the first save, so there's nothing before it. Pick another save to compare.");
  }

  const path = selectedPath;
  const oldHash = currentHistory[pair.old].hash;
  const newHash = currentHistory[pair.new].hash;
  const key = `${path}|${oldHash}|${newHash}`;

  let diff = diffCache.get(key);
  if (!diff) {
    placeholder("Comparing…");
    diff = await call("diff_snapshots", { path, oldHash, newHash });
    if (token !== diffToken) return; // the user picked something else meanwhile
    if (diff === null) return placeholder("Couldn't compare these saves");
    diffCache.set(key, diff);
  }

  pane.innerHTML = "";
  pane.append(buildDiffHeader(pair, diff.summary), buildArrangement(diff));
}

function buildDiffHeader(pair, summary) {
  const header = document.createElement("div");
  header.className = "diff-header";

  const title = document.createElement("div");
  title.className = "diff-title";
  title.textContent = `${entryLabel(pair.old)}  →  ${entryLabel(pair.new)}`;

  const chips = document.createElement("div");
  chips.className = "chips";
  const chip = (cls, text) => {
    const span = document.createElement("span");
    span.className = `chip ${cls}`;
    span.textContent = text;
    chips.appendChild(span);
  };
  const s = summary;
  const changes = s.clips_added + s.clips_modified + s.clips_removed;
  const trackChanges = s.tracks_added + s.tracks_removed;
  if (changes === 0 && trackChanges === 0) {
    chip("none", "No arrangement changes");
  } else {
    chip("added", `+${s.clips_added} added`);
    chip("modified", `~${s.clips_modified} modified`);
    chip("removed", `−${s.clips_removed} removed`);
    chip("unchanged", `${s.clips_unchanged} unchanged`);
    if (trackChanges > 0) {
      chip("tracks", `tracks +${s.tracks_added} −${s.tracks_removed}`);
    }
  }

  header.append(title, chips);
  return header;
}

const BEATS_PER_BAR = 4; // assumes 4/4, which covers the vast majority of sets

function bar(beat) {
  return Math.floor(beat / BEATS_PER_BAR) + 1;
}

function clipTitle(clip, status, changed) {
  const range = `bars ${bar(clip.start)}–${bar(Math.max(clip.start, clip.end - 1e-6))}`;
  let text = `${clip.name || "Untitled clip"} · ${range} · ${status}`;
  if (changed.length > 0) text += ` (${changed.join(", ").replaceAll("_", " ")})`;
  return text;
}

// One lane per track, clips positioned by beat as a percentage of the song length,
// so the whole arrangement fits the pane without horizontal scrolling.
function buildArrangement(diff) {
  const root = document.createElement("div");
  root.className = "arrangement";

  let lastBeat = 0;
  for (const track of diff.tracks) {
    for (const clip of track.clips) {
      for (const c of [clip.before, clip.after]) if (c) lastBeat = Math.max(lastBeat, c.end);
    }
  }
  // Round up to a whole number of grid steps; pick a step that gives ≤ 16 labels.
  const bars = Math.max(4, Math.ceil(lastBeat / BEATS_PER_BAR));
  const step = [1, 2, 4, 8, 16, 32, 64, 128].find((n) => bars / n <= 16) ?? 256;
  const totalBars = Math.ceil(bars / step) * step;
  const totalBeats = totalBars * BEATS_PER_BAR;
  const pct = (beat) => `${(beat / totalBeats) * 100}%`;

  const ruler = document.createElement("div");
  ruler.className = "lane-row ruler";
  const rulerLabel = document.createElement("div");
  rulerLabel.className = "track-label";
  const rulerLane = document.createElement("div");
  rulerLane.className = "lane";
  for (let b = 0; b <= totalBars; b += step) {
    const mark = document.createElement("span");
    mark.className = "bar-mark";
    mark.style.left = pct(b * BEATS_PER_BAR);
    mark.textContent = b < totalBars ? String(b + 1) : "";
    rulerLane.appendChild(mark);
  }
  ruler.append(rulerLabel, rulerLane);
  root.appendChild(ruler);

  // Group nesting depth, following group_id up the chain.
  const byId = new Map(diff.tracks.map((t) => [t.id, t]));
  const depth = (track) => {
    let d = 0;
    for (let t = track; t.group_id !== null && byId.has(t.group_id) && d < 16; t = byId.get(t.group_id)) d++;
    return d;
  };

  for (const track of diff.tracks) {
    const row = document.createElement("div");
    row.className = `lane-row track-${track.status} kind-${track.kind}`;

    const label = document.createElement("div");
    label.className = "track-label";
    label.style.paddingLeft = `${10 + depth(track) * 14}px`;
    label.title = `${track.name} (${track.kind}, ${track.status})`;
    const marker = document.createElement("span");
    marker.className = "track-marker";
    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = track.name;
    label.append(marker, name);

    const lane = document.createElement("div");
    lane.className = "lane";
    for (let b = step; b < totalBars; b += step) {
      const line = document.createElement("span");
      line.className = "grid-line";
      line.style.left = pct(b * BEATS_PER_BAR);
      lane.appendChild(line);
    }

    const addBlock = (clip, cls, title) => {
      const block = document.createElement("div");
      block.className = `clip ${cls}`;
      block.style.left = pct(clip.start);
      block.style.width = pct(Math.max(0, clip.end - clip.start));
      block.title = title;
      const text = document.createElement("span");
      text.textContent = clip.name;
      block.appendChild(text);
      lane.appendChild(block);
    };

    for (const clip of track.clips) {
      if (clip.status === "removed") {
        addBlock(clip.before, "removed", clipTitle(clip.before, "removed", []));
      } else if (clip.status === "modified") {
        const moved = clip.changed.includes("start") || clip.changed.includes("end");
        // Show where a moved or resized clip used to be as a faint outline.
        if (moved) addBlock(clip.before, "ghost", clipTitle(clip.before, "before the change", []));
        addBlock(clip.after, "modified", clipTitle(clip.after, "modified", clip.changed));
      } else {
        addBlock(clip.after, clip.status, clipTitle(clip.after, clip.status, []));
      }
    }

    row.append(label, lane);
    root.appendChild(row);
  }

  if (diff.tracks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "No tracks in either save";
    root.appendChild(empty);
  }
  return root;
}

// A drag handle that sets a CSS width variable; double-click resets it.
const paneWidths = loadPref("paneWidths", {});

function applyWidth(cssVar, px) {
  document.documentElement.style.setProperty(cssVar, `${px}px`);
}

function makeResizer(cssVar, min, max, initial) {
  const handle = document.createElement("div");
  handle.className = "resizer";
  handle.title = "Drag to resize · double-click to reset";
  let startX = 0;
  let startWidth = 0;

  const clamp = (px) => Math.min(max, Math.max(min, Math.round(px)));
  const current = () => paneWidths[cssVar] ?? initial;

  handle.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startWidth = current();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    paneWidths[cssVar] = clamp(startWidth + e.clientX - startX);
    applyWidth(cssVar, paneWidths[cssVar]);
  });
  const stop = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing");
    savePref("paneWidths", paneWidths);
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => {
    delete paneWidths[cssVar];
    applyWidth(cssVar, initial);
    savePref("paneWidths", paneWidths);
  });

  applyWidth(cssVar, current());
  return handle;
}

async function addProject() {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Ableton Live Set", extensions: ["als"] }],
  });
  if (!path) return; // user cancelled
  const projects = await call("add_project", { path });
  if (projects !== null) select(path);
  render(projects);
}

// The watcher thread emits this after every new snapshot.
listen("history-changed", (event) => {
  if (event.payload === selectedPath) renderHistory();
});

document.querySelector("#add-project").addEventListener("click", addProject);
document.querySelector(".sidebar").after(makeResizer("--sidebar-w", 180, 480, 260));
call("list_projects").then(render);

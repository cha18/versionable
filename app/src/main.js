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
  setExpanded(false);
  setSwitcherOpen(path === null);
  renderHistory();
}

// ---------- project switcher ----------
// The project list is an overlay, so the app can stay a narrow panel beside Ableton.

function setSwitcherOpen(open) {
  // With nothing selected there's nothing behind the list, so keep it open.
  document.body.classList.toggle("switcher-open", open || selectedPath === null);
  document.querySelector("#close-switcher").hidden = selectedPath === null;
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
  const switcher = document.createElement("button");
  switcher.type = "button";
  switcher.className = "icon-button switch-project";
  switcher.textContent = "☰";
  switcher.title = "Projects";
  switcher.addEventListener("click", () => setSwitcherOpen(true));
  const titleText = document.createElement("div");
  titleText.className = "title-text";
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
  titleText.append(title, count);
  const compare = document.createElement("button");
  compare.type = "button";
  compare.id = "compare-toggle";
  compare.className = "compare-toggle";
  compare.textContent = "Diff";
  compare.addEventListener("click", toggleCompare);
  titleRow.append(switcher, titleText, compare);
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

  // The panel (header + history) never changes size or position when a diff opens;
  // the diff pane is added beside it and the window grows to fit.
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.append(header, historyPane);

  const diffPane = document.createElement("section");
  diffPane.className = "diff-pane";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button close-diff";
  close.textContent = "×";
  close.title = "Close comparison (Esc)";
  close.addEventListener("click", clearPicks);
  const diffBody = document.createElement("div");
  diffBody.id = "diff-pane";
  diffBody.className = "diff-body";
  diffPane.append(close, diffBody);

  detailEl.append(panel, diffPane);
  updatePicks();
  updateCompareButton();
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
  // Commits (and uncommitted latest save) get a +X ~Y −Z line against what came before.
  if (entry.commit || isLatest) {
    const stats = buildStats(index);
    if (stats) body.appendChild(stats);
  }

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
  if (picks.length === 1) return { old: baseFor(picks[0]), new: picks[0] };
  return null;
}

// What a save is compared against: the commit before it, or the save before
// if there's no earlier commit. null for the very first save.
function baseFor(index) {
  for (let i = index - 1; i >= 0; i--) {
    if (currentHistory[i].commit) return i;
  }
  return index > 0 ? index - 1 : null;
}

// ---------- per-commit stat lines ----------

// Summaries are keyed by the two snapshot hashes. Snapshots are content-addressed,
// so a stored summary can never go stale and is safe to keep across restarts.
const statsCache = new Map(Object.entries(loadPref("diffSummaries", {})));
const STATS_CACHE_LIMIT = 500;

function rememberSummary(oldHash, newHash, summary) {
  statsCache.set(`${oldHash}|${newHash}`, summary);
  while (statsCache.size > STATS_CACHE_LIMIT) statsCache.delete(statsCache.keys().next().value);
  savePref("diffSummaries", Object.fromEntries(statsCache));
}

// Diffs run one at a time so a long history doesn't parse a dozen large sets at once.
let statsQueue = Promise.resolve();

function buildStats(index) {
  const base = baseFor(index);
  if (base === null) return null;
  const oldHash = currentHistory[base].hash;
  const newHash = currentHistory[index].hash;
  const key = `${oldHash}|${newHash}`;

  const el = document.createElement("span");
  el.className = "entry-stats";
  el.dataset.key = key;
  el.dataset.against = currentHistory[base].commit ? "the previous commit" : "the previous save";

  const cached = statsCache.get(key);
  if (cached) {
    fillStats(el, cached);
    return el;
  }

  el.textContent = "…";
  const path = selectedPath;
  statsQueue = statsQueue.then(async () => {
    // Skip if the user moved on, or another queued job already filled it in.
    if (path !== selectedPath || statsCache.has(key)) {
      if (statsCache.has(key)) fillAllStats(key);
      return;
    }
    try {
      const diff = await invoke("diff_snapshots", { path, oldHash, newHash });
      diffCache.set(`${path}|${key}`, diff);
      rememberSummary(oldHash, newHash, diff.summary);
      fillAllStats(key);
    } catch (e) {
      // A failed stat line isn't worth the error banner; say so on hover instead.
      for (const target of document.querySelectorAll(`.entry-stats[data-key="${key}"]`)) {
        target.textContent = "–";
        target.title = `Couldn't compare: ${e}`;
      }
    }
  });
  return el;
}

// The panel may have re-rendered while the diff ran, so look the elements up again.
function fillAllStats(key) {
  for (const target of document.querySelectorAll(`.entry-stats[data-key="${key}"]`)) {
    fillStats(target, statsCache.get(key));
  }
}

function fillStats(el, s) {
  el.innerHTML = "";
  el.title =
    `Clips vs ${el.dataset.against}: ${s.clips_added} added, ${s.clips_modified} modified, ` +
    `${s.clips_removed} removed, ${s.clips_unchanged} unchanged\n` +
    `Tracks: ${s.tracks_added} added, ${s.tracks_removed} removed, ${s.tracks_modified} modified`;

  if (s.clips_added + s.clips_modified + s.clips_removed + s.tracks_added + s.tracks_removed === 0) {
    el.textContent = "no arrangement changes";
    return;
  }
  const part = (cls, text) => {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    el.appendChild(span);
  };
  part("added", `+${s.clips_added}`);
  part("modified", `~${s.clips_modified}`);
  part("removed", `−${s.clips_removed}`);
  if (s.tracks_added + s.tracks_removed > 0) {
    part("tracks", `tracks +${s.tracks_added} −${s.tracks_removed}`);
  }
}

function updatePicks() {
  const pair = comparison();
  for (const item of detailEl.querySelectorAll(".entry")) {
    const index = Number(item.dataset.index);
    item.classList.toggle("picked", picks.includes(index));
    item.classList.toggle("base", pair !== null && pair.old === index && !picks.includes(index));
  }
  setExpanded(pair !== null);
  renderDiff(pair);
}

function clearPicks() {
  picks = [];
  updatePicks();
}

// ---------- panel ⇄ expanded window ----------

// Note: currentMonitor() is a function of the window module, not a method on the window.
const { getCurrentWindow, currentMonitor, PhysicalSize, PhysicalPosition } = window.__TAURI__.window ?? {};
const appWindow = getCurrentWindow?.();
const layout = loadPref("layout", { diffWidth: 900 }); // CSS px, remembered across launches
let expanded = false;
let panelWidth = window.innerWidth; // the narrow width to return to
let grewLeft = false; // the diff opened on the left, so collapsing keeps the right edge
let ignoreResizeUntil = 0;
let windowJob = Promise.resolve(); // window changes run in order, never overlapping

function setExpanded(next) {
  if (next === expanded) return;
  expanded = next;
  if (next) panelWidth = window.innerWidth;
  document.documentElement.style.setProperty("--panel-w", `${panelWidth}px`);
  // Collapsing: hide the diff first, then shrink. Expanding: grow first, then show it,
  // so the diff (and its close button) never appears squeezed inside the narrow panel.
  if (!next) document.body.classList.remove("expanded");
  updateCompareButton();
  // Never let a stuck or failed window call keep the diff hidden: give up after 1.5 s
  // and show the diff in whatever size the window is.
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timed out")), 1500),
  );
  windowJob = windowJob
    .then(() => Promise.race([resizeWindow(next), timeout]))
    .catch((e) => {
      console.warn("window resize:", e);
      showError(`Couldn't resize the window: ${e}`);
    })
    .then(() => {
      if (next && expanded) document.body.classList.add("expanded");
    });
}

// Header button: opens the diff (latest save vs the commit before it, unless saves are
// already picked), or closes it when it's open.
function toggleCompare() {
  if (expanded) return clearPicks();
  if (picks.length === 0) picks = [currentHistory.length - 1];
  updatePicks();
}

function updateCompareButton() {
  const button = document.querySelector("#compare-toggle");
  if (!button) return;
  button.classList.toggle("active", expanded);
  button.disabled = !expanded && currentHistory.length < 2;
  button.title = expanded
    ? "Close comparison (Esc)"
    : button.disabled
      ? "Needs at least two saves to compare"
      : "Show what changed since the last commit";
}

async function resizeWindow(next) {
  if (!appWindow || !PhysicalSize) {
    console.warn("window API unavailable; showing the diff without resizing");
    return;
  }

  const scale = await appWindow.scaleFactor();
  const inner = await appWindow.innerSize();
  const outer = await appWindow.outerSize();
  const pos = await appWindow.outerPosition();
  const frame = outer.width - inner.width; // window border, if any
  const monitor = await currentMonitor();
  const screenWidth = monitor ? monitor.size.width - frame : Infinity;
  const width = Math.min(screenWidth, Math.round((next ? panelWidth + layout.diffWidth : panelWidth) * scale));

  ignoreResizeUntil = Date.now() + 600; // our own resize shouldn't be remembered as the user's
  if (next) {
    // Grow to the right if there's room; otherwise grow left, over Ableton, and put the
    // diff on the left so the panel itself stays exactly where it was.
    const right = monitor ? monitor.position.x + monitor.size.width : Infinity;
    const left = monitor ? monitor.position.x : -Infinity;
    grewLeft = pos.x + width + frame > right;
    document.body.classList.toggle("grow-left", grewLeft);
    if (grewLeft) {
      const x = Math.max(left, pos.x + outer.width - (width + frame));
      await appWindow.setPosition(new PhysicalPosition(x, pos.y));
    }
    await appWindow.setSize(new PhysicalSize(width, inner.height));
  } else {
    await appWindow.setSize(new PhysicalSize(width, inner.height));
    if (grewLeft) {
      await appWindow.setPosition(new PhysicalPosition(pos.x + outer.width - (width + frame), pos.y));
    }
    grewLeft = false;
    document.body.classList.remove("grow-left");
  }
}

// Remember how wide the user likes the diff, if they resize the expanded window.
let saveLayoutTimer = 0;
window.addEventListener("resize", () => {
  if (!expanded || Date.now() < ignoreResizeUntil) return;
  layout.diffWidth = Math.max(420, window.innerWidth - panelWidth);
  clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => savePref("layout", layout), 300);
});

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
    rememberSummary(oldHash, newHash, diff.summary);
    fillAllStats(`${oldHash}|${newHash}`);
  }

  // Keep the scroll position when a new save re-renders the same comparison.
  const previous = pane.querySelector(".arrangement");
  const keepScroll = previous?.dataset.key === key ? previous.scrollLeft : 0;
  pane.innerHTML = "";
  const arrangement = buildArrangement(diff);
  arrangement.dataset.key = key;
  const card = document.createElement("div");
  card.id = "change-card";
  card.className = "change-card";
  card.hidden = true;
  pane.append(buildDiffHeader(pair, diff.summary), card, arrangement);
  arrangement.scrollLeft = keepScroll;

  // A filter or focused clip survives a re-render of the same comparison, not a new one.
  if (diffView.key !== key) diffView = { key, filter: null, focus: null };
  setFilter(diffView.filter);
  setFocus(diffView.focus, { scroll: false });
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
    if (cls === "none") {
      const span = document.createElement("span");
      span.className = "chip none";
      span.textContent = text;
      return chips.appendChild(span);
    }
    // Each chip filters the arrangement to that kind of change; click again to clear.
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip ${cls}`;
    button.dataset.filter = cls;
    button.textContent = text;
    button.title = cls === "tracks" ? "Show only added and removed tracks" : `Show only ${cls} clips`;
    button.addEventListener("click", () => setFilter(diffView.filter === cls ? null : cls));
    chips.appendChild(button);
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

  const toolbar = document.createElement("div");
  toolbar.className = "diff-toolbar";
  toolbar.append(chips, buildZoomControls());

  header.append(title, toolbar);
  return header;
}

const BEATS_PER_BAR = 4; // assumes 4/4, which covers the vast majority of sets

// ---------- filtering and focusing ----------

let diffView = { key: null, filter: null, focus: null };

// Shows only clips of one status (or only added/removed tracks), and hides tracks
// with nothing to show. A group stays visible if anything inside it does.
function setFilter(filter) {
  diffView.filter = filter;
  const root = document.querySelector(".arrangement");
  if (!root?._rows) return;

  if (filter) root.dataset.filter = filter;
  else delete root.dataset.filter;
  for (const chip of document.querySelectorAll(".chip[data-filter]")) {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  }

  const matches = ({ track, statuses }) =>
    !filter ||
    (filter === "tracks" ? track.status === "added" || track.status === "removed" : statuses.has(filter));
  const visible = new Set();
  for (const info of root._rows) {
    if (!matches(info)) continue;
    for (let t = info.track; t; t = t.group_id === null ? null : root._byId.get(t.group_id)) {
      if (visible.has(t.id)) break;
      visible.add(t.id);
    }
  }
  for (const { row, track } of root._rows) row.hidden = !visible.has(track.id);

  // A focused clip that the filter hides would leave a card for something invisible.
  const focused = diffView.focus && root._clipInfo.get(diffView.focus);
  if (focused && filter && filter !== "tracks" && focused.clip.status !== filter) setFocus(null);
}

// Highlights one changed clip (dimming the rest) and explains the change in a card.
function setFocus(key, { scroll = true } = {}) {
  const root = document.querySelector(".arrangement");
  const card = document.querySelector("#change-card");
  const info = key && root?._clipInfo?.get(key);
  diffView.focus = info ? key : null;
  if (!root || !card) return;

  root.classList.toggle("has-focus", Boolean(info));
  let target = null;
  for (const block of root.querySelectorAll(".clip")) {
    const on = Boolean(info) && block.dataset.clip === key;
    block.classList.toggle("focused", on);
    if (on && !block.classList.contains("ghost")) target = block;
  }

  card.hidden = !info;
  card.innerHTML = "";
  if (!info) return;
  card.append(...buildChangeCard(info.track, info.clip));
  if (scroll && target) {
    // Bring the clip into view sideways, clear of the sticky track names.
    const labelWidth = root.querySelector(".track-label").offsetWidth;
    const lanes = root.clientWidth - labelWidth;
    const left = target.offsetLeft;
    if (left < root.scrollLeft || left + target.offsetWidth > root.scrollLeft + lanes) {
      root.scrollLeft = Math.max(0, left - (lanes - target.offsetWidth) / 2);
    }
  }
}

function formatBar(beat) {
  return `bar ${+(beat / BEATS_PER_BAR + 1).toFixed(2)}`;
}

function formatLength(beats) {
  if (beats >= BEATS_PER_BAR) {
    const bars = +(beats / BEATS_PER_BAR).toFixed(2);
    return `${bars} bar${bars === 1 ? "" : "s"}`;
  }
  const b = +beats.toFixed(2);
  return `${b} beat${b === 1 ? "" : "s"}`;
}

function buildChangeCard(track, diffClip) {
  const { before, after, status } = diffClip;
  const clip = after ?? before;

  const head = document.createElement("div");
  head.className = "card-head";
  const badge = document.createElement("span");
  badge.className = `card-badge ${status}`;
  badge.textContent = status;
  const name = document.createElement("span");
  name.className = "card-name";
  name.textContent = clip.name || "Untitled clip";
  const where = document.createElement("span");
  where.className = "muted";
  where.textContent = `on ${track.name}`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button card-close";
  close.textContent = "×";
  close.title = "Show all clips (Esc)";
  close.addEventListener("click", () => setFocus(null));
  head.append(badge, name, where, close);

  const rows = document.createElement("dl");
  rows.className = "card-rows";
  const row = (label, from, to) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (to === undefined) {
      dd.textContent = from;
    } else {
      const old = document.createElement("span");
      old.className = "was";
      old.textContent = from;
      dd.append(old, ` → ${to}`);
    }
    rows.append(dt, dd);
  };
  const length = (c) => c.end - c.start;

  if (status === "modified") {
    if (before.start !== after.start) row("Position", formatBar(before.start), formatBar(after.start));
    if (Math.abs(length(before) - length(after)) > 1e-6) {
      row("Length", formatLength(length(before)), formatLength(length(after)));
    }
    if (before.name !== after.name) row("Name", `“${before.name}”`, `“${after.name}”`);
    if (before.color !== after.color) row("Colour", "changed");
    if (before.loop_start !== after.loop_start || before.loop_end !== after.loop_end) {
      const loop = (c) => `beats ${+c.loop_start.toFixed(2)}–${+c.loop_end.toFixed(2)}`;
      row("Loop", loop(before), loop(after));
    }
  } else {
    row("Position", formatBar(clip.start));
    row("Length", formatLength(length(clip)));
  }
  return [head, rows];
}

function bar(beat) {
  return Math.floor(beat / BEATS_PER_BAR) + 1;
}

function clipTitle(clip, status, changed) {
  const range = `bars ${bar(clip.start)}–${bar(Math.max(clip.start, clip.end - 1e-6))}`;
  let text = `${clip.name || "Untitled clip"} · ${range} · ${status}`;
  if (changed.length > 0) text += ` (${changed.join(", ").replaceAll("_", " ")})`;
  return text;
}

// ---------- zoom ----------

// 1 = the whole song fits the pane. Zooming widens the lanes (clips are positioned in %
// of the lane, so they scale for free) and the pane scrolls horizontally.
let zoom = 1;
const GRID_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

function buildZoomControls() {
  const controls = document.createElement("div");
  controls.className = "zoom-controls";
  controls.title = "Zoom: pinch, ⌘/Ctrl + scroll, or the + and − keys";
  const button = (text, label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    controls.appendChild(b);
    return b;
  };
  button("−", "Zoom out", () => setZoom(zoom / 1.5));
  const level = document.createElement("span");
  level.id = "zoom-level";
  controls.appendChild(level);
  button("+", "Zoom in", () => setZoom(zoom * 1.5));
  button("Fit", "Fit the whole song", () => setZoom(1));
  updateZoomLabel(level);
  return controls;
}

function updateZoomLabel(level = document.querySelector("#zoom-level")) {
  if (level) level.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
}

// Changes zoom, keeping the beat under clientX (or the middle of the view) in place.
function setZoom(next, clientX) {
  const root = document.querySelector(".arrangement");
  if (!root) return;
  const maxZoom = Number(root.dataset.maxZoom);
  next = Math.min(maxZoom, Math.max(1, next));
  if (Math.abs(next - zoom) < 1e-3) return;

  const labelWidth = root.querySelector(".track-label").offsetWidth;
  const viewport = root.clientWidth - labelWidth; // visible lane width
  const box = root.getBoundingClientRect();
  const x = clientX === undefined ? viewport / 2 : Math.min(viewport, Math.max(0, clientX - box.left - labelWidth));
  const songFraction = (root.scrollLeft + x) / (viewport * zoom);

  zoom = next;
  applyZoom(root);
  root.scrollLeft = songFraction * viewport * zoom - x;
  updateZoomLabel();
}

// Sets the lane width and redraws the ruler and grid for the current zoom.
function applyZoom(root) {
  const totalBars = Number(root.dataset.totalBars);
  zoom = Math.min(zoom, Number(root.dataset.maxZoom));
  // Finest bar step that still shows ≤ 16 labels across the visible width.
  const step = GRID_STEPS.find((n) => totalBars / n / zoom <= 16 && totalBars % n === 0) ?? totalBars;
  root.style.setProperty("--zoom", zoom);
  const at = (bar) => `${(bar / totalBars) * 100}%`;

  const rulerLane = root.querySelector(".ruler .lane");
  rulerLane.innerHTML = "";
  for (let b = 0; b < totalBars; b += step) {
    const mark = document.createElement("span");
    mark.className = "bar-mark";
    mark.style.left = at(b);
    mark.textContent = String(b + 1);
    rulerLane.appendChild(mark);
  }

  // Grid lines use the same % positions as the ruler marks, so they can't drift apart.
  // (A repeating CSS background did: browsers round each tile to whole pixels.)
  const grid = root.querySelector(".grid-overlay");
  grid.innerHTML = "";
  const line = (bar, cls) => {
    const el = document.createElement("span");
    el.className = cls;
    el.style.left = at(bar);
    grid.appendChild(el);
  };
  for (let b = step; b < totalBars; b += step) line(b, "grid-line");
  if (totalBars / zoom <= 12) {
    // Beat lines once bars are wide enough to need them.
    for (let beat = 1; beat < totalBars * BEATS_PER_BAR; beat++) {
      const bar = beat / BEATS_PER_BAR;
      if (bar % step !== 0) line(bar, "grid-line beat");
    }
  }
}

function attachZoomGestures(root) {
  // Trackpad pinch arrives as ctrl+wheel in Chromium, and ⌘/Ctrl+wheel is the mouse equivalent.
  root.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX);
    },
    { passive: false },
  );
  // WebKit (the macOS webview) reports pinch as gesture events instead.
  let gestureStart = 1;
  root.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStart = zoom;
  });
  root.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    setZoom(gestureStart * e.scale, e.clientX);
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.target.closest?.("input, textarea")) {
    if (document.body.classList.contains("switcher-open")) setSwitcherOpen(false);
    else if (diffView.focus) setFocus(null);
    else if (diffView.filter) setFilter(null);
    else if (picks.length > 0) clearPicks();
    return;
  }
  if (e.target.closest?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "+" || e.key === "=") setZoom(zoom * 1.5);
  if (e.key === "-" || e.key === "_") setZoom(zoom / 1.5);
});

// One lane per track, clips positioned by beat as a percentage of the lane width.
// At zoom 1 the whole song fits the pane; zooming widens the lanes.
function buildArrangement(diff) {
  const root = document.createElement("div");
  root.className = "arrangement";

  let lastBeat = 0;
  for (const track of diff.tracks) {
    for (const clip of track.clips) {
      for (const c of [clip.before, clip.after]) if (c) lastBeat = Math.max(lastBeat, c.end);
    }
  }
  // Round the song length up to a whole number of the zoomed-out grid step, so every
  // finer step at higher zoom divides it evenly too.
  const bars = Math.max(4, Math.ceil(lastBeat / BEATS_PER_BAR));
  const fitStep = GRID_STEPS.find((n) => bars / n <= 16) ?? 512;
  const totalBars = Math.ceil(bars / fitStep) * fitStep;
  const totalBeats = totalBars * BEATS_PER_BAR;
  const pct = (beat) => `${(beat / totalBeats) * 100}%`;
  root.dataset.totalBars = totalBars;
  root.dataset.maxZoom = Math.max(1, totalBars / 2); // zoomed in fully: ~2 bars on screen

  const ruler = document.createElement("div");
  ruler.className = "lane-row ruler";
  const rulerLabel = document.createElement("div");
  rulerLabel.className = "track-label";
  const rulerLane = document.createElement("div");
  rulerLane.className = "lane";
  ruler.append(rulerLabel, rulerLane);
  root.appendChild(ruler);

  // One overlay spanning every lane holds the grid lines; filled in by applyZoom.
  const grid = document.createElement("div");
  grid.className = "grid-overlay";
  root.appendChild(grid);

  // Group nesting depth, following group_id up the chain.
  const byId = new Map(diff.tracks.map((t) => [t.id, t]));
  const depth = (track) => {
    let d = 0;
    for (let t = track; t.group_id !== null && byId.has(t.group_id) && d < 16; t = byId.get(t.group_id)) d++;
    return d;
  };

  // Kept on the element so filtering and focusing can work without rebuilding the lanes.
  const rows = [];
  const clipInfo = new Map(); // clip key → { track, clip }
  root._rows = rows;
  root._clipInfo = clipInfo;
  root._byId = byId;

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

    const addBlock = (clip, cls, title, diffClip) => {
      const block = document.createElement("div");
      block.className = `clip ${cls}`;
      // A moved clip's outline belongs to the same change as the clip itself.
      const key = `${track.id}:${diffClip.id}:${diffClip.status}`;
      block.dataset.status = diffClip.status;
      block.dataset.clip = key;
      clipInfo.set(key, { track, clip: diffClip });
      if (diffClip.status !== "unchanged" && cls !== "ghost") {
        block.classList.add("clickable");
        block.addEventListener("click", (e) => {
          e.stopPropagation();
          setFocus(diffView.focus === key ? null : key);
        });
      }
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
        addBlock(clip.before, "removed", clipTitle(clip.before, "removed", []), clip);
      } else if (clip.status === "modified") {
        const moved = clip.changed.includes("start") || clip.changed.includes("end");
        // Show where a moved or resized clip used to be as a faint outline.
        if (moved) addBlock(clip.before, "ghost", clipTitle(clip.before, "before the change", []), clip);
        addBlock(clip.after, "modified", clipTitle(clip.after, "modified", clip.changed), clip);
      } else {
        addBlock(clip.after, clip.status, clipTitle(clip.after, clip.status, []), clip);
      }
    }

    lane.addEventListener("click", () => setFocus(null)); // clicking empty space unfocuses

    row.append(label, lane);
    root.appendChild(row);
    rows.push({ row, track, statuses: new Set(track.clips.map((c) => c.status)) });
  }

  if (diff.tracks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "No tracks in either save";
    root.appendChild(empty);
  }
  applyZoom(root);
  attachZoomGestures(root);
  return root;
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
document.querySelector("#close-switcher").addEventListener("click", () => setSwitcherOpen(false));
errorEl.addEventListener("click", () => showError(""));
setSwitcherOpen(true);
call("list_projects").then(render);

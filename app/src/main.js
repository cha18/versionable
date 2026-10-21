const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

const listEl = document.querySelector("#project-list");
const errorEl = document.querySelector("#error");
const detailEl = document.querySelector("#detail");

let selectedPath = null;

function fileName(path) {
  return path.split(/[\\/]/).pop().replace(/\.als$/i, "");
}

function parentDir(path) {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
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

function render(projects) {
  if (projects === null) return;
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
    name.textContent = fileName(path);
    const dir = document.createElement("span");
    dir.className = "project-dir";
    dir.textContent = parentDir(path);
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

    item.addEventListener("click", () => {
      select(path);
      render(projects);
    });

    item.append(label, remove);
    listEl.appendChild(item);
  }
}

function select(path) {
  selectedPath = path;
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

  const history = (await call("get_history", { path: selectedPath })) ?? [];

  const header = document.createElement("header");
  header.className = "detail-header";
  const title = document.createElement("h2");
  title.textContent = fileName(selectedPath);
  const count = document.createElement("span");
  count.className = "muted";
  count.textContent = `${history.length} save${history.length === 1 ? "" : "s"}`;
  header.append(title, count);

  const list = document.createElement("ol");
  list.className = "history";

  if (history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No saves recorded yet. Save the set in Ableton.";
    list.appendChild(empty);
  }

  // Newest first
  [...history].reverse().forEach((entry, i) => {
    const item = document.createElement("li");
    item.className = "entry" + (entry.commit ? " committed" : "") + (i === 0 ? " latest" : "");

    const dot = document.createElement("span");
    dot.className = "dot";

    const body = document.createElement("div");
    body.className = "entry-body";
    const label = document.createElement("span");
    label.className = "entry-label";
    label.textContent = entry.commit ? entry.commit.msg : "Autosave";
    const meta = document.createElement("span");
    meta.className = "entry-meta";
    meta.textContent = `${formatTime(entry.created_at)} · ${entry.hash.slice(0, 7)}`;
    body.append(label, meta);

    item.append(dot, body);
    list.appendChild(item);
  });

  detailEl.append(header, list);
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
call("list_projects").then(render);

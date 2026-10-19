const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

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
  detailEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = path ? fileName(path) : "Select a project";
  detailEl.appendChild(p);
}

async function addProject() {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Ableton Live Set", extensions: ["als"] }],
  });
  if (!path) return; // user cancelled
  render(await call("add_project", { path }));
}

document.querySelector("#add-project").addEventListener("click", addProject);
call("list_projects").then(render);

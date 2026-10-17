const state = { data: null, selected: "boot-the-shop", lastResult: null };

const $ = (selector) => document.querySelector(selector);

function toast(message, kind = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible ${kind}`;
  window.setTimeout(() => element.classList.remove("visible"), 2800);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function renderStats(data) {
  $("#stats").innerHTML = [
    ["REPOSITORY", "quest-shop", "demo fixture"],
    ["FILES MAPPED", data.scan.files, `${data.scan.symbols} symbols found`],
    ["MISSIONS GENERATED", data.planner.candidates, `${data.progress.completed} verified`],
    ["VERIFIERS", "3", "command · trace · test"],
  ].map(([label, value, detail]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`).join("");
}

function renderMissions(data) {
  $("#progress-label").textContent = `${data.progress.completed} / ${data.progress.total} complete`;
  $("#missions").innerHTML = data.missions.map((mission, index) => {
    const selected = mission.id === state.selected ? " selected" : "";
    return `<button class="mission-node ${mission.status}${selected}" data-mission="${mission.id}" ${mission.status === "locked" ? "disabled" : ""}>
      <span class="node-number">${mission.status === "completed" ? "✓" : index + 1}</span>
      <span class="node-copy"><strong>${mission.title}</strong><small>${mission.tags?.join(" · ") || "guided mission"}</small></span>
      <span class="node-state">${mission.status === "completed" ? "DONE" : mission.status === "locked" ? "LOCKED" : "PLAY"}</span>
    </button>`;
  }).join('<div class="map-line"></div>');
  document.querySelectorAll("[data-mission]").forEach((button) => button.addEventListener("click", () => {
    state.selected = button.dataset.mission;
    state.lastResult = null;
    render();
  }));
}

function selectedMission(data) {
  return data.missions.find((mission) => mission.id === state.selected) || data.missions[0];
}

function outputFor(mission, result) {
  if (!result) return "Waiting for a mission run…";
  if (result.error) return `ERROR\n${result.error}`;
  const lines = [`$ ${result.result?.command?.executable || "repoquest"} ${(result.result?.command?.args || []).join(" ")}`];
  lines.push(result.passed ? "\n✓ verifier passed" : "\n✗ verifier failed");
  if (result.traceEvents?.length) lines.push(`\ntrace: ${result.traceEvents.join(" → ")}`);
  if (result.result?.stdout) lines.push(`\n${result.result.stdout.trim()}`);
  if (result.result?.stderr) lines.push(`\n${result.result.stderr.trim()}`);
  return lines.join("");
}

function renderMissionPanel(data) {
  const mission = selectedMission(data);
  if (!mission) return;
  const fixCompleted = mission.id === "fix-invalid-login" && mission.status === "completed";
  const hasVerifier = Boolean(mission.validation);
  $("#mission-title").textContent = mission.title;
  $("#mission-status").textContent = mission.status.toUpperCase();
  $("#mission-status").className = `difficulty ${mission.status}`;
  $("#mission-objective").textContent = mission.objective;
  $("#mission-meta").innerHTML = (mission.tags || ["verified challenge"]).map((tag) => `<span>${tag}</span>`).join("");
  $("#terminal-output").textContent = outputFor(mission, state.lastResult);

  const actions = [];
  if (mission.id === "fix-invalid-login" && !data.seededBug && mission.status !== "completed") {
    actions.push('<button class="secondary-button" data-action="seed">Inject the challenge bug</button>');
  }
  if (mission.id === "fix-invalid-login" && data.seededBug && !fixCompleted) {
    actions.push('<button class="secondary-button" data-action="fix">Apply guided fix</button>');
  }
  if (hasVerifier && (mission.status === "available" || (mission.id === "fix-invalid-login" && data.seededBug))) {
    actions.push(`<button class="primary-button" data-action="verify" data-mission-id="${mission.id}">${mission.id === "fix-invalid-login" ? "Run hidden verifier" : "Run verification"} <span>→</span></button>`);
  }
  if (mission.status === "completed") actions.push('<span class="success-copy">Mission complete — next node unlocked ✦</span>');
  if (!hasVerifier && mission.status === "available") actions.push('<span class="success-copy">Mission brief ready — verifier template coming next ✦</span>');
  $("#mission-actions").innerHTML = actions.join("");
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", handleAction));
}

function renderActivity(data) {
  $("#activity").innerHTML = data.activity.map((item, index) => `<div class="activity-item"><span class="activity-icon">${index === 0 ? "✦" : "✓"}</span><span>${item}</span><small>${index === 0 ? "now" : "recent"}</small></div>`).join("");
}

function render() {
  if (!state.data) return;
  renderStats(state.data);
  renderMissions(state.data);
  renderMissionPanel(state.data);
  renderActivity(state.data);
}

async function refresh() {
  state.data = await api("/api/state");
  render();
}

async function handleAction(event) {
  const button = event.currentTarget;
  const action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === "reset") {
      state.selected = "boot-the-shop";
      state.lastResult = null;
      await api("/api/reset", { method: "POST", body: "{}" });
      toast("Demo workspace reset", "success");
    } else if (action === "scan") {
      toast("Scanning repository and mapping concepts…");
      await refresh();
      toast("Repository mapped — choose your first quest", "success");
      return;
    } else if (action === "seed") {
      await api("/api/seed-bug", { method: "POST", body: "{}" });
      toast("Mutation seeded in disposable workspace", "success");
    } else if (action === "fix") {
      await api("/api/apply-fix", { method: "POST", body: "{}" });
      toast("Guided patch applied — run the verifier", "success");
    } else if (action === "verify") {
      const missionId = button.dataset.missionId;
      const result = await api("/api/verify", { method: "POST", body: JSON.stringify({ missionId }) });
      state.lastResult = result;
      toast(result.passed ? "Mission verified — next node unlocked" : "Verifier found a failing behavior", result.passed ? "success" : "error");
    }
    await refresh();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", handleAction));
  refresh().catch((error) => toast(error.message, "error"));
});

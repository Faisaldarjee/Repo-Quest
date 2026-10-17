const state = {
  data: null,
  selected: "boot-the-shop",
  lastResult: null,
  hasScanned: false,
  busy: false,
  scanning: false,
  preview: false,
  hints: {},
};

const $ = (selector) => document.querySelector(selector);
const wait = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message, kind = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible ${kind}`;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => element.classList.remove("visible"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function commandText(command) {
  if (!command?.executable) return "select a mission to inspect its command";
  return [command.executable, ...(command.args || [])].join(" ");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function selectedMission(data) {
  return data?.missions?.find((mission) => mission.id === state.selected) || data?.missions?.[0];
}

function resultCommand(result) {
  return result?.result?.command || result?.command;
}

function outputFor(result) {
  if (!result) return "Waiting for a mission run…";
  if (result.error) return `ERROR\n${result.error}`;
  const commandResult = result.result;
  const lines = [];
  if (commandResult?.status) lines.push(`status: ${commandResult.status}`);
  if (result.passed === true) lines.push("\n✓ verifier passed");
  if (result.passed === false) lines.push("\n✗ verifier failed");
  if (result.traceEvents?.length) lines.push(`\ntrace: ${result.traceEvents.join(" → ")}`);
  if (commandResult?.stdout?.trim()) lines.push(`\n${commandResult.stdout.trim()}`);
  if (commandResult?.stderr?.trim()) lines.push(`\n${commandResult.stderr.trim()}`);
  if (commandResult?.error) lines.push(`\n${commandResult.error}`);
  return lines.join("") || "Verifier returned no captured output.";
}

function renderLanding() {
  const experience = $("#experience");
  experience.dataset.mode = state.scanning ? "scanning" : state.hasScanned ? "ready" : "landing";
  experience.classList.toggle("is-scanning", state.scanning);
  experience.classList.toggle("is-ready", state.hasScanned && Boolean(state.data));

  const scanState = $("#scan-state");
  const readout = $("#scan-readout");
  const note = $("#scan-note");
  const button = $(".scan-button");
  const label = button?.querySelector(".button-label");
  const verifierCount = state.data?.missions?.filter((mission) => Boolean(mission.validation)).length;
  $("#scan-repo-label").textContent = state.data?.manifest?.id ? `SCAN / ${state.data.manifest.id}` : "SCAN / LOCAL FIXTURE";
  $("#hero-proof").textContent = state.preview
    ? "Public preview. Generated locally. Not maintainer-reviewed."
    : verifierCount === undefined
    ? "One repository. Real verifiers. A path you can see."
    : `One repository. ${number(verifierCount)} real verifiers. A path you can see.`;

  if (state.scanning) {
    scanState.textContent = "MAPPING";
    readout.innerHTML = '<span class="readout-dot active"></span><span>Reading repository state…</span>';
    note.textContent = "Reading the repository · hold tight";
    if (label) label.textContent = "Mapping repository";
  } else if (state.hasScanned && state.data) {
    scanState.textContent = "MAPPED";
    readout.innerHTML = `<span class="readout-dot"></span><span>${number(state.data.scan.files)} files mapped · path ready</span>`;
    note.textContent = state.preview ? "Community preview mapped · maintainer review required" : "Map complete · choose a mission below";
    if (label) label.textContent = "Re-scan repository";
  } else {
    scanState.textContent = "READY";
    readout.innerHTML = '<span class="readout-dot"></span><span>Awaiting repository map</span>';
    note.textContent = "Repository ready · deterministic local run";
    if (label) label.textContent = "Scan demo repository";
  }
}

function renderStats(data) {
  const verifierCount = data.missions.filter((mission) => Boolean(mission.validation)).length;
  const attempts = (data.analytics || []).reduce((total, item) => total + item.attempts, 0);
  const stats = [
    ["FILES MAPPED", number(data.scan.files), `${number(data.scan.symbols)} symbols located`],
    ["ROUTES FOUND", number(data.scan.routes), `${number(data.scan.tests)} test files nearby`],
    ["MISSION CANDIDATES", number(data.planner.candidates), `${number(data.progress.completed)} verified · ${number(attempts)} attempts`],
    ["REAL VERIFIERS", number(verifierCount), `${data.planner.mode || "local"} execution mode`],
  ];
  $("#stats").innerHTML = stats.map(([label, value, detail], index) => `
    <div class="stat-card stat-${index + 1}">
      <span>${label}</span><strong>${value}</strong><small>${escapeHtml(detail)}</small>
      <i class="stat-spark" aria-hidden="true"></i>
    </div>`).join("");
}

function renderRepoGraph(data) {
  const nodes = [
    ["files", data.scan.files, "source"],
    ["routes", data.scan.routes, "entry points"],
    ["tests", data.scan.tests, "checks"],
    ["symbols", data.scan.symbols, "exports"],
  ];
  $("#repo-graph").innerHTML = `
    <div class="graph-canvas" aria-hidden="true">
      <span class="graph-beam beam-one"></span><span class="graph-beam beam-two"></span><span class="graph-beam beam-three"></span>
      <span class="graph-particle particle-one"></span><span class="graph-particle particle-two"></span>
    </div>
     <div class="graph-root"><span class="root-mark">⌁</span><strong>${escapeHtml(data.project?.name || data.manifest.id || "repository")}</strong><small>${escapeHtml(data.watcher?.mode || "local")} · disposable workspace</small></div>
    <div class="graph-nodes">${nodes.map(([label, value, detail], index) => {
      const revealed = index === 0 || data.progress.completed >= index;
      return `<div class="graph-node ${revealed ? "revealed" : "fogged"}"><span class="node-label">${label}</span><strong>${revealed ? number(value) : "??"}</strong><small>${revealed ? detail : "hidden until unlocked"}</small></div>`;
    }).join("")}</div>`;
}

function renderMissions(data) {
  const missions = data.missions || [];
  $("#progress-label").textContent = `${data.progress.completed} / ${data.progress.total} complete`;
  $("#path-count").textContent = `${String(data.progress.completed).padStart(2, "0")} / ${String(data.progress.total).padStart(2, "0")}`;
  $("#missions").innerHTML = missions.map((mission, index) => {
    const selected = mission.id === state.selected ? " selected" : "";
    const status = mission.status || "locked";
    const stateLabel = status === "completed" ? "VERIFIED" : status === "available" ? "OPEN" : "LOCKED";
    const step = status === "completed" ? "✓" : String(index + 1).padStart(2, "0");
    return `
      <button class="mission-node ${escapeHtml(status)}${selected}" data-mission="${escapeHtml(mission.id)}" type="button" ${status === "locked" || state.busy ? "disabled" : ""}>
        <span class="node-number">${step}</span>
        <span class="node-copy"><strong>${escapeHtml(mission.title)}</strong><small>${escapeHtml(mission.objective)}</small><em>${escapeHtml(mission.tags?.join("  ·  ") || "guided mission")}</em></span>
        <span class="node-state">${stateLabel}</span>
      </button>
      ${index < missions.length - 1 ? `<span class="path-connector ${status === "completed" ? "complete" : ""}" aria-hidden="true"><i></i></span>` : ""}`;
  }).join("");
}

function renderMissionPanel(data) {
  const mission = selectedMission(data);
  if (!mission) return;
  const result = state.lastResult;
  const missionIndex = Math.max(0, data.missions.findIndex((item) => item.id === mission.id));
  const command = resultCommand(result) || mission.validation?.verifier;
  const status = mission.status || "locked";
  const terminalStatus = result?.error ? "ERROR" : result ? (result.passed ? "PASSED" : "FAILED") : "STANDBY";
  const statusClass = result?.error ? "error" : result ? (result.passed ? "passed" : "failed") : status;
  const hasVerifier = Boolean(mission.validation?.verifier);
  const fixMission = mission.id === "fix-invalid-login";
  const fixCompleted = fixMission && status === "completed";

  $("#mission-title").textContent = mission.title;
  $("#mission-status").textContent = status.toUpperCase();
  $("#mission-status").className = `mission-status ${status}`;
  $("#mission-step").textContent = `STEP ${String(missionIndex + 1).padStart(2, "0")}`;
  $("#mission-signal").textContent = mission.status === "completed" ? "verified" : mission.status === "locked" ? "waiting on previous step" : "ready to run";
  $("#mission-objective").textContent = mission.objective;
  $("#mission-meta").innerHTML = (mission.tags || ["verified challenge"]).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const hintIndex = state.hints[mission.id] || 0;
  const hints = mission.hints || [];
  const mentorBox = $("#mentor-box");
  mentorBox.hidden = hints.length === 0 || hintIndex === 0;
  $("#mentor-text").textContent = hints[Math.min(hintIndex - 1, hints.length - 1)] || "Ask yourself where this behavior enters the repository.";
  $("#terminal").className = `terminal ${statusClass}`;
  $("#terminal-status").textContent = terminalStatus;
  $("#terminal-command").textContent = commandText(command);
  $("#terminal-output").textContent = outputFor(result);

  const actions = [];
  if (fixMission && !data.seededBug && !fixCompleted) {
    actions.push('<button class="secondary-button" data-action="seed" type="button"><span>01</span> Inject challenge bug</button>');
  }
  if (fixMission && data.seededBug && !fixCompleted) {
    actions.push('<button class="secondary-button" data-action="fix" type="button"><span>02</span> Apply guided fix</button>');
  }
  if (hasVerifier && (status === "available" || (fixMission && data.seededBug && !fixCompleted))) {
    actions.push(`<button class="primary-button run-button" data-action="verify" data-mission-id="${escapeHtml(mission.id)}" type="button"><span class="button-icon">▶</span><span>${fixMission ? "Run hidden verifier" : "Run verification"}</span><b>→</b></button>`);
  }
  if (status === "completed") actions.push('<span class="success-copy"><i>✓</i> Mission complete — next node unlocked</span>');
  if (!hasVerifier && status === "available") actions.push('<span class="success-copy"><i>↗</i> Brief ready — this node is presentation-only in the MVP</span>');
  if (hints.length > 0 && status !== "locked" && hintIndex < hints.length) actions.push(`<button class="hint-button" data-action="hint" data-mission-id="${escapeHtml(mission.id)}" type="button">Ask the mentor <span>${hintIndex}/${hints.length} hints</span></button>`);
  $("#mission-actions").innerHTML = actions.join("");

  const success = $("#success-panel");
  if (result?.passed === true && result.missionId === mission.id) {
    success.hidden = false;
    $("#success-title").textContent = `${mission.title} verified`;
    $("#success-detail").textContent = `${data.progress.completed} of ${data.progress.total} path steps verified from the sandbox response.`;
  } else {
    success.hidden = true;
  }
}

function renderActivity(data) {
  const items = data.activity || [];
  $("#activity").innerHTML = items.length ? items.map((item, index) => `
    <div class="activity-item"><span class="activity-icon ${index === 0 ? "active" : ""}">${index === 0 ? "✦" : "✓"}</span><span>${escapeHtml(item)}</span><small>${index === 0 ? "now" : `${index} step${index === 1 ? "" : "s"} ago`}</small></div>`).join("") : '<div class="empty-state">No activity recorded yet.</div>';
}

function render() {
  renderLanding();
  if (!state.data) return;
  const workspace = $("#workspace");
  workspace.setAttribute("aria-hidden", String(!state.hasScanned));
  workspace.toggleAttribute("inert", !state.hasScanned);
  $("#workspace-title").textContent = state.data.manifest.title || "Repository onboarding";
  $("#manifest-description").textContent = state.data.manifest.description || "A living map of the repository, with each step unlocked by the one before it.";
  $("#workspace-mode-text").innerHTML = `workspace / <b>${escapeHtml(state.data.watcher?.mode || "local")}</b>`;
  renderStats(state.data);
  renderRepoGraph(state.data);
  renderMissions(state.data);
  renderMissionPanel(state.data);
  renderActivity(state.data);
  document.body.classList.toggle("has-success", state.lastResult?.passed === true);
}

async function refresh() {
  state.data = await api("/api/state");
  render();
}

async function handleAction(event) {
  const missionButton = event.target.closest("[data-mission]");
  if (missionButton && !state.busy) {
    state.selected = missionButton.dataset.mission;
    state.lastResult = null;
    render();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button || state.busy) return;
  const action = button.dataset.action;
  state.busy = true;
  button.disabled = true;

  try {
    if (action === "reset") {
      state.selected = "boot-the-shop";
      state.lastResult = null;
      state.preview = false;
      state.hints = {};
      await api("/api/reset", { method: "POST", body: "{}" });
      state.hasScanned = true;
      toast("Demo workspace reset to a clean checkout", "success");
      await refresh();
    } else if (action === "scan") {
      state.scanning = true;
      render();
      const [data] = await Promise.all([api("/api/state"), wait(900)]);
      state.data = data;
      state.hasScanned = true;
      state.lastResult = null;
      state.scanning = false;
      render();
      toast("Repository mapped — choose your first quest", "success");
    } else if (action === "preview") {
      const url = $("#github-url").value.trim();
      if (!url) throw new Error("Paste a public GitHub repository URL first");
      state.scanning = true;
      render();
      toast("Cloning a shallow preview and mapping the repository…");
      const preview = await api("/api/preview", { method: "POST", body: JSON.stringify({ url }) });
      state.data = preview.state;
      state.hasScanned = true;
      state.preview = true;
      state.lastResult = null;
      state.scanning = false;
      render();
      toast("Community preview ready — maintainer review required", "success");
    } else if (action === "hint") {
      const missionId = button.dataset.missionId;
      state.hints[missionId] = (state.hints[missionId] || 0) + 1;
      render();
      toast("Hint unlocked — keep reasoning, don't skip the journey", "success");
    } else if (action === "seed") {
      state.lastResult = null;
      await api("/api/seed-bug", { method: "POST", body: "{}" });
      await refresh();
      toast("Mutation seeded in the disposable workspace", "success");
    } else if (action === "fix") {
      state.lastResult = null;
      await api("/api/apply-fix", { method: "POST", body: "{}" });
      await refresh();
      toast("Guided patch applied — run the verifier", "success");
    } else if (action === "verify") {
      const missionId = button.dataset.missionId;
      const result = await api("/api/verify", { method: "POST", body: JSON.stringify({ missionId }) });
      state.lastResult = result;
      state.data = result.state;
      state.hasScanned = true;
      render();
      toast(result.passed ? "Mission verified — next node unlocked" : "Verifier found a failing behavior", result.passed ? "success" : "error");
    }
  } catch (error) {
    state.scanning = false;
    state.lastResult = { error: error instanceof Error ? error.message : "Request failed" };
    render();
    toast(state.lastResult.error, "error");
  } finally {
    state.busy = false;
    render();
  }
}

document.addEventListener("click", handleAction);
document.addEventListener("DOMContentLoaded", () => {
  render();
  refresh().catch((error) => {
    state.lastResult = { error: error instanceof Error ? error.message : "Unable to load repository state" };
    render();
    toast(state.lastResult.error, "error");
  });
});

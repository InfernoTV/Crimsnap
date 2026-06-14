import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  api,
  displayLabel,
  encoderLabel,
  estimateBitrate,
  QUALITY_PRESETS,
  type AudioDevice,
  type MonitorInfo,
  type Preset,
  type Rect,
  type RecResult,
  type SelectedRegion,
  type Settings,
  type WindowEntry,
} from "./api";

interface UiRegion {
  id: string;
  name: string;
  rect: Rect;
  monitor: string;
  windowTitle?: string | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const appWin = getCurrentWindow();

const state = {
  monitors: [] as MonitorInfo[],
  settings: null as Settings | null,
  presets: [] as Preset[],
  regions: [] as UiRegion[],
  windows: [] as WindowEntry[],
  audioDevices: [] as AudioDevice[],
  recording: false,
  paused: false,
  recommended: null as string | null,
  availableEncoders: ["libx264"] as string[],
};

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_LAST_CHECK_KEY = "crimsnap:last-update-check-ms";
type AvailableUpdate = Exclude<Awaited<ReturnType<typeof check>>, null>;
let pendingUpdate: AvailableUpdate | null = null;
let updateBusy = false;

// ----------------------------------------------------------------- options

const FPS_OPTIONS: SelectOpt[] = [
  { value: "24", label: "24" },
  { value: "30", label: "30" },
  { value: "48", label: "48" },
  { value: "60", label: "60" },
  { value: "120", label: "120" },
  { value: "144", label: "144" },
  { value: "custom", label: "Custom" },
];

const RES_OPTIONS: SelectOpt[] = [
  { value: "0", label: "Native", sub: "no cap" },
  { value: "2160", label: "2160p", sub: "4K" },
  { value: "1440", label: "1440p", sub: "QHD" },
  { value: "1080", label: "1080p", sub: "FHD" },
  { value: "720", label: "720p", sub: "HD" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
  { value: "240", label: "240p" },
  { value: "144", label: "144p" },
  { value: "custom", label: "Custom" },
];

const BACKEND_OPTIONS: SelectOpt[] = [
  { value: "gdigrab", label: "GDI", sub: "reliable" },
  { value: "ddagrab", label: "GPU DDA", sub: "experimental" },
];

// ------------------------------------------------------------ custom select

interface SelectOpt {
  value: string;
  label: string;
  sub?: string;
}
interface MountedSelect {
  el: HTMLElement;
  options: SelectOpt[];
  value: string;
  onChange?: (v: string) => void;
}
const selects = new Map<string, MountedSelect>();

function mountSelect(
  id: string,
  options: SelectOpt[],
  initial: string,
  onChange?: (v: string) => void,
) {
  const el = document.querySelector<HTMLElement>(`[data-cs-id="${id}"]`);
  if (!el) return;
  el.innerHTML = `
    <button type="button" class="cs-trigger">
      <span class="lbl"></span>
      <span class="caret">▼</span>
    </button>
    <div class="cs-pop"></div>`;
  selects.set(id, { el, options, value: initial, onChange });
  renderSelect(id);
  const trigger = el.querySelector<HTMLButtonElement>(".cs-trigger")!;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = el.classList.contains("open");
    document.querySelectorAll(".cs.open").forEach((o) => o.classList.remove("open"));
    if (!open) el.classList.add("open");
  });
}

function renderSelect(id: string) {
  const s = selects.get(id);
  if (!s) return;
  const opt = s.options.find((o) => o.value === s.value);
  const lbl = s.el.querySelector<HTMLElement>(".cs-trigger .lbl")!;
  lbl.textContent = opt?.label ?? "—";
  const pop = s.el.querySelector<HTMLElement>(".cs-pop")!;
  pop.innerHTML = s.options
    .map(
      (o) => `
      <div class="cs-opt ${o.value === s.value ? "active" : ""}" data-value="${o.value}">
        <span>${escapeHtml(o.label)}</span>
        ${o.sub ? `<span class="sub">${escapeHtml(o.sub)}</span>` : ""}
      </div>`,
    )
    .join("");
  pop.querySelectorAll<HTMLElement>(".cs-opt").forEach((node) => {
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = node.dataset.value!;
      s.value = v;
      s.el.classList.remove("open");
      renderSelect(id);
      s.onChange?.(v);
    });
  });
}

function setSelect(id: string, value: string, fireChange = false) {
  const s = selects.get(id);
  if (!s) return;
  s.value = value;
  renderSelect(id);
  if (fireChange) s.onChange?.(value);
}

function getSelect(id: string): string {
  return selects.get(id)?.value ?? "";
}

function setSelectOptions(id: string, options: SelectOpt[], value?: string) {
  const s = selects.get(id);
  if (!s) return;
  s.options = options;
  if (value !== undefined) s.value = value;
  if (!options.find((o) => o.value === s.value) && options.length > 0) {
    s.value = options[0].value;
  }
  renderSelect(id);
}

document.addEventListener("click", () => {
  document.querySelectorAll(".cs.open").forEach((o) => o.classList.remove("open"));
});

// -------------------------------------------------------------------- toasts

function toast(message: string, kind: "ok" | "info" | "err" = "ok") {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-dot"></span><span class="t-msg"></span>`;
  el.querySelector(".t-msg")!.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 280);
  }, 3200);
}

// ------------------------------------------------------------------- updates

function changelogText(update: AvailableUpdate): string {
  const body = update.body?.trim();
  if (body) return body;
  const notes = update.rawJson?.notes;
  return typeof notes === "string" && notes.trim()
    ? notes.trim()
    : "No changelog was included with this release.";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${Math.round((bytes / 1_048_576) * 10) / 10} MB`;
}

function setUpdateStatus(kind: "idle" | "busy" | "ok" | "err", text: string) {
  const el = $("update-status");
  el.className = `update-status ${kind}`;
  el.textContent = text;
}

function setUpdateNotes(text: string | null) {
  const el = $("update-changelog");
  el.classList.toggle("hidden", !text);
  el.textContent = text ?? "";
}

function setUpdateActions(install: boolean, restart: boolean) {
  const actions = $("update-actions");
  actions.classList.toggle("hidden", !install && !restart);
  ($("install-update") as HTMLButtonElement).classList.toggle("hidden", !install);
  ($("restart-update") as HTMLButtonElement).classList.toggle("hidden", !restart);
}

function updateErrorMessage(error: unknown): string {
  const msg = String(error instanceof Error ? error.message : error);
  if (/429|rate limit|too many requests/i.test(msg)) {
    return "Update host is rate limiting checks. Try again later.";
  }
  if (/404|not found/i.test(msg)) {
    return "No update feed is published yet. Upload latest.json with the release.";
  }
  return `Update check failed: ${msg}`;
}

async function checkForUpdates(manual = false) {
  if (updateBusy) return;

  const now = Date.now();
  const last = Number(localStorage.getItem(UPDATE_LAST_CHECK_KEY) ?? "0");
  if (!manual && last > 0 && now - last < UPDATE_CHECK_INTERVAL_MS) {
    return;
  }

  updateBusy = true;
  pendingUpdate = null;
  setUpdateActions(false, false);
  if (manual) setUpdateNotes(null);
  setUpdateStatus("busy", manual ? "Checking for updates..." : "Auto-checking for updates...");
  localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(now));

  try {
    const update = await check({ timeout: 15_000 });
    if (!update) {
      setUpdateStatus("ok", "Crimsnap is up to date.");
      if (manual) toast("No update available", "info");
      return;
    }

    pendingUpdate = update;
    const notes = changelogText(update);
    setUpdateStatus(
      "ok",
      `Crimsnap ${update.version} is available (you have ${update.currentVersion}).`,
    );
    setUpdateNotes(notes);
    setUpdateActions(true, false);
    toast(`Update ${update.version} available`, "info");

    if (!manual) {
      const yes = window.confirm(
        `Crimsnap ${update.version} is available.\n\nChangelog:\n${notes}\n\nDownload and install it now?`,
      );
      if (yes) {
        updateBusy = false;
        await installPendingUpdate();
      }
    }
  } catch (e) {
    const msg = updateErrorMessage(e);
    setUpdateStatus(manual ? "err" : "idle", manual ? msg : "Update check unavailable.");
    if (manual) toast(msg, "err");
  } finally {
    updateBusy = false;
  }
}

async function installPendingUpdate() {
  if (!pendingUpdate || updateBusy) return;

  const update = pendingUpdate;
  const notes = changelogText(update);
  const ok = window.confirm(
    `Install Crimsnap ${update.version}?\n\nChangelog:\n${notes}\n\nThe installer will run passively. Save any active recording first.`,
  );
  if (!ok) return;

  updateBusy = true;
  let downloaded = 0;
  let total = 0;
  setUpdateActions(false, false);
  setUpdateStatus("busy", `Downloading Crimsnap ${update.version}...`);
  setUpdateNotes(notes);

  try {
    await update.downloadAndInstall((event: DownloadEvent) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          setUpdateStatus(
            "busy",
            total > 0
              ? `Downloading ${formatBytes(total)}...`
              : "Downloading update...",
          );
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (total > 0) {
            const pct = Math.min(100, Math.round((downloaded / total) * 100));
            setUpdateStatus(
              "busy",
              `Downloading update... ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})`,
            );
          } else {
            setUpdateStatus("busy", `Downloading update... ${formatBytes(downloaded)}`);
          }
          break;
        case "Finished":
          setUpdateStatus("busy", "Download finished. Installing update...");
          break;
      }
    });

    setUpdateStatus("ok", "Update installed. Restart Crimsnap to finish.");
    setUpdateActions(false, true);
    toast("Update installed. Restart to finish.", "ok");
    const restart = window.confirm("Update installed. Restart Crimsnap now?");
    if (restart) await relaunch();
  } catch (e) {
    setUpdateStatus("err", `Update install failed: ${e}`);
    setUpdateActions(true, false);
    toast(`Update failed: ${e}`, "err");
  } finally {
    updateBusy = false;
  }
}

// ------------------------------------------------------------------- helpers

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string),
  );
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function monitorOptions(): SelectOpt[] {
  return state.monitors.map((m) => ({
    value: m.name,
    label: displayLabel(m),
  }));
}

function monitorLabelFor(name: string): string {
  const m = state.monitors.find((x) => x.name === name);
  return m ? displayLabel(m) : name;
}

function presetOptions(): SelectOpt[] {
  return [
    { value: "", label: "— pick a preset —" },
    ...state.presets.map((p) => ({ value: p.id, label: p.name })),
  ];
}

function effectiveFps(): number {
  const v = getSelect("fps");
  if (v === "custom") {
    const c = parseInt(($("fps-custom") as HTMLInputElement).value, 10);
    return c > 0 ? Math.min(c, 240) : 60;
  }
  return parseInt(v, 10) || 60;
}

function effectiveRes(): number {
  const v = getSelect("res");
  if (v === "custom") {
    const h = parseInt(($("res-h") as HTMLInputElement).value, 10);
    return h > 0 ? h : 0;
  }
  return parseInt(v, 10) || 0;
}

// ---------------------------------------------------------------- rendering

function renderRegions() {
  const list = $("regions-list");
  const empty = $("regions-empty");
  empty.classList.toggle("hidden", state.regions.length > 0);
  list.innerHTML = state.regions
    .map((r) => {
      const dims = r.windowTitle
        ? `<span class="region-dims" title="follows window">⊞ window</span>`
        : `<span class="region-dims">${r.rect.w}×${r.rect.h}</span>`;
      const monLabel = monitorLabelFor(r.monitor);
      const where = r.windowTitle
        ? `<span class="region-mon" title="${escapeHtml(r.windowTitle)}">${escapeHtml(
            r.windowTitle.length > 22 ? r.windowTitle.slice(0, 21) + "…" : r.windowTitle,
          )}</span>`
        : `<span class="region-mon" title="${escapeHtml(monLabel)}">${escapeHtml(
            monLabel.length > 28 ? monLabel.slice(0, 27) + "…" : monLabel,
          )}</span>`;
      return `
      <li class="region" data-id="${r.id}">
        <span class="region-grip">▰</span>
        <input class="region-name" data-id="${r.id}" value="${escapeHtml(r.name)}" maxlength="40" />
        ${dims}
        ${where}
        <button class="region-edit" data-action="edit" data-id="${r.id}" title="Edit">✎</button>
        <button class="region-remove" data-action="remove" data-id="${r.id}" title="Remove">✕</button>
      </li>`;
    })
    .join("");
  updateOutputBar();
}

function updateEncoderChip() {
  if (!state.settings) return;
  const enc = state.settings.encoder;
  let label = encoderLabel(enc);
  if (enc === "auto" && state.recommended) {
    label = `Auto · ${encoderLabel(state.recommended)}`;
  }
  $("encoder-chip-label").textContent = label;
}

function updateSavePaths() {
  const p = state.settings?.save_folder ?? "";
  $("save-path").textContent = p;
  $("set-save-path").textContent = p;
}

/** What size/fps/bitrate would this session actually produce right now? */
function primaryOutputDims(): { w: number; h: number } {
  const fs = ($("include-fullscreen") as HTMLInputElement | null)?.checked ?? false;
  // First region wins as the "primary"; fullscreen-only sessions fall back to monitor dims.
  const firstWinReg = state.regions.find((r) => !r.windowTitle);
  let w = 0, h = 0;
  if (firstWinReg) {
    w = firstWinReg.rect.w;
    h = firstWinReg.rect.h;
  } else if (fs) {
    const name = getSelect("fs-monitor");
    const m = state.monitors.find((x) => x.name === name) ?? state.monitors[0];
    if (m) {
      w = m.width;
      h = m.height;
    }
  } else if (state.regions.some((r) => r.windowTitle)) {
    return { w: 0, h: 0 }; // window region — size unknown until capture
  }
  // Apply downscale cap.
  const cap = effectiveRes();
  if (cap > 0 && h > cap) {
    w = Math.round((w * cap) / h) & ~1;
    h = cap;
  }
  return { w, h };
}

function updateOutputBar() {
  const fps = effectiveFps();
  const { w, h } = primaryOutputDims();
  const dimsLabel =
    w > 0 && h > 0
      ? `${w}×${h} @ ${fps}`
      : state.regions.some((r) => r.windowTitle)
        ? `window @ ${fps}`
        : `— @ ${fps}`;
  $("output-dims").textContent = dimsLabel;

  const q = state.settings?.quality ?? 20;
  const bps = w > 0 && h > 0 ? estimateBitrate(w, h, fps, q) : 0;
  $("output-bitrate").textContent = bps > 0 ? `~${bps} Mbps` : "—";

  // Audio chip.
  const wantsAudio =
    !!state.settings?.audio_enabled && !!state.settings?.audio_device;
  const audioChip = $("audio-chip");
  audioChip.classList.toggle("hidden", !wantsAudio);
  if (wantsAudio) {
    $("audio-chip-label").textContent = truncate(state.settings!.audio_device ?? "", 28);
  }
}

function updatePinButton() {
  const btn = $("btn-pin");
  if (!btn || !state.settings) return;
  btn.classList.toggle("pinned", state.settings.always_on_top);
  btn.title = state.settings.always_on_top
    ? "Pinned · click to unpin"
    : "Always on top";
}

async function togglePin() {
  if (!state.settings) return;
  const next = !state.settings.always_on_top;
  try {
    await api.setAlwaysOnTop(next);
    state.settings = { ...state.settings, always_on_top: next };
    updatePinButton();
    toast(next ? "Pinned on top" : "Unpinned", "info");
  } catch (e) {
    toast(`${e}`, "err");
  }
}

/**
 * Open the dim screen overlay and drag-to-mark a region. Hide the main window
 * first so a pinned/always-on-top Crimsnap window cannot cover the overlay.
 */
let snapRestoreFlag = false;
async function snapFromScreen(monitorOverride: string | null) {
  const monName = monitorOverride ?? getSelect("monitor") ?? null;
  const mon = state.monitors.find((m) => m.name === monName) ?? state.monitors[0];
  if (!mon) {
    toast("No monitors available", "err");
    return;
  }
  try {
    snapRestoreFlag = true;
    await appWin.hide();
    await api.openOverlay(mon.name);
    toast(`Snap → ${displayLabel(mon)} — drag to mark · Esc to cancel`, "info");
  } catch (e) {
    snapRestoreFlag = false;
    await appWin.show().catch(() => {});
    await appWin.setFocus().catch(() => {});
    toast(`Couldn't open snap overlay: ${e}`, "err");
  }
}

async function restoreFromSnap() {
  if (!snapRestoreFlag) return;
  snapRestoreFlag = false;
  try {
    await appWin.show();
    await appWin.setFocus();
  } catch {
    /* ignore */
  }
}

async function refreshAudioDevices() {
  try {
    state.audioDevices = await api.listAudioDevices(state.settings?.ffmpeg_path ?? null);
  } catch {
    state.audioDevices = [];
  }
  const options: SelectOpt[] = state.audioDevices.length
    ? state.audioDevices.map((d) => ({
        value: d.name,
        label: truncate(d.name, 36),
        sub: d.is_loopback_hint ? "system audio" : undefined,
      }))
    : [{ value: "", label: "No audio devices found" }];

  const cur = state.settings?.audio_device ?? "";
  const safe = options.find((o) => o.value === cur)
    ? cur
    : (state.audioDevices.find((d) => d.is_loopback_hint)?.name ??
       state.audioDevices[0]?.name ??
       "");
  if (selects.has("audio-device")) {
    setSelectOptions("audio-device", options, safe);
  } else {
    mountSelect("audio-device", options, safe, (v) => {
      void persistSettings({ audio_device: v || null });
      updateOutputBar();
    });
  }
  // Persist auto-pick only if the user already had a saved device that's gone
  // missing now — otherwise leave settings untouched so we don't pre-select
  // a microphone they never asked for.
  if (cur && !options.find((o) => o.value === cur)) {
    void persistSettings({ audio_device: safe || null });
  }
  updateOutputBar();
}

async function refreshWindows() {
  try {
    state.windows = await api.listWindows();
  } catch {
    state.windows = [];
  }
  const options: SelectOpt[] = state.windows.length
    ? state.windows.map((w) => ({
        value: w.title,
        label: truncate(w.title, 40),
        sub: `${w.width}×${w.height}`,
      }))
    : [{ value: "", label: "No top-level windows found" }];

  const cur = picker?.windowTitle ?? state.windows[0]?.title ?? "";
  if (selects.has("picker-window")) {
    setSelectOptions("picker-window", options, cur);
  } else {
    mountSelect("picker-window", options, cur, (v) => {
      if (!picker) return;
      const w = state.windows.find((x) => x.title === v);
      picker.windowTitle = v || null;
      if (w) {
        picker.rect = { x: w.x, y: w.y, w: w.width, h: w.height };
        if (!($("picker-window-name") as HTMLInputElement).value.trim()) {
          ($("picker-window-name") as HTMLInputElement).value =
            picker.name = truncate(w.title, 30);
        }
      }
    });
  }
  if (picker && cur && !picker.windowTitle) {
    picker.windowTitle = cur;
    const w = state.windows.find((x) => x.title === cur);
    if (w) picker.rect = { x: w.x, y: w.y, w: w.width, h: w.height };
  }
}

function setRecUi() {
  const rec = state.recording;
  const paused = state.paused;
  ($("btn-record") as HTMLButtonElement).disabled = rec;
  ($("btn-pause") as HTMLButtonElement).disabled = !rec;
  ($("btn-stop") as HTMLButtonElement).disabled = !rec;
  ($("add-region") as HTMLButtonElement).disabled = rec;
  const snap = document.getElementById("snap-screen") as HTMLButtonElement | null;
  if (snap) snap.disabled = rec;
  $("btn-pause").textContent = paused ? "▶ Resume" : "❚❚ Pause";
  const dot = $("rec-dot");
  dot.className = "rec-dot" + (rec && !paused ? " live" : paused ? " paused" : "");
  $("rec-label").textContent = rec ? (paused ? "Paused" : "Recording") : "Idle";
  $("shell").classList.toggle("is-recording", rec && !paused);
}

// ------------------------------------------------------------------- timer

let elapsedBase = 0;
let runningSince: number | null = null;
let timerHandle: number | null = null;

function tick() {
  const live = runningSince != null ? performance.now() - runningSince : 0;
  $("timer").textContent = fmtTime(elapsedBase + live);
}
function startTimer() {
  elapsedBase = 0;
  runningSince = performance.now();
  tick();
  if (timerHandle == null) timerHandle = window.setInterval(tick, 250);
}
function pauseTimer() {
  if (runningSince != null) {
    elapsedBase += performance.now() - runningSince;
    runningSince = null;
  }
}
function resumeTimer() {
  runningSince = performance.now();
}
function stopTimer() {
  if (timerHandle != null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  runningSince = null;
  elapsedBase = 0;
  $("timer").textContent = "00:00";
}

// ----------------------------------------------------------- region picker

interface PickerSession {
  mode: "screen" | "window";
  monitor: MonitorInfo;
  rect: { x: number; y: number; w: number; h: number }; // physical pixels
  name: string;
  windowTitle: string | null;
  editingId: string | null;
}
let picker: PickerSession | null = null;
type DragRect = { x: number; y: number; w: number; h: number };
let pickerDrag:
  | {
      mode: "create" | "move" | "resize";
      corner?: string;
      startX: number;
      startY: number;
      baseRect: DragRect;
    }
  | null = null;

async function openPicker(editId: string | null = null) {
  if (state.monitors.length === 0) {
    toast("No monitors found", "err");
    return;
  }
  const editing = editId ? state.regions.find((r) => r.id === editId) : null;
  const initialMonitorName =
    editing?.monitor ||
    state.settings?.default_monitor ||
    state.monitors.find((m) => m.primary)?.name ||
    state.monitors[0].name;
  const monitor =
    state.monitors.find((m) => m.name === initialMonitorName) ?? state.monitors[0];

  const editingWindow = editing?.windowTitle ?? null;
  picker = {
    mode: editingWindow ? "window" : "screen",
    monitor,
    rect: editing
      ? { x: editing.rect.x, y: editing.rect.y, w: editing.rect.w, h: editing.rect.h }
      : centerDefault(monitor),
    name: editing?.name ?? `Region ${state.regions.length + 1}`,
    windowTitle: editingWindow,
    editingId: editing?.id ?? null,
  };

  // Reflect the mode on the tab buttons + panes.
  document.querySelectorAll<HTMLButtonElement>(".pm-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === picker!.mode);
  });
  $("picker-screen-pane").classList.toggle("hidden", picker.mode !== "screen");
  $("picker-window-pane").classList.toggle("hidden", picker.mode !== "window");

  $("region-modal-title").textContent = editing ? "Edit region" : "Pick a region";
  ($("picker-save") as HTMLButtonElement).textContent = editing
    ? "Save changes"
    : "Add region";
  ($("picker-window-name") as HTMLInputElement).value = picker.name;

  setSelectOptions("picker-monitor", monitorOptions(), monitor.name);
  ($("picker-name") as HTMLInputElement).value = picker.name;
  $("region-modal").classList.remove("hidden");
  syncPickerInputs();

  if (picker.mode === "window") {
    await refreshWindows();
  } else {
    await loadMonitorSnapshot(monitor.name);
  }
}

function centerDefault(mon: MonitorInfo) {
  const w = Math.min(1280, mon.width - 200);
  const h = Math.min(720, mon.height - 200);
  return {
    x: mon.x + Math.floor((mon.width - w) / 2),
    y: mon.y + Math.floor((mon.height - h) / 2),
    w,
    h,
  };
}

function closePicker() {
  $("region-modal").classList.add("hidden");
  picker = null;
  pickerDrag = null;
}

async function loadMonitorSnapshot(monitorName: string) {
  $("picker-loading").classList.remove("hidden");
  $("picker-loading").textContent = "Capturing monitor…";
  const frame = $("picker-frame");
  frame.style.backgroundImage = "";
  // Match the frame's aspect ratio to the monitor's.
  const mon = state.monitors.find((m) => m.name === monitorName);
  if (mon) frame.style.aspectRatio = `${mon.width} / ${mon.height}`;
  try {
    const path = await api.snapshotMonitor(monitorName);
    const url = convertFileSrc(path);
    // Force-load so any error throws before we hide the loading text.
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = url;
    });
    frame.style.backgroundImage = `url(${JSON.stringify(url)})`;
    $("picker-loading").classList.add("hidden");
  } catch (e) {
    $("picker-loading").textContent = `Couldn't snapshot: ${e}`;
  }
  drawPickerRect();
}

function frameSize() {
  const frame = $("picker-frame");
  return { w: frame.clientWidth, h: frame.clientHeight };
}

function physToFrame(px: number, py: number, pw: number, ph: number) {
  if (!picker) return { x: 0, y: 0, w: 0, h: 0 };
  const fs = frameSize();
  const sx = fs.w / picker.monitor.width;
  const sy = fs.h / picker.monitor.height;
  return {
    x: (px - picker.monitor.x) * sx,
    y: (py - picker.monitor.y) * sy,
    w: pw * sx,
    h: ph * sy,
  };
}

function frameToPhys(fx: number, fy: number, fw: number, fh: number) {
  if (!picker) return { x: 0, y: 0, w: 0, h: 0 };
  const fs = frameSize();
  const sx = picker.monitor.width / fs.w;
  const sy = picker.monitor.height / fs.h;
  return {
    x: Math.round(picker.monitor.x + fx * sx),
    y: Math.round(picker.monitor.y + fy * sy),
    w: Math.max(2, Math.round(fw * sx)) & ~1,
    h: Math.max(2, Math.round(fh * sy)) & ~1,
  };
}

function drawPickerRect() {
  if (!picker) return;
  const rect = $("picker-rect");
  const fs = frameSize();
  if (fs.w === 0) return;
  const f = physToFrame(picker.rect.x, picker.rect.y, picker.rect.w, picker.rect.h);
  // Clamp inside the frame
  const x = Math.max(0, Math.min(f.x, fs.w - 4));
  const y = Math.max(0, Math.min(f.y, fs.h - 4));
  const w = Math.max(4, Math.min(f.w, fs.w - x));
  const h = Math.max(4, Math.min(f.h, fs.h - y));
  rect.hidden = false;
  rect.style.left = `${x}px`;
  rect.style.top = `${y}px`;
  rect.style.width = `${w}px`;
  rect.style.height = `${h}px`;
  rect.querySelector(".rect-label")!.textContent = `${picker.rect.w} × ${picker.rect.h}`;
}

function syncPickerInputs() {
  if (!picker) return;
  ($("picker-x") as HTMLInputElement).value = String(picker.rect.x - picker.monitor.x);
  ($("picker-y") as HTMLInputElement).value = String(picker.rect.y - picker.monitor.y);
  ($("picker-w") as HTMLInputElement).value = String(picker.rect.w);
  ($("picker-h") as HTMLInputElement).value = String(picker.rect.h);
  drawPickerRect();
}

function pickerInputsToRect() {
  if (!picker) return;
  const x = Math.max(0, parseInt(($("picker-x") as HTMLInputElement).value, 10) || 0);
  const y = Math.max(0, parseInt(($("picker-y") as HTMLInputElement).value, 10) || 0);
  const w = Math.max(2, parseInt(($("picker-w") as HTMLInputElement).value, 10) || 2);
  const h = Math.max(2, parseInt(($("picker-h") as HTMLInputElement).value, 10) || 2);
  const cx = Math.min(x, picker.monitor.width - 2);
  const cy = Math.min(y, picker.monitor.height - 2);
  const cw = Math.min(w, picker.monitor.width - cx) & ~1;
  const ch = Math.min(h, picker.monitor.height - cy) & ~1;
  picker.rect = { x: picker.monitor.x + cx, y: picker.monitor.y + cy, w: cw, h: ch };
  drawPickerRect();
}

function wirePicker() {
  const frame = $("picker-frame");
  const rect = $("picker-rect");

  // Click+drag on empty area = create a new rect.
  frame.addEventListener("mousedown", (e) => {
    if (!picker) return;
    if ((e.target as HTMLElement).closest(".picker-rect")) return;
    const fs = frameSize();
    const r = frame.getBoundingClientRect();
    const fx = e.clientX - r.left;
    const fy = e.clientY - r.top;
    if (fx < 0 || fy < 0 || fx > fs.w || fy > fs.h) return;
    const start = frameToPhys(fx, fy, 0, 0);
    picker.rect = { x: start.x, y: start.y, w: 2, h: 2 };
    pickerDrag = {
      mode: "create",
      startX: e.clientX,
      startY: e.clientY,
      baseRect: { ...picker.rect },
    };
    drawPickerRect();
    syncPickerInputs();
    e.preventDefault();
  });

  // Drag the rect itself to move.
  rect.addEventListener("mousedown", (e) => {
    if (!picker) return;
    if ((e.target as HTMLElement).classList.contains("handle")) return;
    pickerDrag = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      baseRect: { ...picker.rect },
    };
    e.preventDefault();
    e.stopPropagation();
  });

  // Drag the corner handles to resize.
  rect.querySelectorAll<HTMLElement>(".handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      if (!picker) return;
      const cls = Array.from(handle.classList).find((c) => c.startsWith("h-")) ?? "h-br";
      pickerDrag = {
        mode: "resize",
        corner: cls,
        startX: e.clientX,
        startY: e.clientY,
        baseRect: { ...picker.rect },
      };
      e.preventDefault();
      e.stopPropagation();
    });
  });

  window.addEventListener("mousemove", (e) => {
    if (!picker || !pickerDrag) return;
    const fs = frameSize();
    if (fs.w === 0) return;
    const sx = picker.monitor.width / fs.w;
    const sy = picker.monitor.height / fs.h;
    const dx = Math.round((e.clientX - pickerDrag.startX) * sx);
    const dy = Math.round((e.clientY - pickerDrag.startY) * sy);
    const m = picker.monitor;
    const base = pickerDrag.baseRect;
    if (pickerDrag.mode === "move") {
      let nx = base.x + dx;
      let ny = base.y + dy;
      nx = Math.max(m.x, Math.min(nx, m.x + m.width - base.w));
      ny = Math.max(m.y, Math.min(ny, m.y + m.height - base.h));
      picker.rect = { x: nx, y: ny, w: base.w, h: base.h };
    } else if (pickerDrag.mode === "create") {
      const x = Math.max(m.x, Math.min(base.x + dx, base.x));
      const y = Math.max(m.y, Math.min(base.y + dy, base.y));
      const w = Math.max(2, Math.abs(dx)) & ~1;
      const h = Math.max(2, Math.abs(dy)) & ~1;
      picker.rect = {
        x: dx >= 0 ? base.x : Math.max(m.x, base.x + dx),
        y: dy >= 0 ? base.y : Math.max(m.y, base.y + dy),
        w: Math.min(w, m.x + m.width - x),
        h: Math.min(h, m.y + m.height - y),
      };
    } else if (pickerDrag.mode === "resize") {
      let nx = base.x, ny = base.y, nw = base.w, nh = base.h;
      const c = pickerDrag.corner!;
      if (c === "h-br") { nw = base.w + dx; nh = base.h + dy; }
      if (c === "h-tr") { nw = base.w + dx; ny = base.y + dy; nh = base.h - dy; }
      if (c === "h-bl") { nx = base.x + dx; nw = base.w - dx; nh = base.h + dy; }
      if (c === "h-tl") { nx = base.x + dx; ny = base.y + dy; nw = base.w - dx; nh = base.h - dy; }
      nw = Math.max(20, nw) & ~1;
      nh = Math.max(20, nh) & ~1;
      nx = Math.max(m.x, Math.min(nx, m.x + m.width - nw));
      ny = Math.max(m.y, Math.min(ny, m.y + m.height - nh));
      nw = Math.min(nw, m.x + m.width - nx);
      nh = Math.min(nh, m.y + m.height - ny);
      picker.rect = { x: nx, y: ny, w: nw, h: nh };
    }
    drawPickerRect();
    syncPickerInputs();
  });

  window.addEventListener("mouseup", () => {
    pickerDrag = null;
  });

  // Numeric inputs.
  ["picker-x", "picker-y", "picker-w", "picker-h"].forEach((id) => {
    ($(id) as HTMLInputElement).addEventListener("input", pickerInputsToRect);
  });
  ($("picker-name") as HTMLInputElement).addEventListener("input", (e) => {
    if (picker) picker.name = (e.target as HTMLInputElement).value;
  });

  // Quick presets.
  document.querySelectorAll<HTMLButtonElement>("[data-snap]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!picker) return;
      const m = picker.monitor;
      switch (b.dataset.snap) {
        case "center-720": {
          const w = Math.min(1280, m.width - 80) & ~1;
          const h = Math.min(720, m.height - 80) & ~1;
          picker.rect = { x: m.x + ((m.width - w) >> 1), y: m.y + ((m.height - h) >> 1), w, h };
          break;
        }
        case "center-480": {
          const w = Math.min(854, m.width - 80) & ~1;
          const h = Math.min(480, m.height - 80) & ~1;
          picker.rect = { x: m.x + ((m.width - w) >> 1), y: m.y + ((m.height - h) >> 1), w, h };
          break;
        }
        case "full": {
          picker.rect = { x: m.x, y: m.y, w: m.width & ~1, h: m.height & ~1 };
          break;
        }
      }
      syncPickerInputs();
    });
  });

  $("region-modal-close").addEventListener("click", closePicker);
  $("picker-cancel").addEventListener("click", closePicker);
  $("region-modal").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("modal-backdrop")) closePicker();
  });
  $("picker-refresh").addEventListener("click", () => {
    if (picker) void loadMonitorSnapshot(picker.monitor.name);
  });
  $("picker-snap-screen").addEventListener("click", async () => {
    if (!picker) return;
    const mon = picker.monitor.name;
    closePicker();
    await snapFromScreen(mon);
  });
  $("picker-save").addEventListener("click", commitPicker);

  window.addEventListener("resize", () => {
    if (picker) drawPickerRect();
  });
}

function commitPicker() {
  if (!picker) return;
  const nameInput =
    picker.mode === "window"
      ? ($("picker-window-name") as HTMLInputElement).value
      : picker.name;
  const name = (nameInput || "Region").trim() || "Region";
  const windowTitle = picker.mode === "window" ? picker.windowTitle : null;

  if (picker.mode === "window" && !windowTitle) {
    toast("Pick a window first", "err");
    return;
  }

  const rect: Rect =
    picker.mode === "window"
      ? // For windows the rect is a hint (size at pick-time) — used for the UI label.
        {
          x: 0,
          y: 0,
          w: picker.rect.w || 0,
          h: picker.rect.h || 0,
        }
      : picker.rect;

  if (picker.editingId) {
    const r = state.regions.find((x) => x.id === picker!.editingId);
    if (r) {
      r.name = name;
      r.rect = rect;
      r.monitor = picker.monitor.name;
      r.windowTitle = windowTitle;
    }
  } else {
    state.regions.push({
      id: crypto.randomUUID(),
      name,
      rect,
      monitor: picker.monitor.name,
      windowTitle,
    });
  }
  renderRegions();
  closePicker();
  updateOutputBar();
  toast(
    windowTitle
      ? `Window region · "${truncate(windowTitle, 26)}"`
      : `Region · ${rect.w}×${rect.h}`,
    "ok",
  );
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// --------------------------------------------------------- record lifecycle

async function startRecording() {
  const s = state.settings;
  if (!s) return;
  const fps = effectiveFps();
  const res = effectiveRes();
  const includeFs = ($("include-fullscreen") as HTMLInputElement).checked;
  const fsMon = getSelect("fs-monitor") || null;

  if (state.regions.length === 0 && !includeFs) {
    toast("Add a region or enable full screen first", "err");
    return;
  }

  const audio_device =
    s.audio_enabled && s.audio_device ? s.audio_device : null;

  try {
    await api.startRecording({
      regions: state.regions.map((r) => ({
        name: r.name,
        rect: r.rect,
        window_title: r.windowTitle ?? null,
      })),
      include_fullscreen: includeFs,
      fullscreen_monitor: fsMon,
      fps,
      encoder:
        s.encoder === "auto" ? state.recommended ?? "libx264" : s.encoder,
      quality: s.quality,
      max_height: res > 0 ? res : null,
      backend: s.backend,
      show_cursor: s.show_cursor,
      save_root: s.save_folder,
      label: "session",
      ffmpeg_path: s.ffmpeg_path,
      audio_device,
    });
    state.recording = true;
    state.paused = false;
    setRecUi();
    startTimer();
    $("last-saved").classList.add("hidden");
    toast("Recording started", "ok");
  } catch (e) {
    toast(`${e}`, "err");
  }
}

async function togglePause() {
  try {
    if (state.paused) {
      await api.resumeRecording();
      state.paused = false;
      resumeTimer();
      toast("Resumed", "info");
    } else {
      await api.pauseRecording();
      state.paused = true;
      pauseTimer();
      toast("Paused", "info");
    }
    setRecUi();
  } catch (e) {
    toast(`${e}`, "err");
  }
}

async function stopRecording() {
  try {
    const result = await api.stopRecording();
    state.recording = false;
    state.paused = false;
    setRecUi();
    pauseTimer();
    const finalMs = elapsedBase;
    stopTimer();
    showLastSaved(result, finalMs);
    toast(`Saved ${result.files.length} file(s)`, "ok");
  } catch (e) {
    toast(`${e}`, "err");
  }
}

function showLastSaved(result: RecResult, ms: number) {
  const box = $("last-saved");
  box.classList.remove("hidden");
  const count = result.files.length;
  box.innerHTML = `
    <div class="ls-head">✓ Saved · ${count} clip${count === 1 ? "" : "s"} · ${fmtTime(ms)}</div>
    <code class="path">${escapeHtml(result.root)}</code>
    <div class="ls-actions">
      <button id="ls-open" class="btn ghost small">Open folder</button>
      ${
        result.files[0]
          ? `<button id="ls-reveal" class="btn ghost small">Reveal first clip</button>`
          : ""
      }
    </div>`;
  $("ls-open").addEventListener("click", () => void openPath(result.root));
  const reveal = document.getElementById("ls-reveal");
  reveal?.addEventListener("click", () => void revealItemInDir(result.files[0]));
}

// -------------------------------------------------------------- presets

async function savePresetFlow() {
  const name = window.prompt("Preset name:", "");
  if (!name) return;
  const includeFs = ($("include-fullscreen") as HTMLInputElement).checked;
  const fsMon = getSelect("fs-monitor") || null;
  const preset: Preset = {
    id: "",
    name,
    regions: state.regions.map((r) => ({
      name: r.name,
      rect: r.rect,
      monitor: r.monitor,
    })),
    include_fullscreen: includeFs,
    fullscreen_monitor: fsMon,
    fps: effectiveFps(),
    encoder: state.settings?.encoder ?? null,
    quality: state.settings?.quality ?? null,
  };
  try {
    await api.savePreset(preset);
    state.presets = await api.listPresets();
    setSelectOptions("preset", presetOptions(), preset.id || "");
    toast(`Preset “${name}” saved`, "ok");
  } catch (e) {
    toast(`${e}`, "err");
  }
}

function loadPreset() {
  const id = getSelect("preset");
  const p = state.presets.find((x) => x.id === id);
  if (!p) {
    toast("Pick a preset first", "info");
    return;
  }
  state.regions = p.regions.map((r) => ({
    id: crypto.randomUUID(),
    name: r.name,
    rect: r.rect,
    monitor: r.monitor ?? "",
  }));
  renderRegions();
  ($("include-fullscreen") as HTMLInputElement).checked = p.include_fullscreen;
  if (p.fullscreen_monitor) setSelect("fs-monitor", p.fullscreen_monitor);
  if (p.fps) setSelect("fps", String(p.fps), true);
  toast(`Loaded “${p.name}”`, "ok");
}

async function exportConfigFlow() {
  const picked = await saveDialog({
    defaultPath: "crimsnap-config.crimsnap.json",
    filters: [{ name: "Crimsnap config", extensions: ["json"] }],
  });
  if (typeof picked !== "string") return;
  const regions = state.regions.map((r) => ({
    name: r.name,
    rect: r.rect,
    monitor: r.monitor || null,
    window_title: r.windowTitle ?? null,
  }));
  try {
    const path = await api.exportConfig(picked, regions);
    toast(`Exported · ${truncate(path, 40)}`, "ok");
  } catch (e) {
    toast(`Export failed: ${e}`, "err");
  }
}

async function importConfigFlow() {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "Crimsnap config", extensions: ["json"] }],
  });
  if (typeof picked !== "string") return;
  if (
    state.regions.length > 0 &&
    !window.confirm(
      "Importing will replace the current regions, presets, and settings. Continue?"
    )
  ) {
    return;
  }
  try {
    const imported = await api.importConfig(picked);
    state.settings = imported.settings;
    state.presets = imported.presets;
    state.regions = imported.regions.map((r) => ({
      id: crypto.randomUUID(),
      name: r.name,
      rect: r.rect,
      monitor: r.monitor ?? "",
      windowTitle: r.window_title ?? null,
    }));
    setSelectOptions("preset", presetOptions(), "");
    renderRegions();
    updateEncoderChip();
    updateSavePaths();
    updateOutputBar();
    updatePinButton();
    toast(`Imported ${imported.regions.length} region(s), ${imported.presets.length} preset(s)`, "ok");
  } catch (e) {
    toast(`Import failed: ${e}`, "err");
  }
}

async function deletePreset() {
  const id = getSelect("preset");
  if (!id) return;
  const p = state.presets.find((x) => x.id === id);
  if (!p || !window.confirm(`Delete preset “${p.name}”?`)) return;
  try {
    await api.deletePreset(id);
    state.presets = await api.listPresets();
    setSelectOptions("preset", presetOptions(), "");
    toast("Preset deleted", "info");
  } catch (e) {
    toast(`${e}`, "err");
  }
}

// -------------------------------------------------------------- settings

async function persistSettings(partial: Partial<Settings>) {
  if (!state.settings) return;
  state.settings = { ...state.settings, ...partial };
  try {
    state.settings = await api.saveSettings(state.settings);
    updateEncoderChip();
    updateSavePaths();
  } catch (e) {
    toast(`Couldn't save settings: ${e}`, "err");
  }
}

async function probeFfmpegFlow() {
  const status = $("ffmpeg-status");
  status.textContent = "Testing…";
  status.className = "ffmpeg-status";
  try {
    const probe = await api.probeFfmpeg();
    if (!probe.found) {
      status.className = "ffmpeg-status bad";
      status.textContent = `Not found (${probe.bin}). Install ffmpeg or set a path.`;
      return;
    }
    state.recommended = probe.recommended;
    state.availableEncoders = probe.encoders.length ? probe.encoders : ["libx264"];
    repopulateEncoderSelect();
    updateEncoderChip();
    status.className = "ffmpeg-status good";
    const rec = probe.recommended
      ? ` · best working: ${encoderLabel(probe.recommended)}`
      : "";
    status.textContent = `✓ ${probe.version ?? "ffmpeg"}${rec}`;
  } catch (e) {
    status.className = "ffmpeg-status bad";
    status.textContent = `${e}`;
  }
}

function repopulateEncoderSelect() {
  const options: SelectOpt[] = [
    { value: "auto", label: "Auto", sub: "best on this PC" },
    ...state.availableEncoders.map((e) => ({ value: e, label: encoderLabel(e) })),
  ];
  const want = state.settings?.encoder ?? "auto";
  const safe = options.find((o) => o.value === want)?.value ?? "auto";
  if (safe !== want) void persistSettings({ encoder: safe });
  setSelectOptions("encoder", options, safe);
}

async function browseSaveFolder() {
  const picked = await openDialog({
    directory: true,
    defaultPath: state.settings?.save_folder || undefined,
  });
  if (typeof picked === "string") {
    await persistSettings({ save_folder: picked });
    toast("Save folder updated", "ok");
  }
}

async function browseFfmpeg() {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "ffmpeg", extensions: ["exe"] }],
  });
  if (typeof picked === "string") {
    ($("set-ffmpeg") as HTMLInputElement).value = picked;
    await persistSettings({ ffmpeg_path: picked });
    void probeFfmpegFlow();
  }
}

// --------------------------------------------------------------------- bind

function bind() {
  $("btn-min").addEventListener("click", () => void appWin.minimize());
  $("btn-close").addEventListener("click", () => void appWin.close());

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      $("panel-capture").classList.toggle("hidden", which !== "capture");
      $("panel-settings").classList.toggle("hidden", which !== "settings");
    });
  });

  // Region buttons.
  $("add-region").addEventListener("click", () => openPicker(null));
  $("btn-record").addEventListener("click", startRecording);
  $("btn-pause").addEventListener("click", togglePause);
  $("btn-stop").addEventListener("click", stopRecording);

  // Region list — edit/remove/rename (delegated).
  $("regions-list").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id!;
    if (btn.dataset.action === "remove") {
      state.regions = state.regions.filter((r) => r.id !== id);
      renderRegions();
    } else if (btn.dataset.action === "edit") {
      void openPicker(id);
    }
  });
  $("regions-list").addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains("region-name")) return;
    const r = state.regions.find((x) => x.id === input.dataset.id);
    if (r) r.name = input.value;
  });

  // Save folder.
  $("browse-save").addEventListener("click", browseSaveFolder);
  $("set-browse-save").addEventListener("click", browseSaveFolder);
  $("open-folder").addEventListener("click", () => {
    if (state.settings?.save_folder) void openPath(state.settings.save_folder);
  });

  // Presets.
  $("save-preset").addEventListener("click", savePresetFlow);
  $("load-preset").addEventListener("click", loadPreset);
  $("delete-preset").addEventListener("click", deletePreset);
  $("export-config").addEventListener("click", exportConfigFlow);
  $("import-config").addEventListener("click", importConfigFlow);

  // Settings — checkboxes + ffmpeg.
  ($("set-cursor") as HTMLInputElement).addEventListener("change", (e) =>
    persistSettings({ show_cursor: (e.target as HTMLInputElement).checked })
  );
  ($("set-audio-enabled") as HTMLInputElement).addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    void persistSettings({ audio_enabled: on });
    updateOutputBar();
  });
  $("refresh-audio").addEventListener("click", refreshAudioDevices);

  // Window controls — pin, snap shortcut.
  $("btn-pin").addEventListener("click", togglePin);
  $("snap-screen").addEventListener("click", () => void snapFromScreen(null));

  // Picker mode tabs (screen rect vs window).
  document.querySelectorAll<HTMLButtonElement>(".pm-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".pm-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const mode = b.dataset.mode;
      $("picker-screen-pane").classList.toggle("hidden", mode !== "screen");
      $("picker-window-pane").classList.toggle("hidden", mode !== "window");
      if (picker) picker.mode = mode === "window" ? "window" : "screen";
      if (mode === "window") void refreshWindows();
    });
  });
  $("picker-window-refresh").addEventListener("click", refreshWindows);
  ($("set-ffmpeg") as HTMLInputElement).addEventListener("change", (e) =>
    persistSettings({ ffmpeg_path: (e.target as HTMLInputElement).value || null })
  );
  $("set-browse-ffmpeg").addEventListener("click", browseFfmpeg);
  $("probe-ffmpeg").addEventListener("click", probeFfmpegFlow);
  $("check-updates").addEventListener("click", () => void checkForUpdates(true));
  $("install-update").addEventListener("click", () => void installPendingUpdate());
  $("restart-update").addEventListener("click", () => void relaunch());

  // Custom resolution width/height.
  ["res-w", "res-h"].forEach((id) =>
    ($(id) as HTMLInputElement).addEventListener("change", () => {
      void persistSettings({ resolution: effectiveRes() });
    })
  );
  ($("fps-custom") as HTMLInputElement).addEventListener("change", () =>
    persistSettings({ fps: effectiveFps() })
  );

  wirePicker();
}

// -------------------------------------------------------------- init

async function init() {
  bind();

  window.addEventListener("keydown", (e) => {
    if (e.key === "F9") {
      if (state.recording) void stopRecording();
      else void startRecording();
    }
    if (e.key === "Escape" && !$("region-modal").classList.contains("hidden")) {
      closePicker();
    }
  });

  // Load settings + monitors + presets.
  try {
    state.settings = await api.getSettings();
  } catch (e) {
    toast(`Failed to load settings: ${e}`, "err");
    state.settings = {
      save_folder: "",
      fps: 60,
      encoder: "auto",
      quality: 20,
      resolution: 0,
      backend: "gdigrab",
      show_cursor: true,
      default_monitor: null,
      ffmpeg_path: null,
      always_on_top: false,
      audio_device: null,
      audio_enabled: false,
    };
  }
  try {
    state.monitors = await api.listMonitors();
  } catch (e) {
    toast(`Failed to read monitors: ${e}`, "err");
  }
  try {
    state.presets = await api.listPresets();
  } catch {
    /* non-fatal */
  }

  // A local non-null reference — TS can't narrow `state.settings` across awaits,
  // but it's guaranteed non-null past this point.
  const s = state.settings!;
  const defaultMon =
    s.default_monitor ||
    state.monitors.find((m) => m.primary)?.name ||
    state.monitors[0]?.name ||
    "";

  // Mount all custom dropdowns now that we have data.
  mountSelect("monitor", monitorOptions(), defaultMon, (v) => {
    void persistSettings({ default_monitor: v });
  });
  mountSelect("fs-monitor", monitorOptions(), defaultMon, () => updateOutputBar());
  ($("include-fullscreen") as HTMLInputElement).addEventListener("change", updateOutputBar);
  ["res-w", "res-h", "fps-custom"].forEach((id) =>
    ($(id) as HTMLInputElement).addEventListener("input", updateOutputBar)
  );
  mountSelect("picker-monitor", monitorOptions(), defaultMon, (v) => {
    if (!picker) return;
    const m = state.monitors.find((x) => x.name === v);
    if (!m) return;
    picker.monitor = m;
    picker.rect = centerDefault(m);
    syncPickerInputs();
    void loadMonitorSnapshot(v);
  });
  mountSelect("fps", FPS_OPTIONS, fpsToValue(s.fps), (v) => {
    $("custom-fps-field").classList.toggle("hidden", v !== "custom");
    if (v === "custom") ($("fps-custom") as HTMLInputElement).focus();
    void persistSettings({ fps: effectiveFps() });
    updateOutputBar();
  });

  // Quality preset dropdown (replaces the raw QP slider).
  const qualityOptions: SelectOpt[] = QUALITY_PRESETS.map((p) => ({
    value: String(p.value),
    label: p.label,
    sub: p.sub,
  }));
  const initialQp = s.quality;
  const matchedQp =
    qualityOptions.find((o) => Number(o.value) === initialQp)?.value ??
    qualityOptions.reduce((best, o) =>
      Math.abs(Number(o.value) - initialQp) <
      Math.abs(Number(best.value) - initialQp)
        ? o
        : best
    ).value;
  mountSelect("quality", qualityOptions, matchedQp, (v) => {
    const q = parseInt(v, 10);
    if (!Number.isNaN(q)) {
      void persistSettings({ quality: q });
      updateOutputBar();
    }
  });
  ($("fps-custom") as HTMLInputElement).value = String(s.fps);
  if (fpsToValue(s.fps) === "custom") {
    $("custom-fps-field").classList.remove("hidden");
  }

  mountSelect("res", RES_OPTIONS, resToValue(s.resolution), (v) => {
    $("custom-res-fields").classList.toggle("hidden", v !== "custom");
    if (v === "custom") ($("res-h") as HTMLInputElement).focus();
    void persistSettings({ resolution: effectiveRes() });
    updateOutputBar();
  });
  if (s.resolution > 0) {
    ($("res-h") as HTMLInputElement).value = String(s.resolution);
    // Width left blank (we cap by height; width auto-scales) but visible.
  }
  if (resToValue(s.resolution) === "custom") {
    $("custom-res-fields").classList.remove("hidden");
  }

  mountSelect("backend", BACKEND_OPTIONS, s.backend, (v) => {
    void persistSettings({ backend: v });
  });
  mountSelect("encoder", [{ value: "auto", label: "Auto" }], s.encoder, (v) => {
    void persistSettings({ encoder: v });
  });
  mountSelect("preset", presetOptions(), "");

  // Settings form values.
  ($("set-cursor") as HTMLInputElement).checked = s.show_cursor;
  ($("set-audio-enabled") as HTMLInputElement).checked = s.audio_enabled;
  ($("set-ffmpeg") as HTMLInputElement).value = s.ffmpeg_path ?? "";

  // Audio devices — list once at startup, can be refreshed from settings.
  void refreshAudioDevices();

  // Apply pin state from saved settings.
  updatePinButton();

  renderRegions();
  updateEncoderChip();
  updateSavePaths();
  updateOutputBar();
  setRecUi();

  // Sync with any in-flight recording (e.g. after a reload).
  try {
    const status = await api.recordingStatus();
    if (status.recording) {
      state.recording = true;
      state.paused = status.paused;
      setRecUi();
      elapsedBase = status.elapsed_ms;
      if (!status.paused) {
        runningSince = performance.now();
        timerHandle = window.setInterval(tick, 250);
      } else {
        tick();
      }
    }
  } catch {
    /* ignore */
  }

  // Probe ffmpeg in the background — fills the encoder list.
  void probeFfmpegFlow();
  void checkForUpdates(false);

  // Overlay round-trip (when the user picks "or pick on actual screen").
  await listen<SelectedRegion>("region:selected", async (e) => {
    const r = e.payload;
    state.regions.push({
      id: crypto.randomUUID(),
      name: `Region ${state.regions.length + 1}`,
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      monitor: r.monitor,
    });
    renderRegions();
    toast(`Region · ${r.w}×${r.h}`, "ok");
    await restoreFromSnap();
  });
  await listen("region:cancelled", async () => {
    toast("Selection cancelled", "info");
    await restoreFromSnap();
  });
}

function fpsToValue(fps: number): string {
  return FPS_OPTIONS.find((o) => o.value === String(fps)) ? String(fps) : "custom";
}
function resToValue(res: number): string {
  return RES_OPTIONS.find((o) => o.value === String(res)) ? String(res) : "custom";
}

init();

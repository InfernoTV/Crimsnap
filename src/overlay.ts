import { invoke } from "@tauri-apps/api/core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sel = $<HTMLDivElement>("sel");
const badge = $<HTMLDivElement>("badge");
const hLine = $<HTMLDivElement>("h-line");
const vLine = $<HTMLDivElement>("v-line");

let startX = 0;
let startY = 0;
let dragging = false;
let done = false;

const dpr = () => window.devicePixelRatio || 1;
const clampPos = (v: number, max: number) => Math.max(0, Math.min(v, max));

function geom(e: MouseEvent) {
  const x = clampPos(e.clientX, window.innerWidth);
  const y = clampPos(e.clientY, window.innerHeight);
  const left = Math.min(startX, x);
  const top = Math.min(startY, y);
  const w = Math.abs(x - startX);
  const h = Math.abs(y - startY);
  return { left, top, w, h };
}

function drawSelection(e: MouseEvent) {
  const { left, top, w, h } = geom(e);
  sel.style.left = `${left}px`;
  sel.style.top = `${top}px`;
  sel.style.width = `${w}px`;
  sel.style.height = `${h}px`;

  const pw = Math.round(w * dpr());
  const ph = Math.round(h * dpr());
  badge.textContent = `${pw} × ${ph}`;
  badge.style.display = "block";
  // Park the badge just above the selection (or below if near the top edge).
  const bx = clampPos(left, window.innerWidth - 90);
  const by = top > 28 ? top - 26 : top + h + 8;
  badge.style.left = `${bx}px`;
  badge.style.top = `${by}px`;
}

function drawCrosshair(e: MouseEvent) {
  hLine.style.top = `${e.clientY}px`;
  vLine.style.left = `${e.clientX}px`;
}

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || done) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  document.body.classList.add("dragging");
  sel.style.display = "block";
  drawSelection(e);
});

window.addEventListener("mousemove", (e) => {
  if (dragging) drawSelection(e);
  else drawCrosshair(e);
});

window.addEventListener("mouseup", async (e) => {
  if (!dragging || done) return;
  dragging = false;
  const { left, top, w, h } = geom(e);

  // A tiny drag = an accidental click → bail out.
  if (w < 4 || h < 4) {
    void invoke("cancel_region_selection");
    return;
  }

  done = true;
  sel.classList.add("flash");

  const d = dpr();
  const payload = {
    x: Math.round(left * d),
    y: Math.round(top * d),
    w: Math.round(w * d),
    h: Math.round(h * d),
  };
  // Brief flash so the selection visibly "lands" before the overlay closes.
  setTimeout(() => void invoke("finish_region_selection", payload), 120);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    done = true;
    void invoke("cancel_region_selection");
  }
});

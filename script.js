// Seed localStorage from SEED_DATA on first visit. Runs before any other code touches
// localStorage so the whole app initializes from the seeded values as if they'd always
// been there. Anonymous itch visitors get the full authored library on first load.
(function seedFromShippedData() {
  if (typeof SEED_DATA === "undefined") return;
  try {
    if (!localStorage.getItem("picross.puzzles") && SEED_DATA.puzzles) {
      localStorage.setItem("picross.puzzles", JSON.stringify(SEED_DATA.puzzles));
    }
    if (!localStorage.getItem("picross.library") && SEED_DATA.library) {
      localStorage.setItem("picross.library", JSON.stringify(SEED_DATA.library));
    }
    // Merge: for existing users with stored puzzles, fill in metadata fields
    // (fact, source, factSource) that are empty but exist in the current seed.
    // Never overwrites user data — only fills gaps. This is how metadata updates
    // reach existing itch visitors without losing their progress.
    if (SEED_DATA.puzzles) {
      const stored = JSON.parse(localStorage.getItem("picross.puzzles") || "{}");
      let touched = false;
      for (const pid of Object.keys(SEED_DATA.puzzles)) {
        const target = stored[pid];
        const seed = SEED_DATA.puzzles[pid];
        if (!target || !seed) continue;
        if (!(target.fact || "").trim() && seed.fact) { target.fact = seed.fact; touched = true; }
        if (!target.factSource && seed.factSource) { target.factSource = seed.factSource; touched = true; }
        const targetSrc = target.source || {};
        const seedSrc = seed.source || {};
        const targetUrl = (targetSrc.url || "").trim();
        if (!targetUrl && seedSrc.url) {
          target.source = { url: seedSrc.url, attribution: targetSrc.attribution || seedSrc.attribution || "" };
          touched = true;
        }
      }
      if (touched) localStorage.setItem("picross.puzzles", JSON.stringify(stored));
    }
    // Completed state is intentionally NOT seeded — every new visitor starts fresh.
  } catch {}
})();

const SIZE = 10; // default editor canvas size (legacy; use activeW/activeH for runtime dims)
const STATE_EMPTY = 0;
const STATE_FILLED = 1;
const STATE_CROSSED = 2;

// Active board dimensions — derived from the loaded puzzle's truth grid (or editor's size selection).
let activeW = SIZE;
let activeH = SIZE;

const COLOR_MAP = {
  r: "#e63946",
  p: "#ff6b9d",
  b: "#3a86ff",
  o: "#fb8500",
  g: "#2a9d3f",
  y: "#ffd60a",
  k: "#1a1a1a",
};

const STORAGE_KEY = "picross.completed";
const EDITOR_COLORS_KEY = "picross.editorCustomColors";
const EDITOR_SLOTS_KEY = "picross.editorSlotColors";
const EDITOR_AUTOSAVE_KEY = "picross.editorWorkingState";
const LIBRARY_KEY = "picross.library";
const PUZZLES_KEY = "picross.puzzles";

const SLOT_COUNT = 50;
const SETTINGS_KEY = "picross.settings";

const SETTINGS_DEFAULT = {
  timer: false,
  mistakes: false,
  undo: true,
  fadedReveal: false,
  autoCross: false,
  soundEffects: false,
  reduceMotion: false,
  dpad: false,
  disableActionBtn: false,
  devMode: false,
};

const SETTINGS_INFO = [
  ["timer",            "Timer",                     "Show solve time."],
  ["mistakes",         "Mistake counter",           "Count fills placed on cells that don't belong in the picture."],
  ["fadedReveal",      "Faded reveal",              "Correctly-filled cells hint at their reveal color."],
  ["autoCross",        "Auto-cross",                "Auto-cross remaining cells when a row or column is satisfied."],
  ["soundEffects",     "Sound effects",             "Gentle taps and pops while solving, and a soft chime on the win."],
  ["reduceMotion",     "Reduce motion",             "Disables animations and transitions."],
  ["dpad",             "Dpad",                      "Show a directional pad on the right for cursor-based navigation. Tapping a cell moves the cursor; commit fills/crosses with the dpad's center button. Useful for large boards with tiny cells."],
  ["disableActionBtn", "Disable action button",     "Removes the dpad's center action button. Fill and Cross buttons execute the action directly on the cursor cell instead of toggling mode. Requires Dpad."],
  // DEV-ONLY row — only rendered when adminMode is on (see buildSettingsModal).
  // Bundles every debug aid behind one switch so the real user experience is one
  // toggle away. Strip this row + the dev-mode blocks at ship.
  ["devMode",          "Dev tools",                 "Show developer aids: board profile number + gap readout, P1–P5 badges in puzzle lists, and the instant-win button."],
];

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...SETTINGS_DEFAULT };
    const merged = { ...SETTINGS_DEFAULT, ...JSON.parse(raw) };
    // Undo stopped being optional on 2026-08-26 (settings row removed) — heal any
    // stored `false` so nobody is left with the button hidden forever.
    merged.undo = true;
    return merged;
  } catch { return { ...SETTINGS_DEFAULT }; }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

const settings = loadSettings();

// === Sound engine (2026-08-25) ===
// Everything is SYNTHESIZED — oscillators and filtered noise through short gain
// envelopes. Zero audio assets, zero network, nothing to license, works offline in
// the eventual Capacitor bundle. Design rules: quiet (peaks ≤ ~0.12), short
// (≤ ~350ms), warm (sines/triangles, downward pitch bends — "pops", never "beeps").
// iOS requires an AudioContext to be created/resumed inside a user gesture: _ready
// flips on the first pointerdown (listener near the bottom) and every play call
// no-ops before that, so there are no autoplay warnings and no half-initialized
// contexts. Paint sounds are rate-limited so brush drags tick pleasantly instead
// of machine-gunning.
const sfx = (() => {
  let ctx = null;
  let _ready = false;
  let _lastPaint = 0;
  function ensure() {
    if (!settings.soundEffects || !_ready) return null;
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { return null; }
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type, peak, bendTo) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  function whoosh(dur, peak, fFrom, fTo) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 0.7;
    f.frequency.setValueAtTime(fFrom, t0);
    f.frequency.exponentialRampToValueAtTime(fTo, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur);
  }
  function paintGate() {
    const n = performance.now();
    if (n - _lastPaint < 45) return false;
    _lastPaint = n;
    return true;
  }
  return {
    unlock() { _ready = true; ensure(); },
    fill()  { if (paintGate()) tone(300, 0.09, "sine", 0.11, 170); },
    cross() { if (paintGate()) tone(540, 0.06, "triangle", 0.07, 430); },
    erase() { if (paintGate()) tone(220, 0.05, "sine", 0.05, 170); },
    tap()   { tone(430, 0.045, "sine", 0.05, 360); },
    swoosh(){ whoosh(0.22, 0.05, 950, 260); },
    win()   {
      // Soft major-ish arpeggio — G4 C5 E5 G5, gently staggered.
      [392, 523.25, 659.25, 783.99].forEach((f, i) =>
        setTimeout(() => tone(f, 0.34, "sine", 0.09), i * 110));
    },
  };
})();

// Canonical Shipping Library categories. These get auto-seeded as empty folders on first
// run and self-healed back into the library if missing on subsequent loads (so adding new
// categories in code propagates automatically without trashing user-organized puzzles).
const SHIPPING_FOLDERS = [
  "Flora",
  "Fauna",
  "Geomorphology",
  "Geography",
  "Architecture",
  "Famous Paintings",
  "Mathematics",
  "Physics",
  "Astronomy",
  "Chemistry",
  "Biology",
  "Instruments",
  "Religions",
  "History",
  "Community",
  "Original Art",
];

// Default library structure on first load.
// Originals (Heart/Diamond/Arrow) → Standby/Tutorial folder.
// Test puzzles → Archive root. Shipping seeded with the canonical category folders, all empty.
const LIBRARY_DEFAULT = {
  shipping: {
    folders: Object.fromEntries(SHIPPING_FOLDERS.map(name => [name, []])),
    puzzles: [],
  },
  standby:  { folders: { "Tutorial": ["0001", "0002", "0003"] }, puzzles: [] },
  archive:  { folders: {}, puzzles: ["0004", "0005", "0006", "0007"] },
};

const SUBSECTIONS = [
  ["shipping", "Shipping Library"],
  ["standby",  "Standby Library"],
  ["archive",  "Archive"],
];

const FOLDER_ICON_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 4.2a1 1 0 011-1h2.6l1.4 1.4H13a1 1 0 011 1v6.2a1 1 0 01-1 1H3a1 1 0 01-1-1V4.2z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

// Char codes available for assignment when a custom color is added.
// Default palette uses r/p/b/o/g/y/k; custom slots fill from this pool, skipping anything already used.
const CHAR_POOL = "abcdefhijlmnqstuvwxzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// Admin mode detection — works via three paths:
//   1. URL flag `?admin=1` (works on local dev; itch iframe strips query strings so unreliable there)
//   2. localStorage flag `picross.adminMode = "1"` (persists across sessions)
//   3. Hidden trigger: click header title 7 times (works inside itch iframe, no URL access needed)
// URL flag also writes to localStorage so it's a one-time activation on any device.
const ADMIN_KEY = "picross.adminMode";
const _urlAdmin = new URLSearchParams(location.search).get("admin") === "1";
if (_urlAdmin) { try { localStorage.setItem(ADMIN_KEY, "1"); } catch {} }
const _lsAdmin = (() => { try { return localStorage.getItem(ADMIN_KEY) === "1"; } catch { return false; } })();
const adminMode = _urlAdmin || _lsAdmin;
const userMode = !adminMode;
const editorMode = adminMode && new URLSearchParams(location.search).get("editor") === "1";

let currentUserScreen = null; // "home" | "category" | "puzzles" | "solve"
let currentUserCategoryName = null;

// Hardcoded seed. After first run, the runtime PUZZLES is restored from localStorage
// (see the loadStoredPuzzles override below), so edits actually persist.
let PUZZLES = {
  "0001": {
    name: "Heart",
    size: 10,
    truth: [
      "..........",
      "..XX..XX..",
      ".XXXXXXXX.",
      ".XXXXXXXX.",
      ".XXXXXXXX.",
      "..XXXXXX..",
      "...XXXX...",
      "....XX....",
      "..........",
      "..........",
    ].map(row => [...row].map(ch => ch === "X")),
    colors: [
      "..........",
      "..rr..rr..",
      ".rrrrrrrr.",
      ".rrrrrrrr.",
      ".rrrrrrrr.",
      "..pppppp..",
      "...pppp...",
      "....pp....",
      "..........",
      "..........",
    ].map(row => [...row].map(ch => COLOR_MAP[ch] || "")),
  },
  "0002": {
    name: "Diamond",
    size: 10,
    truth: [
      "....XX....",
      "...XXXX...",
      "..XXXXXX..",
      ".XXXXXXXX.",
      "XXXXXXXXXX",
      "XXXXXXXXXX",
      ".XXXXXXXX.",
      "..XXXXXX..",
      "...XXXX...",
      "....XX....",
    ].map(row => [...row].map(ch => ch === "X")),
    colors: [
      "....bb....",
      "...bbbb...",
      "..bbbbbb..",
      ".bbbbbbbb.",
      "bbbbbbbbbb",
      "bbbbbbbbbb",
      ".bbbbbbbb.",
      "..bbbbbb..",
      "...bbbb...",
      "....bb....",
    ].map(row => [...row].map(ch => COLOR_MAP[ch] || "")),
  },
  "0003": {
    name: "Arrow",
    size: 10,
    truth: [
      "..........",
      "......X...",
      "......XX..",
      "......XXX.",
      "XXXXXXXXXX",
      "XXXXXXXXXX",
      "......XXX.",
      "......XX..",
      "......X...",
      "..........",
    ].map(row => [...row].map(ch => ch === "X")),
    colors: [
      "..........",
      "......o...",
      "......oo..",
      "......ooo.",
      "oooooooooo",
      "oooooooooo",
      "......ooo.",
      "......oo..",
      "......o...",
      "..........",
    ].map(row => [...row].map(ch => COLOR_MAP[ch] || "")),
  },
  "0004": {
    name: "Heart test",
    size: 10,
    truth: [
      "..........",
      "..XX..XX..",
      ".XXXXXXXX.",
      ".XXXXXXXX.",
      ".XXXXXXXX.",
      "..XXXXXX..",
      "...XXXX...",
      "....XX....",
      "..........",
      "..........",
    ].map(row => [...row].map(ch => ch === "X")),
    colors: [
      "..........",
      "..rr..rr..",
      ".rrrrrrrr.",
      ".rrrrrrrr.",
      ".rrrrrrrr.",
      "..rrrrrr..",
      "...rrrr...",
      "....rr....",
      "..........",
      "..........",
    ].map(row => [...row].map(ch => COLOR_MAP[ch] || "")),
  },
  "0005": {
    name: "House Test",
    size: 10,
    truth: [
      "..XXXX..XX",
      ".XX..XX..X",
      "XXXX..XXXX",
      "XXXXXXXXXX",
      "..XXXX..X.",
      "...XX..XXX",
      "XXXXXXXXXX",
      "XXXXXXXXXX",
      "XXXXXXXXXX",
      "XXXXXXXXXX",
    ].map(row => [...row].map(ch => ch === "X")),
    colors: [
      "..bbbb..yy",
      ".bb..bb..y",
      "bbbb..bbbb",
      "bbbrrbbbbb",
      "..rrrr..g.",
      "...rk..gkg",
      "gggrrgggkg",
      "gggggggggg",
      "kkkkkkkkkk",
      "kkkkkkkkkk",
    ].map(row => [...row].map(ch => COLOR_MAP[ch] || "")),
  },
  "0006": (() => {
    const cm = { "c": "#22ce36", "a": "#436547", "d": "#594d40" };
    return {
      name: "Tree Test",
      width: 10,
      height: 10,
      truth: [
        "..........",
        ".XXXX.....",
        "XXXXXX.XX.",
        "XXXXXXXXXX",
        ".XXXXXXXXX",
        "XX.XXXXXXX",
        ".XXXXXXXX.",
        "..XXXX....",
        "....XX....",
        "....XX....",
      ].map(row => [...row].map(ch => ch === "X")),
      colors: [
        "..........",
        ".cccc.....",
        "ccaacc.cc.",
        "caddaccacc",
        ".caddacdda",
        "ca.cddadac",
        ".daadddac.",
        "..dddd....",
        "....dd....",
        "....dd....",
      ].map(row => [...row].map(ch => cm[ch] || "")),
    };

  })(),
  "0007": (() => {
    const cm = { "y": "#ffd60a", "d": "#cccccc", "c": "#c8ecee", "k": "#1a1a1a", "a": "#5f5544" };
    return {
      name: "Mountain Test",
      width: 15,
      height: 15,
      truth: [
        "XXX....XXX.....",
        "XXX........XX..",
        "XXXX..X...XXXX.",
        "XXXX.X.XX..XXXX",
        ".....X...X...XX",
        "....X...XXX....",
        "....XX.XXXXX...",
        "...XXXXXXXXXX..",
        "..XXXXXXXXXXX..",
        ".XXXXXXXXXXXXX.",
        "XXXXXXXXXXXXXXX",
        "XXXXXXXXXXXXXXX",
        "XXXXXXXXXXXXXXX",
        "XXXXXXXXXXXXXXX",
        "XXXXXXXXXXXXXXX",
      ].map(row => [...row].map(ch => ch === "X")),
      colors: [
        "yyyddddcccddddd",
        "yycdd......cc..",
        "yccc..k...cccc.",
        "cccc.k.kk..cccc",
        "ddd..k...k...cc",
        "ddd.k...kkk...d",
        "dd..kk.kkakk.dd",
        "d..kakkakaakkd.",
        "..kkaaaaakaak.d",
        ".kkaaaaaaakakkd",
        "kkkaaaaaakkaakk",
        "kkkaaaaaaakaakk",
        "kkaakkaaaakkaak",
        "kkaakkaaaakkkak",
        "kkakkakkaaakkkk",
      ].map(row => [...row].map(ch => cm[ch] || "")),
    };
  })(),
};

// Promote PUZZLES to localStorage so in-app edits persist. First run seeds from the hardcoded set above.
const _storedPuzzles = (() => {
  try {
    const raw = localStorage.getItem(PUZZLES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
})();
if (_storedPuzzles && typeof _storedPuzzles === "object") {
  PUZZLES = _storedPuzzles;
} else {
  // Normalize seed (ensure width/height are explicit) and persist.
  for (const id of Object.keys(PUZZLES)) {
    const p = PUZZLES[id];
    if (typeof p.width !== "number") p.width = p.truth[0].length;
    if (typeof p.height !== "number") p.height = p.truth.length;
  }
  try { localStorage.setItem(PUZZLES_KEY, JSON.stringify(PUZZLES)); } catch {}
}

function savePuzzles() {
  try { localStorage.setItem(PUZZLES_KEY, JSON.stringify(PUZZLES)); } catch {}
}

let currentPuzzleId = null;
let activePuzzle = null;
let hints = null;
const completedSet = loadCompleted();

let board = createEmptyBoard(activeW, activeH);
const boardEl = document.getElementById("board");
const colHintsEl = document.getElementById("colHints");
const rowHintsEl = document.getElementById("rowHints");
const libraryEl = document.getElementById("library");
const contextMenuEl = document.getElementById("contextMenu");
let library = loadLibrary();
syncLibraryWithPuzzles();
saveLibrary();
const resetBtn = document.getElementById("resetBtn");

let brushTarget = null;   // STATE we are painting onto cells we drag over
let pointerActive = false;
let currentMode = "fill"; // "fill" | "cross" — used by touch/pen input only
let won = false;
const visited = new Set();


resetBtn.addEventListener("click", clearBoard);

window.addEventListener("pointerup", endBrush);
window.addEventListener("pointercancel", endBrush);
boardEl.addEventListener("pointerdown", onBoardPointerDown);
boardEl.addEventListener("pointermove", onBoardPointerMove);
boardEl.addEventListener("contextmenu", e => e.preventDefault());

const modeBtn = document.getElementById("modeBtn");
// Split Fill/Cross view — both halves always visible so the user sees the
// active + alternate at a glance.
// Default: any click toggles the mode (including in the visible gap between halves).
// With `disableActionBtn` on: each half commits its specific action on the
// cursor cell instead — Fill commits a fill, Cross commits a cross. Fill/Cross
// stop being "mode selectors" and become "action buttons".
modeBtn.addEventListener("click", (e) => {
  if (settings.dpad && settings.disableActionBtn) {
    const half = e.target.closest(".mode-half");
    if (!half) return;   // ignore taps in the gap between halves in this mode
    const mode = half.classList.contains("mode-half-fill") ? "fill" : "cross";
    commitCursorAction(mode);
  } else {
    toggleMode();
  }
});
updateModeButton();

// Win-card actions. Guarded for admin play mode (no user screens there — just close).
document.getElementById("winNext")?.addEventListener("click", e => {
  const nextId = e.currentTarget.dataset.nextId;
  const cat = e.currentTarget.dataset.cat;
  hideWinModal();
  if (cat) currentUserCategoryName = cat;
  if (nextId && PUZZLES[nextId]) loadPuzzle(nextId);
});
document.getElementById("winBack")?.addEventListener("click", e => {
  hideWinModal();
  if (!userMode) return;
  const cat = document.getElementById("winNext")?.dataset.cat;
  if (cat) currentUserCategoryName = cat;
  setUserScreen("puzzles");
});
document.getElementById("winPhotoToggle")?.addEventListener("click", e => {
  const wrap = e.currentTarget.closest(".win-preview-wrap");
  const showing = wrap.classList.toggle("show-photo");
  e.currentTarget.textContent = showing ? "Pixel" : "Photo";
});
// Backdrop tap dismisses the card so the revealed board can be admired full-screen.
document.querySelector("#winModal .modal-backdrop")?.addEventListener("click", hideWinModal);

// Hidden trigger: click the header title 7 times within 2s to toggle admin mode.
// Works inside itch's iframe where URL params are inaccessible.
let _titleClickCount = 0;
let _titleClickTimer = null;
const _titleEl = document.querySelector("header h1");
if (_titleEl) {
  _titleEl.style.cursor = "default";
  _titleEl.addEventListener("click", () => {
    _titleClickCount++;
    if (_titleClickTimer) clearTimeout(_titleClickTimer);
    _titleClickTimer = setTimeout(() => { _titleClickCount = 0; }, 2000);
    if (_titleClickCount >= 7) {
      const next = adminMode ? "0" : "1";
      try { localStorage.setItem(ADMIN_KEY, next); } catch {}
      location.reload();
    }
  });
}

const modeSwitchBtn = document.getElementById("modeSwitch");
modeSwitchBtn.textContent = editorMode ? "→ Play" : "→ Edit";
modeSwitchBtn.addEventListener("click", () => {
  const url = new URL(window.location.href);
  if (editorMode) url.searchParams.delete("editor");
  else url.searchParams.set("editor", "1");
  window.location.href = url.toString();
});

// Settings modal
document.getElementById("settingsBtn").addEventListener("click", openSettingsModal);
document.getElementById("solveSettings")?.addEventListener("click", openSettingsModal);
document.getElementById("solveReset")?.addEventListener("click", clearBoard);
// DEV-ONLY: instant-win for testing the win screen flow. Remove before ship.
// DEV "Win game" button removed 2026-08-22 (unused, and it visually filled the
// bottom-right gap which disguised the spacing imbalance). devWinPuzzle() is kept —
// re-add a trigger if instant-win testing is ever needed again.
document.getElementById("devWinBtn")?.addEventListener("click", devWinPuzzle);
document.getElementById("settingsClose").addEventListener("click", closeSettingsModal);
document.querySelector("#settingsModal .modal-backdrop").addEventListener("click", closeSettingsModal);

// Font dev mode — right-click any text to swap font/weight/style for live experimentation
const FONT_DEV_OPTIONS = [
  "Aghja",
  "Compagnon",
  "Carevo",
  "Showclick",
  "LoversQuarrel",
  "Miama",
  "Georgia",
  "system-ui",
];
let fontDevMode = false;
document.getElementById("fontDevBtn").addEventListener("click", () => {
  fontDevMode = !fontDevMode;
  document.body.classList.toggle("font-dev", fontDevMode);
  if (fontDevMode) {
    console.log("[font-dev] ON. Right-click any text element. Click 'Aa' again to exit.");
  }
});

// Capture phase so we override puzzle/folder/section context menus while in font-dev.
document.addEventListener("contextmenu", (e) => {
  if (!fontDevMode) return;
  // Don't intercept when right-clicking the contextMenu itself
  if (e.target.closest("#contextMenu")) return;
  e.preventDefault();
  e.stopPropagation();
  showFontDevMenu(e, e.target);
}, true);

function showFontDevMenu(e, targetEl) {
  contextMenuEl.innerHTML = "";

  // Header — show what we're targeting
  const tag = targetEl.tagName.toLowerCase();
  const cls = (typeof targetEl.className === "string" && targetEl.className)
    ? "." + targetEl.className.trim().split(/\s+/).join(".")
    : "";
  const targetLabel = (tag + cls).slice(0, 60);
  const header = document.createElement("div");
  header.className = "menu-header";
  header.textContent = `Target: ${targetLabel}`;
  contextMenuEl.appendChild(header);

  // Font family section
  const fontHeader = document.createElement("div");
  fontHeader.className = "font-menu-section";
  fontHeader.textContent = "Font family";
  contextMenuEl.appendChild(fontHeader);

  for (const font of FONT_DEV_OPTIONS) {
    const item = document.createElement("div");
    item.className = "font-menu-preview";
    item.style.fontFamily = `"${font}", serif`;
    const sample = document.createElement("span");
    sample.textContent = "Aa Bb 123";
    const name = document.createElement("span");
    name.className = "font-name";
    name.textContent = font;
    item.appendChild(sample);
    item.appendChild(name);
    item.addEventListener("click", () => {
      targetEl.style.fontFamily = `"${font}", serif`;
      hideContextMenu();
    });
    contextMenuEl.appendChild(item);
  }

  // Weight section
  const weightHeader = document.createElement("div");
  weightHeader.className = "font-menu-section";
  weightHeader.textContent = "Weight";
  contextMenuEl.appendChild(weightHeader);
  for (const w of ["300", "400", "500", "700"]) {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.style.fontWeight = w;
    item.textContent = `${w}`;
    item.addEventListener("click", () => {
      targetEl.style.fontWeight = w;
      hideContextMenu();
    });
    contextMenuEl.appendChild(item);
  }

  // Style section
  const styleHeader = document.createElement("div");
  styleHeader.className = "font-menu-section";
  styleHeader.textContent = "Style";
  contextMenuEl.appendChild(styleHeader);
  for (const s of ["normal", "italic"]) {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.style.fontStyle = s;
    item.textContent = s;
    item.addEventListener("click", () => {
      targetEl.style.fontStyle = s;
      hideContextMenu();
    });
    contextMenuEl.appendChild(item);
  }

  // Reset section
  const resetHeader = document.createElement("div");
  resetHeader.className = "font-menu-section";
  resetHeader.textContent = "Reset";
  contextMenuEl.appendChild(resetHeader);
  const resetThis = document.createElement("div");
  resetThis.className = "menu-item";
  resetThis.textContent = "Clear overrides on this element";
  resetThis.addEventListener("click", () => {
    targetEl.style.fontFamily = "";
    targetEl.style.fontWeight = "";
    targetEl.style.fontStyle = "";
    hideContextMenu();
  });
  contextMenuEl.appendChild(resetThis);
  const resetAll = document.createElement("div");
  resetAll.className = "menu-item danger";
  resetAll.textContent = "Clear ALL font overrides site-wide";
  resetAll.addEventListener("click", () => {
    document.querySelectorAll("*").forEach(el => {
      if (el.style.fontFamily) el.style.fontFamily = "";
      if (el.style.fontWeight) el.style.fontWeight = "";
      if (el.style.fontStyle) el.style.fontStyle = "";
    });
    hideContextMenu();
  });
  contextMenuEl.appendChild(resetAll);

  positionContextMenu(e);
}

// Undo button + Ctrl+Z (routes to editor undo when in editor mode, solve undo otherwise)
document.getElementById("undoBtn").addEventListener("click", undo);
window.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  // Don't intercept when focus is on a text input/textarea — let the browser do its native undo
  const t = e.target;
  const inText = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (inText) return;
  if (key === "z" && e.shiftKey) {
    e.preventDefault();
    if (editorMode) editorRedo();
  } else if (key === "z") {
    e.preventDefault();
    if (editorMode) editorUndo();
    else undo();
  } else if (key === "y") {
    e.preventDefault();
    if (editorMode) editorRedo();
  }
});

// Solve-time stats state
let timerStart = null;
let timerInterval = null;
let elapsedMs = 0;
let mistakeCount = 0;
const undoStack = [];
let currentStroke = [];

function openSettingsModal() {
  buildSettingsModal();
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function buildSettingsModal() {
  const list = document.querySelector(".settings-list");
  list.innerHTML = "";
  for (const [key, name, desc] of SETTINGS_INFO) {
    // Dev row shows in admin mode OR while the flag is on — otherwise, once Dre
    // 7-tapped back to user mode there was no way to turn dev tools OFF (round-2
    // finding). Default-off users still never see it; enabling still needs admin.
    if (key === "devMode" && !adminMode && !settings.devMode) continue;
    const li = document.createElement("li");
    li.className = "setting-row";

    const wrap = document.createElement("div");
    wrap.className = "setting-label-wrap";
    const nameEl = document.createElement("span");
    nameEl.className = "setting-name";
    nameEl.textContent = name;
    const descEl = document.createElement("span");
    descEl.className = "setting-desc";
    descEl.textContent = desc;
    wrap.appendChild(nameEl);
    wrap.appendChild(descEl);
    li.appendChild(wrap);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "setting-toggle";
    toggle.checked = settings[key];
    toggle.addEventListener("change", () => {
      settings[key] = toggle.checked;
      saveSettings();
      applySettings();
    });
    li.appendChild(toggle);
    list.appendChild(li);
  }
}

// === User-mode navigation (Home → Categories → Puzzles → Solve) ===
function initUserNav() {
  document.getElementById("userPlay").addEventListener("click", () => setUserScreen("category"));
  document.querySelectorAll(".back-btn").forEach(btn => {
    btn.addEventListener("click", () => setUserScreen(btn.dataset.back));
  });
}

function setUserScreen(name) {
  if (currentUserScreen !== null && currentUserScreen !== name) sfx.swoosh();
  // Reset scroll BEFORE the screen class changes. html/body scroll on the list
  // screens (overflow-y: auto), but the solve view locks scrolling
  // (overflow: hidden; height: 100dvh). Tapping a puzzle from a scrolled-down list
  // therefore carried that offset into a view that can no longer scroll — the top
  // control row sat clipped off-screen with no way to reach it. Must happen while
  // the page is still scrollable, hence before dataset.screen is reassigned.
  // Reported 2026-08-21.
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  currentUserScreen = name;
  document.body.dataset.screen = name;
  if (name === "category") buildUserCategoryList();
  else if (name === "puzzles") buildUserPuzzleList(currentUserCategoryName);
  // Rotation depends on data-screen === "solve"; clear it when leaving solve
  // so the app doesn't stay rotated on category/home screens.
  updateRotationClass();
  // Fit board to viewport when entering solve. Defer one frame so CSS layout
  // reflects the new data-screen before we measure the container.
  if (name === "solve") {
    requestAnimationFrame(() => {
      resizeBoardToFit();
      // Second reset, after the board is sealed. For one frame the board renders at
      // its NATURAL size, which on tall puzzles overflows the locked viewport; iOS
      // can respond by scrolling, and `overflow: hidden` then makes that offset
      // unrecoverable — the app looks shifted up (logo behind the status bar) or
      // down (bottom controls clipped) with no way to correct it. Resetting before
      // the screen switch can't catch a scroll that happens after it.
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
  }
}

function buildUserCategoryList() {
  const ul = document.getElementById("userCategoryList");
  ul.innerHTML = "";
  for (const folderName of Object.keys(library.shipping.folders)) {
    const ids = library.shipping.folders[folderName] || [];
    if (ids.length === 0) continue; // Hide empty categories from users
    const li = document.createElement("li");
    li.className = "user-cat-item";
    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = folderName;
    const count = document.createElement("span");
    count.className = "cat-count";
    const completed = ids.filter(id => completedSet.has(id)).length;
    count.textContent = `${completed} / ${ids.length}`;
    li.appendChild(name);
    li.appendChild(count);
    li.addEventListener("click", () => {
      currentUserCategoryName = folderName;
      setUserScreen("puzzles");
    });
    ul.appendChild(li);
  }
}

function buildUserPuzzleList(catName) {
  const ul = document.getElementById("userPuzzleList");
  ul.innerHTML = "";
  document.getElementById("screenPuzzlesTitle").textContent = catName || "";
  const ids = (library.shipping.folders[catName] || []).slice();
  for (const id of ids) {
    const puzzle = PUZZLES[id];
    if (!puzzle) continue;
    const li = document.createElement("li");
    li.className = "user-puzzle-item";
    if (completedSet.has(id)) li.classList.add("completed");
    const name = document.createElement("span");
    name.className = "puz-name";
    name.textContent = puzzle.name;
    const meta = document.createElement("span");
    meta.className = "puz-meta";
    const isLandscape = puzzle.width > puzzle.height;
    const iconSvg = isLandscape
      ? '<svg class="puz-orient" viewBox="0 0 20 12" width="17" height="11" aria-label="landscape"><rect x="1" y="1" width="18" height="10" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="17" y1="4.5" x2="17" y2="7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
      : '<svg class="puz-orient" viewBox="0 0 12 20" width="11" height="17" aria-label="portrait"><rect x="1" y="1" width="10" height="18" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4.5" y1="17" x2="7.5" y2="17" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    const completedMark = completedSet.has(id) ? "  ✓" : "";
    meta.innerHTML = `${iconSvg}<span class="puz-size">${puzzle.width}×${puzzle.height}${completedMark}</span>`;
    // DEV-ONLY (temporary, 2026-08-16): which layout profile this puzzle opens in
    // (P1–P5), so a specific profile can be picked from the list without opening
    // puzzles one by one. Reads the LIVE dpad setting via profileForDims, so toggling
    // Dpad flips every badge between the portrait/landscape pairs on next list build.
    // Remove before ship alongside #devWinBtn and #profileNum.
    const profIdx = LAYOUT_PROFILES.indexOf(profileForDims(puzzle.width, puzzle.height));
    const profBadge = document.createElement("span");
    profBadge.className = "puz-profile dev-only";
    profBadge.textContent = profIdx >= 0 ? `P${profIdx + 1}` : "P?";
    meta.prepend(profBadge);
    li.appendChild(name);
    li.appendChild(meta);
    li.addEventListener("click", () => {
      loadPuzzle(id);
      setUserScreen("solve");
    });
    ul.appendChild(li);
  }
}

function applySettings() {
  document.body.classList.toggle("reduce-motion", settings.reduceMotion);
  // The Dev tools ROW is only reachable in admin mode, but the flag itself works
  // in user mode too — Dre debugs from the user-facing side, so gating the aids on
  // live admin state made them unreachable exactly where he needs them (2026-08-26).
  document.body.classList.toggle("dev-mode", !!settings.devMode);
  // Toggle visibility of solve-stats elements (always hidden in editor mode regardless)
  const inSolve = !editorMode;
  document.getElementById("timer").classList.toggle("hidden", !inSolve || !settings.timer);
  document.getElementById("mistakes").classList.toggle("hidden", !inSolve || !settings.mistakes);
  document.getElementById("undoBtn").classList.toggle("hidden", !inSolve);   // undo is always on (2026-08-26)
  // Dpad visibility. Tap-to-select is implicit whenever the dpad is on — no
  // separate toggle, since painting-by-tap with a dpad up would be redundant.
  document.body.classList.toggle("dpad-on", inSolve && settings.dpad);
  // "Disable action button": removes dpad's center square and repurposes Fill/Cross
  // to execute the action directly on the cursor cell. Only takes effect when dpad is on.
  document.body.classList.toggle("disable-action-btn-on", inSolve && settings.dpad && settings.disableActionBtn);
  // Cursor bootstraps to (0,0) as soon as dpad is on, so the user sees the target
  // cell before pressing anything.
  if (inSolve && settings.dpad && activePuzzle && !selectedCell) {
    selectedCell = { r: 0, c: 0 };
  }
  // Cursor may need a re-render (e.g. board changed dimensions since last apply)
  if (inSolve && activePuzzle) renderCursor();
  // Re-render solve board so faded reveal applies/clears
  if (inSolve && activePuzzle && !won) renderBoard();
  // Fill/Cross visual state may change when disableActionBtn flips
  if (typeof updateModeButton === "function") updateModeButton();
  // Layout-affecting classes (dpad-on above, mode-stacked derived from it) changed
  // → re-derive rotation/mode-stacked state and refit the board size. Without
  // this, toggling Dpad in Settings leaves the board at its old dimensions and
  // it overlaps whatever's below it.
  if (inSolve && activePuzzle) {
    updateRotationClass();
    requestAnimationFrame(resizeBoardToFit);
  }
}

function startTimer() {
  if (!settings.timer || timerInterval) return;
  if (timerStart === null) timerStart = Date.now() - elapsedMs;
  timerInterval = setInterval(updateTimerDisplay, 250);
  updateTimerDisplay();
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (timerStart !== null) {
    elapsedMs = Date.now() - timerStart;
  }
}

function resetTimer() {
  stopTimer();
  timerStart = null;
  elapsedMs = 0;
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const live = timerStart !== null ? Date.now() - timerStart : elapsedMs;
  const sec = Math.floor(live / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  document.getElementById("timer").textContent = `${m}:${String(s).padStart(2, "0")}`;
}

function recordMistake() {
  mistakeCount++;
  document.getElementById("mistakes").textContent = `✕ ${mistakeCount}`;
}

function resetMistakes() {
  mistakeCount = 0;
  document.getElementById("mistakes").textContent = `✕ 0`;
}

function undo() {
  if (won) return;
  const stroke = undoStack.pop();
  if (!stroke || stroke.length === 0) return;
  for (const { r, c, prev } of stroke) {
    board[r][c] = prev;
    const cell = boardEl.children[r * activeW + c];
    cell.style.background = "";
    applyCellState(cell, prev);
  }
  updateHintCompletion();
  updateUndoButtonState();
}

function updateUndoButtonState() {
  const btn = document.getElementById("undoBtn");
  btn.disabled = undoStack.length === 0 || won;
}

function hexFaded(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  // Mix 70% toward black (#1a1a1a = 26,26,26) so the cell still reads as "filled"
  // but hints at the reveal color.
  const mix = (a, b) => Math.round(a * 0.3 + b * 0.7);
  return `rgb(${mix(rgb.r, 26)}, ${mix(rgb.g, 26)}, ${mix(rgb.b, 26)})`;
}

function createEmptyBoard(w, h) {
  const grid = [];
  for (let r = 0; r < h; r++) {
    grid.push(new Array(w).fill(STATE_EMPTY));
  }
  return grid;
}

function applyDimensions(w, h) {
  activeW = w;
  activeH = h;
  boardEl.style.gridTemplateColumns = `repeat(${w}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${h}, 1fr)`;
  boardEl.style.aspectRatio = `${w} / ${h}`;
  colHintsEl.style.gridTemplateColumns = `repeat(${w}, 1fr)`;
  rowHintsEl.style.gridTemplateRows = `repeat(${h}, 1fr)`;
}

// Toggle body.rotate-app when the loaded puzzle's orientation disagrees with the
// device's physical orientation. Landscape puzzle + portrait phone → rotate so
// the phone can be held landscape for solving (and vice versa).
// All possible layout profiles. Every state combination the solve view can be
// in maps to exactly one of these. CSS lives in per-profile blocks — no
// compound-class selectors needed.
const LAYOUT_PROFILES = [
  "profile-square-nodpad",   // 10x10, 15x15 with no dpad
  "profile-tall-nodpad",     // 10x15, 15x20 with no dpad
  "profile-portrait-dpad",   // any portrait puzzle with dpad on
  "profile-wide-nodpad",     // 15x10, 20x15 with no dpad
  "profile-wide-dpad",       // any landscape puzzle with dpad on
];

// Profile selection depends only on a puzzle's dimensions + the dpad setting, so it
// can be answered for ANY puzzle, not just the loaded one. Extracted so the solve view
// and the DEV-ONLY puzzle-list badge share one source of truth — if these ever diverge,
// the badge silently lies about which profile a puzzle will open in.
function profileForDims(w, h) {
  const dpadOn = !!settings.dpad;
  const isWide = w > h;
  const isSquare = w === h;
  if (isWide) return dpadOn ? "profile-wide-dpad" : "profile-wide-nodpad";
  // portrait (square or tall)
  if (dpadOn) return "profile-portrait-dpad";
  return isSquare ? "profile-square-nodpad" : "profile-tall-nodpad";
}

function computeLayoutProfile() {
  if (!activePuzzle) return null;
  return profileForDims(activeW, activeH);
}

function updateRotationClass() {
  const active = activePuzzle && !editorMode && document.body.dataset.screen === "solve";
  // Always clear all profile classes first — solve-view state is derived, not accumulated.
  for (const p of LAYOUT_PROFILES) document.body.classList.remove(p);
  if (!active) {
    document.body.classList.remove("rotate-app", "view-landscape");
    updateProfileLabel();
    return;
  }
  const puzzleLandscape = activeW > activeH;
  const deviceLandscape = window.innerWidth > window.innerHeight;
  // Rotation is orthogonal to profile — it applies a transform regardless of
  // which profile is active. Keep as its own body class.
  //
  // Exactly ONE case rotates: a landscape puzzle on a portrait-held device, drawn
  // sideways so the puzzle's long axis runs along the screen's long axis (you turn
  // the phone to play it). Every other combination renders upright.
  //
  // Was `puzzleLandscape !== deviceLandscape`, which ALSO rotated a portrait puzzle
  // on a landscape-held device. That was wrong in standalone/native: the OS has
  // already rotated the viewport by that point, so our +90 stacked on top of the
  // OS's +90 and the app rendered upside-down (180°). Reported 2026-08-16.
  //
  // The proper fix is an OS-level portrait lock — Xcode "Portrait" only at Phase 4,
  // and manifest "orientation": "portrait" for Android/Chrome (iOS PWA ignores it).
  // This condition is the safety net for any context where the viewport rotates
  // anyway, so the app degrades to "upright but letterboxed" instead of upside-down.
  document.body.classList.toggle("rotate-app", puzzleLandscape && !deviceLandscape);
  document.body.classList.toggle("view-landscape", puzzleLandscape);
  const profile = computeLayoutProfile();
  if (profile) document.body.classList.add(profile);
  applyDpadStyle();
  syncSolveBackParent();
  updateProfileLabel();
}

// DEV-ONLY: big faint layout-profile number, centered on the board. A visual
// cue so Dre can say "profile 3" instead of screenshotting. Numbered by
// LAYOUT_PROFILES order (1..5). Created lazily and re-attached to #board here
// because renderBoard() nukes board children. Called from updateRotationClass
// (profile changes) and from the end of renderBoard (board rebuilds). Remove
// before ship: this function + its calls + #profileNum CSS + #board position.
function updateProfileLabel() {
  const onSolve = document.body.dataset.screen === "solve" && activePuzzle && !editorMode;
  const devOn = !!settings.devMode;   // works in user mode once set — see applySettings
  let el = document.getElementById("profileNum");
  if (!onSolve || !devOn) { if (el) el.style.display = "none"; return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "profileNum";
    el.className = "dev-only";
    el.setAttribute("aria-hidden", "true");
  }
  if (el.parentElement !== boardEl) boardEl.appendChild(el);
  el.style.display = "flex";
  const idx = LAYOUT_PROFILES.findIndex(p => document.body.classList.contains(p));
  el.textContent = idx >= 0 ? String(idx + 1) : "?";
}

// Some buttons live in different DOM parents depending on active layout
// profile. This function reconciles their placement.
//   solveBack: header (visible portraits) → #solveStats (wide profiles where
//     the header is hidden)
//   undoBtn:   #solveStats (all profiles) → .solve-bottom-bar (portrait-dpad
//     only, where Undo is a tall skinny button alongside dpad + Fill/Cross)
function syncSolveBackParent() {
  const solveStats = document.getElementById("solveStats");
  if (!solveStats) return;
  const solveBack = document.getElementById("solveBack");
  const undoBtn = document.getElementById("undoBtn");
  const solveReset = document.getElementById("solveReset");

  // Every profile now keeps all four controls in #solveStats; only the ARRANGEMENT
  // differs (4x1 in portrait, 2x2 in landscape), and that is pure CSS.
  //
  // Profile 1 used to be the exception: Back was reparented into the HEADER to flank
  // the logo, and Undo + Reset into the BOTTOM BAR to form a 2x2 above Fill/Cross.
  // Removed 2026-08-23 — Dre wants profile 1 identical to profile 3 for these four
  // ("same order, dimensions, everything"), and that is unreachable while two of them
  // live in other containers. Dropping the branch also deletes the only place where
  // profile classes drove DOM structure rather than styling, so a profile can no
  // longer silently change what is parented where.
  if (solveBack && solveBack.parentElement !== solveStats) solveStats.insertBefore(solveBack, solveStats.firstChild);
  if (undoBtn && undoBtn.parentElement !== solveStats) solveStats.appendChild(undoBtn);
  if (solveReset && solveReset.parentElement !== solveStats) solveStats.appendChild(solveReset);
}

// Resize the dpad SVG's center square (and adjust the surrounding trapezoids
// to hug it) per active profile. Portrait-dpad uses a bigger center for a
// larger tap target; other profiles keep the default. Arrows are drawn as
// rounded-corner <path>s (converted from raw polygons) for a softer look.
const DPAD_CORNER_RADIUS = 10;        // outer corners of each arrow (viewBox units)
const DPAD_INNER_CORNER_RADIUS = 4;   // inner corners (closer to center) — sharper look
const DPAD_INSET = 2;                 // perpendicular inset per arrow — creates the background
                                       // strips between adjacent arrows (and between arrows + center).
                                       // Adjacent arrows' slanted edges shift by DPAD_INSET each,
                                       // so the visible gap between them = 2 * DPAD_INSET perpendicular.
                                       // Inner short edge shifts by 2 * DPAD_INSET so the arrow-to-
                                       // center gap matches the arrow-to-arrow gap width.

// `radii` may be a single number (uniform corners) or an array of length points.length
// (per-corner radius, indexed by vertex).
function roundedPolygonPath(points, radii) {
  const n = points.length;
  const arr = Array.isArray(radii) ? radii : new Array(n).fill(radii);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const r = arr[i];
    const entry = pointAlongEdge(curr, prev, r);
    const exit  = pointAlongEdge(curr, next, r);
    parts.push(i === 0 ? `M ${entry.x} ${entry.y}` : `L ${entry.x} ${entry.y}`);
    parts.push(`Q ${curr.x} ${curr.y} ${exit.x} ${exit.y}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

function pointAlongEdge(from, toward, dist) {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  // Safety: on very short edges, cap the offset at half the edge so the two
  // corner arcs at either end don't overshoot each other.
  const d = Math.min(dist, len / 2);
  return { x: from.x + (dx / len) * d, y: from.y + (dy / len) * d };
}

function applyDpadStyle() {
  const dpadSvg = document.querySelector("#dpad svg");
  if (!dpadSvg) return;
  const isPortraitDpad = document.body.classList.contains("profile-portrait-dpad");
  const h = isPortraitDpad ? 18 : 15;  // half-width of center square in the 100x100 viewBox
  const c1 = 50 - h;
  const c2 = 50 + h;
  const d = DPAD_INSET;
  const s = Math.SQRT2;
  const noCenter = document.body.classList.contains("disable-action-btn-on");
  const rOuter = DPAD_CORNER_RADIUS;
  const rInner = DPAD_INNER_CORNER_RADIUS;
  let shapes;
  let cornerRadii;
  if (noCenter) {
    // TRIANGLE mode: no center square. Each arrow's slanted edges (shifted d
    // perpendicular into interior) meet at an apex — for up, that's (50, 50-d√2).
    // Apex is offset from true center by d√2 toward the arrow's outer edge, so
    // the four apexes leave a tiny diamond of empty space at the exact center.
    // Vertex order [outer, outer, apex] — preserved under 90° rotation.
    const up = [
      { x: d * (1 + s),       y: d },              // [0] top-left OUTER
      { x: 100 - d * (1 + s), y: d },              // [1] top-right OUTER
      { x: 50,                y: 50 - d * s },     // [2] APEX
    ];
    const right = rotate90CW(up);
    const down  = rotate90CW(right);
    const left  = rotate90CW(down);
    shapes = { up, right, down, left };
    cornerRadii = [rOuter, rOuter, rInner];
  } else {
    // TRAPEZOID mode (default): arrows have a short inner edge facing the center square.
    //   - outer edge (top) shifts down d
    //   - slanted edges shift perpendicular into the interior by d (keep slope ±1)
    //   - inner short edge shifts up 2d so the arrow-to-center gap = 2d = same
    //     width as the arrow-to-arrow perpendicular gap.
    // Vertex order [outer, outer, inner, inner] — preserved under 90° rotation.
    const up = [
      { x: d * (1 + s),        y: d },              // [0] top-left OUTER
      { x: 100 - d * (1 + s),  y: d },              // [1] top-right OUTER
      { x: c2 + d * (2 - s),   y: c1 - 2 * d },     // [2] bottom-right INNER
      { x: c1 + d * (s - 2),   y: c1 - 2 * d },     // [3] bottom-left INNER
    ];
    const right = rotate90CW(up);
    const down  = rotate90CW(right);
    const left  = rotate90CW(down);
    shapes = { up, right, down, left };
    cornerRadii = [rOuter, rOuter, rInner, rInner];
  }
  for (const dir of Object.keys(shapes)) {
    const el = dpadSvg.querySelector(`.dpad-${dir}`);
    if (el) el.setAttribute("d", roundedPolygonPath(shapes[dir], cornerRadii));
  }
  const center = dpadSvg.querySelector(".dpad-center");
  if (center) {
    center.setAttribute("x", c1);
    center.setAttribute("y", c1);
    center.setAttribute("width", h * 2);
    center.setAttribute("height", h * 2);
  }
}

function rotate90CW(pts) {
  // Rotate each point 90° clockwise around the center of the 100×100 viewBox.
  return pts.map(p => ({ x: 100 - p.y, y: p.x }));
}

// Measure how tall a single hint digit ACTUALLY renders (painted pixel bounds)
// in Aghja at the col-hint font settings. Previous DOM-based measurement got
// the LINE BOX height, but Aghja's glyphs extend BEYOND their line box → still
// clipped. Canvas `measureText` returns real painted glyph bounds
// (actualBoundingBoxAscent + actualBoundingBoxDescent), which is what we need.
let measuredHintLineHeight = null;
function measureAndCacheHintLineHeight() {
  let h = null;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = '500 12px "Compagnon", Georgia, serif';   // MUST match --font-body (swapped 2026-08-25)
    const m = ctx.measureText("0");
    if (m.actualBoundingBoxAscent !== undefined && m.actualBoundingBoxDescent !== undefined) {
      // +1 safety — Dre wanted tighter, clipping test was clean at +2.
      h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 1;
    }
  } catch (e) { /* fall through to DOM fallback */ }
  if (h === null) {
    // Fallback for browsers without actualBoundingBox — use font's natural
    // line-height (`normal`), which is > 1em and includes enough leading.
    const el = document.createElement("span");
    el.textContent = "0";
    el.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;font-family:var(--font-body);font-size:12px;font-weight:500;line-height:normal;display:block;";
    document.body.appendChild(el);
    h = Math.ceil(el.getBoundingClientRect().height);
    el.remove();
  }
  measuredHintLineHeight = h;
  document.documentElement.style.setProperty("--col-hint-line-height", h + "px");
  return h;
}
// Row-hint text measurement. Replaces a `fontPx * 0.48` estimate that hardcoded
// 14px — but `.row-hint` drops to 12px under the ≤480px media query, i.e. on every
// phone. The estimate therefore ran ~15% wide on exactly the devices this ships to,
// padding the hint track with dead space, right-aligning the numbers away from the
// board, and making the quadrant extension line visibly longer than the hint it
// belongs to (Dre, 2026-08-21). Measuring the real glyphs removes the guess and the
// fudge factor together. Same canvas approach as the line-height measurement above.
let _rowHintCtx = null;
let _rowHintCtxFont = null;
function getRowHintMeasurer() {
  // Read the live font-size so the media query is respected automatically rather
  // than mirrored (and re-mirrored wrongly) in JS.
  let fontPx = 14;
  const sample = document.querySelector("#rowHints .row-hint");
  if (sample) {
    const fs = parseFloat(getComputedStyle(sample).fontSize);
    if (fs > 0) fontPx = fs;
  } else if (window.matchMedia && window.matchMedia("(max-width: 480px)").matches) {
    fontPx = 12;  // fallback mirrors the ≤480px rule in style.css
  }
  const font = `500 ${fontPx}px "Compagnon", Georgia, serif`;   // MUST match --font-body (swapped 2026-08-25)
  try {
    if (!_rowHintCtx) _rowHintCtx = document.createElement("canvas").getContext("2d");
    if (_rowHintCtxFont !== font) { _rowHintCtx.font = font; _rowHintCtxFont = font; }
    const ctx = _rowHintCtx;
    return (s) => ctx.measureText(s).width;
  } catch (e) {
    // No canvas — fall back to the old proportional estimate.
    return (s) => s.length * fontPx * 0.48;
  }
}

function getHintLineHeight() {
  if (measuredHintLineHeight === null) measureAndCacheHintLineHeight();
  return measuredHintLineHeight;
}
// Re-measure once the UI font actually loads (initial measurement may hit fallback font).
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    measuredHintLineHeight = null;
    measureAndCacheHintLineHeight();
    if (activePuzzle && !editorMode) requestAnimationFrame(resizeBoardToFit);
  });
}

// Fit the .puzzle grid (hints + board) inside the .puzzle-and-ref flex container.
// Only runs on the user-mode solve screen — editor & user list screens keep their
// default sizing. Uses measured hint sizes so wide-hint puzzles don't get clipped.
// Profile-3 gap reserve, as a multiple of the safe-area inset.
//
// 2.0 is the minimum for three EXACTLY equal gaps — see the 2026-08-22 budget note:
// the bottom gap has a hard floor of (main padding + safe-area inset), so equality
// forces all three up to that floor, which costs L = 2·D of reserve.
//
// Below 2.0 the gaps shrink and the board takes the difference: every 0.1 here is
// ~3.4px off EACH gap and onto the board. The board cannot be enlarged any other way
// — the only other slack on screen is the home-indicator strip, which is reserved and
// cannot hold controls. TUNE: raise for airier spacing, lower for a bigger board.
const P3_GAP_RESERVE = 1.4;

// Deferred-equalisation scheduling flag + last measured excess (shown in DEV readout).
let _gapFixScheduled = false;
let _lastGapExcess = 0;
// Re-entry guard for the overflow correction at the end of resizeBoardToFit.
let _boardFitPass = 0;
function resizeBoardToFit() {
  if (editorMode) return;
  if (document.body.dataset.screen !== "solve") return;
  const puzzleEl = document.querySelector(".puzzle");
  const container = document.querySelector(".puzzle-and-ref");
  if (!puzzleEl || !container) return;

  // Clear any prior inline sizing so we measure natural hint widths against the
  // container. Otherwise a previous larger grid template blocks us from shrinking.
  puzzleEl.style.width = "";
  puzzleEl.style.height = "";
  puzzleEl.style.gridTemplateColumns = "";
  puzzleEl.style.gridTemplateRows = "";

  // Reset the bar-centering margin before measuring (profiles 1 and 3 consume it).
  // The bar's own margin feeds back into the container height, so leaving it set
  // would skew the read. Recomputed below once we know the board height.
  document.body.style.setProperty("--bar-center-margin", "0px");
  document.body.style.setProperty("--p3-gap-top", "0px");
  document.body.style.setProperty("--p3-gap-bottom", "0px");
  // Clear the previous pass's container cap (see the overflow guard at the end).
  if (_boardFitPass === 0) container.style.maxHeight = "";

  const availW = container.clientWidth - 4;
  // In landscape without dpad, the mini-logo sits at the top-left corner of
  // main and would collide with the tallest column-hint stack. Reserve 20px
  // of vertical space so the topmost hint clears the logo. Start with 20px
  // per Dre — can grow if wide-hint puzzles bump against the logo.
  // Profile 5 joined this 2026-08-23: its relayout moved the control row out of the
  // top, so the board now spans the full height of the left column and the mini-logo
  // sits over the tallest column-hint stack exactly as it does on profile 4.
  const topReserve = document.body.classList.contains("profile-wide-nodpad")
                  || document.body.classList.contains("profile-wide-dpad") ? 20 : 0;
  const availH = container.clientHeight - 4 - topReserve;
  if (availW < 100 || availH < 100) return;

  // Home-indicator inset — body already carries it as padding-bottom. Needed by the
  // board reserve, the gap solve, and the overflow guard, so read it once up front.
  const safeBottomPx = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;

  // Compute hint track sizes from the actual digit counts + gaps + padding so
  // short hints don't get padded with wasted space. This also shortens the
  // "quadrant extension" divider lines to match the hint content extent.
  // Row hints (left of board): horizontal digits + gaps + h-padding (6+6).
  // Col hints (above board): vertical stack, per-line height + v-padding (4+4).
  const numGap = 4;               // matches .row-hint gap in CSS
  const hPad = 8;                 // matches .row-hint horizontal padding total
  const lineH = getHintLineHeight();  // empirical — measured from actual Aghja render, not hardcoded
  const colGap = 1;                   // matches .col-hint gap: 1px
  const vPad = 6;                     // matches .col-hint padding-bottom: 6px (breathing room above board)
  let hintColW = 18;
  if (hints && hints.rows) {
    const measure = getRowHintMeasurer();
    for (const row of hints.rows) {
      let textW = 0;
      for (const n of row) textW += measure(String(n));
      const gaps = Math.max(0, row.length - 1);
      const w = Math.ceil(textW + gaps * numGap + hPad);
      if (w > hintColW) hintColW = w;
    }
  }
  let hintRowH = 18;
  if (hints && hints.cols) {
    for (const col of hints.cols) {
      const h = Math.ceil(col.length * lineH + Math.max(0, col.length - 1) * colGap + vPad);
      if (h > hintRowH) hintRowH = h;
    }
  }

  // Board aspect matches puzzle W/H.
  const ratio = activeW / activeH;
  let bw = availW - hintColW;
  let bh = availH - hintRowH;
  if (bw <= 0 || bh <= 0) return;
  // Constrain by whichever dimension is more limiting for the target aspect.
  if (bw / bh > ratio) bw = bh * ratio;
  else bh = bw / ratio;
  bw = Math.max(80, Math.floor(bw));
  bh = Math.max(80, Math.floor(bh));

  // --- Profile 3: reserve enough leftover that the three gaps CAN be equal ---
  // The bottom gap carries a fixed offset the other two don't — main's bottom padding
  // plus the home-indicator inset. Those pixels are physically reserved and cannot be
  // redistributed, so when the board consumes all available height (L ≈ 0, the normal
  // case on tall puzzles) the top and middle gaps collapse to nothing while the bottom
  // keeps ~34px. That is exactly the "everything crammed together above a big empty
  // strip" Dre reported. No amount of margin maths fixes it: there is nothing to hand
  // out. The board has to yield the space.
  //
  // Equalising requires L ≥ 2·D, where D is that asymmetry (see the solve below), so
  // cap the board to leave precisely that. Costs up to 2·D of board height on tall
  // puzzles, buys evenly spaced controls. Delete this block to revert.
  if (document.body.classList.contains("profile-portrait-dpad")) {
    const maxBh = availH - hintRowH - P3_GAP_RESERVE * safeBottomPx;
    if (maxBh > 80 && bh > maxBh) {
      bh = Math.floor(maxBh);
      bw = Math.max(80, Math.floor(bh * ratio));
    }
  }

  puzzleEl.style.gridTemplateColumns = `${hintColW}px ${bw}px`;
  puzzleEl.style.gridTemplateRows = `${hintRowH}px ${bh}px`;
  puzzleEl.style.width = `${hintColW + bw}px`;
  puzzleEl.style.height = `${hintRowH + bh}px`;

  // Publish the live board width so profile-1's control row can span it (buttons
  // flex to fill this width). Updates on every resize/orientation/font-load pass.
  document.body.style.setProperty("--solve-board-width", `${bw}px`);
  // Profiles 1 and 3 center their bottom bar in the empty space below the board:
  // push it up by half that space (measured with the margin reset to 0 above).
  //
  // The ÷2 is exact ONLY because those profiles pin the board to the TOP of
  // .puzzle-and-ref. A top-pinned board doesn't move when the container shrinks, so
  // the "bar margin shrinks the container, which changes the leftover, which changes
  // the margin..." regress has a closed-form fixed point instead of needing
  // iteration. A vertically-centered board would converge at ÷3 instead. See the
  // 2026-07-20 "seal the size, solve the position" note in CLAUDE.md.
  // Profiles 2, 4 and 5 don't consume this var.
  const emptyBelowBoard = availH - (hintRowH + bh);
  document.body.style.setProperty("--bar-center-margin", `${Math.max(0, Math.floor(emptyBelowBoard / 2))}px`);

  // Profile 3 splits the leftover below the top-pinned board into THREE equal
  // margins: buttons→board, board→bar, bar→bottom. With L = that leftover,
  // T = board top margin and M = bar bottom margin:
  //     top = T          middle = L - T - M          bottom = M
  // so T = M = L/3. Clamped so T + M can never exceed L.
  //
  // An earlier revision also subtracted the safe-area inset from the bottom term,
  // on the theory that the strip under the home indicator reads as part of that gap
  // now the background bleeds into it. Dre's device check says it does NOT — that
  // made the bottom gap "wayyy too small". The eye measures to the last painted
  // CONTROL, not to the screen edge.
  // With A = main's row gap, B = main's bottom padding + the home-indicator inset,
  // T = the board's top margin and M = the bar's bottom margin:
  //     Gtop = A + T      Gmid = A + (L - T - M)      Gbot = M + B
  // Setting all three equal and letting D = B - A (the asymmetry, which reduces to
  // just the safe-area inset since padding and gap are both 8px) gives:
  //     T = (L + D)/3     M = (L - 2·D)/3
  // The board reserve above guarantees L ≥ 2·D so M never wants to be negative.
  //
  // History worth keeping: subtracting the FULL inset was tried on 2026-08-21 and made
  // the bottom "wayyy too small"; removing it entirely made the bottom too large. Both
  // readings were correct — the error was applying the correction while L ≈ 0, where
  // there was no space to redistribute in the first place.
  const D = safeBottomPx;
  const leftoverH = Math.max(0, emptyBelowBoard);
  let gapTop = Math.max(0, Math.min(Math.floor((leftoverH + D) / 3), leftoverH));
  let gapBot = Math.max(0, Math.min(Math.floor((leftoverH - 2 * D) / 3), leftoverH - gapTop));
  document.body.style.setProperty("--p3-gap-top", `${gapTop}px`);
  document.body.style.setProperty("--p3-gap-bottom", `${gapBot}px`);

  // Cell content (× marker, colors on win) scale with cell dimensions.
  // Prevents the ×-marker from overflowing and distorting the grid at large boards.
  const cellSize = Math.min(bw / activeW, bh / activeH);
  const cellFontPx = Math.max(8, Math.min(cellSize * 0.65, 22));
  boardEl.style.setProperty("--cell-font-size", `${cellFontPx}px`);

  // --- Overflow guard, rev 3: cap the CONTAINER, not the board ---
  // Two earlier revisions failed here, both instructively:
  //   rev 1 compared main.scrollHeight to main.clientHeight, which always read 0 —
  //     main is not the element being clipped. It sizes to its own content quite
  //     happily while main ITSELF hangs off the bottom of the screen.
  //   rev 2 measured correctly but corrected the wrong thing: it shrank the BOARD.
  //     .puzzle-and-ref is `flex: 1 1 auto`, so a smaller board frees no height at
  //     all — the container keeps its size and the slack simply opens as a gap
  //     under the board. Dre, exactly right: "we are allocating space, just to the
  //     wrong parts."
  // Capping .puzzle-and-ref's max-height is what actually removes height, because
  // flex-grow cannot exceed max-height. The bar then rises by precisely that much.
  // Re-run once afterwards so the board size AND the gap split are solved against
  // the real container height. Single guarded re-entry: the correction is exact, so
  // the second pass cannot overflow again.
  if (_boardFitPass === 0) {
    const barEl = document.querySelector(".solve-bottom-bar");
    if (barEl) {
      const usableBottom = window.innerHeight - safeBottomPx;
      const controlBottom = lowestControlBottom();
      const overflowPx = controlBottom === null ? 0 : Math.ceil(controlBottom - usableBottom);
      if (overflowPx > 0) {
        container.style.maxHeight = `${Math.max(100, container.clientHeight - overflowPx)}px`;
        _boardFitPass = 1;
        try { resizeBoardToFit(); } finally { _boardFitPass = 0; }
        return;
      }
    }
  }

  // --- Measured equalisation: give the middle gap's surplus to the board ---
  // The container cap above and the margin-based gap solve interact badly. Once
  // .puzzle-and-ref carries an explicit max-height, its margin-top no longer SHRINKS
  // it — the margin merely pushes the block down — so the leftover inside the
  // container never reduces and lands entirely in the MIDDLE gap. Device reported
  // 40 / 78 / 0 where the model predicted 42 / 42 / 42, and Dre could see the room.
  //
  // Rather than model that interaction, close the loop on the measurement. The middle
  // gap IS "container height − board block", so growing the board by the excess
  // removes it 1:1 and hands those pixels straight to the board. The bar is already
  // pinned at the usable bottom (bot ≈ 0), so growing the board cannot push it
  // further and cannot re-introduce overflow.
  // Equalisation runs on the NEXT frame, not inline. Measuring immediately after
  // writing the sizes reported pre-correction geometry — the readout kept coming back
  // 40 / 78 / 0 with the fix verified live — so the surplus only becomes visible once
  // the browser has settled this pass. Deferring a frame reads what the player sees.
  updateGapReadout(safeBottomPx);
  if (!_gapFixScheduled) {
    _gapFixScheduled = true;
    requestAnimationFrame(() => { _gapFixScheduled = false; equalizeGaps(); });
  }
}

// Hand the middle gap's surplus to the board. The middle gap IS "container height −
// board block" (the board is top-pinned in .puzzle-and-ref), so growing the board by
// the excess removes it 1:1. Deferred, and measures real rects — no model.
// Idempotent: once spent, the excess measures under the threshold and it stops.
function equalizeGaps() {
  if (editorMode) return;
  if (document.body.dataset.screen !== "solve") return;
  if (!document.body.classList.contains("profile-portrait-dpad")) return;
  const puzzleEl = document.querySelector(".puzzle");
  const container = document.querySelector(".puzzle-and-ref");
  if (!puzzleEl || !container) return;
  const safeBottomPx = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const g = measureGaps(safeBottomPx);
  if (!g) return;
  const excess = g.mid - g.top;
  _lastGapExcess = excess;
  if (excess <= 4) { updateGapReadout(safeBottomPx); return; }

  // Read the sealed dimensions back off the element rather than from variables —
  // resizeBoardToFit may have run again between passes.
  const rows = puzzleEl.style.gridTemplateRows.split(" ");
  const cols = puzzleEl.style.gridTemplateColumns.split(" ");
  if (rows.length !== 2 || cols.length !== 2) return;
  const hintRowH = parseFloat(rows[0]);
  const hintColW = parseFloat(cols[0]);
  let bh = parseFloat(rows[1]);
  let bw = parseFloat(cols[1]);
  if (!(bh > 0) || !(bw > 0)) return;

  const ratio = activeW / activeH;
  bh += excess;
  bw = Math.floor(bh * ratio);
  const maxBw = container.clientWidth - 4 - hintColW;
  if (bw > maxBw) { bw = Math.floor(maxBw); bh = Math.floor(bw / ratio); }
  bw = Math.max(80, Math.floor(bw));
  bh = Math.max(80, Math.floor(bh));

  puzzleEl.style.gridTemplateColumns = `${hintColW}px ${bw}px`;
  puzzleEl.style.gridTemplateRows = `${hintRowH}px ${bh}px`;
  puzzleEl.style.width = `${hintColW + bw}px`;
  puzzleEl.style.height = `${hintRowH + bh}px`;
  document.body.style.setProperty("--solve-board-width", `${bw}px`);
  const cs = Math.min(bw / activeW, bh / activeH);
  boardEl.style.setProperty("--cell-font-size", `${Math.max(8, Math.min(cs * 0.65, 22))}px`);
  updateGapReadout(safeBottomPx);
}


// DEV-ONLY (temporary, 2026-08-22): print the three MEASURED vertical gaps under the
// profile number. Added because the computed model kept disagreeing with the device —
// every gap fix so far has been reasoned from source and then contradicted by a
// screenshot. These numbers come from getBoundingClientRect on the real elements, so
// they are ground truth rather than another prediction. Remove with #profileNum.
// Bottom edge of the lowest visible control. NOT simply the bar's rect: profiles 4
// and 5 set `.solve-bottom-bar { display: contents }` so the dpad and Fill/Cross
// become direct grid items — a display:contents element generates no principal box,
// so its getBoundingClientRect() is all zeros. The overflow guard was therefore inert
// on both landscape profiles: it would have read bottom = 0 and concluded there was
// no overflow no matter how badly they clipped. Found while surveying profile 4 on
// 2026-08-22, before it cost a repeat of profile 3's clipping saga.
function lowestControlBottom() {
  let bottom = null;
  for (const el of [document.querySelector(".solve-bottom-bar"),
                    document.getElementById("dpad"),
                    document.getElementById("modeBtn")]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) continue;   // skips display:contents and hidden elements
    if (bottom === null || r.bottom > bottom) bottom = r.bottom;
  }
  return bottom;
}

// Measured vertical gaps, in screen space. Ground truth — every attempt to derive
// these from the box model has been contradicted by the device.
function measureGaps(safeBottomPx) {
  const statsEl = document.getElementById("solveStats");
  const puzzleEl = document.querySelector(".puzzle");
  const barEl = document.querySelector(".solve-bottom-bar");
  if (!statsEl || !puzzleEl || !barEl) return null;
  const s = statsEl.getBoundingClientRect();
  const p = puzzleEl.getBoundingClientRect();
  const b = barEl.getBoundingClientRect();
  return {
    top: Math.round(p.top - s.bottom),
    mid: Math.round(b.top - p.bottom),
    bot: Math.round((window.innerHeight - safeBottomPx) - b.bottom),
  };
}

// DEV-ONLY: profile 4's one measurement — how far the Fill/Cross button's bottom sits
// ABOVE the board's bottom edge (negative = still below it). Rotation-aware: under
// rotate-app the layout is turned 90deg clockwise, so the app's "bottom" is the screen's
// LEFT, and the comparison has to switch axes or it measures nothing meaningful.
function measureModeLift() {
  const puzzleEl = document.querySelector(".puzzle");
  const modeEl = document.getElementById("modeBtn");
  if (!puzzleEl || !modeEl) return null;
  const p = puzzleEl.getBoundingClientRect();
  const m = modeEl.getBoundingClientRect();
  if (m.width <= 0 || m.height <= 0) return null;
  return document.body.classList.contains("rotate-app")
    ? Math.round(m.left - p.left)      // app-bottom maps to screen-left
    : Math.round(p.bottom - m.bottom);
}

function updateGapReadout(safeBottomPx) {
  const el = document.getElementById("profileNum");
  if (!el) return;
  let out = el.querySelector(".gap-readout");
  if (document.body.classList.contains("profile-wide-nodpad")) {
    const lift = measureModeLift();
    if (lift === null) return;
    if (!out) { out = document.createElement("div"); out.className = "gap-readout"; el.appendChild(out); }
    out.textContent = `lift ${lift}`;
    return;
  }
  if (!document.body.classList.contains("profile-portrait-dpad")) {
    if (out) out.remove();
    return;
  }
  const g = measureGaps(safeBottomPx);
  if (!g) return;
  const { top, mid, bot } = g;
  if (!out) {
    out = document.createElement("div");
    out.className = "gap-readout";
    el.appendChild(out);
  }
  out.textContent = `${top} / ${mid} / ${bot}  ·  x${_lastGapExcess}`;
}

function renderBoard() {
  boardEl.innerHTML = "";
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      // Quadrant dividers: line on the right of every 5th column, bottom of every 5th row.
      // Skip the last col/row since the board's outer border already provides that edge.
      if ((c + 1) % 5 === 0 && c !== activeW - 1) cell.classList.add("col-divider");
      if ((r + 1) % 5 === 0 && r !== activeH - 1) cell.classList.add("row-divider");
      cell.style.background = "";
      applyCellState(cell, board[r][c]);
      boardEl.appendChild(cell);
    }
  }
  // renderBoard nukes all cell nodes, so any prior cursor class is gone — reapply.
  renderCursor();
  updateProfileLabel(); // DEV-ONLY: re-attach the faint profile number after the wipe
}

function onBoardPointerDown(e) {
  const cell = e.target.closest(".cell");
  if (!cell || !boardEl.contains(cell)) return;
  // Release implicit pointer capture so subsequent pointermove events
  // fire on neighbor cells during a drag (especially important for touch).
  cell.releasePointerCapture?.(e.pointerId);
  // Eyedropper mode in editor: clicking a board cell picks that cell's color into the targeted slot.
  if (editorMode && eyedropperSlot !== null) {
    e.preventDefault();
    e.stopPropagation();
    const r = +cell.dataset.row;
    const c = +cell.dataset.col;
    const ch = editorBoard[r][c];
    const hex = ch && editorColorMap[ch];
    if (hex) {
      const slotIdx = eyedropperSlot;
      setSlotColor(slotIdx, hex);
      selectedColor = SLOT_CHARS[slotIdx];
    }
    deactivateEyedropper();
    return;
  }
  if (editorMode) handleEditorPointerDown(e, cell);
  else handleSolvePointerDown(e, cell);
}

function onBoardPointerMove(e) {
  if (!pointerActive) return;
  const cell = e.target.closest(".cell");
  if (!cell || !boardEl.contains(cell)) return;
  e.preventDefault();
  const r = +cell.dataset.row;
  const c = +cell.dataset.col;
  if (editorMode) {
    paintEditorCell(r, c);
    refreshEditorHints();
  } else {
    paintCell(cell, r, c);
  }
}

function handleSolvePointerDown(e, cell) {
  if (won) return;
  const r = +cell.dataset.row;
  const c = +cell.dataset.col;
  // Dpad-on implies tap-to-select on touch. Mouse users still paint via left/right
  // click (desktop has no dpad affordance, so this would strand them without a commit path).
  if (settings.dpad && e.pointerType !== "mouse") {
    e.preventDefault();
    selectedCell = { r, c };
    renderCursor();
    return;
  }
  // Left-click respects the mode toggle (fill or cross). Right-click always crosses
  // as an override — power users can flip between the two on desktop without touching the button.
  let target;
  if (e.pointerType === "mouse") {
    if (e.button === 2) target = STATE_CROSSED;
    else if (e.button === 0) target = currentMode === "cross" ? STATE_CROSSED : STATE_FILLED;
    else return;
  } else {
    target = currentMode === "cross" ? STATE_CROSSED : STATE_FILLED;
  }
  e.preventDefault();
  // Toggle behavior: clicking a cell that already has the target state clears it.
  brushTarget = board[r][c] === target ? STATE_EMPTY : target;
  pointerActive = true;
  visited.clear();
  paintCell(cell, r, c);
}

function toggleMode() {
  currentMode = currentMode === "fill" ? "cross" : "fill";
  updateModeButton();
}

// One-shot swell on a freshly painted cell. Class-based so reduce-motion's blanket
// `animation: none` kills it for free; the forced reflow restarts the animation
// when the same cell is repainted quickly.
function popCell(cell, state) {
  if (settings.reduceMotion || state === STATE_EMPTY) return;
  cell.classList.remove("pop");
  void cell.offsetWidth;
  cell.classList.add("pop");
}

// === Cursor + dpad ===
// selectedCell = { r, c } | null. Persists across puzzle switches so first
// dpad press after load lands at 0,0.
let selectedCell = null;

function renderCursor() {
  if (!boardEl) return;
  for (const c of boardEl.querySelectorAll(".cell.cursor")) c.classList.remove("cursor");
  if (!selectedCell || !activePuzzle) return;
  const idx = selectedCell.r * activeW + selectedCell.c;
  const cell = boardEl.children[idx];
  if (cell) cell.classList.add("cursor");
}

function moveCursor(dr, dc) {
  if (editorMode || won || !activePuzzle) return;
  if (!selectedCell) {
    selectedCell = { r: 0, c: 0 };
  } else {
    // Wrap-around (2026-08-26, "like pac man"): walking off any edge re-enters on
    // the opposite side. The double-modulo keeps negatives positive.
    const nr = ((selectedCell.r + dr) % activeH + activeH) % activeH;
    const nc = ((selectedCell.c + dc) % activeW + activeW) % activeW;
    selectedCell = { r: nr, c: nc };
  }
  renderCursor();
}

// Dpad center = commit current mode's action on the cursor cell.
// Reuses the brush-stroke pipeline so undo, mistakes, auto-cross, and win
// detection all behave identically to a regular tap-paint.
// Optional `mode` param overrides currentMode — used by the "disable action
// button" flow where Fill/Cross buttons commit their specific action.
function commitCursorAction(mode = currentMode) {
  if (editorMode || won || !activePuzzle) return;
  if (!selectedCell) selectedCell = { r: 0, c: 0 };
  const { r, c } = selectedCell;
  const cell = boardEl.children[r * activeW + c];
  if (!cell) return;
  const target = mode === "cross" ? STATE_CROSSED : STATE_FILLED;
  brushTarget = board[r][c] === target ? STATE_EMPTY : target;
  visited.clear();
  paintCell(cell, r, c);
  endBrush();
  renderCursor(); // paintCell/endBrush may have re-rendered board; reapply cursor
}

const dpadEl = document.getElementById("dpad");
if (dpadEl) {
  dpadEl.addEventListener("click", e => {
    const btn = e.target.closest(".dpad-btn");
    if (!btn) return;
    const dir = btn.dataset.dir;
    if (dir === "up")     moveCursor(-1, 0);
    else if (dir === "down")  moveCursor(1, 0);
    else if (dir === "left")  moveCursor(0, -1);
    else if (dir === "right") moveCursor(0, 1);
    else if (dir === "center") commitCursorAction();
  });
  // Ripple feedback fires on pointerdown (immediate visual response, feels
  // snappier than waiting for click). Inserts a <circle> into the ripples
  // group clipped to the button's shape; CSS animates it and it self-removes.
  const RIPPLE_SVG_NS = "http://www.w3.org/2000/svg";
  // Buoyant press: scale the SVG down on pointerdown, spring back on release.
  // (The idle bob lives on the container; see the CSS note.)
  const _dpadSvg = dpadEl.querySelector("svg");
  const _dpadRelease = () => _dpadSvg && _dpadSvg.classList.remove("dpad-press");
  window.addEventListener("pointerup", _dpadRelease);
  window.addEventListener("pointercancel", _dpadRelease);
  dpadEl.addEventListener("pointerdown", e => {
    const btn = e.target.closest(".dpad-btn");
    if (!btn) return;
    if (_dpadSvg) _dpadSvg.classList.add("dpad-press");
    sfx.tap();
    const dir = btn.dataset.dir;
    const svg = dpadEl.querySelector("svg");
    const group = svg.querySelector(`.dpad-ripples.${dir}`);
    if (!group) return;
    const rect = svg.getBoundingClientRect();
    // Map client coords to the 100x100 viewBox.
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top)  / rect.height) * 100;
    const circle = document.createElementNS(RIPPLE_SVG_NS, "circle");
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    circle.setAttribute("r", 30);
    circle.classList.add("dpad-ripple");
    circle.addEventListener("animationend", () => circle.remove());
    group.appendChild(circle);
  });
}

function updateModeButton() {
  // Split button — active state driven by parent class, halves style
  // themselves via `.mode-fill .mode-half-fill.active` selectors.
  // When `disableActionBtn` is on with dpad, Fill/Cross are action buttons
  // (not mode selectors) — pin the class to mode-fill so Fill stays styled
  // dark and Cross stays styled light, regardless of currentMode.
  if (settings.dpad && settings.disableActionBtn) {
    modeBtn.classList.add("mode-fill");
    modeBtn.classList.remove("mode-cross");
    return;
  }
  modeBtn.classList.toggle("mode-fill", currentMode === "fill");
  modeBtn.classList.toggle("mode-cross", currentMode === "cross");
}

function paintCell(cell, r, c) {
  const key = `${r},${c}`;
  if (visited.has(key)) return;
  visited.add(key);
  const prev = board[r][c];
  if (prev === brushTarget) return; // no actual change, skip side effects
  currentStroke.push({ r, c, prev });
  board[r][c] = brushTarget;
  applyCellState(cell, brushTarget);
  popCell(cell, brushTarget);
  if (brushTarget === STATE_FILLED) sfx.fill();
  else if (brushTarget === STATE_CROSSED) sfx.cross();
  else sfx.erase();
  updateHintCompletion();
  if (settings.timer) startTimer();
  if (settings.mistakes && brushTarget === STATE_FILLED && activePuzzle && !activePuzzle.truth[r][c]) {
    recordMistake();
  }
  if (settings.autoCross) autoCrossAfterPaint(r, c);
}

function autoCrossAfterPaint(r, c) {
  if (!activePuzzle || won) return;
  // Auto-cross fires when a row's or column's filled run-lengths exactly match the hint —
  // standard picross convention. Doesn't undo previous auto-crosses if the user later un-fills.
  const rowFilled = board[r].map(s => s === STATE_FILLED);
  if (arraysEqual(runsInLine(rowFilled), hints.rows[r])) {
    for (let i = 0; i < activeW; i++) {
      if (board[r][i] === STATE_EMPTY) {
        currentStroke.push({ r, c: i, prev: STATE_EMPTY });
        board[r][i] = STATE_CROSSED;
        applyCellState(boardEl.children[r * activeW + i], STATE_CROSSED);
      }
    }
  }
  const colFilled = [];
  for (let i = 0; i < activeH; i++) colFilled.push(board[i][c] === STATE_FILLED);
  if (arraysEqual(runsInLine(colFilled), hints.cols[c])) {
    for (let i = 0; i < activeH; i++) {
      if (board[i][c] === STATE_EMPTY) {
        currentStroke.push({ r: i, c, prev: STATE_EMPTY });
        board[i][c] = STATE_CROSSED;
        applyCellState(boardEl.children[i * activeW + c], STATE_CROSSED);
      }
    }
  }
  updateHintCompletion();
}

function endBrush() {
  pointerActive = false;
  brushTarget = null;
  visited.clear();
  editorBrush = null;
  editorVisited.clear();
  if (editorMode) {
    if (currentEditorStroke.length > 0) {
      editorUndoStack.push(currentEditorStroke);
      if (editorUndoStack.length > 100) editorUndoStack.shift();
      // New action invalidates redo history.
      editorRedoStack.length = 0;
      currentEditorStroke = [];
      updateEditorUndoRedoState();
    }
    truthStrokeDir = null;
    gcEditorColorMap();
    return;
  }
  if (currentStroke.length > 0) {
    undoStack.push(currentStroke);
    if (undoStack.length > 100) undoStack.shift();
    currentStroke = [];
    updateUndoButtonState();
  }
  if (!won && checkWin()) startWinSequence();
}

// DEV-ONLY: force-solve the puzzle and trigger the full win flow (wave, reveal,
// sparkles, card) — exists precisely to iterate on that flow without solving.
// Visible only under the Dev tools setting.
function devWinPuzzle() {
  if (editorMode || !activePuzzle || won) return;
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      board[r][c] = activePuzzle.truth[r][c] ? STATE_FILLED : STATE_EMPTY;
    }
  }
  renderBoard();
  updateHintCompletion();
  startWinSequence();
}

// === Win sequence (2026-08-25) ===
// wave (F=1 cells ripple diagonally) → color reveal (existing .won fade) →
// sparkles → win card. All bookkeeping that used to live inline in endBrush is
// here so the dev button and real wins share one path.
function startWinSequence() {
  won = true;
  if (currentPuzzleId && !completedSet.has(currentPuzzleId)) {
    completedSet.add(currentPuzzleId);
    saveCompleted();
  }
  stopTimer();
  renderLibrary();
  updateUndoButtonState();
  // The cursor ring must not sit painted over the revealed picture (pre-existing
  // bug: solving via dpad left it there).
  selectedCell = null;
  renderCursor();

  if (settings.reduceMotion) {
    revealColors();
    showWinModal();
    return;
  }
  sfx.win();
  const cells = boardEl.children;
  let maxDelay = 0;
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      if (!activePuzzle.truth[r][c]) continue;
      const d = (r + c) * 36;   // diagonal wavefront from the top-left
      if (d > maxDelay) maxDelay = d;
      const el = cells[r * activeW + c];
      el.style.animationDelay = d + "ms";
      el.classList.add("win-wave");
    }
  }
  setTimeout(() => {
    for (const el of boardEl.querySelectorAll(".win-wave")) {
      el.classList.remove("win-wave");
      el.style.animationDelay = "";
    }
    revealColors();
    spawnSparkles();
    setTimeout(showWinModal, 700);
  }, maxDelay + 540);
}

function spawnSparkles() {
  for (let i = 0; i < 9; i++) {
    const s = document.createElement("span");
    s.className = "win-sparkle";
    s.textContent = "✦";
    s.style.left = (6 + Math.random() * 86) + "%";
    s.style.top  = (6 + Math.random() * 86) + "%";
    s.style.animationDelay = (Math.random() * 0.45).toFixed(2) + "s";
    s.addEventListener("animationend", () => s.remove());
    boardEl.appendChild(s);
  }
}

// Which Shipping category holds this puzzle — the win card's Next needs it, and
// it also repairs currentUserCategoryName when a solve was entered from admin.
function findCategoryOf(id) {
  for (const [name, ids] of Object.entries(library.shipping.folders)) {
    if (ids.includes(id)) return name;
  }
  return null;
}

function showWinModal() {
  const modal = document.getElementById("winModal");
  if (!modal || !activePuzzle) return;
  document.getElementById("winName").textContent = activePuzzle.name || "";

  // Stats — a chip only renders when its feature was on (empty spans self-hide in CSS).
  const t = document.getElementById("winTime");
  if (settings.timer && elapsedMs > 0) {
    const sec = Math.floor(elapsedMs / 1000);
    t.textContent = `⏱ ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  } else t.textContent = "";
  const mk = document.getElementById("winMistakes");
  mk.textContent = settings.mistakes ? `✕ ${mistakeCount}` : "";

  // Pixel preview — the solved picture drawn cell-by-cell at 12px/cell.
  const cv = document.getElementById("winPreview");
  const scale = 12;
  cv.width = activeW * scale;
  cv.height = activeH * scale;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#faf3e6";
  ctx.fillRect(0, 0, cv.width, cv.height);
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      const col = activePuzzle.colors[r] && activePuzzle.colors[r][c];
      if (col) { ctx.fillStyle = col; ctx.fillRect(c * scale, r * scale, scale, scale); }
    }
  }

  // Original photo ↔ pixel toggle. Photos ship in images/ keyed by puzzle id via
  // IMAGE_MANIFEST (generated at deploy). No entry, or a failed load → toggle hides
  // and the card is pixel-only; nothing else changes.
  const wrap = modal.querySelector(".win-preview-wrap");
  const photo = document.getElementById("winPhoto");
  wrap.classList.remove("show-photo");
  const file = (typeof IMAGE_MANIFEST !== "undefined") && IMAGE_MANIFEST[currentPuzzleId];
  if (file) {
    wrap.classList.remove("no-photo");
    photo.onerror = () => { wrap.classList.add("no-photo"); wrap.classList.remove("show-photo"); };
    photo.src = "images/" + file;
    document.getElementById("winPhotoToggle").textContent = "Photo";
  } else {
    wrap.classList.add("no-photo");
    photo.removeAttribute("src");
  }

  document.getElementById("winFact").textContent = activePuzzle.fact || "";
  const srcA = document.getElementById("winSource");
  const src = activePuzzle.source;
  if (src && src.url) {
    srcA.href = src.url;
    srcA.textContent = src.attribution ? `image: ${src.attribution}` : "image source";
  } else if (src && src.attribution) {
    srcA.removeAttribute("href");
    srcA.textContent = `image: ${src.attribution}`;
  } else {
    srcA.removeAttribute("href");
    srcA.textContent = "";
  }
  const refA = document.getElementById("winFactSrc");
  if (activePuzzle.factSource) {
    refA.href = activePuzzle.factSource;
    refA.textContent = "fact source";
  } else {
    refA.removeAttribute("href");
    refA.textContent = "";
  }

  // Next is disabled on the last puzzle of a category rather than wrapping —
  // wrapping felt like being trapped in a loop; "go pick" is the honest state.
  const cat = findCategoryOf(currentPuzzleId);
  const nextBtn = document.getElementById("winNext");
  let nextId = null;
  if (cat) {
    const ids = library.shipping.folders[cat];
    nextId = ids[ids.indexOf(currentPuzzleId) + 1] || null;
  }
  nextBtn.disabled = !nextId;
  nextBtn.dataset.nextId = nextId || "";
  nextBtn.dataset.cat = cat || "";

  modal.classList.remove("hidden");
}

function hideWinModal() {
  const modal = document.getElementById("winModal");
  if (modal) modal.classList.add("hidden");
  modal?.querySelector(".win-preview-wrap")?.classList.remove("show-photo");
}

function checkWin() {
  if (!activePuzzle) return false; // user mode home/category screens have no active puzzle
  const truth = activePuzzle.truth;
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      const shouldFill = truth[r][c];
      const isFilled = board[r][c] === STATE_FILLED;
      if (shouldFill !== isFilled) return false;
    }
  }
  return true;
}

function revealColors() {
  boardEl.classList.add("won");
  const colors = activePuzzle.colors;
  const cells = boardEl.children;
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      const cell = cells[r * activeW + c];
      const color = colors[r] && colors[r][c];
      if (color) {
        cell.style.background = color;
        cell.classList.remove("crossed");
      }
    }
  }
  // (The old inline fact card is superseded by the win modal, 2026-08-25.)
}

function showFactCard() {
  const card = document.getElementById("solveFact");
  const nameEl = document.getElementById("solveFactName");
  const textEl = document.getElementById("solveFactText");
  const sourceEl = document.getElementById("solveFactSource");
  if (!card || !activePuzzle) return;
  // Always show the puzzle name on win; fact + source only if present.
  nameEl.textContent = activePuzzle.name || "";
  if (activePuzzle.fact) {
    textEl.textContent = activePuzzle.fact;
    textEl.style.display = "";
  } else {
    textEl.textContent = "";
    textEl.style.display = "none";
  }
  const src = activePuzzle.source;
  if (src && src.url) {
    sourceEl.href = src.url;
    sourceEl.textContent = src.attribution ? `image: ${src.attribution}` : "image source";
  } else if (src && src.attribution) {
    sourceEl.removeAttribute("href");
    sourceEl.textContent = `image: ${src.attribution}`;
  } else {
    sourceEl.removeAttribute("href");
    sourceEl.textContent = "";
  }
  // Fact source (separate URL — where the fact came from, e.g. Wikipedia)
  const refEl = document.getElementById("solveFactSourceRef");
  const factSrc = activePuzzle.factSource;
  if (refEl) {
    if (factSrc) {
      refEl.href = factSrc;
      refEl.textContent = "fact source";
    } else {
      refEl.removeAttribute("href");
      refEl.textContent = "";
    }
  }
  card.classList.remove("hidden");
  // Fact card now consumes flex space — shrink the board to compensate.
  if (!editorMode && document.body.dataset.screen === "solve") {
    requestAnimationFrame(resizeBoardToFit);
  }
}

function hideFactCard() {
  const card = document.getElementById("solveFact");
  if (card) card.classList.add("hidden");
}

function applyCellState(el, state) {
  el.classList.toggle("filled", state === STATE_FILLED);
  el.classList.toggle("crossed", state === STATE_CROSSED);
  // Don't touch background after the win-reveal has stamped colors.
  if (won) return;
  // Faded reveal: filled cells that match the truth get a tinted background hinting at the reveal color.
  if (settings.fadedReveal && activePuzzle && state === STATE_FILLED) {
    const r = +el.dataset.row;
    const c = +el.dataset.col;
    if (activePuzzle.truth[r] && activePuzzle.truth[r][c]) {
      const color = activePuzzle.colors[r] && activePuzzle.colors[r][c];
      if (color) {
        el.style.background = hexFaded(color);
        return;
      }
    }
  }
  el.style.background = "";
}

function computeHints(truth) {
  const h = truth.length;
  const w = truth[0].length;
  const rows = [];
  const cols = [];
  for (let r = 0; r < h; r++) {
    rows.push(runsInLine(truth[r]));
  }
  for (let c = 0; c < w; c++) {
    const colArr = [];
    for (let r = 0; r < h; r++) colArr.push(truth[r][c]);
    cols.push(runsInLine(colArr));
  }
  return { rows, cols };
}

function runsInLine(line) {
  const runs = [];
  let cur = 0;
  for (const v of line) {
    if (v) cur++;
    else if (cur > 0) { runs.push(cur); cur = 0; }
  }
  if (cur > 0) runs.push(cur);
  return runs.length === 0 ? [0] : runs;
}

function loadPuzzle(id) {
  if (!PUZZLES[id]) return;
  currentPuzzleId = id;
  activePuzzle = PUZZLES[id];
  const h = activePuzzle.truth.length;
  const w = activePuzzle.truth[0].length;
  applyDimensions(w, h);
  board = createEmptyBoard(w, h);
  hints = computeHints(activePuzzle.truth);
  renderHints(hints);
  won = false;
  boardEl.classList.remove("won");
  renderBoard();
  updateHintCompletion();
  resetTimer();
  resetMistakes();
  undoStack.length = 0;
  currentStroke = [];
  updateUndoButtonState();
  hideFactCard();
  hideWinModal();
  renderLibrary();
  // Reset cursor when swapping puzzles — position from a prior puzzle is meaningless.
  selectedCell = null;
  renderCursor();
  // Puzzle dimensions may have changed → re-evaluate rotation + refit board.
  updateRotationClass();
  if (!editorMode) requestAnimationFrame(resizeBoardToFit);
}

function clearBoard() {
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) board[r][c] = STATE_EMPTY;
  }
  won = false;
  boardEl.classList.remove("won");
  renderBoard();
  updateHintCompletion();
  resetTimer();
  resetMistakes();
  undoStack.length = 0;
  currentStroke = [];
  updateUndoButtonState();
  hideFactCard();
  hideWinModal();
}

function updateHintCompletion() {
  if (!activePuzzle) return;
  for (let r = 0; r < activeH; r++) {
    const userRuns = runsInLine(board[r].map(s => s === STATE_FILLED));
    const match = arraysEqual(userRuns, hints.rows[r]);
    rowHintsEl.children[r].classList.toggle("completed", match);
  }
  for (let c = 0; c < activeW; c++) {
    const colArr = [];
    for (let r = 0; r < activeH; r++) colArr.push(board[r][c] === STATE_FILLED);
    const userRuns = runsInLine(colArr);
    const match = arraysEqual(userRuns, hints.cols[c]);
    colHintsEl.children[c].classList.toggle("completed", match);
  }
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return structuredClone(LIBRARY_DEFAULT);
    const parsed = JSON.parse(raw);
    // Defensive: ensure all three subsections exist with the right shape
    for (const [k] of SUBSECTIONS) {
      if (!parsed[k]) parsed[k] = { folders: {}, puzzles: [] };
      if (!parsed[k].folders) parsed[k].folders = {};
      if (!parsed[k].puzzles) parsed[k].puzzles = [];
    }
    return parsed;
  } catch {
    return structuredClone(LIBRARY_DEFAULT);
  }
}

function saveLibrary() {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(library)); } catch {}
}

// Make sure every puzzle in PUZZLES is somewhere in the library, and that
// the library doesn't reference any puzzle that no longer exists in PUZZLES.
// Also self-heals canonical Shipping Library category folders so that adding new
// SHIPPING_FOLDERS entries in code propagates to existing users without manual setup.
function syncLibraryWithPuzzles() {
  const present = new Set();
  for (const [k] of SUBSECTIONS) {
    library[k].puzzles = library[k].puzzles.filter(id => {
      if (id in PUZZLES) { present.add(id); return true; }
      return false;
    });
    for (const folderName of Object.keys(library[k].folders)) {
      library[k].folders[folderName] = library[k].folders[folderName].filter(id => {
        if (id in PUZZLES) { present.add(id); return true; }
        return false;
      });
    }
  }
  // Any puzzle not currently classified gets dropped into Standby root.
  for (const id of Object.keys(PUZZLES)) {
    if (!present.has(id)) library.standby.puzzles.push(id);
  }
  // Ensure every canonical Shipping category folder exists (self-heal for existing users).
  for (const name of SHIPPING_FOLDERS) {
    if (!library.shipping.folders[name]) {
      library.shipping.folders[name] = [];
    }
  }
}

function renderLibrary() {
  libraryEl.innerHTML = "";
  const title = document.createElement("h1");
  title.className = "library-title";
  title.textContent = "Puzzle Library";
  libraryEl.appendChild(title);

  const sectionsWrap = document.createElement("div");
  sectionsWrap.className = "library-sections";

  for (const [subKey, subTitle] of SUBSECTIONS) {
    const section = document.createElement("section");
    section.className = "library-section";
    section.dataset.key = subKey;

    const heading = document.createElement("h2");
    heading.textContent = subTitle;
    section.appendChild(heading);

    const scrollArea = document.createElement("div");
    scrollArea.className = "library-scroll";
    const list = document.createElement("ul");
    list.className = "library-list";

    const sub = library[subKey];
    for (const folderName of Object.keys(sub.folders)) {
      list.appendChild(buildFolderItem(subKey, folderName));
    }
    for (const id of sub.puzzles) {
      list.appendChild(buildPuzzleItem(id, subKey, null));
    }
    scrollArea.appendChild(list);
    section.appendChild(scrollArea);

    // Mini "+ folder" button hugging the bottom border between sections
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-folder-mini";
    addBtn.title = "New folder";
    addBtn.innerHTML = `+ ${FOLDER_ICON_SVG}`;
    addBtn.addEventListener("click", e => {
      e.stopPropagation();
      const name = prompt("Folder name:");
      if (name && name.trim()) createFolder(subKey, name.trim());
    });
    section.appendChild(addBtn);

    // Right-click on empty space within a section also creates a folder
    section.addEventListener("contextmenu", e => {
      if (e.target.closest(".puzzle-item")) return;
      if (e.target.closest(".folder-header")) return;
      if (e.target.closest(".add-folder-mini")) return;
      e.preventDefault();
      e.stopPropagation();
      showSectionContextMenu(e, subKey);
    });

    sectionsWrap.appendChild(section);
  }
  libraryEl.appendChild(sectionsWrap);
}

function buildFolderItem(subKey, folderName) {
  const li = document.createElement("li");
  li.className = "folder-item";
  const header = document.createElement("div");
  header.className = "folder-header";
  const ids = library[subKey].folders[folderName];
  header.textContent = `${folderName} (${ids.length})`;
  header.addEventListener("click", () => li.classList.toggle("collapsed"));
  header.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    showFolderContextMenu(e, subKey, folderName);
  });
  li.appendChild(header);
  const children = document.createElement("ul");
  children.className = "folder-children";
  for (const id of ids) {
    children.appendChild(buildPuzzleItem(id, subKey, folderName));
  }
  li.appendChild(children);
  return li;
}

function buildPuzzleItem(id, subKey, folderName) {
  const li = document.createElement("li");
  li.className = "puzzle-item";
  li.dataset.id = id;
  const puzzle = PUZZLES[id];
  if (!puzzle) {
    li.textContent = `[missing: ${id}]`;
    li.classList.add("missing");
    return li;
  }
  const nameSpan = document.createElement("span");
  nameSpan.textContent = puzzle.name;
  li.appendChild(nameSpan);
  const checkSpan = document.createElement("span");
  checkSpan.className = "check";
  checkSpan.textContent = completedSet.has(id) ? "✓" : "";
  li.appendChild(checkSpan);
  const activeId = editorMode ? editTargetId : currentPuzzleId;
  if (id === activeId) li.classList.add("active");
  if (completedSet.has(id)) li.classList.add("completed");

  li.addEventListener("click", () => {
    if (editorMode) {
      if (id !== editTargetId) loadEditorPuzzle(id);
    } else {
      if (id !== currentPuzzleId) loadPuzzle(id);
    }
  });
  li.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    showPuzzleContextMenu(e, id, subKey, folderName);
  });
  return li;
}

function showPuzzleContextMenu(e, id, currentSub, currentFolder) {
  contextMenuEl.innerHTML = "";
  // Mark the puzzle item so the user can see which one their menu is operating on.
  // Cleared in hideContextMenu().
  document.querySelectorAll(".puzzle-item.context-target")
    .forEach(el => el.classList.remove("context-target"));
  const targetEl = e.currentTarget;
  if (targetEl) targetEl.classList.add("context-target");

  const header = document.createElement("div");
  header.className = "menu-header";
  header.textContent = "Move to";
  contextMenuEl.appendChild(header);

  for (const [subKey, subTitle] of SUBSECTIONS) {
    const row = document.createElement("div");
    row.className = "menu-row";

    // Main row: click = move to subsection root
    const main = document.createElement("div");
    main.className = "menu-item";
    main.textContent = subTitle;
    const isCurrentRoot = currentSub === subKey && currentFolder === null;
    if (isCurrentRoot) main.classList.add("disabled");
    main.addEventListener("click", ev => {
      if (isCurrentRoot) return;
      ev.stopPropagation();
      movePuzzle(id, currentSub, currentFolder, subKey, null);
      hideContextMenu();
    });
    row.appendChild(main);

    // Folder icon: click = open submenu of folders in this subsection
    const folderNames = Object.keys(library[subKey].folders);
    const folderToggle = document.createElement("div");
    folderToggle.className = "menu-folder-toggle";
    folderToggle.innerHTML = FOLDER_ICON_SVG;
    if (folderNames.length === 0) folderToggle.classList.add("disabled");
    row.appendChild(folderToggle);

    if (folderNames.length > 0) {
      const submenu = document.createElement("div");
      submenu.className = "menu-submenu hidden";
      let hasItems = false;
      for (const folderName of folderNames) {
        if (currentSub === subKey && currentFolder === folderName) continue;
        const item = document.createElement("div");
        item.className = "menu-item";
        item.textContent = folderName;
        item.addEventListener("click", ev => {
          ev.stopPropagation();
          movePuzzle(id, currentSub, currentFolder, subKey, folderName);
          hideContextMenu();
        });
        submenu.appendChild(item);
        hasItems = true;
      }
      if (hasItems) {
        row.appendChild(submenu);
        folderToggle.addEventListener("click", ev => {
          ev.stopPropagation();
          // Close any other submenus first
          contextMenuEl.querySelectorAll(".menu-submenu").forEach(s => {
            if (s !== submenu) s.classList.add("hidden");
          });
          submenu.classList.toggle("hidden");
        });
      } else {
        folderToggle.classList.add("disabled");
      }
    }

    contextMenuEl.appendChild(row);
  }
  positionContextMenu(e);
}

function showSectionContextMenu(e, subKey) {
  contextMenuEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "menu-header";
  const subTitle = SUBSECTIONS.find(([k]) => k === subKey)[1];
  header.textContent = subTitle;
  contextMenuEl.appendChild(header);
  addMenuItem("+ New Folder", () => {
    const name = prompt("Folder name:");
    if (name && name.trim()) createFolder(subKey, name.trim());
  });
  positionContextMenu(e);
}

function showFolderContextMenu(e, subKey, folderName) {
  contextMenuEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "menu-header";
  header.textContent = `Folder: ${folderName}`;
  contextMenuEl.appendChild(header);
  addMenuItem("Rename...", () => {
    const next = prompt("Rename folder to:", folderName);
    if (next && next.trim() && next.trim() !== folderName) {
      renameFolder(subKey, folderName, next.trim());
    }
  });
  const divider = document.createElement("div");
  divider.className = "menu-divider";
  contextMenuEl.appendChild(divider);
  const item = document.createElement("div");
  item.className = "menu-item danger";
  item.textContent = "Delete folder (puzzles drop to root)";
  item.addEventListener("click", () => {
    deleteFolder(subKey, folderName);
    hideContextMenu();
  });
  contextMenuEl.appendChild(item);
  positionContextMenu(e);
}

function addMenuItem(text, onClick) {
  const item = document.createElement("div");
  item.className = "menu-item";
  item.textContent = text;
  item.addEventListener("click", () => { onClick(); hideContextMenu(); });
  contextMenuEl.appendChild(item);
}

function positionContextMenu(e) {
  contextMenuEl.classList.remove("hidden");
  // Clamp inside viewport
  const w = contextMenuEl.offsetWidth;
  const h = contextMenuEl.offsetHeight;
  const x = Math.min(e.clientX, window.innerWidth - w - 4);
  const y = Math.min(e.clientY, window.innerHeight - h - 4);
  contextMenuEl.style.left = x + "px";
  contextMenuEl.style.top = y + "px";
}

function hideContextMenu() {
  contextMenuEl.classList.add("hidden");
  document.querySelectorAll(".puzzle-item.context-target")
    .forEach(el => el.classList.remove("context-target"));
}

function movePuzzle(id, fromSub, fromFolder, toSub, toFolder) {
  const fromList = fromFolder ? library[fromSub].folders[fromFolder] : library[fromSub].puzzles;
  const idx = fromList.indexOf(id);
  if (idx >= 0) fromList.splice(idx, 1);
  const toList = toFolder ? library[toSub].folders[toFolder] : library[toSub].puzzles;
  toList.push(id);
  saveLibrary();
  renderLibrary();
}

function createFolder(subKey, name) {
  if (library[subKey].folders[name]) return;
  library[subKey].folders[name] = [];
  saveLibrary();
  renderLibrary();
}

function deleteFolder(subKey, folderName) {
  const sub = library[subKey];
  if (!sub.folders[folderName]) return;
  sub.puzzles.push(...sub.folders[folderName]);
  delete sub.folders[folderName];
  saveLibrary();
  renderLibrary();
}

function renameFolder(subKey, oldName, newName) {
  const sub = library[subKey];
  if (!sub.folders[oldName] || sub.folders[newName]) return;
  // Preserve key order by rebuilding
  const newFolders = {};
  for (const [k, v] of Object.entries(sub.folders)) {
    newFolders[k === oldName ? newName : k] = v;
  }
  sub.folders = newFolders;
  saveLibrary();
  renderLibrary();
}

document.addEventListener("click", hideContextMenu);
window.addEventListener("blur", hideContextMenu);

// Audio unlock — iOS only permits audio started inside a user gesture. Capture
// phase so it runs before any handler that might want to play a sound in the
// same gesture. Cheap enough to run on every pointerdown.
document.addEventListener("pointerdown", () => sfx.unlock(), true);
// Uniform tap sound for every real <button> in the app — one delegated listener
// instead of per-button wiring. Cells and dpad arrows aren't <button>s, so their
// dedicated sounds never double-fire with this.
document.addEventListener("click", e => {
  if (e.target && e.target.closest && e.target.closest("button")) sfx.tap();
}, true);

function loadCompleted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveCompleted() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...completedSet]));
  } catch {
    // localStorage may be disabled (private mode) — fail silently, completion just won't persist
  }
}

// ============================================================================
// EDITOR MODE
// ============================================================================

let editorW = SIZE;
let editorH = SIZE;
let editorBoard = createEmptyEditorBoard(editorW, editorH);
let editorTruth = createEmptyEditorTruth(editorW, editorH);
let selectedColor = "r";
let editorBrush = null;  // "paint" | "erase" | null
let paintMode = "accent"; // "truth" | "accent" — default accent so import + paint don't auto-flag every cell as F=1
let truthStrokeDir = null; // true = promote, false = demote — decided per stroke from the first cell's current truth state
const editorUndoStack = [];
let currentEditorStroke = [];
let editTargetId = null; // null = new puzzle; string id = editing existing
let editorDirty = false;
let editorSnapshot = null;
const editorVisited = new Set();
const editorColorMap = { ...COLOR_MAP };

// 20 stable char codes pre-allocated for slot positions, none overlapping with COLOR_MAP defaults.
const SLOT_CHARS = (() => {
  const out = [];
  for (const c of CHAR_POOL) {
    if (out.length >= SLOT_COUNT) break;
    if (!(c in COLOR_MAP)) out.push(c);
  }
  return out;
})();

// Chars used internally for transient shifted colors (lighten/darken outputs).
// These DON'T appear in the palette as slots — they're just storage for cell colors that
// don't deserve a permanent slot. GC'd after each stroke to free unused entries.
const SHIFT_CHARS = (() => {
  const out = [];
  for (const c of CHAR_POOL) {
    if (c in COLOR_MAP) continue;
    if (SLOT_CHARS.includes(c)) continue;
    out.push(c);
  }
  return out;
})();

function assignNextShiftChar() {
  for (const ch of SHIFT_CHARS) {
    if (!(ch in editorColorMap)) return ch;
  }
  return null;
}

// Free shifted chars no longer used by any cell. Slot chars stay even when unused.
function gcEditorColorMap() {
  const used = new Set();
  for (const row of editorBoard) for (const ch of row) if (ch) used.add(ch);
  for (const ch of Object.keys(editorColorMap)) {
    if (ch in COLOR_MAP) continue;
    if (SLOT_CHARS.includes(ch)) continue;
    if (!used.has(ch)) delete editorColorMap[ch];
  }
}

function createEmptyEditorTruth(w, h) {
  const grid = [];
  for (let r = 0; r < h; r++) grid.push(new Array(w).fill(false));
  return grid;
}

function loadCustomSlots() {
  // Try new format first.
  try {
    const raw = localStorage.getItem(EDITOR_SLOTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const slots = new Array(SLOT_COUNT).fill(null);
        for (let i = 0; i < Math.min(parsed.length, SLOT_COUNT); i++) {
          slots[i] = (parsed[i] && typeof parsed[i] === "string") ? parsed[i] : null;
        }
        return slots;
      }
    }
  } catch {}
  // Migrate from previous { char → hex } object format.
  try {
    const oldRaw = localStorage.getItem(EDITOR_COLORS_KEY);
    if (oldRaw) {
      const oldParsed = JSON.parse(oldRaw) || {};
      const slots = new Array(SLOT_COUNT).fill(null);
      const hexes = Object.values(oldParsed).filter(h => typeof h === "string");
      for (let i = 0; i < Math.min(hexes.length, SLOT_COUNT); i++) slots[i] = hexes[i];
      return slots;
    }
  } catch {}
  return new Array(SLOT_COUNT).fill(null);
}

function saveCustomSlots() {
  try { localStorage.setItem(EDITOR_SLOTS_KEY, JSON.stringify(customSlots)); } catch {}
}

const customSlots = loadCustomSlots();
rebuildEditorColorMap();

function rebuildEditorColorMap() {
  for (const k of Object.keys(editorColorMap)) {
    if (!(k in COLOR_MAP)) delete editorColorMap[k];
  }
  customSlots.forEach((hex, i) => {
    if (hex) editorColorMap[SLOT_CHARS[i]] = hex.toLowerCase();
  });
}

// First empty slot index, or null if full.
function firstEmptySlot() {
  for (let i = 0; i < SLOT_COUNT; i++) if (!customSlots[i]) return i;
  return null;
}

// Find existing slot's char for a given hex (case-insensitive). Null if not present.
function findSlotCharForHex(hex) {
  const lower = hex.toLowerCase();
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (customSlots[i] && customSlots[i].toLowerCase() === lower) return SLOT_CHARS[i];
  }
  return null;
}

// Fill the slot at `index` with `hex`. Updates editorColorMap, persists, rebuilds palette.
function setSlotColor(index, hex) {
  customSlots[index] = hex.toLowerCase();
  editorColorMap[SLOT_CHARS[index]] = hex.toLowerCase();
  saveCustomSlots();
  buildEditorPalette();
}

// Clear slot at `index`. Removes its char from editorColorMap.
function clearSlot(index) {
  const ch = SLOT_CHARS[index];
  customSlots[index] = null;
  delete editorColorMap[ch];
  if (selectedColor === ch) selectedColor = "r";
  saveCustomSlots();
  buildEditorPalette();
}

// Clear all custom slots in one shot. Cells using those chars become "empty" visually,
// but their data stays — if you later re-add the matching hex, those cells repopulate.
function clearAllSlots() {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const ch = SLOT_CHARS[i];
    customSlots[i] = null;
    delete editorColorMap[ch];
  }
  if (selectedColor !== "" && selectedColor !== "__lighten" && selectedColor !== "__darken" && !(selectedColor in COLOR_MAP)) {
    selectedColor = "r";
  }
  saveCustomSlots();
  buildEditorPalette();
  if (editorMode) renderEditorBoard();
}

// Legacy: assign next free slot's char (for callers that just want to register a new color).
function assignNextChar() {
  const i = firstEmptySlot();
  if (i === null) return null;
  return SLOT_CHARS[i];
}

// Compatibility shim — pixelate / loadEditorPuzzle still call saveCustomColors().
function saveCustomColors() { saveCustomSlots(); }

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function rgbToHex(r, g, b) {
  const c = n => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}

function createEmptyEditorBoard(w, h) {
  const grid = [];
  for (let r = 0; r < h; r++) grid.push(new Array(w).fill(""));
  return grid;
}

function initEditor() {
  document.body.classList.add("editor-mode");
  applyDimensions(editorW, editorH);
  buildEditorPalette();
  renderEditorBoard();
  refreshEditorHints();
  renderLibrary();
  document.getElementById("editorSave").addEventListener("click", saveEditorPuzzle);
  document.getElementById("editorDiscard").addEventListener("click", discardEditorChanges);
  document.getElementById("editorNew").addEventListener("click", newEditorPuzzle);
  document.getElementById("editorClear").addEventListener("click", clearEditorBoard);
  document.getElementById("editorClearColors").addEventListener("click", () => {
    if (confirm("Clear all 20 custom color slots? Cells using these colors will lose their color.")) {
      clearAllSlots();
      markEditorDirty();
    }
  });
  document.getElementById("editorUndo").addEventListener("click", editorUndo);
  document.getElementById("editorRedo").addEventListener("click", editorRedo);
  document.getElementById("seedExport").addEventListener("click", exportSeed);
  document.getElementById("seedImport").addEventListener("click", importSeed);
  document.getElementById("editorName").addEventListener("input", markEditorDirty);
  document.getElementById("editorFact").addEventListener("input", markEditorDirty);
  document.getElementById("editorSourceUrl").addEventListener("input", markEditorDirty);
  document.getElementById("editorSourceAttribution").addEventListener("input", markEditorDirty);
  const sizeSel = document.getElementById("editorSize");
  sizeSel.value = `${editorW}x${editorH}`;
  sizeSel.addEventListener("change", e => {
    const [w, h] = e.target.value.split("x").map(Number);
    editorW = w;
    editorH = h;
    editorBoard = createEmptyEditorBoard(w, h);
    editorTruth = createEmptyEditorTruth(w, h);
    applyDimensions(w, h);
    renderEditorBoard();
    refreshEditorHints();
    markEditorDirty();
  });
  initEyedropper();
  initPaintModeToggle();
  initImageImport();
  // Initialize snapshot of the blank starting state so dirty diffing works from move 1.
  editorSnapshot = currentEditorState();
  updateSaveButtonState();
  // Restore autosaved working state if there is one and it's non-trivial (had content).
  // This catches accidental refreshes / Print Screen / Snipping Tool sequences that
  // unloaded the page mid-edit.
  const autosaved = loadAutosavedEditorState();
  if (autosaved && hasNonTrivialAutosave(autosaved)) {
    if (confirm("Recover unsaved editor work from your last session?")) {
      restoreAutosavedEditorState(autosaved);
    } else {
      clearAutosavedEditorState();
    }
  }
}

function hasNonTrivialAutosave(state) {
  if (!state || !state.board) return false;
  for (const row of state.board) for (const ch of row) if (ch) return true;
  return false;
}

function restoreAutosavedEditorState(state) {
  editorW = state.width || SIZE;
  editorH = state.height || SIZE;
  editorTruth = state.truth.map(row => [...row]);
  editorBoard = state.board.map(row => [...row]);
  editTargetId = state.editTargetId || null;
  if (state.paintMode === "truth" || state.paintMode === "accent") paintMode = state.paintMode;
  document.getElementById("editorName").value = state.name || "";
  document.getElementById("editorFact").value = state.fact || "";
  document.getElementById("editorSourceUrl").value = state.sourceUrl || "";
  document.getElementById("editorSourceAttribution").value = state.sourceAttribution || "";
  document.getElementById("editorSize").value = `${editorW}x${editorH}`;
  applyDimensions(editorW, editorH);
  buildEditorPalette();
  renderEditorBoard();
  refreshEditorHints();
  updatePaintModeButton();
  editorDirty = true;
  editorSnapshot = currentEditorState();
  // Snapshot reflects current restored state, but since this state is unsaved, keep dirty.
  editorDirty = true;
  updateSaveButtonState();
}

function currentEditorState() {
  return {
    name: document.getElementById("editorName").value,
    width: editorW,
    height: editorH,
    truth: editorTruth.map(row => [...row]),
    board: editorBoard.map(row => [...row]),
    fact: document.getElementById("editorFact").value,
    sourceUrl: document.getElementById("editorSourceUrl").value,
    sourceAttribution: document.getElementById("editorSourceAttribution").value,
  };
}

function markEditorDirty() {
  if (!editorDirty) {
    editorDirty = true;
    updateSaveButtonState();
  }
  // Always autosave on dirty events — keeps localStorage in sync with what's on screen
  // so snipping-tool / accidental refresh / window close doesn't lose work.
  scheduleAutosave();
}

let _autosaveTimer = null;
function scheduleAutosave() {
  if (_autosaveTimer) return;
  _autosaveTimer = setTimeout(() => {
    _autosaveTimer = null;
    autosaveEditorState();
  }, 200);
}

function autosaveEditorState() {
  if (!editorMode) return;
  try {
    const state = {
      name: document.getElementById("editorName")?.value || "",
      width: editorW,
      height: editorH,
      truth: editorTruth,
      board: editorBoard,
      fact: document.getElementById("editorFact")?.value || "",
      sourceUrl: document.getElementById("editorSourceUrl")?.value || "",
      sourceAttribution: document.getElementById("editorSourceAttribution")?.value || "",
      editTargetId: editTargetId,
      paintMode: paintMode,
    };
    localStorage.setItem(EDITOR_AUTOSAVE_KEY, JSON.stringify(state));
  } catch {}
}

function loadAutosavedEditorState() {
  try {
    const raw = localStorage.getItem(EDITOR_AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch { return null; }
}

function clearAutosavedEditorState() {
  try { localStorage.removeItem(EDITOR_AUTOSAVE_KEY); } catch {}
}

// beforeunload warning: only fires when there are unsaved changes in editor mode.
window.addEventListener("beforeunload", e => {
  if (editorMode && editorDirty) {
    e.preventDefault();
    e.returnValue = "";
    return "";
  }
});

function editorUndo() {
  if (!editorMode) return;
  const stroke = editorUndoStack.pop();
  if (!stroke || stroke.length === 0) {
    updateEditorUndoRedoState();
    return;
  }
  for (const { r, c, prevHex, prevTruth } of stroke) {
    // Re-register the hex if its char was GC'd between strokes — undo data is hex, not char.
    const prevCh = prevHex ? (ensureExactColorChar(prevHex) || "") : "";
    editorBoard[r][c] = prevCh;
    editorTruth[r][c] = prevTruth;
  }
  editorRedoStack.push(stroke);
  renderEditorBoard();
  refreshEditorHints();
  gcEditorColorMap();
  markEditorDirty();
  updateEditorUndoRedoState();
}

function editorRedo() {
  if (!editorMode) return;
  const stroke = editorRedoStack.pop();
  if (!stroke || stroke.length === 0) {
    updateEditorUndoRedoState();
    return;
  }
  for (const { r, c, newHex, newTruth } of stroke) {
    const newCh = newHex ? (ensureExactColorChar(newHex) || "") : "";
    editorBoard[r][c] = newCh;
    editorTruth[r][c] = newTruth;
  }
  editorUndoStack.push(stroke);
  renderEditorBoard();
  refreshEditorHints();
  gcEditorColorMap();
  markEditorDirty();
  updateEditorUndoRedoState();
}

function updateEditorUndoRedoState() {
  const u = document.getElementById("editorUndo");
  const r = document.getElementById("editorRedo");
  if (u) u.disabled = editorUndoStack.length === 0;
  if (r) r.disabled = editorRedoStack.length === 0;
}

// Legacy alias — kept so existing call sites don't break.
function updateEditorUndoButton() { updateEditorUndoRedoState(); }

const editorRedoStack = [];

function updateSaveButtonState() {
  const save = document.getElementById("editorSave");
  const discard = document.getElementById("editorDiscard");
  const indicator = document.getElementById("editorDirty");
  if (!save) return;
  save.disabled = !editorDirty;
  discard.disabled = !editorDirty || !editorSnapshot;
  if (editorDirty) indicator.classList.remove("hidden");
  else indicator.classList.add("hidden");
  // Label changes based on edit target so user knows what Save will do.
  if (editTargetId) {
    save.textContent = `Save → "${PUZZLES[editTargetId]?.name || editTargetId}"`;
  } else {
    save.textContent = "Save (new)";
  }
}

function buildPuzzleFromEditor() {
  const truth = editorTruth.map(row => [...row]);
  // Resolve color chars to hex via editorColorMap so the stored puzzle is self-contained
  // (no dependency on which char codes the editor happens to be using right now).
  const colors = editorBoard.map(row => row.map(ch => ch ? (editorColorMap[ch] || "") : ""));
  const name = document.getElementById("editorName").value.trim() || "Untitled";
  const fact = document.getElementById("editorFact").value.trim();
  const sourceUrl = document.getElementById("editorSourceUrl").value.trim();
  const sourceAttribution = document.getElementById("editorSourceAttribution").value.trim();
  const result = { name, width: editorW, height: editorH, truth, colors };
  if (fact) result.fact = fact;
  if (sourceUrl || sourceAttribution) result.source = { url: sourceUrl, attribution: sourceAttribution };
  return result;
}

function saveEditorPuzzle() {
  const data = buildPuzzleFromEditor();
  if (editTargetId === null) {
    // New: assign next ID, drop into Standby root by default
    const ids = Object.keys(PUZZLES).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const nextId = String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0");
    PUZZLES[nextId] = data;
    library.standby.puzzles.push(nextId);
    saveLibrary();
    editTargetId = nextId;
  } else {
    PUZZLES[editTargetId] = data;
  }
  savePuzzles();
  editorSnapshot = currentEditorState();
  editorDirty = false;
  updateSaveButtonState();
  clearAutosavedEditorState();
  renderLibrary();
}

function discardEditorChanges() {
  if (!editorSnapshot) return;
  editorW = editorSnapshot.width;
  editorH = editorSnapshot.height;
  editorTruth = editorSnapshot.truth.map(row => [...row]);
  editorBoard = editorSnapshot.board.map(row => [...row]);
  document.getElementById("editorName").value = editorSnapshot.name;
  document.getElementById("editorSize").value = `${editorW}x${editorH}`;
  document.getElementById("editorFact").value = editorSnapshot.fact || "";
  document.getElementById("editorSourceUrl").value = editorSnapshot.sourceUrl || "";
  document.getElementById("editorSourceAttribution").value = editorSnapshot.sourceAttribution || "";
  applyDimensions(editorW, editorH);
  renderEditorBoard();
  refreshEditorHints();
  editorDirty = false;
  updateSaveButtonState();
  clearAutosavedEditorState();
}

function newEditorPuzzle() {
  if (editorDirty && !confirm("You have unsaved changes. Discard them and start a new puzzle?")) return;
  editTargetId = null;
  editorUndoStack.length = 0;
  editorRedoStack.length = 0;
  currentEditorStroke = [];
  updateEditorUndoRedoState();
  editorBoard = createEmptyEditorBoard(editorW, editorH);
  editorTruth = createEmptyEditorTruth(editorW, editorH);
  document.getElementById("editorName").value = "";
  document.getElementById("editorFact").value = "";
  document.getElementById("editorSourceUrl").value = "";
  document.getElementById("editorSourceAttribution").value = "";
  // Clear custom color slots so the palette doesn't retain previous puzzle's colors.
  clearAllSlots();
  renderEditorBoard();
  refreshEditorHints();
  editorSnapshot = currentEditorState();
  editorDirty = false;
  updateSaveButtonState();
  hideEditorReference();
  clearAutosavedEditorState();
  renderLibrary();
}

// ---- Seed sync (two-machine workflow) ----
// The authored puzzle library lives in localStorage, which git can't see. These two
// buttons bridge that gap: Export dumps this browser's puzzles + library + completed
// into a fresh seed-data.js to commit and push; Import force-loads the currently
// shipped SEED_DATA back into localStorage after a pull — the opposite of the
// first-visit seeder at the top of this file, which never overwrites existing data.
function buildSeedFileText() {
  const puzzles = JSON.parse(localStorage.getItem(PUZZLES_KEY) || "{}");
  const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "null");
  const completed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  const data = { puzzles, library, completed };
  return "// Auto-generated by the in-app seed exporter (Sync row in the editor). Do not edit by hand.\nconst SEED_DATA = " + JSON.stringify(data, null, 2) + ";\n";
}

async function exportSeed() {
  if (editorDirty && !confirm("You have unsaved editor changes — they are NOT included in the export until saved. Export anyway?")) return;
  const text = buildSeedFileText();
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: "seed-data.js",
        types: [{ description: "JavaScript", accept: { "text/javascript": [".js"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      alert("Seed exported. If you saved it somewhere other than nonograms/seed-data.js, move it there before committing.");
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return; // user cancelled the save dialog
    // Any other failure falls through to the plain-download path below.
  }
  const blob = new Blob([text], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "seed-data.js";
  a.click();
  URL.revokeObjectURL(url);
  alert("Seed downloaded. Move it from Downloads into nonograms/, replacing seed-data.js, then commit.");
}

function importSeed() {
  if (typeof SEED_DATA === "undefined") {
    alert("No SEED_DATA loaded — is seed-data.js present next to index.html?");
    return;
  }
  if (!confirm("Replace this browser's puzzle library with the contents of seed-data.js?\n\nPuzzles + library organization are overwritten. Completed-puzzle progress is merged, never lost. The page will reload.")) return;
  try {
    if (SEED_DATA.puzzles) localStorage.setItem(PUZZLES_KEY, JSON.stringify(SEED_DATA.puzzles));
    if (SEED_DATA.library) localStorage.setItem(LIBRARY_KEY, JSON.stringify(SEED_DATA.library));
    // Completed is a union of local + seed so solve progress survives in both directions.
    const done = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
    for (const id of SEED_DATA.completed || []) done.add(id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...done]));
  } catch (err) {
    alert("Import failed: " + err);
    return;
  }
  // Autosaved editor work is intentionally left alone — the recovery prompt after
  // reload lets the user decide whether to keep it.
  location.reload();
}

function loadEditorPuzzle(id) {
  const puzzle = PUZZLES[id];
  if (!puzzle) return;
  if (editorDirty && !confirm("You have unsaved changes. Discard them and load this puzzle?")) return;

  editTargetId = id;
  editorW = puzzle.width;
  editorH = puzzle.height;
  editorTruth = puzzle.truth.map(row => [...row]);

  // Reset palette + undo/redo so the loaded puzzle starts from a clean slate.
  for (let i = 0; i < SLOT_COUNT; i++) {
    customSlots[i] = null;
    delete editorColorMap[SLOT_CHARS[i]];
  }
  editorUndoStack.length = 0;
  editorRedoStack.length = 0;
  currentEditorStroke = [];

  // Pre-register any unfamiliar hex values as new custom palette entries so the editor
  // can paint with the puzzle's existing colors during the edit session.
  const uniqueHex = new Set();
  for (const row of puzzle.colors) for (const hex of row) if (hex) uniqueHex.add(hex.toLowerCase());
  let paletteChanged = false;
  for (const hex of uniqueHex) {
    const existing = Object.entries(editorColorMap).find(([_, h]) => h.toLowerCase() === hex);
    if (existing) continue;
    const slotIdx = firstEmptySlot();
    if (slotIdx !== null) {
      customSlots[slotIdx] = hex;
      editorColorMap[SLOT_CHARS[slotIdx]] = hex;
      paletteChanged = true;
    } else {
      // Slots full — overflow into SHIFT_CHARS so the cells still resolve correctly
      // (palette won't show these but the puzzle data round-trips fine via hex).
      const ch = assignNextShiftChar();
      if (ch) editorColorMap[ch] = hex;
    }
  }
  if (paletteChanged) {
    saveCustomColors();
    buildEditorPalette();
  }

  // Map hex back to char codes for the editor's working representation.
  editorBoard = puzzle.colors.map(row => row.map(hex => {
    if (!hex) return "";
    const found = Object.entries(editorColorMap).find(([_, h]) => h.toLowerCase() === hex.toLowerCase());
    return found ? found[0] : "";
  }));

  document.getElementById("editorName").value = puzzle.name;
  document.getElementById("editorSize").value = `${editorW}x${editorH}`;
  document.getElementById("editorFact").value = puzzle.fact || "";
  document.getElementById("editorSourceUrl").value = puzzle.source?.url || "";
  document.getElementById("editorSourceAttribution").value = puzzle.source?.attribution || "";
  applyDimensions(editorW, editorH);
  renderEditorBoard();
  refreshEditorHints();
  editorSnapshot = currentEditorState();
  editorDirty = false;
  editorUndoStack.length = 0;
  editorRedoStack.length = 0;
  currentEditorStroke = [];
  updateEditorUndoRedoState();
  updateSaveButtonState();
  clearAutosavedEditorState();
  hideEditorReference();
  renderLibrary();
}

function exportPuzzle() {} // legacy stub — kept for compatibility, now unused

function initPaintModeToggle() {
  const btn = document.getElementById("paintMode");
  btn.addEventListener("click", () => {
    paintMode = paintMode === "truth" ? "accent" : "truth";
    updatePaintModeButton();
  });
  updatePaintModeButton();
}

// === Image import + pixelate ===
let editorImportedImage = null;
let editorReferenceCrop = null;  // { x, y, w, h } of last applied crop, for the side-by-side reference

function initImageImport() {
  const drop = document.getElementById("importDrop");
  const pixelateBtn = document.getElementById("importPixelate");
  const clearBtn = document.getElementById("importClear");

  // Click drop zone → open file picker
  drop.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) loadImportImage(input.files[0]);
    });
    input.click();
  });

  // Drag-and-drop on the drop zone
  drop.addEventListener("dragover", e => {
    e.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) loadImportImage(file);
  });

  // Window-wide paste — handles Ctrl+V from anywhere in editor mode.
  // Skips when the paste target is a text input/textarea so name/hex fields still get
  // normal text-paste behavior; only intercepts when clipboard contains an actual image.
  window.addEventListener("paste", e => {
    if (!editorMode || !e.clipboardData) return;
    const target = e.target;
    const isTextInput =
      target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          loadImportImage(file);
          return;
        }
      }
    }
    // No image in clipboard — let default paste behavior fire on text inputs.
    if (!isTextInput) {/* nothing to do */}
  });

  pixelateBtn.addEventListener("click", () => { cropMode = "pixelate"; openCropModal(); });
  clearBtn.addEventListener("click", clearImportImage);
  document.getElementById("importRestore").addEventListener("click", () => {
    cropMode = "restore";
    openCropModal();
  });

  document.getElementById("cropClose").addEventListener("click", closeCropModal);
  document.getElementById("cropCancel").addEventListener("click", closeCropModal);
  document.querySelector("#cropModal .modal-backdrop").addEventListener("click", closeCropModal);
  document.getElementById("cropApply").addEventListener("click", () => {
    closeCropModal();
    if (cropMode === "restore") {
      autoRestoreAndFill(cropX, cropY, cropW, cropH);
    } else {
      pixelateAndFill(cropX, cropY, cropW, cropH);
    }
  });

  // Crop drag/resize — pointerdown initiates, window pointermove/up handle the drag.
  document.getElementById("cropBox").addEventListener("pointerdown", e => {
    if (e.target.classList.contains("crop-handle")) return; // handle it via the handle's own listener
    startCropDrag(e, "move");
  });
  document.querySelectorAll(".crop-handle").forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      e.stopPropagation();
      startCropDrag(e, handle.dataset.handle);
    });
  });
  window.addEventListener("pointermove", onCropPointerMove);
  window.addEventListener("pointerup", endCropDrag);
  window.addEventListener("pointercancel", endCropDrag);
  window.addEventListener("resize", () => {
    if (!document.getElementById("cropModal").classList.contains("hidden")) {
      updateCropDisplayScale();
    }
  });
}

// === Crop modal state ===
let cropImageW = 0, cropImageH = 0;
let cropX = 0, cropY = 0, cropW = 0, cropH = 0;
let cropDisplayScale = 1;
let cropDragMode = null;
let cropDragStart = null;
let cropMode = "pixelate"; // "pixelate" | "restore" — set before opening cropModal

// Auto-restore: like pixelateAndFill but uses EXACT colors per cell (no fuzzy snap-to-existing).
// Each cell's center pixel is sampled from the cropped source after nearest-neighbor scale,
// preserving distinct shades that pixelateAndFill would have collapsed.
function autoRestoreAndFill(srcX, srcY, srcW, srcH) {
  if (!editorImportedImage) return;
  const img = editorImportedImage;
  const canvas = document.createElement("canvas");
  canvas.width = editorW;
  canvas.height = editorH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, editorW, editorH);
  const data = ctx.getImageData(0, 0, editorW, editorH).data;

  for (let r = 0; r < editorH; r++) {
    for (let c = 0; c < editorW; c++) {
      const i = (r * editorW + c) * 4;
      const red = data[i], green = data[i + 1], blue = data[i + 2], alpha = data[i + 3];
      if (alpha < 128) {
        editorBoard[r][c] = "";
        editorTruth[r][c] = false;
        continue;
      }
      const hex = rgbToHex(red, green, blue);
      const ch = findOrAllocateExactChar(hex);
      editorBoard[r][c] = ch;
      editorTruth[r][c] = true;
    }
  }

  buildEditorPalette();
  renderEditorBoard();
  refreshEditorHints();
  markEditorDirty();
  editorReferenceCrop = { x: srcX, y: srcY, w: srcW, h: srcH };
  renderEditorReference();
}

// Allocate a char for a hex value WITHOUT fuzzy snapping. Prefers slots until full,
// then overflows into SHIFT_CHARS. Used by autoRestoreAndFill for exact-color preservation.
function findOrAllocateExactChar(hex) {
  const lower = hex.toLowerCase();
  for (const [ch, h] of Object.entries(editorColorMap)) {
    if (h.toLowerCase() === lower) return ch;
  }
  const slotIdx = firstEmptySlot();
  if (slotIdx !== null) {
    customSlots[slotIdx] = lower;
    const ch = SLOT_CHARS[slotIdx];
    editorColorMap[ch] = lower;
    saveCustomSlots();
    return ch;
  }
  const ch = assignNextShiftChar();
  if (!ch) return "";
  editorColorMap[ch] = lower;
  return ch;
}

function openCropModal() {
  if (!editorImportedImage) return;
  const img = editorImportedImage;
  cropImageW = img.naturalWidth;
  cropImageH = img.naturalHeight;
  // Initial crop: largest centered region matching editor canvas aspect ratio.
  const aspect = editorW / editorH;
  const imgAspect = cropImageW / cropImageH;
  if (imgAspect > aspect) {
    cropH = cropImageH;
    cropW = Math.round(cropH * aspect);
  } else {
    cropW = cropImageW;
    cropH = Math.round(cropW / aspect);
  }
  cropX = Math.round((cropImageW - cropW) / 2);
  cropY = Math.round((cropImageH - cropH) / 2);

  document.getElementById("cropImage").src = img.src;
  document.getElementById("cropRatioLabel").textContent = `${editorW} × ${editorH}`;
  document.getElementById("cropModal").classList.remove("hidden");

  // Defer rendering until the image's display size is available
  const imgEl = document.getElementById("cropImage");
  if (imgEl.complete && imgEl.offsetWidth > 0) {
    updateCropDisplayScale();
  } else {
    imgEl.addEventListener("load", updateCropDisplayScale, { once: true });
  }
}

function closeCropModal() {
  document.getElementById("cropModal").classList.add("hidden");
  cropDragMode = null;
}

function updateCropDisplayScale() {
  const imgEl = document.getElementById("cropImage");
  const displayW = imgEl.offsetWidth;
  if (displayW === 0) return;
  cropDisplayScale = displayW / cropImageW;
  renderCropBox();
}

function renderCropBox() {
  const box = document.getElementById("cropBox");
  const imgEl = document.getElementById("cropImage");
  // Position relative to the image, accounting for centering inside the container
  const imgRect = imgEl.getBoundingClientRect();
  const containerRect = imgEl.parentElement.getBoundingClientRect();
  const offsetX = imgRect.left - containerRect.left;
  const offsetY = imgRect.top - containerRect.top;
  box.style.left = (offsetX + cropX * cropDisplayScale) + "px";
  box.style.top = (offsetY + cropY * cropDisplayScale) + "px";
  box.style.width = (cropW * cropDisplayScale) + "px";
  box.style.height = (cropH * cropDisplayScale) + "px";
}

function startCropDrag(e, mode) {
  e.preventDefault();
  cropDragMode = mode;
  cropDragStart = {
    mouseX: e.clientX,
    mouseY: e.clientY,
    cropX, cropY, cropW, cropH,
  };
}

function endCropDrag() {
  cropDragMode = null;
  cropDragStart = null;
}

function onCropPointerMove(e) {
  if (!cropDragMode) return;
  e.preventDefault();
  const dx = (e.clientX - cropDragStart.mouseX) / cropDisplayScale;
  const dy = (e.clientY - cropDragStart.mouseY) / cropDisplayScale;
  const aspect = editorW / editorH;
  const start = cropDragStart;
  const minSize = 16;

  if (cropDragMode === "move") {
    cropX = Math.max(0, Math.min(cropImageW - start.cropW, start.cropX + dx));
    cropY = Math.max(0, Math.min(cropImageH - start.cropH, start.cropY + dy));
  } else {
    let newW, newH;
    // Compute proposed dimensions per corner direction
    if (cropDragMode === "se") { newW = start.cropW + dx; newH = start.cropH + dy; }
    else if (cropDragMode === "sw") { newW = start.cropW - dx; newH = start.cropH + dy; }
    else if (cropDragMode === "ne") { newW = start.cropW + dx; newH = start.cropH - dy; }
    else if (cropDragMode === "nw") { newW = start.cropW - dx; newH = start.cropH - dy; }
    // Lock aspect: take the larger dimension and derive the other so we grow consistently
    if (newW / aspect > newH) newH = newW / aspect;
    else newW = newH * aspect;
    // Bounds clamping per anchor (the corner that stays still during this resize)
    if (cropDragMode === "se") {
      newW = Math.min(newW, cropImageW - start.cropX);
      newH = Math.min(newH, cropImageH - start.cropY);
    } else if (cropDragMode === "sw") {
      newW = Math.min(newW, start.cropX + start.cropW);
      newH = Math.min(newH, cropImageH - start.cropY);
    } else if (cropDragMode === "ne") {
      newW = Math.min(newW, cropImageW - start.cropX);
      newH = Math.min(newH, start.cropY + start.cropH);
    } else if (cropDragMode === "nw") {
      newW = Math.min(newW, start.cropX + start.cropW);
      newH = Math.min(newH, start.cropY + start.cropH);
    }
    // Re-lock aspect after clamp (clamp may have broken the ratio — take the smaller dim)
    if (newW / aspect < newH) newH = newW / aspect;
    else newW = newH * aspect;
    newW = Math.max(newW, minSize);
    newH = Math.max(newH, minSize);
    // Apply, deriving cropX/cropY based on which corner is moving
    if (cropDragMode === "se") {
      cropW = newW; cropH = newH;
    } else if (cropDragMode === "sw") {
      cropX = (start.cropX + start.cropW) - newW;
      cropW = newW; cropH = newH;
    } else if (cropDragMode === "ne") {
      cropY = (start.cropY + start.cropH) - newH;
      cropW = newW; cropH = newH;
    } else if (cropDragMode === "nw") {
      cropX = (start.cropX + start.cropW) - newW;
      cropY = (start.cropY + start.cropH) - newH;
      cropW = newW; cropH = newH;
    }
  }
  renderCropBox();
}

function loadImportImage(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      editorImportedImage = img;
      showImportPreview(img);
      // Show the image side-by-side with the board immediately, before any operation,
      // so the user can compare visually and decide what canvas size to use.
      // Default crop is centered cover-fit on the current canvas aspect.
      const refScale = Math.min(img.width / editorW, img.height / editorH);
      editorReferenceCrop = {
        x: (img.width - editorW * refScale) / 2,
        y: (img.height - editorH * refScale) / 2,
        w: editorW * refScale,
        h: editorH * refScale,
      };
      renderEditorReference();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function showImportPreview(img) {
  const drop = document.getElementById("importDrop");
  drop.innerHTML = "";
  drop.classList.add("has-image");
  const preview = document.createElement("img");
  preview.src = img.src;
  preview.alt = "imported image preview";
  drop.appendChild(preview);
  document.getElementById("importPixelate").disabled = false;
  document.getElementById("importClear").disabled = false;
  document.getElementById("importRestore").disabled = false;
}

function clearImportImage() {
  editorImportedImage = null;
  const drop = document.getElementById("importDrop");
  drop.classList.remove("has-image");
  drop.innerHTML = "drop or paste image";
  document.getElementById("importPixelate").disabled = true;
  document.getElementById("importRestore").disabled = true;
  document.getElementById("importClear").disabled = true;
  hideEditorReference();
}

// === Restore mode: manually click each cell of the source ref to fill the board sequentially ===
let restoreCurrentCell = null; // { r, c } | null
const restoreHistoryStack = []; // [{ r, c, prevCh, prevTruth }] for backspace undo

function startRestoreMode() {
  if (!editorImportedImage) return;
  if (!editorReferenceCrop) {
    const img = editorImportedImage;
    const refScale = Math.min(img.width / editorW, img.height / editorH);
    editorReferenceCrop = {
      x: (img.width - editorW * refScale) / 2,
      y: (img.height - editorH * refScale) / 2,
      w: editorW * refScale,
      h: editorH * refScale,
    };
  }
  // Clear board so user starts from a blank state.
  editorBoard = createEmptyEditorBoard(editorW, editorH);
  editorTruth = createEmptyEditorTruth(editorW, editorH);
  renderEditorBoard();
  refreshEditorHints();
  restoreCurrentCell = { r: 0, c: 0 };
  restoreHistoryStack.length = 0;
  document.body.classList.add("restore-mode");
  highlightRestoreCell();
  renderEditorReference(); // re-render source with grid overlay + marker
}

function endRestoreMode() {
  if (restoreCurrentCell) {
    const idx = restoreCurrentCell.r * editorW + restoreCurrentCell.c;
    const cell = boardEl.children[idx];
    if (cell) cell.classList.remove("restore-target");
  }
  restoreCurrentCell = null;
  restoreHistoryStack.length = 0;
  document.body.classList.remove("restore-mode");
  renderEditorReference(); // strip the overlay
}

function highlightRestoreCell() {
  if (!restoreCurrentCell) return;
  const { r, c } = restoreCurrentCell;
  const idx = r * editorW + c;
  const cell = boardEl.children[idx];
  if (cell) cell.classList.add("restore-target");
}

function unhighlightCurrentRestoreCell() {
  if (!restoreCurrentCell) return;
  const idx = restoreCurrentCell.r * editorW + restoreCurrentCell.c;
  const cell = boardEl.children[idx];
  if (cell) cell.classList.remove("restore-target");
}

function restoreUndoLast() {
  if (restoreHistoryStack.length === 0) return;
  const last = restoreHistoryStack.pop();
  // Move pointer back to that cell.
  unhighlightCurrentRestoreCell();
  restoreCurrentCell = { r: last.r, c: last.c };
  // Restore the cell's previous state.
  editorBoard[last.r][last.c] = last.prevCh;
  editorTruth[last.r][last.c] = last.prevTruth;
  const idx = last.r * editorW + last.c;
  const cell = boardEl.children[idx];
  cell.style.background = last.prevCh ? editorColorMap[last.prevCh] : "";
  cell.classList.toggle("editor-truth", !!last.prevCh && last.prevTruth);
  cell.classList.toggle("accent", !!last.prevCh && !last.prevTruth);
  highlightRestoreCell();
  refreshEditorHints();
  renderEditorReference();
}

function handleRestoreClickOnCanvas(e) {
  if (restoreCurrentCell === null) return;
  e.preventDefault();
  e.stopPropagation();
  const canvas = document.getElementById("editorRefCanvas");
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
  const ctx = canvas.getContext("2d");
  let hex;
  try {
    const data = ctx.getImageData(x, y, 1, 1).data;
    hex = rgbToHex(data[0], data[1], data[2]);
  } catch { return; }

  // Resolve hex → char (slot if available, otherwise shift char overflow)
  let ch = null;
  for (const [k, v] of Object.entries(editorColorMap)) {
    if (v.toLowerCase() === hex.toLowerCase()) { ch = k; break; }
  }
  if (!ch) {
    const slotIdx = firstEmptySlot();
    if (slotIdx !== null) {
      customSlots[slotIdx] = hex.toLowerCase();
      ch = SLOT_CHARS[slotIdx];
      editorColorMap[ch] = hex.toLowerCase();
      saveCustomSlots();
      buildEditorPalette();
    } else {
      ch = assignNextShiftChar();
      if (ch) editorColorMap[ch] = hex.toLowerCase();
    }
  }
  if (!ch) return;

  // Push the cell's previous state onto the restore-history stack so Backspace can revert.
  const { r, c } = restoreCurrentCell;
  restoreHistoryStack.push({ r, c, prevCh: editorBoard[r][c], prevTruth: editorTruth[r][c] });

  // Fill current cell as a truth cell
  const idx = r * editorW + c;
  const cell = boardEl.children[idx];
  cell.classList.remove("restore-target");
  editorBoard[r][c] = ch;
  editorTruth[r][c] = true;
  cell.style.background = hex;
  cell.classList.add("editor-truth");
  cell.classList.remove("accent");

  // Advance
  let nc = c + 1;
  let nr = r;
  if (nc >= editorW) { nc = 0; nr += 1; }
  if (nr >= editorH) {
    restoreCurrentCell = null;
    document.body.classList.remove("restore-mode");
    refreshEditorHints();
    markEditorDirty();
    renderEditorReference();
    return;
  }
  restoreCurrentCell = { r: nr, c: nc };
  highlightRestoreCell();
  refreshEditorHints();
  markEditorDirty();
  renderEditorReference(); // re-render source so the marker moves to the new target
}

window.addEventListener("keydown", e => {
  if (restoreCurrentCell === null) return;
  // Don't interfere with text-input typing (name, fact, etc.).
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.key === "Escape") {
    e.preventDefault();
    endRestoreMode();
  } else if (e.key === "Backspace") {
    e.preventDefault();
    restoreUndoLast();
  }
});

function pixelateAndFill(srcX, srcY, srcW, srcH) {
  if (!editorImportedImage) return;
  const img = editorImportedImage;

  // Render the image to a small canvas at editor dimensions with nearest-neighbor scaling.
  // If a crop region is provided, use it directly via drawImage's source-rect form.
  // Otherwise fall back to centered cover-fit (legacy path; cropper now always supplies bounds).
  const canvas = document.createElement("canvas");
  canvas.width = editorW;
  canvas.height = editorH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  if (srcW != null && srcH != null) {
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, editorW, editorH);
    editorReferenceCrop = { x: srcX, y: srcY, w: srcW, h: srcH };
  } else {
    const scale = Math.max(editorW / img.width, editorH / img.height);
    const scaledW = img.width * scale;
    const scaledH = img.height * scale;
    const dx = (editorW - scaledW) / 2;
    const dy = (editorH - scaledH) / 2;
    ctx.drawImage(img, dx, dy, scaledW, scaledH);
    // For a centered cover-fit (no explicit crop), capture the equivalent source rect so the reference still works.
    const refScale = Math.min(img.width / editorW, img.height / editorH);
    editorReferenceCrop = {
      x: (img.width - editorW * refScale) / 2,
      y: (img.height - editorH * refScale) / 2,
      w: editorW * refScale,
      h: editorH * refScale,
    };
  }

  const data = ctx.getImageData(0, 0, editorW, editorH).data;

  for (let r = 0; r < editorH; r++) {
    for (let c = 0; c < editorW; c++) {
      const i = (r * editorW + c) * 4;
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      const alpha = data[i + 3];
      if (alpha < 128) {
        editorBoard[r][c] = "";
        editorTruth[r][c] = false;
        continue;
      }
      const hex = rgbToHex(red, green, blue);
      const ch = findOrAddColorChar(hex);
      editorBoard[r][c] = ch;
      // Imported cells default to accent (F=0). The user then switches to truth mode and
      // marks which cells form the actual puzzle silhouette — much faster than starting
      // with everything as truth and demoting most of it.
      editorTruth[r][c] = false;
    }
  }

  buildEditorPalette();
  renderEditorBoard();
  refreshEditorHints();
  markEditorDirty();
  renderEditorReference();
}

function renderEditorReference() {
  const refWrap = document.getElementById("editorReference");
  const canvas = document.getElementById("editorRefCanvas");
  if (!editorImportedImage || !editorReferenceCrop) {
    refWrap.classList.remove("visible");
    return;
  }
  const board = document.getElementById("board");
  const rect = board.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);
  const c = editorReferenceCrop;
  ctx.drawImage(editorImportedImage, c.x, c.y, c.w, c.h, 0, 0, w, h);
  // If we're in restore mode, draw the grid + current cell marker on top of the image.
  if (restoreCurrentCell !== null) {
    drawRestoreOverlay(ctx, w, h);
  }
  refWrap.classList.add("visible");
}

function drawRestoreOverlay(ctx, w, h) {
  const cw = w / editorW;
  const ch_ = h / editorH;
  // Light grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
  ctx.lineWidth = 1;
  for (let i = 1; i < editorW; i++) {
    const x = Math.round(i * cw) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 1; i < editorH; i++) {
    const y = Math.round(i * ch_) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // Current cell highlight (matches the mocha pulse on the board cell)
  if (restoreCurrentCell) {
    const { r, c } = restoreCurrentCell;
    ctx.strokeStyle = "#8a4a2a"; // mocha
    ctx.lineWidth = 3;
    ctx.strokeRect(
      Math.round(c * cw) + 1.5,
      Math.round(r * ch_) + 1.5,
      Math.round(cw) - 3,
      Math.round(ch_) - 3
    );
    // Inner brighter line for visibility against dark images
    ctx.strokeStyle = "#fdfaf2"; // foam
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(c * cw) + 3,
      Math.round(r * ch_) + 3,
      Math.round(cw) - 6,
      Math.round(ch_) - 6
    );
  }
}

function hideEditorReference() {
  editorReferenceCrop = null;
  document.getElementById("editorReference").classList.remove("visible");
}

window.addEventListener("resize", () => {
  if (editorReferenceCrop && editorImportedImage) renderEditorReference();
});

// Quantization: try to match an existing palette color within a tolerance so we don't
// blow up the palette with hundreds of near-duplicates. Falls back to assigning a new
// custom char only when no close match exists.
//
// CRUCIAL: the snap target excludes default palette entries (r/p/b/o/g/y/k). Defaults are
// vivid pure colors meant for manual painting; if pixelation could snap to them, every
// reddish-brown pixel snaps to bright cherry-red, every tan to vivid orange, etc. Only
// snap to custom colors already added during this pixelation pass (or user-added slots).
function findOrAddColorChar(hex) {
  const target = hexToRgb(hex);
  if (!target) return "";
  let bestCh = null;
  let bestDist = Infinity;
  for (const [ch, h] of Object.entries(editorColorMap)) {
    if (ch in COLOR_MAP) continue; // skip defaults — they corrupt the snap toward vivid hues
    const rgb = hexToRgb(h);
    if (!rgb) continue;
    const d = (rgb.r - target.r) ** 2 + (rgb.g - target.g) ** 2 + (rgb.b - target.b) ** 2;
    if (d < bestDist) { bestDist = d; bestCh = ch; }
  }
  // Tight squared-distance threshold (~10 RGB euclidean = 100 squared) — only true
  // near-duplicates merge; distinct shades each get their own char so subjects don't
  // bleed into background colors during pixelation.
  const SNAP_THRESHOLD_SQ = 100;
  if (bestCh && bestDist < SNAP_THRESHOLD_SQ) return bestCh;
  const slotIdx = firstEmptySlot();
  if (slotIdx !== null) {
    customSlots[slotIdx] = hex.toLowerCase();
    const ch = SLOT_CHARS[slotIdx];
    editorColorMap[ch] = hex.toLowerCase();
    saveCustomSlots();
    return ch;
  }
  // Slots full — overflow to SHIFT_CHARS so cells past the 50th unique color still
  // render with their exact hex (just not visible in the palette).
  const ch = assignNextShiftChar();
  if (ch) editorColorMap[ch] = hex.toLowerCase();
  return ch || "";
}

function updatePaintModeButton() {
  const btn = document.getElementById("paintMode");
  btn.textContent = paintMode === "truth" ? "Mode: Truth" : "Mode: Accent";
  btn.classList.toggle("mode-truth", paintMode === "truth");
  btn.classList.toggle("mode-accent", paintMode === "accent");
  // Body class lets CSS target cells based on the active paint mode (e.g. checkered F=0 cells in truth mode).
  document.body.classList.toggle("editor-truth-mode", paintMode === "truth");
}

// Eyedropper state — when set, next click on the source reference canvas picks that pixel
// and fills the targeted slot with its hex.
let eyedropperSlot = null;

function activateEyedropper(slotIndex) {
  eyedropperSlot = slotIndex;
  document.body.classList.add("eyedropper-active");
  buildEditorPalette(); // re-render so the targeted slot shows the pulse animation
}

function deactivateEyedropper() {
  eyedropperSlot = null;
  document.body.classList.remove("eyedropper-active");
  buildEditorPalette();
}

function initEyedropper() {
  const canvas = document.getElementById("editorRefCanvas");
  canvas.addEventListener("click", e => {
    // Restore mode takes precedence: click samples pixel and fills the next cell sequentially.
    if (restoreCurrentCell !== null) {
      handleRestoreClickOnCanvas(e);
      return;
    }
    if (eyedropperSlot === null) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    const ctx = canvas.getContext("2d");
    try {
      const data = ctx.getImageData(x, y, 1, 1).data;
      const hex = rgbToHex(data[0], data[1], data[2]);
      const slotIdx = eyedropperSlot;
      setSlotColor(slotIdx, hex);
      selectedColor = SLOT_CHARS[slotIdx];
    } catch {
      // canvas tainted (cross-origin) — shouldn't happen since we draw a same-origin image
    }
    deactivateEyedropper();
  });
  // Escape exits eyedropper without picking
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && eyedropperSlot !== null) deactivateEyedropper();
  });
}

function openSlotColorPicker(slotIndex) {
  // Use the OS-native color input — gives the user hex/RGB/wheel/eyedropper-swatches built-in.
  const input = document.createElement("input");
  input.type = "color";
  input.value = customSlots[slotIndex] || "#888888";
  input.style.position = "fixed";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    setSlotColor(slotIndex, input.value);
    selectedColor = SLOT_CHARS[slotIndex];
    buildEditorPalette();
    document.body.removeChild(input);
  });
  // If the user dismisses without picking, clean up after a delay.
  setTimeout(() => { if (input.parentNode) document.body.removeChild(input); }, 60000);
  input.click();
}

function buildEditorPalette() {
  const palette = document.getElementById("editorPalette");
  palette.innerHTML = "";

  // Section 1: default colors (r/p/b/o/g/y/k)
  const defaultsRow = document.createElement("div");
  defaultsRow.className = "palette-section defaults";
  for (const ch of Object.keys(COLOR_MAP)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-btn";
    btn.style.background = COLOR_MAP[ch];
    btn.dataset.ch = ch;
    btn.title = `${ch} — ${COLOR_MAP[ch]}`;
    if (ch === selectedColor) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      selectedColor = ch;
      buildEditorPalette();
    });
    defaultsRow.appendChild(btn);
  }
  palette.appendChild(defaultsRow);

  // Section 2: 20 custom slots (filled or empty +)
  const slotsGrid = document.createElement("div");
  slotsGrid.className = "palette-section slots";
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "palette-slot";
    const hex = customSlots[i];
    const ch = SLOT_CHARS[i];
    if (hex) {
      slot.classList.add("filled");
      slot.style.background = hex;
      slot.title = `${hex}`;
      if (ch === selectedColor) slot.classList.add("selected");
      slot.addEventListener("click", () => {
        selectedColor = ch;
        deactivateEyedropper();
        buildEditorPalette();
      });
      slot.addEventListener("contextmenu", e => {
        e.preventDefault();
        // Right-click on filled slot: clear it back to empty +.
        clearSlot(i);
      });
    } else {
      slot.classList.add("empty");
      slot.title = "click to pick a color, right-click to use eyedropper";
      if (eyedropperSlot === i) slot.classList.add("eyedropper-target");
      slot.addEventListener("click", () => {
        if (eyedropperSlot === i) { deactivateEyedropper(); return; }
        deactivateEyedropper();
        openSlotColorPicker(i);
      });
      slot.addEventListener("contextmenu", e => {
        e.preventDefault();
        // Right-click on empty slot: activate eyedropper targeting this slot.
        activateEyedropper(i);
      });
    }
    slotsGrid.appendChild(slot);
  }
  palette.appendChild(slotsGrid);

  // Section 3: tools (eraser + lighten + darken)
  const toolsRow = document.createElement("div");
  toolsRow.className = "palette-section tools";

  const eraser = document.createElement("button");
  eraser.type = "button";
  eraser.className = "palette-btn eraser";
  eraser.title = "eraser";
  if (selectedColor === "") eraser.classList.add("selected");
  eraser.addEventListener("click", () => {
    selectedColor = "";
    deactivateEyedropper();
    buildEditorPalette();
  });
  toolsRow.appendChild(eraser);

  const lighten = document.createElement("button");
  lighten.type = "button";
  lighten.className = "palette-btn lighten";
  lighten.title = "lighten cell color";
  lighten.dataset.glyph = "↑";
  if (selectedColor === "__lighten") lighten.classList.add("selected");
  lighten.addEventListener("click", () => {
    selectedColor = "__lighten";
    deactivateEyedropper();
    buildEditorPalette();
  });
  toolsRow.appendChild(lighten);

  const darken = document.createElement("button");
  darken.type = "button";
  darken.className = "palette-btn darken";
  darken.title = "darken cell color";
  darken.dataset.glyph = "↓";
  if (selectedColor === "__darken") darken.classList.add("selected");
  darken.addEventListener("click", () => {
    selectedColor = "__darken";
    deactivateEyedropper();
    buildEditorPalette();
  });
  toolsRow.appendChild(darken);

  palette.appendChild(toolsRow);
}

function shiftBrightness(hex, delta) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const clamp = v => Math.max(0, Math.min(255, v));
  return rgbToHex(clamp(rgb.r + delta), clamp(rgb.g + delta), clamp(rgb.b + delta));
}

// Like findOrAddColorChar but never snaps to existing — used by lighten/darken so successive
// nudges always produce a distinct new color rather than collapsing back to the original.
function ensureExactColorChar(hex) {
  const lower = hex.toLowerCase();
  for (const [ch, h] of Object.entries(editorColorMap)) {
    if (h.toLowerCase() === lower) return ch;
  }
  // Lighten/darken outputs go into the SHIFT_CHARS pool — they don't pollute the palette slots.
  const ch = assignNextShiftChar();
  if (!ch) return null;
  editorColorMap[ch] = lower;
  return ch;
}

function renderEditorBoard() {
  boardEl.innerHTML = "";
  for (let r = 0; r < editorH; r++) {
    for (let c = 0; c < editorW; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      if ((c + 1) % 5 === 0 && c !== editorW - 1) cell.classList.add("col-divider");
      if ((r + 1) % 5 === 0 && r !== editorH - 1) cell.classList.add("row-divider");
      const ch = editorBoard[r][c];
      if (ch && !editorTruth[r][c]) cell.classList.add("accent");
      if (ch && editorTruth[r][c]) cell.classList.add("editor-truth");
      cell.style.background = ch ? editorColorMap[ch] : "";
      boardEl.appendChild(cell);
    }
  }
}

function handleEditorPointerDown(e, cell) {
  // Mouse: left = paint with selected tool (color/eraser/lighten/darken), right = always erase.
  // Touch/pen: paint with selected tool.
  const brushFromSelection = (forceErase) => {
    if (forceErase) return "erase";
    if (selectedColor === "") return "erase";
    if (selectedColor === "__lighten") return "lighten";
    if (selectedColor === "__darken") return "darken";
    return "paint";
  };
  if (e.pointerType === "mouse") {
    if (e.button !== 0 && e.button !== 2) return;
    editorBrush = brushFromSelection(e.button === 2);
  } else {
    editorBrush = brushFromSelection(false);
  }
  // Truth mode strokes flip F values only — direction is decided here based on the first cell's
  // current state, then locked for the rest of the stroke (matches solve-mode brush-toggle pattern).
  const r0 = +cell.dataset.row;
  const c0 = +cell.dataset.col;
  if (paintMode === "truth" && editorBrush === "paint") {
    truthStrokeDir = !editorTruth[r0][c0];
  } else {
    truthStrokeDir = null;
  }
  e.preventDefault();
  const r = +cell.dataset.row;
  const c = +cell.dataset.col;
  pointerActive = true;
  editorVisited.clear();
  paintEditorCell(r, c);
  refreshEditorHints();
}

function paintEditorCell(r, c) {
  const key = `${r},${c}`;
  if (editorVisited.has(key)) return;
  editorVisited.add(key);
  const prevCh = editorBoard[r][c];
  const prevTruth = editorTruth[r][c];
  let ch, truth;
  if (editorBrush === "lighten" || editorBrush === "darken") {
    // Shift the existing cell color brighter or darker. No-op on empty cells.
    if (!prevCh) return;
    const currentHex = editorColorMap[prevCh];
    if (!currentHex) return;
    const delta = editorBrush === "lighten" ? 18 : -18;
    const newHex = shiftBrightness(currentHex, delta);
    const newCh = ensureExactColorChar(newHex);
    if (!newCh) return;
    ch = newCh;
    truth = prevTruth; // lighten/darken only changes color, not F value
  } else if (editorBrush === "erase") {
    ch = "";
    truth = false;
  } else if (paintMode === "truth") {
    // Truth mode is a pure F-toggle — color is never modified. Stroke direction (promote vs
    // demote) is decided in handleEditorPointerDown from the first cell's current truth state.
    ch = prevCh;
    truth = truthStrokeDir === null ? prevTruth : truthStrokeDir;
  } else {
    // Accent mode: paint with selected color, F=0.
    ch = selectedColor;
    truth = false;
  }
  if (prevCh !== ch || prevTruth !== truth) {
    // Store hex values rather than char codes — chars can be GC'd between strokes,
    // but the underlying hex is stable and re-registerable.
    const prevHex = prevCh ? (editorColorMap[prevCh] || "") : "";
    const newHex = ch ? (editorColorMap[ch] || "") : "";
    currentEditorStroke.push({ r, c, prevHex, prevTruth, newHex, newTruth: truth });
  }
  editorBoard[r][c] = ch;
  editorTruth[r][c] = truth;
  const cell = boardEl.children[r * editorW + c];
  cell.style.background = ch ? editorColorMap[ch] : "";
  cell.classList.toggle("accent", !!ch && !truth);
  cell.classList.toggle("editor-truth", !!ch && truth);
  markEditorDirty();
}

function refreshEditorHints() {
  renderHints(computeHints(editorTruth));
}

function clearEditorBoard() {
  for (let r = 0; r < editorH; r++) {
    for (let c = 0; c < editorW; c++) {
      editorBoard[r][c] = "";
      editorTruth[r][c] = false;
    }
  }
  renderEditorBoard();
  refreshEditorHints();
  markEditorDirty();
}

function renderHints({ rows, cols }) {
  colHintsEl.innerHTML = "";
  for (let c = 0; c < cols.length; c++) {
    const cell = document.createElement("div");
    cell.className = "col-hint";
    if ((c + 1) % 5 === 0 && c !== cols.length - 1) cell.classList.add("divider-right");
    for (const n of cols[c]) {
      const span = document.createElement("span");
      span.textContent = n;
      cell.appendChild(span);
    }
    colHintsEl.appendChild(cell);
  }
  rowHintsEl.innerHTML = "";
  for (let r = 0; r < rows.length; r++) {
    const cell = document.createElement("div");
    cell.className = "row-hint";
    if ((r + 1) % 5 === 0 && r !== rows.length - 1) cell.classList.add("divider-bottom");
    for (const n of rows[r]) {
      const span = document.createElement("span");
      span.textContent = n;
      cell.appendChild(span);
    }
    rowHintsEl.appendChild(cell);
  }
}

// Refit board on viewport size or orientation changes (rotate phone, resize window).
// Debounced so we don't thrash during a resize drag on desktop.
let resizeRAF = null;
function scheduleResize() {
  if (resizeRAF !== null) return;
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = null;
    updateRotationClass();
    resizeBoardToFit();
  });
}
window.addEventListener("resize", scheduleResize);
window.addEventListener("orientationchange", () => setTimeout(() => {
  updateRotationClass();
  resizeBoardToFit();
}, 100));

// Dispatch sits at the very bottom so every `let`/`const` binding
// (including editor state) is past TDZ before init runs.
if (userMode) {
  document.body.classList.add("user-mode");
  initUserNav();
  setUserScreen("home");
} else if (editorMode) {
  initEditor();
} else {
  loadPuzzle("0001");
}
applySettings();

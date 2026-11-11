// Seed localStorage from SEED_DATA on first visit. Runs before any other code touches
// localStorage so the whole app initializes from the seeded values as if they'd always
// been there. Anonymous itch visitors get the full authored library on first load.
(function seedFromShippedData() {
  if (typeof SEED_DATA === "undefined") return;
  try {
    const firstVisit = !localStorage.getItem("picross.puzzles");
    if (firstVisit && SEED_DATA.puzzles) {
      localStorage.setItem("picross.puzzles", JSON.stringify(SEED_DATA.puzzles));
    }
    if (!localStorage.getItem("picross.library") && SEED_DATA.library) {
      localStorage.setItem("picross.library", JSON.stringify(SEED_DATA.library));
    }
    // 2026-08-30 — VERSIONED AUTO-SYNC. Before this, only first-visit visitors ever
    // received seed data: truth/colors/library in localStorage were a fossil of
    // whenever the app was first opened, and deployed puzzle edits never reached
    // existing devices (Dre: "none of the changes took effect"). Now a bumped
    // SEED_DATA.seedVersion re-syncs every SHIPPED puzzle and the library into
    // localStorage on next load. Preserved: stored puzzles NOT in the seed (user-
    // created), picross.completed, settings. Rule: every seed edit bumps the
    // version (YYYYMMDD) or devices never see it.
    const shippedVersion = SEED_DATA.seedVersion ? String(SEED_DATA.seedVersion) : null;
    if (shippedVersion && localStorage.getItem("picross.seedVersion") !== shippedVersion) {
      const stored = JSON.parse(localStorage.getItem("picross.puzzles") || "{}");
      for (const pid of Object.keys(SEED_DATA.puzzles || {})) stored[pid] = SEED_DATA.puzzles[pid];
      localStorage.setItem("picross.puzzles", JSON.stringify(stored));
      if (SEED_DATA.library) localStorage.setItem("picross.library", JSON.stringify(SEED_DATA.library));
      localStorage.setItem("picross.seedVersion", shippedVersion);
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
  devUnlocked: false,
};

const SETTINGS_INFO = [
  ["timer",            "Timer",                     "Show solve time."],
  ["mistakes",         "Mistake counter",           "Count fills placed on cells that don't belong in the picture."],
  ["fadedReveal",      "Faded reveal",              "Correctly-filled cells hint at their reveal color."],
  ["autoCross",        "Auto-cross",                "Auto-cross remaining cells when a row or column is satisfied."],
  ["soundEffects",     "Sound effects",             "Gentle taps and pops while solving, and a soft chime on the win."],
  ["reduceMotion",     "Reduce motion",             "Disables animations and transitions."],
  ["dpad",             "Dpad",                      "Implement a directional pad for cursor movement. Useful for larger puzzles."],
  ["disableActionBtn", "Disable action button",     "Removes the dpad's center action button. Fill and Cross buttons execute the action directly on the cursor cell instead of toggling mode. Requires Dpad."],
  // DEV-ONLY row — rendered in admin mode, while the flag is on, or once it has
  // ever been enabled on this device (devUnlocked; see buildSettingsModal).
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
// The tutorial trio (Heart/Diamond/Arrow) is NOT a category (batch E, his E1
// ruling: "one unique window thats a chronological collection of puzzles"): it
// lives in library.tutorial in play order — arrow, heart, diamond = ids
// 0003/0001/0002 (id order is NOT play order) — and runs as one window.
// Test puzzles → Archive root. Shipping seeded with the canonical category folders, all empty.
const LIBRARY_DEFAULT = {
  shipping: {
    folders: Object.fromEntries(SHIPPING_FOLDERS.map(name => [name, []])),
    puzzles: [],
  },
  standby:  { folders: {}, puzzles: [] },
  archive:  { folders: {}, puzzles: ["0004", "0005", "0006", "0007"] },
  tutorial: ["0003", "0001", "0002"],
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
// Touch gate (2026-09-07): admin/editor is a DESKTOP dev tool — the editor is
// retired and puzzle edits ship via _apply_edits_*.py scripts. On a phone the
// 7-tap title trigger is a loaded gun: a fidgeting player lands in a dead
// desktop admin screen that persists across relaunches (Dre hit exactly this
// on the first native device run). So: never arm the trigger on coarse-pointer
// devices, and auto-heal any stale flag already set there (a deliberate
// ?admin=1 typed into a mobile URL bar still works for that session).
const _touchPrimary = window.matchMedia && matchMedia("(pointer:coarse)").matches;
const _urlAdmin = new URLSearchParams(location.search).get("admin") === "1";
if (_urlAdmin) { try { localStorage.setItem(ADMIN_KEY, "1"); } catch {} }
if (_touchPrimary && !_urlAdmin) { try { localStorage.setItem(ADMIN_KEY, "0"); } catch {} }
const _lsAdmin = (() => { try { return localStorage.getItem(ADMIN_KEY) === "1"; } catch { return false; } })();
const adminMode = _urlAdmin || (_lsAdmin && !_touchPrimary);
const userMode = !adminMode;
const editorMode = adminMode && new URLSearchParams(location.search).get("editor") === "1";

// DEV_BUILD (2026-09-08): master switch for every developer aid (the solve-screen
// telemetry badge, the instant-win button, the "Dev tools" settings row). The
// aids are already invisible to fresh touch users (devMode defaults off and the
// row can't be unlocked on coarse pointers), but a carried-over container from
// a dev-era install keeps them — and in-place TestFlight/App Store updates
// PRESERVE the container (verified on Citrus, batch F5). Source always stays
// true; sync-native.sh --release flips this to false in the www COPY only, so
// the submission build is provably clean even for dev-era devices.
const DEV_BUILD = true;

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
// tutorial state is declared up here, not next to the tutorial functions,
// because updateModeButton() runs at TOP LEVEL below and reaches `tutorial`
// through dpadEffective() — with the declaration later in the file that read
// is a TDZ ReferenceError that kills boot whenever settings.dpad is on
// (batch G5: the 2026-09-09 boot death on Citrus).
let tutorial = null;     // { idx, beat } while running; null otherwise
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
  if (dpadEffective() && settings.disableActionBtn) {
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
if (_titleEl && !_touchPrimary) {
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
if (DEV_BUILD) document.getElementById("devWinBtn")?.addEventListener("click", devWinPuzzle);
document.getElementById("settingsClose").addEventListener("click", closeSettingsModal);
document.querySelector("#settingsModal .modal-backdrop").addEventListener("click", closeSettingsModal);

// === Scroll-edge content dissolve (round 7, 2026-08-28) ===
// The blur experiment is over: strips banded (round 5→6), the wrapper-mask
// rendered blur-less on-device (round 6 verdict — iOS rejects the ancestor-
// mask too), and Dre retired the feature: "no blur, just opacity." But a foam
// opacity OVERLAY still hard-covers rows at its solid line (Dre: "you can
// still clearly see where it immediately disappears underneath the section
// above it"). The true dissolve has to live on the CONTENT: each row's own
// opacity goes 0 → 1 LINEARLY (Dre's explicit call) as its top edge crosses
// the ramp's translucent span — the 44–116px band below the safe-area line
// (44 = where the foam ramp turns solid, 116 = zone bottom; both mirror the
// .edge-grad geometry in style.css). Body is the scroller, so no CSS mask can
// do this — a mask rides the element's own box and scrolls away with it —
// hence a rAF-throttled scroll handler. Rows at rest below the zone keep NO
// inline opacity (it's cleared, not set to 1), so nothing can strand a row
// invisible.
(function initScrollEdgeDissolve() {
  const FADE_TOP = 44;     // px below the safe-area line → opacity 0
  const FADE_BOTTOM = 116; // px below the safe-area line → opacity 1
  const FADE_SPAN = FADE_BOTTOM - FADE_TOP;

  // env(safe-area-inset-top) isn't readable from JS — measure it off a probe.
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);" +
    "visibility:hidden;pointer-events:none";
  probe.setAttribute("aria-hidden", "true");
  document.body.appendChild(probe);

  let targets = [];
  let ticking = false;

  function collectTargets() {
    const screenId = { category: "screenCategory", puzzles: "screenPuzzles" }[document.body.dataset.screen];
    const screen = screenId ? document.getElementById(screenId) : null;
    if (!document.body.classList.contains("user-mode") || !screen) { targets = []; return; }
    targets = Array.from(
      screen.querySelectorAll(":scope > .back-btn, :scope > .screen-heading, :scope > .user-list > li")
    );
  }

  function applyDissolve() {
    ticking = false;
    if (!targets.length) return;
    const zero = probe.getBoundingClientRect().height + FADE_TOP;
    for (const el of targets) {
      const t = el.getBoundingClientRect().top;
      const o = Math.min(1, Math.max(0, (t - zero) / FADE_SPAN));
      el.style.opacity = o >= 1 ? "" : o.toFixed(3);
    }
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(applyDissolve); }
  }

  // Lists re-render and screens switch outside this module — watch, don't hook.
  const observer = new MutationObserver(() => { collectTargets(); applyDissolve(); });
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-screen", "class"] });
  for (const id of ["userCategoryList", "userPuzzleList"]) {
    const list = document.getElementById(id);
    if (list) observer.observe(list, { childList: true });
  }

  // C10: in user mode the document never scrolls — the lists scroll inside
  // .layout main. Listen to BOTH so the dissolve fires in either world
  // (admin/editor still scroll the body).
  window.addEventListener("scroll", onScroll, { passive: true });
  const listScroller = document.querySelector(".layout main");
  if (listScroller) listScroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  collectTargets();
  applyDissolve();
})();

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
  const modal = document.getElementById("settingsModal");
  modal.classList.remove("hidden");
  // Always open at the top. The LIST is the scroller since the 1.1 pinned-
  // header change (.settings-list, not .modal-content) and nothing else reads
  // its scroll state, so reopening where you left off just hid the top rows
  // for no benefit.
  const listEl = modal.querySelector(".settings-list");
  if (listEl) listEl.scrollTop = 0;
}

function closeSettingsModal() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function buildSettingsModal() {
  const list = document.querySelector(".settings-list");
  list.innerHTML = "";
  for (const [key, name, desc] of SETTINGS_INFO) {
    // Dev row shows in admin mode, while the flag is on, OR once it has ever been
    // enabled on this device (devUnlocked) — round 3: Dre enabled it, played a
    // puzzle, and the row was gone from settings ("doesn't persist"). Nothing in
    // code can reset devMode (grep: only the toggle writes settings.*), so the
    // likely culprit was turning it off and having the row self-hide per the
    // round-2 gate — which read as a bug. Now the row stays findable forever
    // once unlocked; never-enabled users still never see it.
    if (key === "devMode" && (!DEV_BUILD || (!adminMode && !settings.devMode && !settings.devUnlocked))) continue;
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
    // Batch E (his rulings): "disable action button" is a suboption of the dpad
    // row — indented, no description ("pretty self explanatory"), a slightly
    // smaller toggle, and NO divider between the two rows so they read as one
    // grouped unit. The name keeps the full .setting-name styling (same font,
    // size, color as "Dpad" — his amendment).
    if (key === "dpad") li.classList.add("has-subsetting"); // paired with the row below
    if (key === "disableActionBtn") {
      li.classList.add("subsetting");
      descEl.remove();
    }

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "setting-toggle";
    toggle.checked = settings[key];
    toggle.addEventListener("change", () => {
      settings[key] = toggle.checked;
      // Once dev tools have been enabled anywhere, keep the row visible in every
      // mode so it can always be found again (the round-3 "doesn't persist" fix).
      if (key === "devMode" && toggle.checked) settings.devUnlocked = true;
      saveSettings();
      applySettings();
    });
    li.appendChild(toggle);
    list.appendChild(li);
  }
  // Replay row for the givens explainer (batch C7): the recovery path for a
  // device where "Don't show again" is armed — replay the card and disarm the
  // toggle there. Also the only way to re-review the guide on demand.
  const replayLi = document.createElement("li");
  replayLi.className = "setting-row";
  const replayWrap = document.createElement("div");
  replayWrap.className = "setting-label-wrap";
  const replayName = document.createElement("span");
  replayName.className = "setting-name";
  replayName.textContent = "Hint-cell guide";
  const replayDesc = document.createElement("span");
  replayDesc.className = "setting-desc";
  replayDesc.textContent = "Replay the two-slide intro to hint cells, or change its Don't-show-again toggle.";
  replayWrap.appendChild(replayName);
  replayWrap.appendChild(replayDesc);
  replayLi.appendChild(replayWrap);
  const replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.className = "setting-action-btn";
  replayBtn.textContent = "Replay";
  replayBtn.addEventListener("click", () => {
    closeSettingsModal();
    showGivensExplainer();
  });
  replayLi.appendChild(replayBtn);
  list.appendChild(replayLi);

  // Replay row for the tutorial (batch E): the re-entry path now that the
  // first-open offer is once-ever. Starts the window from the arrow.
  const tutLi = document.createElement("li");
  tutLi.className = "setting-row";
  const tutWrap = document.createElement("div");
  tutWrap.className = "setting-label-wrap";
  const tutName = document.createElement("span");
  tutName.className = "setting-name";
  tutName.textContent = "How to play";
  const tutDesc = document.createElement("span");
  tutDesc.className = "setting-desc";
  tutDesc.textContent = "Replay the three-puzzle tutorial.";
  tutWrap.appendChild(tutName);
  tutWrap.appendChild(tutDesc);
  tutLi.appendChild(tutWrap);
  const tutBtn = document.createElement("button");
  tutBtn.type = "button";
  tutBtn.className = "setting-action-btn";
  tutBtn.textContent = "Replay";
  tutBtn.addEventListener("click", () => {
    closeSettingsModal();
    if (userMode) tutorialStart();
  });
  tutLi.appendChild(tutBtn);
  list.appendChild(tutLi);
}

// === User-mode navigation (Home → Categories → Puzzles → Solve) ===
function initUserNav() {
  document.getElementById("userPlay").addEventListener("click", () => setUserScreen("category"));
  document.querySelectorAll(".back-btn").forEach(btn => {
    btn.addEventListener("click", () => setUserScreen(btn.dataset.back));
  });
}

// Where the puzzles list was scrolled when a puzzle opened — restored on Back
// so the player returns to the same spot. (2026-09-01: the solve-lock fix
// below zeroes the offset the list used to KEEP accidentally via the
// lazy-clamp bug — this preserves the convenience without the bug. C10: the
// list scrolls inside .layout main now — the document never scrolls in user
// mode — so the remembered position is main.scrollTop, not window.scrollY.)
let savedPuzzleListScroll = 0;

// Zero EVERY scroller on the solve path (batch C8). overflow:hidden elements
// are still PROGRAMMATICALLY scrollable — a stray scrollTop on .layout/main/
// .puzzle-and-ref (or one surviving on html/body despite the lock) shifts the
// whole solve view exactly like the C7 dog glitch, and on iOS the hit-testing
// desyncs from the shifted visuals: small targets (the explainer's gold
// arrow) go dead while the full-screen backdrop still catches taps. The CSS
// side of the fix is overflow:clip on all five containers (no scroll container
// = no offset, ever); this is the belt-and-braces for engines without clip.
function zeroSolveScroll() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const layout = document.querySelector(".layout");
  if (layout && layout.scrollTop) layout.scrollTop = 0;
  const main = document.querySelector(".layout main");
  if (main && main.scrollTop) main.scrollTop = 0;
  const pnr = document.querySelector(".puzzle-and-ref");
  if (pnr && pnr.scrollTop) pnr.scrollTop = 0;
}

function setUserScreen(name) {
  if (currentUserScreen !== null && currentUserScreen !== name) sfx.swoosh();
  const leavingScreen = currentUserScreen;
  if (name === "solve" && leavingScreen !== "solve") {
    const mainEl = document.querySelector(".layout main");
    savedPuzzleListScroll = mainEl ? mainEl.scrollTop : 0;
  }
  // Reset scroll BEFORE the screen class changes. html/body scroll on the list
  // screens (overflow-y: auto), but the solve view locks scrolling
  // (html.solve-lock, below). Tapping a puzzle from a scrolled-down list
  // therefore carried that offset into a view that can no longer scroll — the top
  // control row sat clipped off-screen with no way to reach it. Must happen while
  // the page is still scrollable, hence before dataset.screen is reassigned.
  // Reported 2026-08-21. (C8: zeroSolveScroll also covers .layout/main/
  // .puzzle-and-ref — programmatic-only scrollers the window resets can't see.)
  zeroSolveScroll();
  currentUserScreen = name;
  document.body.dataset.screen = name;
  // THE FLOOD hero intro (batch H53): the first home show of a launch starts
  // the intro; later shows resolve instantly to the finished wordmark.
  if (window.heroIntro) heroIntro.onScreen(name);
  // The real lock for that same bug class, finally reproduced 2026-09-01
  // (plains, Geomorphology — the "dog glitch"): WebKit does NOT reliably
  // re-clamp scrollTop when the list's display:none shrinks the document, so
  // the resets above could still lose to a lazy re-clamp (or a stale offset
  // could never be clamped at all) — the solve view rendered shifted up, top
  // controls clipped, dead space below, no way to scroll. With overflow:hidden
  // on the ROOT scroller there is no scroll range for an offset to live in.
  document.documentElement.classList.toggle("solve-lock", name === "solve");
  if (name === "solve") {
    // C12: wipe ripples stranded mid-flight by the last puzzle's exit. iOS
    // pauses animations in display:none subtrees (animationend never fires,
    // so the circles never self-remove), and they ghost back in when the
    // next solve screen un-hides the dpad.
    document.querySelectorAll(".dpad-ripples").forEach(g => g.replaceChildren());
  }
  if (name !== "solve") {
    hideGivensModal(); // never leave the explainer floating over list screens
    if (tutorial) tutorialExit(null); // batch E: backing out of the tutorial ends it quietly
  }
  if (name === "category") buildUserCategoryList();
  else if (name === "puzzles") {
    buildUserPuzzleList(currentUserCategoryName);
    // Back from solve returns the list to where it was (the reset zeroed it).
    // C10: the offset lives on main now — the document can't scroll at all.
    if (leavingScreen === "solve" && savedPuzzleListScroll > 0) {
      const y = savedPuzzleListScroll;
      requestAnimationFrame(() => {
        const mainEl = document.querySelector(".layout main");
        if (mainEl) mainEl.scrollTop = y;
      });
    }
  }
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
      zeroSolveScroll();
    });
    // Late straggler pass (2026-09-01): once the entry transition has settled,
    // re-zero and re-fit — a fit measured against a transient viewport, or an
    // offset that somehow slipped both resets, gets corrected instead of stuck.
    setTimeout(() => {
      if (currentUserScreen !== "solve") return;
      zeroSolveScroll();
      try { resizeBoardToFit(); } catch {}
    }, 350);
  }
}

/* ==================== THE FLOOD — hero intro (batch H53, 2026-11-09) ====================
   TRUE-TRACE V6 "THE FLOOD": a quantized distance-field flood fill (8-neighbor
   Dijkstra wave over each word's ink) ported from nonograms-qa/logo-intro.html
   — the round-26→33 iteration history lives in that file and nonograms' dev log.
   It replaces the pass-2 CSS clip-wipe (hero-write). Everything between the
   FLOOD_VERBATIM markers below is copied BYTE-EXACT from the QA page by
   _port_logo_intro.py (constants incl. the two gray16 field PNGs + every flood
   function); the glue around it (boot, skip, gating, degrade ladder) is
   hand-written and adapts the page's dev-tool script for the app:

   - Runs ONCE per app launch, on the first home show (hooked from setUserScreen
     via window.heroIntro). Every later home show is the finished wordmark
     instantly — the screens live in display:none, which restarts CSS anims and
     would restart the flood too; one flood per launch is the ruling.
   - Play is gated on FINISH instead of the old fixed 2.5 s. The wordmark is
     tappable = skip, and a 9 s watchdog guarantees Play even if the font or GL
     never resolves (at the 3× speed the flood finishes ≈ 3.7 s in, so 9 s is
     ~2× headroom). Degrade ladder (finished wordmark, app fully usable):
     no WebGL / no highp fragment precision / FBO failure / reduced motion /
     font-load failure / watchdog.
   - Styling contract (H53 fix): the verbatim buildGuide fills the FINISH
     vectors with var(--espresso) and MEASURES #heroWm's two <text> elements
     (Aghja 500, calt pinned — style.css carries both rules; a JS-only port
     shaped the guide in the body font and the finished frame landed with
     broken spacing).
   - If script.js never runs at all, the .hero-fallback h1 sits exactly like the
     old static title and Play is visible — the pre-JS base state never regressed. */
window.heroIntro = (() => {
  const screenHome = document.getElementById("screenHome");
  const svg = document.getElementById("heroWm");
  const fx = document.getElementById("heroFx");
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let booted = false, finished = false;
  if (!screenHome || !svg || !fx) return { onScreen() {} };

  // ---- hand-written state (mirrors the page script; speed fixed at 4 — his
  // round-40 ruling: 3× was "still just slightly too slow, but almost
  // negligible"; the endgame wall-clock timer below derives from this) ----
  const gl = fx.getContext("webgl", { alpha: true, premultipliedAlpha: true }) ||
             fx.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: true });
  // glProg (and glU/glAttr) are declared inside the VERBATIM block below —
  // the page declares them between buildGuide and initGL.
  const speed = 4;
  // buildGuide consults the page's query flags (?guide, ?dump — dev overlays);
  // declared so the verbatim code runs unmodified. In-app these are never set.
  const params = new URLSearchParams(location.search);
  let t0 = null, raf = null, running = false, lastT = 0;
  let viewW = 0, viewH = 480;
  let origins = [], gGlyph = null;
  const words = [];

  function finishNow(why) {
    if (finished) return;
    finished = true; running = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (gl) gl.clear(gl.COLOR_BUFFER_BIT);
    if (gGlyph) {
      gGlyph.setAttribute("visibility", "visible");
      screenHome.classList.add("flood-done");
    } else {
      // Boot died before the SVG guide existed: fall back to the plain h1.
      console.warn("hero intro: finishing without the vector wordmark (" + why + ")");
      screenHome.classList.add("flood-fallback");
    }
    screenHome.classList.remove("flood-live");
  }
  function play() {
    if (raf) cancelAnimationFrame(raf);
    t0 = null; running = true;
    raf = requestAnimationFrame(frame);
    // Wall-clock backup for the endgame (his round-40 dead window): rAF
    // delivery stalls on some engines (WebKit, headless) once the canvas
    // stops changing — the frames right before FINISH are visually identical,
    // so the compositor stops scheduling, t never crosses FINISH, and the
    // swap sat waiting for the 9 s watchdog. This timer lands the finish at
    // TOTAL + a 0.3 s grace regardless; the natural rAF path no-ops it.
    setTimeout(() => finishNow("wallclock"), TOTAL / speed * 1000 + 300);
  }





// ---- BEGIN verbatim from logo-intro.html (round-33 state) ----
const OUTLINES = {"N.I_":"M70 0 C86 0 100 14 100 30 L100 370 C100 436 154 490 220 490 C286 490 340 436 340 370 L340 130 C340 58 398 0 470 0 C486 0 500 14 500 30 C500 46 486 60 470 60 C432 60 400 92 400 130 L400 370 C400 470 320 550 220 550 C166 545.5 143.5 536.8 116.8 517.1 L98.9 514.3 C97.7 528.2 84.7 540 70 540 C54 540 40 526 40 510 L40 30 C40 14 54 0 70 0 Z","O.I_":"M20 270 C20 130 101 0 220 0 C276.1 5.4 298.5 15.5 325.8 39.7 L356.2 40 C380.1 15.3 413.3 0 450 0 L470 0 C486 0 500 14 500 30 C500 46 486 60 470 60 L450 60 C418 60 390 83 382 112 C406 158 420 213 420 270 C420 410 339 540 220 540 C101 540 20 410 20 270 ZM80 270 C80 394 151 480 220 480 C289 480 360 394 360 270 C360 146 289 60 220 60 C151 60 80 146 80 270 Z","a._I_":"M420 30 C420 46 406 60 390 60 C352 60 320 92 320 130 L320 260 C320 276 306 290 290 290 C286 290 281 289 277 287 C250 307 216 320 180 320 C91 320 20 249 20 160 C20 138 24 117 32 98 C20 76 -3 60 -30 60 C-46 60 -60 46 -60 30 C-60 14 -46 0 -30 0 C15.5 4.4 34.4 12.5 55.1 31.9 L83.4 31.9 C110.4 11.8 144.2 0 180 0 C230.4 4.5 251.3 13.2 275.7 32.9 L304 32.9 C327.1 12.5 357.5 0 390 0 C406 0 420 14 420 30 ZM180 260 C212 260 241 244 260 220 L260 100 C241 75 212 60 180 60 C125 60 80 105 80 160 C80 215 125 260 180 260 Z","g.VI_":"M70 -226C70 -234 73 -241 79 -247C107 -275 142 -290 180 -290C258 -290 320 -228 320 -150V-70C320 -32 352 0 390 0C406 0 420 14 420 30C420 46 406 60 390 60C364 60 340 52 320 39V180C320 258 258 320 180 320H-30C-46 320 -60 306 -60 290C-60 274 -46 260 -30 260H55C33 233 20 198 20 160C20 71 91 0 180 0C209 0 237 8 260 22V-150C260 -194 224 -230 180 -230C158 -230 139 -223 121 -205C115 -199 108 -196 100 -196C84 -196 70 -210 70 -226ZM260 180V100C241 76 212 60 180 60C125 60 80 105 80 160C80 215 125 260 180 260C224 260 260 224 260 180Z","g._I_":"M70 -226C70 -234 73 -241 79 -247C107 -275 142 -290 180 -290C258 -290 320 -228 320 -150V-70C320 -32 352 0 390 0C406 0 420 14 420 30C420 46 406 60 390 60C364 60 340 52 320 39V180C320 258 258 320 180 320C91 320 20 249 20 160C20 138 24 117 32 98C20 76 -3 60 -30 60C-46 60 -60 46 -60 30C-60 14 -46 0 -30 0C9 0 44 17 68 45C97 17 137 0 180 0C209 0 237 8 260 22V-150C260 -194 224 -230 180 -230C158 -230 139 -223 121 -205C115 -199 108 -196 100 -196C84 -196 70 -210 70 -226ZM260 180V100C241 76 212 60 180 60C125 60 80 105 80 160C80 215 125 260 180 260C224 260 260 224 260 180Z","i._I_":"M70 440 C70 423 83 410 100 410 C117 410 130 423 130 440 C130 457 117 470 100 470 C83 470 70 457 70 440 ZM-60 30 C-60 14 -46 0 -30 0 L10 0 C56.6 4.6 76.1 13.3 96.9 33.4 L123 33.4 C146.1 12.5 176.7 0 210 0 L250 0 C266 0 280 14 280 30 C280 46 266 60 250 60 L210 60 C172 60 140 92 140 130 L140 290 C140 306 126 320 110 320 C94 320 80 306 80 290 L80 130 C80 92 48 60 10 60 L-30 60 C-46 60 -60 46 -60 30 Z","l._I":"M-60 30 C-60 14 -46 0 -30 0 L-10 0 C36.6 4.6 56.1 13.3 76.9 33.4 L103 33.4 C126.1 12.5 156.7 0 190 0 C206 0 220 14 220 30 C220 46 206 60 190 60 C152 60 120 92 120 130 L120 410 C120 448 152 480 190 480 C206 480 220 494 220 510 C220 526 206 540 190 540 C118 540 60 482 60 410 L60 130 C60 92 28 60 -10 60 L-30 60 C-46 60 -60 46 -60 30 Z","m._I_":"M290 0 C306 0 320 14 320 30 L320 170 C320 219 361 260 410 260 C448 260 480 228 480 190 L480 130 C480 58 538 0 610 0 C626 0 640 14 640 30 C640 46 626 60 610 60 C572 60 540 92 540 130 L540 190 C540 262 482 320 410 320 C356.4 314.7 334.3 304.5 310 281.5 L281.9 281.5 C258.2 305.4 225.8 320 190 320 C107 320 40 253 40 170 L40 130 C40 92 8 60 -30 60 C-46 60 -60 46 -60 30 C-60 14 -46 0 -30 0 C42 0 100 58 100 130 L100 170 C100 219 141 260 190 260 C228 260 260 228 260 190 L260 30 C260 14 274 0 290 0 Z","n.VI_":"M-60 290 C-60 274 -46 260 -30 260 C8 260 40 228 40 190 L40 30 C40 14 54 0 70 0 C86 0 100 14 100 30 L100 170 C100 219 141 260 190 260 C228 260 260 228 260 190 L260 130 C260 58 318 0 390 0 C406 0 420 14 420 30 C420 46 406 60 390 60 C352 60 320 92 320 130 L320 190 C320 262 262 320 190 320 C136.4 314.7 114.3 304.5 90 281.5 L61.9 281.5 C38.2 305.4 5.8 320 -30 320 C-46 320 -60 306 -60 290 Z","n._I_":"M420 30 C420 46 406 60 390 60 C352 60 320 92 320 130 L320 190 C320 262 262 320 190 320 C150 317.1 133.5 311.9 113 298.8 L98.9 297.8 C95.3 310.3 83.3 320 70 320 C54 320 40 306 40 290 L40 130 C40 92 8 60 -30 60 C-46 60 -60 46 -60 30 C-60 14 -46 0 -30 0 C0.9 2 14.2 5.2 30.6 14.6 L43.6 15.3 C49 6.2 59.2 0 70 0 C86 0 100 14 100 30 L100 170 C100 219 141 260 190 260 C228 260 260 228 260 190 L260 130 C260 58 318 0 390 0 C406 0 420 14 420 30 Z","o._IV":"M80 160 C80 215 125 260 180 260 C235 260 280 215 280 160 C280 105 235 60 180 60 C125 60 80 105 80 160 ZM420 290 C420 306 406 320 390 320 L180 320 C91 320 20 249 20 160 C20 138 24 117 32 98 C20 76 -3 60 -30 60 C-46 60 -60 46 -60 30 C-60 14 -46 0 -30 0 C15.5 4.4 34.4 12.5 55.1 31.9 L83.4 31.9 C110.4 11.8 144.2 0 180 0 C269 0 340 71 340 160 C340 198 327 233 305 260 L390 260 C406 260 420 274 420 290 Z","r._I_":"M280 320H70C54 320 40 306 40 290V130C40 92 8 60 -30 60C-46 60 -60 46 -60 30C-60 14 -46 0 -30 0C42 0 100 58 100 130V260H236C226 230 220 195 220 160C220 71 291 0 380 0C396 0 410 14 410 30C410 46 396 60 380 60C325 60 280 105 280 160C280 202 290 242 307 277C309 281 310 286 310 290C310 305 298 320 280 320Z","s._I":"M150 50C150 12 218 0 250 0C339 0 410 71 410 160C410 249 339 320 250 320C242 320 233 316 227 309L47 96C30 75 4 60 -30 60C-46 60 -60 46 -60 30C-60 14 -46 0 -30 0C24 0 66 27 93 58L263 259C312 253 350 211 350 160C350 105 305 60 250 60C229 60 211 65 196 75C191 78 186 80 180 80C165 80 150 67 150 50Z"};
const OCC = [{"word":"Nonograms","name":"N.I_","adv":500},{"word":"Nonograms","name":"o._IV","adv":420},{"word":"Nonograms","name":"n.VI_","adv":420},{"word":"Nonograms","name":"o._IV","adv":420},{"word":"Nonograms","name":"g.VI_","adv":420},{"word":"Nonograms","name":"r._I_","adv":410},{"word":"Nonograms","name":"a._I_","adv":420},{"word":"Nonograms","name":"m._I_","adv":640},{"word":"Nonograms","name":"s._I","adv":490},{"word":"Original","name":"O.I_","adv":500},{"word":"Original","name":"r._I_","adv":410},{"word":"Original","name":"i._I_","adv":280},{"word":"Original","name":"g._I_","adv":420},{"word":"Original","name":"i._I_","adv":280},{"word":"Original","name":"n._I_","adv":420},{"word":"Original","name":"a._I_","adv":420},{"word":"Original","name":"l._I","adv":300}];

// ---- v6 flood constants (generated by r30_gen.py, verified by r30_sim.py) ----
const FS = 220, S = FS / 1000;            // Aghja is 1000 units/em
const LS = 2 * FS / 64;                   // app letter-spacing 2px at 64px, scaled
const LH = 1.09;                          // Aghja line height (OS/2 typo metrics)
const WORD_GAP = 0.05, START_PAUSE = 0.4; // r31: O starts 0.5 s earlier (his ruling) — the between-words breath is now a 50 ms heartbeat
const BASE1 = 260, BASE2 = BASE1 + FS * LH;  // stacked baselines, like the app hero
const MARGIN = 60;
const TOP = 580;                          // field row r <-> font y = TOP - r
const VB_Y = 100;                         // viewBox min-y (box tops; g descender never clipped)
const SPEED2 = 3841.405508072175;  // flood pace, half-units per second
const INK = [45 / 255, 31 / 255, 23 / 255];    // --espresso #2d1f17
const FIELDS = [
  { W: 4394, H: 900, maxT: 24575.0,
    uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAESoAAAOECAIAAAA3Jy8EAAEAAElEQVR42uzdeZxkVX03/k932eNYxQyjYpbH5JfHxCRGZQCFsINGWQSMaxajuAtGk2iigj5ZNKssKpJEjLiLeRLjAigoi4qyI7Kj0USjebIpgsAMM+A0w/z+6K5Zu6drubfq3lvv9yt/nAzjoelz7qlT997P+SYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJNiyq+A8XrwkUknaSedPhpTO/zJfZf5XQIAAAAAAAAAAAAAAMV7kF8BZVv27WTZfFRmasc4zWyyIZkZtrH8KYsmdu57pUEAAAAAAAAAAAAAAAAifsP4LXv7lqTNlhjM+iTzUZlNGzJVROSmr36Wv3/7WM59uxsrAAAAAAAAAAAAAAAg4jeUaNnBSyRtCqlpU1Jj+Te2/MybC/Lc+z2jCgAAAAAAAAAAAAAARPyGQczcl8xkqoikzVgK4PTSz0N+ekuU6N7LjDkAAAAAAAAAAAAAAJCI37CYmS9sW9xmXdKpek2bAhsPecqW//Z73286AAAAAAAAAAAAAABAxG8gMyctUdymsoVrSu3nIa/slsT5c3MEAAAAAAAAAAAAAAAifsMEmXlOMrNV5GZiitsMWBLnz7cqiXOs6QMAAAAAAAAAAAAAABG/oZlmHtON3KxLOk0uXFNePw/5x25JnKeYUAAAAAAAAAAAAAAAEPEb6j/SGzO1TJWbEkriXDb/W733MWYZAAAAAAAAAAAAAABE/Kaqfi5Zl6xL1iYzSadb3aWTrNjq/z1r8gb4lu7vYb3CNeX285Bvz8+0e1dYWAAAAAAAAAAAAAAAIOI3FfCcbt5mLnjTSlpJJ5lOZpKZZFky0/3z6aSVvDppJyuTP276uH6mG0NSpmbkjYfcl6lO0s76tVYYAAAAAAAAAAAAAACI+M04/G43ddPaKmkz202bbP7DzQmc7RrTyTu7hXF+s3Ej+jdJO1m3cPZG4ZpR9tN+eNLO+v+wzgAAAAAAAAAAAAAAQMRvRuWkbvBmc+Rmu+zNzLbxm8USODPdv3l+sjI5uP4D+TrlbiraaP9c0k46WX+1BQcAAAAAAAAAAAAAACJ+U5qzkjXJ+m3L3eyYvZlNprcK2CyZwJkrhnNjsmc9x+/pybKdlbtRuKY6/bQPTjpZf4FlBwAAAAAAAAAAAAAAIn5TtHOSdTtEbhbM3mzoVr/pK4Ezk3w3WZE8vD4j98RkJlmfRJ2ZOjXaT086SSfr32/9AQAAAAAAAAAAAACAiN8M7bpkbT/Zm5lu/GaABE4r2Zi0Kj9mP5HM9FHuRuGaavbTfmXSyfq3W4UAAAAAAAAAAAAAACDiN4P6drJ2ocjNTrI3s8n0QgGb3hI4U62kk03rKvr7aG3M1LJu8EYxmUY02m9MOln/x9YiAAAAAAAAAAAAAACI+E2f7hgoe7OhW/1m0AROZjL1yGz6r2r9Mlr/kcwk6xWcaWY/7ZOSTtb/rhUJAAAAAAAAAAAAAAAiftObjYNmb2a68Zv+EzhTM0mnm8B5XDZ9rRK/idbVyUy34o2KMc2uhPN3SSfrj7UuAQAAAAAAAAAAAABAxG92ZmpF0sqmdQNlb2aT6Z2WuOm9Bs6B2XTFOH8PrU8my7rBG4ViJqaf9j8mnax/utUJAAAAAAAAAAAAAAAifrOAqZ8eou7NXKO1VMBmqdI3WxI4R2fT+eP5PbT+LlmfRFmYSa2Ec0HSyfqDrVEAAAAAAAAAAAAAABDxm211wzNTMwsVwOn0kF5o9VDipvcaOMdm01mj/QX88fblbhSKmdh+2lcnnazf3UoFAAAAAAAAAAAAAAARv0mSqT2TdUPUvZlrTPeUq1my9M18ozW6//zWK7v/CYrAaGwdwvlG1j/GYgUAAAAAAAAAAAAAAOMxXZ0fZeop26dfpraOwXSSdtLprdHL31zeaw2cqdeO4j+/9Zxk3VbZm6Uamzb08Zf1U/d+2t9O+3vWKwAAAAAAAAAAAAAAyGRXv5keuu7Nhm69mt5yNXP/t7PSN5sTOH+eTX9c1n93a78+/wM1JrXRviPpZP1yCxcAAAAAAAAAAAAAAGTi4jdTv5asXyB7MzWTTf1mFaZ7C95slcBZ+m+WUyWo9XNDhTE2bchUp4BQh37q1U97Y9a3rF0AAAAAAAAAAAAAAJAJq36zeN2bqXYy208Ip9Vr8GZqrrG8twRO0VorknXq3mgM0ui0knbWrbWCAQAAAAAAAAAAAABA6aar8ENMvXqR3EsnaSed+RDOVGebP9lZY6m/NtXJ1NZ/0kMCZ+q9hf7eNyaz3TTFEI1NG/Qzuf10Hp7OT1vEAAAAAAAAAAAAAAAgE1D9Zmbhujc7lv7oqRLOdA8Vb9oL/Z0la+AUYfp73Z9TFReNQirh/FzWfdtSBgAAAAAAAAAAAAAAaWz8ZurPkzU9ZW96DeG0+g/e9JbAmTonm5451H/s9C3JuqQzX8BkqlNABkM/+uk8Julk3XUWNAAAAAAAAAAAAAAASBOr30z3l71ZOoTTGih402MNnIH/K7+QLFOqRaPERme/rLvamgYAAAAAAAAAAAAAAGlc/Gag7M3OQjjTgwZvekngDGT6H5P1SRR40U+5/XQOTjpZd4GVDQAAAAAAAAAAAAAA0qD4zczg2ZuFQzitIYI3SyZwejD9ymQm6SSdpJ10FGbRGGmj8/Ss+4zFDQAAAAAAAAAAAAAA0oT4zdSHknXDZm+2C+HMxW8GD97sPIGzg+mf3jZp00nW9RG5UeBFP2X003lO1n3S+gYAAAAAAAAAAAAAAKl/9ZuZwrI3WxrTQwdvFk/gTH0tWTmftJmai9zMKrqiUcVG5zeTTta93yoHAAAAAAAAAAAAAACpc/ym8OzNhm71m9ISOJlOWklLQ6MGjc7rsu7tFjoAAAAAAAAAAAAAAEidq990ii790SooeLOTBM5MpuZ+8qH7149+yu1nOp23ZN1brHUAAAAAAAAAAAAAAJB6xm8Kz97MJtPFBW92msDR0KhLo/POZEXWvcyKBwAAAAAAAAAAAAAAqVv8pl109mZDt/pNmQkcJVn0U79+Wul8MuueY9EDAAAAAAAAAAAAAIDUrfrNbNEFcFqlFRJRSkWj1o1WOhdn3WHWPQAAAAAAAAAAAAAASK3iNxuKLoAzXWaMQSkV/dS8n861WbePpQ8AAAAAAAAAAAAAAFKT+E276OzNhm71m2Vq4GhoLJLA+ddkRdb9hAUQAAAAAAAAAAAAAABSh+o3s0UXwGmVFVqYmmssV0pFP/Xvp5XOfVm33BoIAAAAAAAAAAAAAACpfPxmQ9EFcKZLC9601cDRaFCjlV2W5577LIMAAAAAAAAAAAAAAJDqxm+m2slsNhVbAKdVcvBm6ASOkiz6qU4/u/xE7vmelRAAAAAAAAAAAAAAAFLh6jezRYdwWuUHb9TA0WhSDZzH5J5vWAwBAAAAAAAAAAAAACBVjd90wzOFhXCmRxK8GTSBoySLfirXTyu77Jd7rrYeAgAAAAAAAAAAAABAqhe/aW8fnikghNMaVfBGDRyNJtXAOSz3XGxJBAAAAAAAAAAAAACAVK/6zUIpmqFCOK0RBm/6TOAoyaKfKvezy6/lno9bFQEAAAAAAAAAAAAAIBWL3ywepxkwhDM92uCNGjgaDWrs8orc814LIwAAAAAAAAAAAAAApDLxm/bScZq+QzitkQdvekvgKMmin1r0s8sbcs+p1kYAAAAAAAAAAAAAAEhlqt/0lqvpI4TTGkfwRg0cjSbVwPnL3POHlkcAAAAAAAAAAAAAAEgqEb/psaZN7yGc6TEFb3aawFGSRT/16meXd+WeV1shAQAAAAAAAAAAAABg7PGbdh/Zm15DOK3xBW/UwNFoUg2cv889z7dIAgAAAAAAAAAAAAAQ8ZuMufpNn9mbpUM4rbEGbxZK4Cilop+a9rPL+bnnaOskAAAAAAAAAAAAAAARv8k44zcDZW92FsKZHnfwRg0cjSbVwLki9xxoqQQAAAAAAAAAAAAAIOI3Y9IeKnuzcAinVYHgzVYJHKVU9FP3fnb5Wu55nNUSAAAAAAAAAAAAAICI32Q81W+Gzt5sF8KZi9+MP3ijBo5Gk2rgfC/3/IQFEwAAAAAAAAAAAACAiN9kDPGbgrI3WxrTVQktzFfgWa6Uin7q308ru9yXe5ZbMwEAAAAAAAAAAAAAiPjNaLWLzt5s6Fa/qULwpq0GTn+NH1276Ex58Hv9fsbdaGXF8qy9z7IJAAAAAAAAAAAAAEDEbzLS6jezRRfAaVUseDN0AqcZpVQ2HLbIHLgruWvpmfKjVyzxF5Z3lKwZRT8rfiJrv2flBAAAAAAAAAAAAAAg4jcZXfxmQ9EFcKarF7yZvBo4G94y6ql0338t8IfLX6F2TQk1cB6Ttd+weAIAAAAAAAAAAAAAEPGbkWgXnb3Z0K1+U7XgzaAJnBqVUtnw95Wb3/e9d0t7+buUvimon5aVEwAAAAAAAAAAAACAiN9kdNVvZosugNOqavCmiTVwNlxbm7l+36u3tJdfoZrNUI0VB2btFdZPAAAAAAAAAAAAAAAifpNRxG82FF0AZ7rCwZs+EzjVLIGy4a7krnrP+/sO3NJevk7pm0H6WXF01p5vCQUAAAAAAAAAAAAAIOI3JWsXnb3Z0K1+U9ngTW1r4Mx2kiTrmnYN3Nf973rIKmVt+qyB8/ys/XurKAAAAAAAAAAAAAAAEb9JudVvZosugNOqfPCmtwRORUqgzP78pFwM9/5XkjzkQKVv+uhnxe9m7d9YSAEAAAAAAAAAAAAAiPhNSozfbCi6AM50HYI3la+BM/ukCb0k7r1ivvGQF6tv00OjZRUFAAAAAAAAAAAAACDiNyWaaiez2VRsAZxWTYI3O03gjLEEyuwzXRdJcu+H5hsPeYvSNzv7OyvekrVvMV8AAAAAAAAAAAAAAIj4TcqqfjNbdAinVZ/gTcVq4My+2BWxgHvfkiQPea+KN4sncN6Zta81UwAAAAAAAAAAAAAAiPhNSonfdMMzhYVwpmsVvFkogTPiEiizf+hCWNq9r0iSh1ys9M0iCZyzsvZY0wQAAAAAAAAAAAAAgIjfFK29fXimgBBOq27Bm/HVwJk91SXQn3sPS5KHfE3Fmx0a02YHAAAAAAAAAAAAAAARv0kp1W8WStEMFcJp1TB4s1UCZzSlS2bfa/IP7t7HJclD7lL6ZpvGivOz9mizAwAAAAAAAAAAAACAiN+k4PjN4nGaAUM40/UM3oyqBs7sx037Yty7KknaHaVvtkrgXJG1B5oaAAAAAAAAAAAAAABE/KY47aXjNH2HcFp1Dd7M/zzLSyxdMnuOOV+w9euSpL1q0kvfbEngfCNrH2NeAAAAAAAAAAAAAAAQ8ZsUVv2mt1xNHyGcVm2DN+0Sa+DMfslsL9H67yZJ+0A1cJKW6QAAAAAAAAAAAAAAQMRvUmT8pseaNr2HcKZrHrwZOoGzXemS2RvN8xFZf0Xaz5zo0jdzjRU/yNpHmA4AAAAAAAAAAAAAAET8pgjtPrI3vYZwWvUP3hRXA2f2ayb5SK0/J0nar5j0GjgrZrN2xnQAAAAAAAAAAAAAACDiNymg+k2f2ZulQzitRgRvBk3gbC5dMvtfpvfYrH9vkrTfMomlbzb3s3JF1qw1FwAAAAAAAAAAAAAAiPhNho3fDJS92VkIZ7opwZtBEziz65J15vb4rX9L2u+a4Bo4LVMAAAAAAAAAAAAAAICI3wytPVT2ZuEQTqtBwZs+EzhTM5k1qatk/auTpP3xiSt9M9fPyp/Lmm+bBQAAAAAAAAAAAAAARPwmQ1W/GTp7s10IZy5+05zgTT8JHNmbalr/a2lfPJE1cKYNPgAAAAAAAAAAAAAAEb/JsPGbgrI3WxrTjQve9JDAuX+VyVxp6w9L+8bJKn0z9ycr98maa40/AAAAAAAAAAAAAAARvxlUu+jszYZu9ZuGBW92msC5/xFmcg2s3zNJ2v81cTVwVh6ZNRcYfwAAAAAAAAAAAAAAIn6TAavfzBZdAKfV0ODNIgmc+x9pGtfJ+kemvW5SSt/MN1qGHQAAAAAAAAAAAACAiN9k8PjNhqIL4Ew3N3izbQLn/seZwLW0vpNOZ7Jq4Kw8NmvOMvIAAAAAAAAAAAAAAET8pn/torM3G7rVb5oavNlc9GZPs7fG1q1Lks6qCSh9s0wBHAAAAAAAAAAAAAAAIn6ToarfzBZdAKfV8OBNluX+3U3dJlj33XT2nJQaOCtfmzXvNOYAAAAAAAAAAAAAAET8Jn3HbzYUXQBnusnBm8zk/seYt82x7sZ0ntT00jebEzh/njV/bMwBAAAAAAAAAAAAAIj4TT/aRWdvNnSr3wjeUBPrvpTOr01GDZxpow0AAAAAAAAAAAAAQMRv0nf1m9miC+C0Ghi8yUzu/znTtbHWfTydVzS89M1cY+W7subVBhwAAAAAAAAAAAAAgIjfpI/4zYaiC+BMNy14k2W5/6fN1YZb99503jAZNXAAAAAAAAAAAAAAACDiNz2baiez2VRsAZxWo4I3mcn9P2GiToR1p6bzl00ufTPXWPnxrPk1ow0AAAAAAAAAAAAAQMRv0mv1m9miQzit5gRvMpP7H26WTpB1f5jOu5pfA2flF7LmKUYbAAAAAAAAAAAAAICI36Sn+E03PFNYCGe6IcGbLMv9K0zRibPu1UnS+XgzS9/MN1rGGQAAAAAAAAAAAACAiN/0pr19eKaAEE6rCcGbzOT+5ebnBFtRWB2nijYAAAAAAAAAAAAAACDiN+mt+s1CKZqhQjit2gdvMpP7lQeZbOuOTOfq7SdzQ0rfzCTLsvJrWfM44wwAAAAAAAAAAAAAQMRvsnT8ZvE4zYAhnOl6B2+mlmV2o5lJ1u2XzjcaXQMHAAAAAAAAAAAAAAAifrOk9tJxmr5DOK0aB28yI3vDFusek8735qd0k0rfzDVW/iBrHmGQAQAAAAAAAAAAAACI+E2WqH7TW66mjxBOq67Bm7Qzu9acZBvrfiKd+5pbAwcAAAAAAAAAAAAAACJ+k6XiNz3WtOk9hDNdy+DN/J+I37CDdcuzS0FTrmoldHZN7jbAAAAAAAAAAAAAAABE/GYn2n1kb3oN4bTqGbyZyex/mJAs7J7Z7LKqcaVvlnUvWwAAAAAAAAAAAAAAiPhNFq9+02f2ZukQTqt+wZssy+y3zUZ25p4fZJefb1Tpm7l+dl2Vu39geAEAAAAAAAAAAAAAiPhNFo3fDJS92VkIZ7pmwZvMZPYbpiJLu+dfs8s+TayBAwAAAAAAAAAAAAAAEb9ZTHuo7M3CIZxWnYI3mcnsLeYhPVu5TcCs7qVv5v5k18fl7q8ZWgAAAAAAAAAAAAAAIn6ThavfDJ292S6EMxe/qUXwJssye51JSB/u+UJ2ec6ACZxKNwAAAAAAAAAAAAAAIOI3WSR+U1D2Zktjuh7BG6kDBnPPJ7PLi5tT+mbuT3Z9Uu7+krEFAAAAAAAAAAAAACDiNztoF5292dCtflP94M2yzH7BDGQQ93wou7y2QaVv5hoAAAAAAAAAAAAAABDxmyxU/Wa26AI4rRoEbzKT2QtMP4awotekWfVL38w1dv3N3P2PxhUAAAAAAAAAAAAAgIjfZPv4zYaiC+BMVz14k5nMfsbcYyj3/Hl2eXslaj0V1mgZVQAAAAAAAAAAAAAAIn6zg3bR2ZsNYwgk9BW8mW/A0O55XXZ5b0NK38w3AAAAAAAAAAAAAAAg4jfZofrNbNEFcFrVDt7MZPYsE49i3POK7PLxRpS+WZbMZNfX5u53GlUAAAAAAAAAAAAAACJ+k23iNxuKLoAzXd3gTZZl9v1mHYVasWjkrGalbxSGAgAAAAAAAAAAAAAg4jc7ahedvdnQjSJUL3gz34BC3XNkdrmiCaVv5hq7npS732hUAQAAAAAAAAAAAACI+E22VL+ZLboATquqwZtlmX27KUfx7jkwu3ytEaVv5q5fAAAAAAAAAAAAAACI+E22it9sKLoAznQVgzeZyexJ5hulWVnKzB9PAwAAAAAAAAAAAAAAIn7TNdVOZrOp2AI4rcoFb+YbUJp7fjq73DU/06aKC8OMpYTOrmfl7mMNKQAAAAAAAAAAAAAAEb9JknSS2aJDOK3qBW9mMvtGk42SrcjU3OTv1LwGzrSxBAAAAAAAAAAAAAAg4jfZEr/phmcKC+FMVyt4o/QNo3FPKysKDd6MpfSN6wUAAAAAAAAAAAAAgIjfbKO9fXimgBBOq2LBm5nMvtJMYxTWrsuKR9a89M1MMpNdL87dhxlPAAAAAAAAAAAAAAAifpN0Fk7RDBXCaVUoeJOZzL7MNGOEVgx4CVSo9M1cAwAAAAAAAAAAAAAAIn6TpLOzOM2AIZzpqgRv5hswQmu/kRX71Lv0jQsHAAAAAAAAAAAAAICI32zRXjpO03cIp1WZ4M1MZp9jjjFyK/sOoVWu9M2y7Pq13P04YwkAAAAAAAAAAAAAQFS/6bWmTR8hnFYlgjcqeDAua7+QFc+seembuQYAAAAAAAAAAAAAAET8ptNzTZveQzjT1QjezGT2KSYYY7KijzJQFSx9M9fY9Y7c/XBjCQAAAAAAAAAAAABAJjt+0+4je9NrCKc1/uCN0jeM19qzsuLVNS99M1fJCgAAAAAAAAAAAAAAovpNn9mbpUM4rQoEb2Yy+0Szi1SiAE49S9/IsAEAAAAAAAAAAAAAEPGbJOkMmL3ZWQhneszBG7EBqmDtSVnxl3UufTPXAAAAAAAAAAAAAACATHj8pj1U9mbhEE5r3MGbmcz+nKlFBazcJo1Wu9I3UzNZtSJ3rTWQAAAAAAAAAAAAAABksqvfDJ292S6EMxe/GVfwRukbqmPt72bFh+pc+mYmaRlGAAAAAAAAAAAAAAAy8fGbgrI3WxrTY44NzD7cvKIyVnQDaTUsfTPfDwAAAAAAAAAAAAAAZJLjN+2iszcbeg0bKH3DJFj7nKy4uLalb+YaAAAAAAAAAAAAAACQCa9+M1t0AZzWWEvftEwqUtECOItM3aniLoEySuis2j133WIUAQAAAAAAAAAAAADIBMdvNhRdAGd6PMGbKaVvqKS1+2XF13YavOlUuwaOSBsAAAAAAAAAAAAAAJnk+E276OzNhm6hj9EHb9rJsuQ+k4rq6YwieFNG6Zv5fwQAAAAAAAAAAAAAAJnk6jezRRfAaY0peDOTDd8zo6ikFVtiafWoeLNdAwAAAAAAAAAAAAAAMsnxmw1FF8CZHkPwRkiAKlv78KyYLTd4U2Lpm5msOjp3nW8YAQAAAAAAAAAAAADIRMZv2kVnbzZsqfIx0uDNTDZ8w3SiuqZW1K3izXYNAAAAAAAAAAAAAADIxFa/mS26AE5r1MEbpW+ogU6JhaFKLX0z3wAAAAAAAAAAAAAAgExs/GZD0QVwpkcevFGdg8pbc0dW/u/alr4RbwMAAAAAAAAAAAAAIJMav5lqJ7PZVGwBnNbIgzfLsuEL5hKVt6Lgq2N0pW9msurVuetdhhAAAAAAAAAAAAAAgExk9ZvZokM4rZEGb5S+oS7W3JKVB9az9I2rDAAAAAAAAAAAAACATHL8phueKSyEMz3a4M1cA2qhXcvSN64yAAAAAAAAAAAAAAAyufGb9vbhmQJCOK3RBm9msuEsE4maWFlAPm1sDQAAAAAAAAAAAAAAyGRWv1koRTNUCKc1uuCNohzUy5pPZuWL61n6xoUGAAAAAAAAAAAAAEAmNn6zeJxmwBDO9AiDN4pyUDudepa+mcmqd+au1xo/AAAAAAAAAAAAAAAyYfGb9tJxmr5DOK0RBm9msuEks4haWTFghagxl75RaQoAAAAAAAAAAAAAgExs9ZvecjV9hHBaIwreKH1Dalr9Zrp+pW9cbgAAAAAAAAAAAAAAZHLjNz3WtOk9hDM9quDNXANqZc0fZ+U7h5r5U8WFavouoQMAAAAAAAAAAAAAAJm0+E27j+xNryGc1qiCN3MNSA0L4AwTvOmMrwYOAAAAAAAAAAAAAABkAqvf9Jm9WTqE0xpV8GYmG15mClFDKxa4TEYfvJkaoEMAAAAAAAAAAAAAAMgExm8Gyt7sLIQzPYrgjVocpNbVb6brU/Fmq8aqL+Supxg/AAAAAAAAAAAAAAAySfGb9lDZm4VDOK2RBG/U4qC21jw9K7805uDN1GA9t4weAAAAAAAAAAAAAACZvOo3Q2dvtgvhzMVvSg/ezDUgtS2AU5OKN0pOAQAAAAAAAAAAAACQSY/fFJS92dKYHlESYMPB5g+1taIbVBtH8GZqmH8FAAAAAAAAAAAAAABkouI37aKzNxu6oQKlbyA7Tb5N16fijesOAAAAAAAAAAAAAIBMcvWb2aIL4LRGlQSA2lrz01l513iCN1ND/rsAAAAAAAAAAAAAACCTFr/ZUHQBnOlR1eKA1LsATm0q3rjuAAAAAAAAAAAAAADIxMZv2kVnbzZ0q9+MIAkAdTbVHkPwZmrotM+qO3LXw40eAAAAAAAAAAAAAACZpOo3s0UXwGmNKlEAqXf1m9pUvNm60TJyAAAAAAAAAAAAAABkwuI3G4ougDM9iiTABhkA6m7FCEtFFVT6RvINAAAAAAAAAAAAAIBMXPymXXT2ZkPpiYIpAQDSlOo3rbqVvplrAAAAAAAAAAAAAABAJqr6zWzRBXBaJQdv2smy5D6Th9Q+fjNdv9I3U8JvAAAAAAAAAAAAAABk0uI3G4ougDNdcvBm7h/dYfJQb3dfl12fVMPSN3OXOQAAAAAAAAAAAAAAZDLiN1PtZDabii2A0yo5eDPXgDSiAE75gZmpwkvoiN8AAAAAAAAAAAAAAJCJqn4zW3QIp1Vy8GauAQ3QHknwpvCQDwAAAAAAAAAAAAAAZKLiN93wTGEhnOmSgzcz+dHVZg6NsLKA62VkwZupzR0CAAAAAAAAAAAAAEAmJ37T3j48U0AIp1Vi8EbpG9Kw6jetmlS8cQECAAAAAAAAAAAAAJCJrX6zUIpmqBBOq8zgzVwDmqEz4PUy+uDN1NY9AwAAAAAAAAAAAABAJip+s3icZsAQznSZwZu5BqQp8ZvpmlS8cQECAAAAAAAAAAAAAJDJjN+0l47T9B3CaZUZvJlrQDO0+7hexhi8mdruXwEAAAAAAAAAAAAAAJmo6je95Wr6COG0ygzezDUgTal+06pJxRsXIAAAAAAAAAAAAAAAmdj4TY81bXoP4UyXGbyZa0CaEr+ZrnrwZmrHfxcAAAAAAAAAAAAAAGRy4jftPrI3vYZwWmUGb+Ya0AztRa+XylW8cQECAAAAAAAAAAAAAJCJrX7TZ/Zm6RBOq8zgzVwDGuHu52TXiysdvJla6F/60KNz5/lGDwAAAAAAAAAAAACATEz8ZqDszc5CONNlBm/mGpAGFcCpRcUbETgAAAAAAAAAAAAAADKZ8Zv2UNmbhUM4rTKDN3MNaIxOdYM3Uzv5twMAAAAAAAAAAAAAQCan+s3Q2ZvtQjhz8Zuygjcqb5Amxm9qUfFGBA4AAAAAAAAAAAAAgExm/Kag7M2WxnT5AQBojHZFgzdTO/8xAAAAAAAAAAAAAAAgExK/aRedvdnQrX6j8gak5+o3tah4IwIHAAAAAAAAAAAAAEAms/rNbNEFcFrlBwAgzYnfVC14MyUCBwAAAAAAAAAAAABAxG+yVfxmQ9EFcKZV3oBeTbWrF7zp5ecBAAAAAAAAAAAAAIBMSPymXXT2ZkO3+k2paQFIc6rf1Cx4IwIHAAAAAAAAAAAAAEAmrfrNbNEFcFrlpwUgzYrf1Ch4IwIHAAAAAAAAAAAAAEAmLX6zoegCONPlxwagMdp1C96IwAEAAAAAAAAAAAAAkImK37SLzt5s6Fa/KS02MKXyBmlc9ZsaBW9E4AAAAAAAAAAAAAAAyKRVv5ktugBOq8zgzUzSTtaaOaRR8ZsaBW/mGgAAAAAAAAAAAAAAkMmJ32wougDOdJnBm7mG+A2N0a5b8GauAQAAAAAAAAAAAAAAmYz4zVQ7mc2mYgvgtMoM3qi8QZpY/aZGwZu5BgAAAAAAAAAAAAAAZHKq38wWHcJplRm8UXmDNDF+U6PgjQgcAAAAAAAAAAAAAACZtPhNNzxTWAhnuszgjcobNEy7bsEbETgAAAAAAAAAAAAAADJR8Zv29uGZAkI4rTKDNypvkCZWv6lR8EYEDgAAAAAAAAAAAACATFr1m4VSNEOFcFplBm9U3iBNjN/UKHgjAgcAAAAAAAAAAAAAQCYtfrN4nGbAEM50mcEblTdomHbdgjcicAAAAAAAAAAAAAAAZKLiN+2l4zR9h3BaZQZvVN4gTax+U6PgjQgcAAAAAAAAAAAAAACZtOo3veVq+gjhtMoM3qi8QZoYv6lR8EYEDgAAAAAAAAAAAACATFr8pseaNr2HcKbLDN6ovEHDtOsWvBGBAwAAAAAAAAAAAAAgExW/afeRvek1hNMqM3ij8gZpYvWbGgVvROAAAAAAAAAAAAAAAMikVb/pM3uzdAinVWbwRuUN0sT4TY2CNyJwAAAAAAAAAAAAAABk0uI3A2VvdhbCmS4zeKPyBg3TrlnwZv7nAQAAAAAAAAAAAACATEj8pj1U9mbhEE6rzOCNyhukidVvahS8mft57jJyAAAAAAAAAAAAAABkYqrfDJ292S6EMxe/KSt4o/IGaWL8pkbBm7l/JH4DAAAAAAAAAAAAAEAmJ35TUPZmS2O6/EgANEa7bsEbETgAAAAAAAAAAAAAADJR8Zt20dmbDd3qN6VmAyDNqn5To+CNCBwAAAAAAAAAAAAAAJm06jezRRfAaZWfDYA0J35Ts+CNCBwAAAAAAAAAAAAAAJm0+M2GogvgTJcfEoCmmGrXLXgjAgcAAAAAAAAAAAAAQCYqftMuOnuzoVv9ptS0AKQ51W9qFrwRgQMAAAAAAAAAAAAAIJNW/Wa26AI4rfLTApBmxW9qFLwRgQMAAAAAAAAAAAAAIJMWv9lQdAGc6fJjA9AY7boFb0TgAAAAAAAAAAAAAADIRMVv2kVnbzZ0q9+UFhuYUnmDNK76TY2CNyJwAAAAAAAAAAAAAABk0qrfzBZdAKdVZvBmJmkna80c0qj4TY2CN3MNAAAAAAAAAAAAAADI5MRvNhRdAGe6zODNXEP8hsZo1y14M9cAAAAAAAAAAAAAAIBMRvxmqp3MZlOxBXBaZQZvVN4gTax+U6PgzVwDAAAAAAAAAAAAAAAyOdVvZosO4bTKDN6ovEGaGL+pUfBGBA4AAAAAAAAAAAAAgExa/KYbnikshDNdZvBG5Q0apl234I0IHAAAAAAAAAAAAAAAmaj4TXv78EwBIZxWmcEblTdIE6vf1Ch4IwIHAAAAAAAAAAAAAEAmrfrNQimaoUI4rTKDNypvkCbGb2oUvBGBAwAAAAAAAAAAAAAgkxa/WTxOM2AIZ7rM4I3KGzRMu27BGxE4AAAAAAAAAAAAAAAyUfGb9tJxmr5DOK0ygzcqb5AmVr+pUfBGBA4AAAAAAAAAAAAAgExa9ZvecjV9hHBaZQZvVN4gTYzf1Ch4IwIHAAAAAAAAAAAAAEAmLX7TY02b3kM402UGb1TeoGHadQveiMABAAAAAAAAAAAAAJCJit+0+8je9BrCaZUZvFF5gzSx+k2NgjcicAAAAAAAAAAAAAAAZNKq3/SZvVk6hNMqM3ij8gZpYvymRsEbETgAAAAAAAAAAAAAADJp8ZuBsjc7C+FMlxm8UXmDhmnXLHgz//MAAAAAAAAAAAAAAEAmJH7THip7s3AIp1Vm8EblDdLE6jc1Ct7M/Tx3GTkAAAAAAAAAAAAAADIx1W+Gzt5sF8KZi9+UFbxReYM0MX5To+DN3D8SvwEAAAAAAAAAAAAAIJMTvykoe7OlMV1+JAAao1234I0IHAAAAAAAAAAAAAAAmaj4Tbvo7M2GbvWbUrMBkGZVv6lR8EYEDgAAAAAAAAAAAACATFr1m9miC+C0ys8GQJoTv6lZ8EYEDgAAAAAAAAAAAACATFr8ZkPRBXCmyw8JQFNMtesWvBGBg3HY68dGshrMrUid+cZUZ/s/Gayhn4nt58oNg8z2A67f2WZyyR/vindaMCjSU9b3NPF20vj8nn6LQHO85N8W+nQufGu606V1qoiNin4mqp8znjDIbH/1CVvNyeV+7fqpQT9ve7CPKairv35euTf9ppZV5QHEgD/Pcuv82Po5/uUuUKilz7y+4PNSt/7if8ydfsEAufKPSllj97fGUrQb9h72u8Oet/stAtTPD2/tae+xk8ZDP++3SMRvdqpddPZmQ/duTqn36CHNqX5Ts+CNCByUac//2P6hyPyud133T2ZLa6SELYHGZDcO6N6hu/K7S0/+Az7e/Rhas/hc7SE3fuAJ298cvOLXLC0s7Snv7e6Ftru/vG7YAwue+vUF3nG5+Da/cqDSXvLxRe7trFvgY3rT+q12rcNvTZdadTfNZqqIo2T0Mzn9vOqW+c/fM358iZn/6udtlQPfPNuXJy2/dv3UoJ/XP7BAaPzUS32mQUX99UELfeiUc9Nv07pu6GW2/BuMhf88DyTTfS6MswXd4NLPhrznw/OfKccf5aqFivrMkxd6mLt2qz8pYvXe+ov/ebtsdUhBd9t5jBezgOa68pheb5MOv8ZetcsC/679bzUILO36b275aJ7a+nHn0N8dbvzJ7Z+f7nmu3zdARf3wou4uYn1Pe4+dbFTuPHTbbUkn6eShZ/gdE/GbbHn1v/AXLlvlpwUgzYrf1Ch4IwIHBdnzMwt9Yu7wUKTg1xn7yd54t0k/RfVzwC/M34+78ortL4QDTu1+DM0uFTPrDPjjHXjOQkVyVlmEJtpTnrnDrFi3s29GhV8Xhz1y+zl58TmGBRiPl/zhQkmbtUM9Jy4ve6OhMUzjVT+cT8O+a+P2F8Krn7xIDryH7I2GRpUbb3jKAt+GTv1jn34wTn/96KUOHxHCGSZ7M5NNs5kq4uRB/WzdeM/n5z9Kjt/DRQxj85mHLvTcdv3oVu8tX/znvihttVac97QFtp3HnGjQgJq58me2CsnPjCgtv+TN1at+afs1dv8PG6uJdv1pC9WQnx3dd4cbn7v9v31PH/oAY/XDD3Y3D+vKebDbfZfmztcsUDDtoc8yAmRS4zeFP96bLj82AI3RrlvwRgQOBrXnO7b9iOzn+LFyQzjxTpLGiBoHPCnp5Mrzk+SA13a/+/WcvSnwhzlw/ZY6JJerQ9J0T+ns7B50RRqH/fqWn/DiUwwaUKKX/Pq2IfC1I3pOXGD2RgpaP0P28+pO0s677kiSVz9u8QcS/WRv/Nr1U6N+3nDylp3nqb/hgxFG569XjqrGdTNCOANlbxSuKbuf93w96eT4n3FBwyh8+vZtn+ou+P73yFfvTfdlqrcDXs87bcu28xjvYwFVdcX93ZuZ4wjJL31zdYfEYzbkqpdveey1/x8Zw4a7/mnJsm2fcq7r4V76aL873LjVh/6ePvQBRuiHb0tag6eFe3qwu9QXwDvP2zaN8yjDQiYjftMu4e2xVrmxgallpg1pWvWbGgVvROCgH3v+3laRmzVjfZ1xoOyNd5v0U0Y/B8wVHlm/1fTrJ3tT+I93ULcOyeU3WrSa4Feu3P6wjdTt+jrsD7f88Be/wpACBXjJL28VueknBD66Xau6Nxojb7z6x3Z6VrS6NxqT0XjDp7bsPE99gg9MKMvp93fvENao8sx4f55hsjcK15Tfz3v+O+nk+F1d3FC8T391q+/sW90237Ruqye8YwzhLE9agywj5523zd3aY7yPBYzVFd/aprhNuedgFlptbMfGVSdveSK2vyM26u/6B3Xf5tr8ubl+kNNUx/jd4catPvT3fLwhBSjLD09MWsUcs7izvVCn70+QO/9z/oNsqp1V9xso0ujqN4U/umuVGbyZSdrJWjOHNCp+U6Pgzeb39YFF7PmrRUZuyg3hxPtGGhVorKvKy7gH/fKW53+X/5PFrDZ+5Z3bHvvUrAvksA9tucl+8ZOMNtCHl/zYSCM3Q+1aO9LL+hl5P8uTjYvPyYGyN37t+ql7P2+4ZcvO89QVPkihMKd/f/4OYZ0qz4z35xkue6Nwzcj6ec/6HN92iUMBPv2JhSM3OzbGHMLZ+i3w4ZaR8/5zfts51cnR3scCRuKKz28TuRnROZgjqTa2uXHV2Vselu2/lzGvjetu2DJwm9p9j3uVvzvc+M0t95r2fLChBijMD19e/MPfBfZCnWGfVty11SkMq75u3Ejj4jeFvys2XWbwZln3xRFohnbdgjdzDWBbe64uN3JTyh3AeCdJPxXoZ6DszQh+vIOe3y2J804rXBX9you3itysn5RCXod1C/tc/POmALCwF6+fj9xMjSlyM8iuVd0bjdE37sumdYu/bazujYbGTN7wo0y1k05OWePTFQZ3+teT1vbv9gnhLPHz3KfgTJ36ec/9mWrnuA0ud+jbp9/Wa+SmKiGcbSswFLgcnd99GevofzcvgIJd8cGtnuCvG/k5mOOoNra5cdWt3ZI4P24iVNF1H1z0YMGmfne4cdP8vaY9bjf+AIP74bOT6WR9+Q92iy7scdceW8qjrTrXSJLax2+m2slsNhX7fK5VZvBm8xvDkAZVv6lR8GauASRJ9nx491NvTVVfZ1T3RkPdmyFL4pww//Xv8jdY88bsV/bsI3LT7MZh3006ufgRJgUw78X/2t2UdiM3lTuscbGfpyO9rJ+R93PffN2bhd82Hi5749eun+b1c8LD598FOeWffd5Cf06/srs3q1flmfH+PHN1bxScqVs/Z+6S4+5x0UNPPv37A0ZuxhzC2TZ7U9JydP6j51/GOvoqMwUYyhV/MewT/DHfXC2u2lhmctWdSTv7KzxSAde9ZtHIzUR9B7npJ+d/CXvcZFIA9OeHvzKqM8FLflpx13O7JXHOMKqkztVvZosO4bTKDN6ovEGaGL+pUfBGBA6SPe5LWrU6U3y47I13kvRTSj/DZW9G/5950Dvnv/5d/ltWwZH6lSIiN428vg67K+lkqpOLnDILk+rFX+4e37i22oc1LvbzqHujMY66N3PZm4XfNlb3RkNj8cYJq+ffhjzlCz6BYWmnf3Zn2RshnJ1lbxScqWc/Zz40x93p0odFffrX+6u9UK0QzoLZmzKXo/MPnb8hfPQnzB2gP1f8zjZHFI3tHMzqVRu7qlt4ZD+FR0bruqd239rq+O6wfT837Z10sseXTROAnvzwCaM6HLwzuucOd71m/rnDqj8ywqSG8ZvubC4shDNdZvBG5Q0apl234I0IHJNtj+9uecGxNmeKq3ujUcHGfcmGqte9Waxx0MeTTi4/yopYrid/t3szuu2SWaJxePcXddF3TRyYFC/+WB/HN1Z01yq9rJ/R97ND9mabt42X+3XpRz899XPC05J2TvmkT2NY1On/t6fsjRDOgtkbBWfq28+ZP5bjbrMAwDY+fUj33NL15a6lJYZwFsnejGY5Ov9587eIjz7dbAJ25opnlZVyHPXN1fKrjV3dLTyyn8IjZbruZ7qvbK0b9CXmifkOctNT559y7vEPJg7Aon74s6PO3oz4acVdp8yfwrDqJUab1CR+s8PbbAWEcFplBm82vzoMaVD1mxoFb0TgmEh7XNm9BNbX7UzxgrI33knST8H9bOzePh4iezPe/8yDLp6/FXj5ntbIIj25+4vdfPvV9dV7P4f/QtLORTeaR9BYL35H9xNzXU0Oa6xn1FZjQurebNNQ90ZDo8/GCc+bfxh2yl/7fIZtnH5Gf9kbIZwFsjcKztS2nzN/Ksf9p2UA8ulHL1GrtjYhnJ1nb0a4HJ3/+vmbxkefaH4BW1yx/4hSjiO6uTraamNX7510sp/CI4X66o+SZZlqd1M3vjv0089NL5q/17TH20wlgG388GENrHuzWOOuj85HhVcdbuRJ5avfLDSJhwrhtMoM3qi8QZoYv6lR8EYEjkmyx6e6z0jW1fNMcXVvNKr8+mOrIS/jHvT1pJ3L/7clcyhPPmP+jqoLZPjG4b+ctHPRl0wraI4Xn9D93FxXq8Mad5q9ka7Uz6j76SF749elH/0M0M8Jr0s6OeXPfFxDkpz+V8O+aT2JIZwdsjcKztS7H5hsn96lj1q1VQ/hLJW9GctydP5pSTtHH2+uwUS74mfGk3Is9+bqmKqNXf3UpJP9zjWthvLVW7sva61P4rvDsP3c9Kakkz3+yMwCSJIfTo8tezPepxV3XZJ0suqXTQFS4fjN4pN4wBDOdJnBG5U3aJh23YI3InBMhj3OGOQZSaVDOPEukX4q0899W+0Yh8veVOc/86D/Ttq5fJXlsz9Pfu38wRWui8L7OfzwpJ2LzjHLoN5e/MJkpvsguV6HNap7o1G1xgPq3mholNg44c+TTk75Ax/dTLy1Naw8M96fZ7HsjYIzCuBArZx7zw4vSIx7AR82hNNj9mZMy9H5H5w/y+noY8w+mCxXPCRpjTnlWMrN1XFXG7v6uUkn+33YFOvPV8/uvqm1bptXln13KKSfm05OOtnjd0w0YKLdsSabul82p5pe92bhEM4N86VQV/2U6UAqFr/pYUPTdwinVWbwZvM7xJAGVb+pUfBGBI6m2+MtPZW7qVcIp5D7IBoahTU2JrPd+8jNehn3oPWZaucyK2kPnvzrSbu4c5I0FquE8+tJOxd9yIyD+nnx04opd1OtXWtHulI/Y+onycaesjd+XfrRzzD9nPA3SSenvNTHOBPq9N8uePPW/BDO4tkbBWdq3c+Zj8px37EkMCnO/bdtXgRfIvRSlxBOz9mbsS9H51+YdHL0QWYiNN/l9yStbKrsOZhlZm9Gtthe/fKkk/1ON92W9tW/7d697/juUG4/N70n6WSPF5h0wCS64/9tkzou8cFupwZPK+66LWln1S7mBalS9ZveJnEfIZxWmcEblTdIE+M3NQreiMDRUHu8svv5tb7+Z4pv14h3gPRTsX4e2DawPVz2poL/mQd3knYuu8vKurAnH1jvSkd17Ofw45J2Lnqn2Qc18OK9uifmrqvtYY3q3mhUNgGu7o2Gxmgq4Zw1X+LylCN8sDNBTn9BWcHpxoZwlszeODS61v3ABDj3ymTZwnXP6h3C6Td7U4Hl6Pxrkk6OfrxZCc10+XeS6S3lwSt4DuZQP0/1qo1d/fqkk/3+1NRb2Fff1L173/HdYXT93PSxpJM9VL0DJs2akTzY7dTpAcRdGzLVzq73mxwklYjf9DOJewrhTJcZvFF5g4Zp1y14IwJH4+zxnKS18DOSJoRw4tUfjYo1puc3k1PTDX8Z9+AfS9q57LtW2XlPfmT9vro3rRLOCUk7F73FZISKevEjtzkxt66HNfaZvZGu1M/o+nmg1+yNX5d+9FNUPyd8MenklH19yDO5j8OFcIbJ3jjsWQEcqKxzz+3pKLdahnD6z95UZzk6/5tJJ0f/lBkKzXH5NYveL21ICKfC1cau/oukk/1+3zTc4qvPSzrJ+p5fwPDdoeh+brow6WQPVe+AyXDH5Tv71lnYXqhTy6cVd3eSdna93TSJ+E3G/Op//5N4iRBOq8zgzeaXiSENqn5To+CNCBwNssch2xyW04QzxRfP3ngHSD9V6Wcmm+5L1nWvi6b/ug7+haSdy26c6MX2yenpICjX12j6OfyvknYueq1dAFTIi5eVmAavxK5V3RuN8TbWdavfqHujoTGOxgnXJ52c8os+8Gmy059cWD3tiQjh9J69cdizAjhQMee+L5npr9xZnUI4A2dvqrQcnf/9pJOjdzFbod4uP3fRCmPNCeHUodrY1X+bdLLfSyZ9Qn710KTdd1zEd4eS+rnpmqSTPVS9AxrtjvN6utk47F6o5ofn3v2/knZ2/Zb5EvGbjO3V/0En8aIhnFaZwRuVN0gT4zc1Ct6IwNEIezxmDIeLj/oOYLzoo1HFxqa5NyDvS1oT9DLuwb+cy74yiYvtk/47mcmmTjH3YTWKrIRzRtLORS+2I4Axe9HdyXQ2LWvEYY2DZm+kK/VTej8buvGbnrM3fu360U/h/ZzwbznlZ33y01zlH+7TnBBOP9kbhz0rgAPVce5fdQ8YKqPyTBVCOFt/Uar/cnT+jzLVyVH3m7lQP5e/r6cKY7UP4dSq2tjVH0062e9Zkzghv/ro4R5n++5QWj83fTN7OOoFaKg7/mEke6FOQ55W3P3YpJ1dv2riRPwmY3j1f7jZvEAIZ7rM4I3KGzRMu2bBm/mfB2prj4eP+XDxEd0BjHeA9FPRfjKdPNA9AnNjNj2QqXayMXkg2Th4o/r9HHxIsiKXnT9B6+2TbuxWvHFdVLWfw/9vLvotWwMYjxf96/Zp8Hof1qjujUb1Gw+oe6OhMebGCf+RdHLKw+wCaJrTf2Hwt7EnLoQzQPbGYc8K4MC4nfv7fb8IXr8QznZflJqyHH22nXRy1O1mMdTD5Scnrf4qjNU1hFPPamNXn5f9jpmgCfnVXe35q97PTd9J2tnjxy2fQKPc8e4BD/rpby/UadoDiLsPSNrZ9fNmUMRvMtJX/4uYxNuEcFplBm82v1UMaVD1mxoFb+Z+nruMHPWz+oFMTY/6NMrx3AGM13o0KtxY1v00me5eBUV80tWjn1YO/s1kZS47s+Hr7ZM+O0gRdo2xNA7/eNLJRUfZJsDovOjKnaXBGxXC6UhF6qcy/axPNvaXvfFr149+SurnhLVJJ6dM2xGQppW+qUXlmfH+PANlbxz2rAAOjNG5L0hmBn8RvDYhnPsW2uM1aDn67E8mnRz1LTMaquvy1xd2emYNbq4Okb0Z+2J79YVJJ/sd1PAJee093WfZHXv+GvRz051JO3s82FIKNMEdbx32tcae9kKdxj6tuPuopJ1dP2EqRfwmI3r1v7j3t+ZCOHPxm7KCNypvkCbGb2oUvJn7R+I31M3qHyRrGnqmeD/ZG+8A6acSBXA681mU+XP1KvBJN9LGdA4+IZed0szF9kkfSpa5LurXz+EXJ51cdID9ApTuRZ/p6bZpE3at6t5oVKruzcbu/By6yKGGhkYhjROX5eQN9gU0wem7FP9adjNDOMNkbxz2rAAOjNy5T+tWYBhB5ZnxrtvLk1Y2bcjUdi+NNG45+uwvJZ0c9VWzGyrn8pcUf3pmdW+uDp+9qcBie/U1SSf7Pb6ZE/La7yTrko49f836uWlT9piyoAJpyCk/pe6FOs1/OHj3byXt7Po+8yniNyn91f/CJ/F0+S8vQmO06xa8EYGjblZ/ffvzyZocwokX7DTq0Zia+/jb/PkyCaVvtkvg/HmyIpe9tlHr7ZNOTdZbiOpcCefaXLSPjQOU5UUfSGaS9c06rLG47I1UpH5K7Gf5IJHvqWXdmuHD3VrRj370s1g/J65KVuTkb9sjUHPruu/PzQjhLP7zDJe9cdhzvfuBujl372S6+BfBKxrC2XmB0CYua5/dP+nkqM+b6VAJlz8jme7vfmm9Qzj37ZB1rPPe7+pvZr9fbNSEvPaaHU4YtOevVT83PyjpZPXdFlegru54VcFnQCywF+pM0MPBu1+VtLPr28ysiN+kxFf/C39/q1V+NgDSrOo3NQreiMBRH6sv29n5ZA0M4cQrd/qpWz8zhSVwatlo5eAP5LKXNmG9fdJre/qi7rqofj+H35h0ctHP20RAkV50andT2rDDGtW90ahLY27PuXEiN5waGpX/TnTiXsmKnHyp/QJ1tWntVrkyIZwFf577HNI80f2c+VM57j8tFdTGuY9K1oxhwRxPCGfb7M0kFMDZEsJ5WtLJUZ8w5WFsLt8/aY1oya3KzdW5amPN2vtd/Z2knf1+vPYT8tqzuydnxZ6/9v3cvFtW326VBernjt8qq/7qlr1QZxKfEt79f7LrX5lfEb9JWa/+Fz53W+U/n4M0J35Ts+CNCBw1sfqcns4na04IR7kJjVq/ENlKWsn0II2p6aQz+P987P0c/PGkk8uOquti+6TnD/U4VqOajcO/m4v+t60EFONFb+puSht2WONiP09HmlE/lexnWX93XZQu0Y9+RtpPKycenZPPt2sgda1+U/HKM+P9eebq3jikWQEcqLxzVw51cEb9Qjg7r3vT6AI4W0I4z8tR/2Duwxhc/ovF3C+t083V5d2amU3c+119Z/Z7aI0n5LXvSdYtflvbnr+G/dz8k0knq79luQVq446jysrebNkLTfBDxrvfnHSy6wkmWsRvUnz8pvDXtqbLDwlAU0y16xa8EYGj8la/t3s8SYPPFB8ue+PVPf3op2r9HHxxLjusfuvtkw7v3pI27o3r5/D/Ttq5aJVtBQzuRS9LlpVfJbxSu1Z1bzQq3lje/T8lRzQ0qtc48fnJypz8bjsI6uSd39r+RW0hnAWyNw5p1g9U2zk/2vZo0XEv4KMI4SySvZmoAjhzjc++KGnnKFtQGJXLd+tmHWt3DmZR2ZuG7v2uvif77VK/CXntXyz9eWfPX99+bv6lrP5n6y5QA3ccVP7uqOMpYe4+Lelk1+PMuIjfFKddwpRtlf9YDtKc6jc1C96IwFFhq08a6nyyuoZw4nU6DY0mNA7+Ui57Up2W3Cf9soFrfuPw9bmobX8BfXvRs5Lp/tLgTdi1SjPqpy79LBu22qGGhkZZjeTE1+Xkt9tKkDqVvmlVuPLMeH+ebvbGIc36gSo757/nKzCMtPLMeEM4Pda9mYwCOPMhnNck7Rz1VhcElOvyqW7Rm9qdg1lc9qbBe7+rf5SpTva9vzYT8trX93zCoD1/bfu5eY+svsnqC1TaHY8vvypgx8PBrUI4H8yuLzHvIn6Twl79L/xtrVb5aQFIs+I3NQreiMBRVatPKGZLWrMQTrxypx/9NKefg69M2rlsz6qvt0/638ky4zUp/Rw+m4t8/4J+vOiQZE1zD2tcrKHujYaGhoZGQY0T35STvftIahW/qWblmfH+PNtlbxzSPOH9QCWdc+sCB2c0P4SzVPZmAgvgbAnhvDlH/akrA0px2Z3JdDYtq+c5mIVnbxq997umnX3vrcGcvPZFPWdv7Plr3s/NeyedrP6ylRioojt+anTZG08fNjfu/mjSya7PMgEjfpMCXv0vfKZOlx8bgMZo1y14IwJH9ax+WfGFqusRwoltsYZGAxsHfz2XPba6S+6TOsl6689kNY5I0smF6+w4YAkvetxQlRhrvGvtSDPqRz/60Y9+iuznxD9JOjn5RJsLKm9tVSvPjPfn2SF745DmCe/nzF1y3D3WC6rlnC/v7OCMxoZw+q17M0kFcOYan/2LpJOjft8lAkW67FvbLLk1OwezhOxN4/d+1+yafe+u7oS89mkDnTBoz1/zfm5+alZ/3noM1PLWYrHZGw8vtoRwzsuux5iCEb/JsK/+F/6SVqvc2MDUMtOGNK36TY2CNyJwVMzqZ5ZYqLrSdwBjN6wf/TS2n4P/NZf9fBWX3EMLqm9g3OvYzxGrcuFd9h2wqBf9ZPk3Sau5a1X3RkNDQ0OjnMaJ78jJf2CLQape/aaClWfG+/Mslr1xSLMCOFAN53yq14MzmhbC6Tl7M8kFcOZDOH+bo37HtQLFuOyrCy+5zQ/h7Dx70/S93zW7JZ3s+++Vm5DX7j/gCYP2/A3o5+anZfXnrMpAhdy+Sd2bMTfuvihpZ9eDTMaI32TwV/8Ln6CtMoM3M0k7WWvmkEbFb2oUvNn83j9UwOonJesn40zxbX+eqbbdsIZGwxsHfzfp5LJHVGW9PfS/DYpGjvixXHib3Qcs4EUPKbgSY212rR1pRv3oRz/60U+J/Zz4Nzn5d200qLD11as8M96fZ/HsjUOaJ70fqIZzPtD3wRkNCeEMXPdm8grgzDU++56kk6Ne4KKBwV124dJxx8aGcJbK3kzIHvKaR2ffb1VoTl776AGzN/b8jenn5mck7az+Bys0MH6335msK3Mv1PHQoecQzley6y+bkhG/yYCv/hf+btZ0mcGbuYb4DY3RrlvwZq4B47Z6dTI9iuxNFe8Axm5YP/qZlH4OviuXrRr/knvojcm6+S8OxmvC+znikbnwv2xDYIsXrk9a2dTswxrVvdHQ0NDQGF/jxPck7Zx8rE0HqWj1m0pVnhlvCGfJ7I1Dmie4n7E/DIck57xt8KK19Q7h9J+9UQBnPoTzsRz1G4vOqM/tlnSSdtLZWeNpCukwkS77hz6W3KaFcHrM3kzGHvKaX8q+/zz+CXntrvbq+tkqhPOirP6wdRoYp9v/3zYR5eL3Qure9Nm4+4bsupeJGfGbvk21k9lsKnZetsoM3nTfPIY0qfpNjYI3cw0Yq9WPTNZMzJniO2Rv7H01NCaqcfD6XNYe55J76JeKO2pIoxGNI/53LvyuzQgkyQv/o/sgucGHNfaZvZFm1I9+9KMf/ZTRz4kfy8m/YetBqhi/qU7lmfGGcHrI3jikeaL7gbE6503dCgxjqTwz3hDO8HVvJrUAzlzjs2fnqGdtM50+e2fS3iGetHjjc+/ZksZ52hEuRybCZe8eZMltyM3VnrM3k7OHvGaP7HvTOCfkVzZ1X5eyV9dPt3Hzy7P6fVZrYDxuv3nhNx4L2wt1PHQY5H9+961JJ7s+ygyN+E36e/V/tugQTqvM4I3KG6SJ8ZsaBW9E4Bi31Z2hnm3XO4QTu2H96GcS+zl4NpeNaQN86DkL3J00Xvo54hdy4b/YkjDpXnjLApUYJyWEo+6NhoaGhsbIGyd+Kic/2waEillfmcoz4w3h9J69cUjzRPZz/G4WC8bpnN/ecnDGGCrPjDeEM0T2RgGczY3PnrdtTZshfp7PXZK087R9XZc01mV/MWzcsd43V/vN3kzMHvKavbPvV8czJ79yZ7LOXl0/C/ydm387q99t2QZG7fZLlzhtfNi9kLo3wzXu/s/s+lPmacRv0ser/93ZU1gIZ7rM4I3KGzRMu27BGxE4xmf3+7YqsDYJZ4qre6OhodFtHJJcOvJV99APqXujsWjjiMclnVz4FdsTJtELv5xM7+xty4aHcDpSiPrRj370o5/x9HPiZ3Ly0+1ESLWq31Sh8sx4Qzj9ZG8c0jyh/cD4nPPrBWdv6hTCKbDuzWQXwCm8n8/dkLTztF90gdI0l/1+YUtuLW+u9p+9mahF8pr9s+9Vo56TX/lOsq57N9uHkX52aNz8mqw+3eINjNaaMvdCHQ8dCujn7tuy64+ZqRG/Sa+v/m87jQoI4bTKDN5sfgUZ0qDqNzUK3ojAMSa7//f8PbtJOVO8h+yN3bB+9DNR/RzSyaUbRrTkHnrqEocaGi/9zIdwDsyFV9ikMFle+KmS741WfNeq7o2GhoaGxlgbJ16Yk4+wHyEVit+MvfLMeEM4A2RvHNI8gf3AOJzz1CUOzmh4CKeI7I0COKX287nvJO087cddrDTEZS8pfsmt083VgbM3k7RIXnNo0s6+nxvRnPzKNVtlb3wY6WeRv3Pz67P6bZZwYERu/2h/+6X+9kLq3hTXuPvOpJNdhRQifpMeXv1faBoNFcJplRm8UXmDNDF+U6PgjQgcI7f7LQsUqp6sEE5scDU0NJINOaSTS9eVvuoe+ofdW9J+8xo9NI54Ui78kt0KE+GF7+1uSht/WOPQ2RtpRv3oRz/60U95/Zz4xZz8KzYmVMP6cVeeGW8IZ6DsjUOaJ7EfGLlz9ur14IxmhnDuK2arpgDOCPr53J152kNdstTeZc8qMe5Yg5urQ2RvJnCRvOYZ2ffc0ufkVy5c6N/uw0g/CzVuflNWv9VCDpTu9r8dcL/U016o46FD8f3cvSm7Tpm5Eb/JEq/+Lz6NBgzhTJcZvFF5g4Zp1y14IwLHaO1+2c4KVU9ECCd2w/rRj3629HPIqlx6V4mr7qGv7jV7Y7z0s/kfHXF4LrzInoWGe+Gp3U1p4w9rVPdGQ0NDQ6PyjRMvSzo5+Ql2KGT81W/GWHlmvCGcYbI3DmmetH5gtM55VMHVyWoWwlmetBYqXKMATlX7+dw9SSdP814X9XTZoaMoNVbpm6vDZ28mb5G85rnZ9xMlTsuvfGzhDywfRvpZ7O/c/Oas/lMrOlCi2/9i2P3SzvZCztUtrbHmQVl5v/kb8Zvs7NX/paZR3yGcVpnBm83vIkMaVP2mRsEbEThGaPfP7Cx7MxEhnNjOamhobN845Mdy6W2lrLqHPl/dG40BG0ccnQvPt3OhsV74h0Nlb5qwa+1IIepHP/rRj34q18+Jt+Tk3e1TyJjjN+OqPDPeEM5w2RuHNE9cPzBC5zx0PNmbqoRw5t4CL/tmoGWthH4ueFCO9F4XdXPZHiMtNVbFm6v3FZN1nMBF8prnZd9/KGVafuU9O/3hfRjpZ5HGzX+R1X9kXQdKcfuJhWWVF9gLdTwsKLefNZ2sXG8WR/wmi77639t86iOE0yozeKPyBmli/KZGwRsROEZl97N6yt40OYQTu2H96Ec/C/dzyCOTTtJOOgM2phb8R31mb4yXfrb+R0c8MxeeY/9CA73w1cVkb2q8a1X3RkNDQ0Ojqo0Tv5mTf9FuhfFZP6bKM+MN4dzncGX99NE4fm8rBaNzztSYszdjDuFsm71RAKd2/VzQzpH3uo6pjct+ZtTZm8rdXJ2rNmZxG7Sfa17U38PNqR7/8qzfs34G7Ofmk7P6RKs7ULDbj+/v1cf+9kLO1R1JY82uWXm3uRzxmyz86n8/86mnEM50mcEblTdomHbdgjcicIzE7u8ccAPanBBO7GI1NDQ0NGrWOOLXc+E/2cXQKC98XsHZm/rtWjtSiPrRj370o59K93Piv+Xkn7VnIWOrfjP6yjPj3TrO1b1xuLJ+em/ASJz9w6SVTTNjrTwz3hDOaOreKIBTcj8X7JojvddFHVy269iyN1W5uTq36lrc9KOfZvVz82lZ/fvWeKAwt/9G8dmbLXshDwtG2M+a3ZJOVv67SR3xm2z/6n//E2uJEE6rzODN5peSIQ2qflOj4I0IHOXb/S3DHh5Z+xBO7GL1ox/96Ec/tezniOfnwr+3l6EhXvi00l+prPquVd0bDQ0NDY06NE78j5z803YuZDzxmxFXnhlvCGcue+NwZf309T+H8p39b9scnDGeyjPjDeEskr1RAKeO/VywW4683WVNpV26qXsic63PwSwqe2Nx049+mtXPzX+b1b9jpQcKUlr2Rt2bsTTWPDorv2VaR/wm27z6P+h8WjSE0yozeKPyBmli/KZGwRsROEq2+2uHzd7UPoQTe1YNDQ0NjRo3jnhxLvyQHQ2198L9R3eceUV3rVKI+tGPfvSjn/r0c+L3c/KP278wcuvHs2cbTwinm71xKLJ+ev9fHf8MywSlO/v6hYvWTlAIZ8R1bxTAKb+fC34yR/6Pi5uKuvT2ZE39z8EsLntjcdOPfprXz83vyerjrffAsG4/oLQHzR0PC8bWz5rHZuXXze6I32TLq//DzbAFQjjTZQZvVN6gYdo1C97M/zxQjt1fXPxz65rdAYxdrH70ox/96Kf2/RxxXC48076GGnvhL40ue1PRXau6NxoaGhoadWuc+MOc/DC7GDLq6jfj27ONNISzXfbGocj66fF/BSU7+4sLZ28mKISzVPZGAZy69gOVdOm3tin/OIkhnAWzNxY3/eincf3c/MGsfolVHxjc7Y8tPXvjicC4Gmv2yMqbzPGI3yRJ2sVMrG1COK0ygzeb306GNKj6TY2CN3M/z11GjuLt/swSz4ysxx3A2KpqaGhoaDSlAbX1wp8c55uUldi1dqQQ9aMf/ehHP7Xs58S1OXmFvQwZafxm3HcaRxHC2SF741Bk/fT0lzdaIyjX2Z9aInvT/BDOuOreKICjAA4T6dKvLrz7naAQziLZG4ubfvTTyH5u/mhWv8DaDwzi9p8aXfbGw4Kx9LNm76z8qpke8ZuC83BzIZy5+E1ZwRuVN0gT4zc1Ct7M/SPxGwq1+yHJdInZm3rcAYxdrH70ox/96EcBHBinFy5LWmM+xXz8u1Z1bzQ0NDQ06tw48Uc5+cE2NYzK+krcYCw3hLNY9sahyPpZ6i8ff7w1ghKd/b5eszeNDeH0nL1RAKem/VzwMzny313rVMWln18ied78EM7OszcWN/3op4n93PyxrP4NnwBAf27fpe/vqure1LGx5oCsvNJ8j/hNCTNsuvxIADRGu27BGxE4irb76mTN5J0pvu3PU8j9Ag0NDQ0NjUo1jnh1LnyXnQ61cez6bGpNzGGNvWVvpBD1ox/96Ec/deznxAdy8rStDaMwisoz4w3hLJ69cSiyfpb+y1Cas982+MEZDQnhjL3ujQI4o+kHquHST/Ra9bGxIZylsjcWN/3op6n93Hx2Vj/L5wDQqx/cn02tcvZCHQ8LKtfPmkOz8stmfSY7flPG+76t8rMBkGZVv6lR8EYEjkLt/v+NOntTxTuAsYvVj370ox/9NLOfI16bC99pv0MNHPvf3bOIJuGwRnVvNDQ0NDQa34DRWFdy5ZnxhnCWzN44FFk/i/+d499sgaAsZ/9RAUVr6x3C6T97owCOAjgwsEs/2Gv2prEhnB6zNxY3/einof3cfF5WH+PTAOjN2nL2QureVLWx5qlZ+XnzPpNd/abwidUqPxsAaU78pmbBGxE4irP7yrFlbyp0BzD2oxoaGhoaTW4ccUIuPMWuh0o79utbsjfNP6yxz+yNFKJ+9KMf/ehHARxY1PoyK8+MN4TTQ/bGocj6EYNk9M7+nQKyN/UO4VSn7o0COArgMAEuPW3wR/kNubnac/bG4qYf/TS4n5svzOojfCYAS/jBd7YJLRe2F+p4WFDpftYclZWfNf0zwfGbwm+1TJcfEoCmmGrXLXgjAkdBHv9A9/Nios4UXzx7YxerH/3oRz/6aWo/R/xhLvxLex8q6tgrF8jeTFwIR90bDQ0NDY3GNd7Yykkb7XRI6dVvSqo8M94QTu/ZG4ci62ehv3P831odKMXZLygye1PLEM4Q2RsFcBTAgX5d+uYCjtGs983VfrM3Fjf96KfB/QDs1A9uWLhg4LB7IXVv6tBY84ysPNdFkImM37RLmFit8tMCkOZUv6lZ8EYEjqKsmbwzxdW90dDQ0NCY1MYRb8mFb7H7IZWtAz4RhzUOmr2RQtSPfvSjH/3UtJ83dnLSvfY6pNz4TRmVZ8Ybwukne+NQZP0s/I+gBGf/ainZmzqFcCpY90YBHAVwaK5LX1NA9qbeN1f7z95Y3PSjHwVwgMn0g0sXvUk41F6o4yZ/bfpZ89ys/IRLIRNZ/abwOyyt8tMCkGbFb2oUvBGBowiP/26yfsLOFO8he2MXqx/96Ec/+mlyP1A9x36sj9d3mrlrVfdGQ0NDQ6PRjTeuzElrbHkozfoSKs+MN4QzQPbGocj62fYfHX+epYHinX1I9+yMMVaeGW8Ip4jsjQI4CuBAjy59UZHZm1reXB04e2Nx049+mtvPzZdk9ZN9RADb+8Gne9049bcXUvembo01v5WV/9cFkcmL3xQ+n6bLjw1AY7TrFrwRgWNoj79xgYfTkxXCid2nhoaGhoYCODBmx75nkKNzG7Vr7UgP6kc/+tGPfprfzxsfnpPusPEhZVW/KbbyzHhDOANlbxyKrB9Hb1C2s1ePKHtT3RDOfcVsjRTAUQAHenHpM0rJ3tTp5uoQ2RuLm3700+x+br48qw/yQQFs8YOP9L1x6mkv1HGTv5b9rHlRVn7YZZFJit+0S7jD0io3NjC1zLQhTat+U6PgjQgcw3n8l3Z2MOREhHBi96kf/ehHP/qZ0H6O+Ktc+H/shqiEY08eJHvTqF2rujcaGhoaGhPTeONP5qT/sf0hpcRvCqw8M94QzjDZG4ci62fzP9poXaBgZ/9/o87eVC6EszxplVm4RgGcWvQDo7Sm/udgDvPzDJ+9sbjpRz/N7geg6wd/PfjGaWd7IXVv6txY8/KsfJ+LI5NU/abwadQqM3gzk7STtWYOaVT8pkbBm835Aejf48/ZWfZmIkI4sdfU0NDQ0JjoxhGn5sI32BMxZse+aajsTRN2rR3pQf3oRz/60c+E9QNlWF9c5ZnxhnCGy944FFk/m//k+EutCxTp7JVjy95UJYQz9xZ4XW79WR7L6wdG5dK9+t7iNurm6n3FZBQtbvrRjwI4QISWB9sLddzkr30/a16VlWe4PDIx8ZvC77BMlxm8mWuI39AY7boFb+Ya0L/Hf6i/G3YNDOHE7lM/+tGPfvSjH3sixuzY3y4me1PjXau6NxoaGhoaCuBACqp+U0jlmfGGcO5zmLF+CupH6RsK9akHuid+VmDBHE8IZ9vsjQI4k9zPBbvlyNutCpTu0keNNHtTuZurc9XGLEr60Y9+lmrcfE1W7+tDAybdD15f2MZpy15I3ZumNNa8JitPd5Wk+fGbqXYym03FTqNWmcGbzW8wQxpU/aZGwZu5BvTp8X8z4L6zOSGc2GJqaGz1MP6BZKOGhsaENo54Ry78A5sjxuPY5xecvanfrrUjPagf/XT7WeGjWUNjshpv/Lmc9G27IVJw/Gb4yjPj3TrO1b1xmLF+iujn+H+2KFCoteOuPDPeEE696t4ogKMADvV36W7jyd5U5ebq3KprUdKPfvTTYwOYbD94efEbJw/1mtYPmZDqN7NFh3BaZQZvVN4gTYzf1Ch4IwJH/x7/58narebPBIZwYvepH/1syd5c9YUk2f9loyj+pqGhUc3GER/KhS+2RWLUjj26uylt/GGNi/086t5oaGxubMwZ65J1edUv+GjW0JiYRitvfGJOus6eiOIM/aB9zCGcueyNw4z1U1Q/UJxP/fuWiOMkhnAWyd4ogDPR/UCZLn3QsI/y631zdevsjUVJP/rRjwI4wE794DdKCC2re6MADqlp/KY76oWFcKbLDN6ovEHDtOsWvBGBo0+Pf11hN+zqGsKJnaWGxvw7jlf9y5bF4ar3J8n+f9LTR89UQR9q+tGPfqrST8sWiVE79sDSszdV37VKC+tHP3ON5Xn3w7YsDmf8S5K86smD3sBsF3QCkX70o5/R9GMXSoquflPEnm08IZxu9sZhxvoppJ/j77QiUJhP3bRAebEJCuHUtO6NAjhl9wNl2rS25udgFpe9sSjpRz/66bFx8w1ZvZcPEJg4PziihNByx0O9Zvaz5vVZ+TYXTRodv9khxVtACKdVZvBm86vMkAZVv6lR8EYEjn48/mXF7ztrFsKJ3ad+Jr6fjblq7pWUdQusElf92Xxj/w84kllDY7IaR3wmFz7dXokROfZxo8veVHTXqu6NhsbGvHvxIwnPuCRJXvUSn9EaGs1vvPHwnHSRzREpLH5T3J5tpCGc7bI3DjPWz9D9jP1xN43xqS/vbHVtfghnqeyNAjiTu8xOWR4oy5f/Zz5VXtdzMAvP3liU9KMf/fTWuPnWrH68jxGYID/Yt8TsjWd5jWys+T9Z+VcunTS6+s1Cwz9UCKdVZvBG5Q3SxPhNjYI3InD0pbRC1fW4AxgbSo3JayxPNiYbkwdy9c/3sVpc9dL5xv5XKxWiH/1MSj9HXJkLD7BbYoSb0sYf1rjT7I20sH4mq5+NyQPz+9J3H9vrUnHGB7e0X3WqUiH60U9j+3nj83LSP9geUYT1xW/eRhHC2SF74zBj/Qx/+A4U4lPn9ZRsbGwIp+51bxTAKbUfKMeXv7l9RccJCuEskr2xKOlHP/rpowF4B7LQ7I2Hg83rZ82bs/JPXTxpbvxm8eEfMIQzXWbwRuUNGqZdt+CNCBw9e/yR29+wm6wQTkrbpW31Jtnmxk0vXnQg9mwlrWQ60Si5ce0iBV4ywOGpjeynN1ftt9CfrknWzDcPeIpjmzXG0PjCxm3m4dae8nt+P4M2pm2XGIVjH1rwweQ127V2SqwlsuO+9EPvXnQgXnztNhunqVbSLmADpp8dG+/dfYff/r3JHUVcTk3tZyFnvGGC9+079PN7L0vus3UZUePtH1x0ZF53pd9PYbvQN/52Tnq3XRJFLJjl7OJKDeG89gWL/xfdk9xTxG9GP332c8av1vu+6CsfbDmgIGvGWnlmvCGcnrM3gxSu2eH7+zMevP1d9zmf/vUilgVPi8poQAm+fM2ihxY1P4Sz8+zNAAUxdrhNetBDu7/ou5O7t/nNX/Esi5vGGBpP+J9FV4Pr/8jvZ8DGzd/J6kf5PIGJ8IP/VfSdQHVvJqdBmhq/6eELQ98hnFaZwZvN7zRDGlT9pkbBGxE4evP4/UZ3yngF7wAWUuh2u1oiN9044FjcuPgr40n2fJ33bwpr7LMq197h6i/dlV9Y+M8P+DslR/QzbD9f/M1B5uQX/nrhP3/KZX7PSzeO+EYufIyFjRIdO9Xf6ztN27V2ijvLp/vk+MOLvKOzpA/tk5284v+SA+0nC2u84l/z3p939VOY33tdsr6/audKsuy88Y65G2sbkjv7G4u3L1g2cENe/wi/5/77kQMnBcVvytzOlRXCoWLOeEGyseYbUSjCp84YpKpYQ0I4Bda92RywOXGQUfjVf1riL3z6qzu9KzjM8+5OQQdWNrUfyBgKhjc2hLNU9mbpghjdx/cHDbTYHnj2An94xT9YJPVTQD9PfOoi0+5HO5uTT/iLBf7w+pv8np0zCMz7QXt02ZvxF3jZ2N0sCVsW1Fjz1qx8k8soDa1+09vV1UcIp1Vm8EblDdLE+E2NgjeeplDQDbsmh3BSwKuNNz8iOxb9KMONb9/+T/a8wKv5g/ezzy/k2n9x/Y/Hla/c0j7geq/eavSWtzmpxDn5hYO3tJ9yn1+4jSXjsWnNVh/WkxbC6RTwys6Hnz6ikfrgFdv/yUv+1CvjQyRwfpj3PswCQEHmPqwf6E4wW5c+G+84tPQhetu2X0Jf/xK/+Z4ab/zDnPSXrnCGs34Ue8jiQzhUTbvvz9lKbV9fuYshpACfOnmoRbXeIZz+szfbFMBZnmzMMz4/opH61b23+X8/s8u2y4KtZnmNH1knKNiXP9FrmLxpIZweszfbFcDZmDyQg8pcbA983jb/7xXfsgBqLN144ptLnJNP2GOb//eGB/uFL9y4+e6s3tWnCjTZbfdnU6vQvVCV695szMP3zo4Zzh86Amy4fta8Oyt/28WUJsZv+rnMegrhTJcZvFF5g+Y9WalX8EYEjh48/pGln/5Y3TuAGSJyc1glhu/GI7e09/yeOyZ9H3Cyzy/n2q9YBsbsyidsaR9wn/yYfrb5R1/85Bjm5BeWd1v35amrjNc2jSN+mAu9I045XvAfW17faexhjX1mb5ZIic9Fbv64EsP3wa2eHb7kXFvNPhutvOKBvNfZewzt907ean3o7aU6z1Eyk3e8Ypyj9rYPbmm//nTjJQdOyq1+M6o9ZJEhHFK9M9o21vnldRjap97UPdBtLJVnxhvCGbjuzcY84/bxj93T70mypajjZ57sFPzS+hG/oVBf/mDfj/IbcnO15+zNfOOBZGMO+vcxjNGBj+4+8XxwMXs2i22T+nnie8YwJ/f6UfKj5M7csJfx2r5xy4Oy+/0+W6CZbrt9/utqYXuhTpmFa4bsZ2MevkgVtYd9c0v7h7/hOewgjTX/lJW/7pJKs+I37UEuziVCOK0ygzdu5tLI6jc1Ct6IwLGUx68cW/Zm/HcA088udi5y84ZKj+aNP9G9n/Jwr/j33I/XHCvmyuXzhaQOXOV73eQ2vnhzhebk578933jqkUZnvnFkcoHViqK94OsLHJ07KSGcTv9Vbj5Z6dH84DPmGy/5V6+M99xPyzLAsH7vA903y+e+wDrWeqeNd5xSxUF822vmG6//rGFaoPHG03PSa1zrZKj4zWj3kMWEcKiSM/4qWd/f52zVtp1QgCKyN7UM4fSbvdmYbMwzK3yKzdMvmW985nhbTY/mqa4vn5asqe05mMP8PL1nbzbm4Idm83Hv43XAXObhnlz5eEviZBe6uaQqa8heN8w3bvgNo7PlMKyI30AT3fat7tfVovZCVa57M5uHP7enX8vDPral/cO3OrKtj+O8SQOr3wx6vS0awmmVGbxxM5c0MX5To+CNCBw79bgHujXQJuFM8YHr3mzMzWfWbGRvuKN7P2U/91CWbuxzZK71Inn1XPH/kuTAQ+THJqufL/6/6s7Jz1+QJE99pfFKWslGqxRFesGVO3t9p+EhnE7PZx0tz4dvrtnIfvDn5xsvnbLnXLpxXCdn3mk9YEC/96lk3Va3jh/YYaZ5jjJX6Obv6zGgbztqvvH6r3vutW0C56ycdKwrnkGtH88ectgQDpUyNyK9fc5WsPHKBxtChvWpF5RSTKwGIZzeszcbkwfyzH3rNKxP757K/5nTVS0oqB8o0JranoM5zM/TS/ZmYw6u8GJ7wK3zjSuPsUhOUD9P/GZ15+Re3devbzjReOWWh2X3//EBA41y21e3z94MuxfqlFm4Zuh+Hn7cIL+lh71pS/uHn/ZkdonGms9n5VNdW2lW/Ga4q3SBEM50mcEbx3vQMO2aBW/mfx5Y/IbdpJwp3kP2Zvtd7Mbc/KXaj/ANV3fvp7zQK/4762ef5+fav7ciVNEVlybJgb/pC17DG1/cmKxJ1tRgTn7+75LkqX8+6QN35KpccIcliozy6Nxm7lo7PUXBP3xvcm9S54vuA5uSDcmGvPQRSt/srJ/jfi5nftuKwEC2exq0caEpN8Fbl3dcUteBfdtj5xuvn/WtoZsDhwxR/WZ8e8jBQzhU7QlRP5+zSt/QMJ/61XLX0uqGcHrM3mzMM19Q7yF+erfS4Gc+Z/NpvaUSvvz7hWXI63RzdefZm+U5uFaL7QHnJcmV6ow1uvHEe5J7ajMn9zo5SW443f0lIA181lzUXqjidW9OKOAX9rBfTZIf3qz0zU4TOF/Nyr1dXWlK/KZdzBW4TQinVWbwZvNbzpAGVb+pUfBm7ue5y8ixgMd9d8sNu8kK4WSnH5TLk425+V+aNtw3fKR7P+VP3AVbuMTwPq/Ote+yMFTUFf+YJAe+Tn6saf1c8hN1nZOf/+MkeeoHJnvcoSAv+Fgfr+80atfaWfq43I88rGnD/YHuNvulh9uFLvzY77gn5szrLAz05/cuS2Z3WENmlngzeEKeo7zjhoaM8ttmkuQNqzz3yhs/m5OOct2TAeM3495DDhLCoWpPiHr7nFX6hub51CFLv8/UzBDOfUsdP7wxz/yzpg3305823/jMP6t+MFA/UIQvv7z4+o01uLm6k+zNxhx8Yl1H84D3JMmVf2qRbFo/ez+ornNyr9ckyQ2fmNxxv+Xx2f1WHzXQELed3et9v572Qp1yC9cM2c/D/6rIX93DVs83frjGs9pFEjjfycpHucjSlOo3xcXg5kI4c/GbsoI3jvegkfGbGgVv5v6R+A07eNwtC9ywm4gQTnb2jOTm1Kb8wsBu+LMk2esDogILJHCouCveniQHvsMXvCY0LnlME+bk51+aJE+9YEKH8sjH5IJvWJkY1gveO8jRuU3YtXZ2dlzuR/Zt/tB/4KIkeelxSt/s0I9NKX36vW8m63ZYTB5YfO5NxkblHbc1c7hPvS1J3rDXxH+hgMGsr8TWse8QDpVxxrn9fc4qfUMm7CzhZoZwlietbNqQqc4i5W7e1/Bhf/ovJcln7nZb2+m0VLRgeNNCOItlbzbm4NObMKQHvDlJrnyf1bIJjb13a8Kc3Ou5SXLDVe4vATV22wf7PnNnZ3uhate9ycayfo0PWznfuNMRYF4mTIPjN4Vfk9P2K5A+KlDVK3jjsQoLedxlO7th1+QQThZ9x/GW/zVZc+CGlybJXhe4QbZNY58/ybV/ZoWouiv+IEkOPEt+rK79XLJf0+bk549MkqdeP5HjDsN5walDvb5T411rZ9EyjB959mTNgQ+cmSQv/VPb0W0axx2eMy+yQtCT3/t+sm6hVWXjTmdao/Ns79iUbGj4uJ96Q5K84ejJfe71xmtz0j4WAPo2SOWZKoRwSJVOZ+vtc9a7ZTTPpx41nhpiYw7hzL0Fvsj392d+boImwNN3TZLzHqr6Qc/9wNC+/LRBDi2q983V+xbKOi7PwZ9o2uAe8PJcea5SMzXuZ+9HN21O7rV/bvjWJI77LU/O7pf4wIF6u+2vB/+uusBeqFNu4Zph+9mYh7+n9F/pQ7+fJHc+wUPbLY01a7Jypast9Y/ftEsIxrUc7wF9Vr+pUfDGYxUy4GE5DQzhZOFnJLdM8BsbNxyZJHvdIiqwVQLnnbn2tdaIGrji2CQ58Iu+6dWq4s2RTZ6Tn39Ckjz1e5M1pkcekgsutSAx5qNz67drXeSG6Ud+d3InwgfenCQvfa/SN1slcJ6XM//BGkEPZhZdVZaYhE3cn5zWnqzBP/X8JHnDcRP6FeON/5aTftYSQJ/W9V95pgohHFKl09l6/pyt2rbzldPGj8F9arfxZG/GHMLZNnuzpQDOxjzz5gmdCcfcmSTnPd6NbolHSvfl/UdXc6wqN1fnqo3NZmqrHdfBVzV2iA94RpJc+VXLZt0q3uzd2Dm516OT5IZ7FawD6uS2P0vWFLcXqnjdmw15+MdG97t96PVJcucxE1/6pttYO50VD7jmUv/qN4VfnK3y9yuQ5sRvaha88YWBHTzuH/s4LKc5IZws8DbSLc80HZLkht27d1XWunemamTNXPErSXLgN+THqt7PJb85KXPy8z+RJIe1JmncYVAv+P0iX9+pza51oQoVH3mr6ZAkH3jFfOOlF3uUm3g/kh783gOL3/J9YKcPGwpK4FTn+cdp/2typ8GpZ+YNfziRz718eWcA6/uvPFOFEA7VcMa3knVLf85WN+kKw1hTie/aIw3h7Fj3ZnmeeW9yb3L7pE+HY26db5x3jCoKi/cDGf+hRXW6uTq36s6tt3PBm3+fiHE+YO8kufJ/lJqpQT97P3Ui5uReD0mSGyep3t0tv5HdP+ZTB2rptj8o8rtq6YVrhu7n4VeO4Zf80POS5M7jvUyYzCQ/ctml/vGbwoNx0+7qQq+m2nUL3ngtkm097u8GuWFX+xBOtn/H8ZZXmQsLuGFFkjxh5aRHBfY5K9ceazrUyRWPyYE/9J5udRuXTN4FdfHGHNaelFE+8jm54JPWIfr2gpeU8vpO1Xetne3f3fnIR8yFBXzgsCR56dcnt/TNXOO4V+fMd5kO7PQmVWf+McwCt3w3Lh68aTeqBs5pjzURcupfJskbzpi47xpvvDsn7Wr8SX/Vb/qtPFOFEA4VsXXFuY1L7fEqmHSFQX1yfTaNvvLMeEM4O2RvnvVTJsICjjkv573EPXCP5inel39mbDXHxnNzdevszfIcfH9y52SN+AE/mSRX3m/9rGrFm+dO3Cq0551JcuMv+tQGMinnRFS/7s3Xx/mbfuh7kuTOP5vc0jdz/axdlRXfd+GlzvGbdglXaUupPkgfEbh6BW9E4Ehhh+XUNYSTbT77bvlLk2AJ16/JEx4x6XfT9vlsrj3KXKiTKx6WAx9QaqZy/Vzyu5M7Jy/+Xg57zMSMO1Ts6NyK7lq3zd585CqTYAkfeGxe+oNJf7h73J/kzD8zF1jYa35yflVZOISzcangzdBvBo/9+cdpB5gF2zj1VUnyho9P1nMvSL/xm34rz1QhhEMq82xokc/Z6iddj7/f+DGgT35/vnTYSCvPjDeEs132ZmOe9bMmwqKO+WCSnHeiKgrul9KommMjvbm6bfbmkIdM7rAf8KBctYtSM5XrZ+/nTe6c3PObuXHfiRj3W34nu/+tzx6omdueu02Z60KyN5UtgPPw/67E7/yhf5I73z3pLxOufWxWfN31lzpXvyk8IdcSFIY+4zc1Ct6IwLGVx/1JAYfl1CyEk23OF7/F6dG9uf7bSfKE/SY4cjBtFtTPFdNJcpDTmCpS8eaPTclc/I0kOeyQ5g/3ka/MBX9nwOnDCw4v7pZoXXat276r95HrzIKefOARSfKyqUksfTPfaJkFLOw1q7s1HGYXCeE80EPwps41cE471CxY2Km/ljd8eYK+fbxpWd66wbDTs/X9V56pQgiHitj6eMQHegjeVCrpChnuQLdRVp4Zbwhn6+zNxjzrIDOgJ8ecnCTnne6uePfFGMXrGMKXHzSKG6dVubm6OXuzMYf8osHP/vfkqkdYSKvS2Pu3TcnseU1uPGZiPr6B+rjtqcVnbypb9ybLK/Sbf+hvJ8mdn57E0jdeJkxD4jeFX6XTtimQPh6x1Ct4IwJHSjkspx4hnGx5x/GWcwx/366/Ok/41Um9rdbKPl/KtU8yC+rn8jty0Cola8bczyXO6d/KxZfmsF+dgHGHDP76TvNDON134qdW5CP/k/yPGdCf92/KyzqT+rh3OsednDNPNAvYwSKPhbaEcDb2FrwZ9M3gMT7/OO0Zhn8Jpx6aN9w0Sc+9xG9IP9Vv+q08U4UQzoON3Pi9e1nSyabZLS/l9xS8qU7SVfUbBvLJ6xdeORsbwtkue3OUKdCfY16T8/5hgqsopLsvVbyOIXzpnmxq1eoczOGzNxtzyJON/Bb7fydX7aVkzZj72ftNZuIWe56XG1/Q/HG/5U+z+5uNNtTDbfuWmL2pWgGcPJCH/7ByQ/DQX02SO6+a0Izu2oOy4nIXYuoZv2mXkJBrlTvnnKtEmlf9pkbBGxE4uh734uIPy6l0CCfzn3S3fMXgD+76TyfJE145MZGD6eSB5L7uQ3Tq6fJv56D9HMs0nsYlf20CLuDiT+ewlzV8Ahz5J7lA7IrevOCXenrxsTm71u7d1bMchzOE99+WJC/ba2JK37SSjcl9yQMOzWUBr3lKMruzW75TnWRj/yfIVL/izYsMfq9O3SNJ3vDfE/E15E2r8tb/Muak1/hNv5VnqhDCIdV4MDSbqXYyOx9z7TV4U4Gk6/GyNwzkk1/snp0xssoz4w3hbM7eLM+zjjf+AzrmeUly3pcn6a54ktmF7nRBhjq0qB7nYBaSvXHExg72vyFJrjrCk8fxNPaWwdjBnh9Nkht/v+kTAKiD236xuEMe61D35uEPVHcsHrp/7vzWhJW+2ZzAeUZWnOtyTD2r3xR+ubbKDN7M3Xpea+aQRsVvahS88T2BJMnjnlNioeoK3gGcas+fT3bLvxj8Alz/d0nyhD9p7s2U7V5w7E6nfc7Jtc80/rV0+dU56Egla0bdzyV/Z+ot6uL357DXNX3+QA9e8MgxZG/GuWvtzN8ePethBr8A778hSV52eJMLMM5vSjduM52Oe1POfKvxZ95rnpes6+lQtEEmYYWff5z2CoPft1P/V94wOxnPvaBH6/uvPFOFEA6pxoOh7ufsVLv7OVuXpKv4DRniFfCRVZ4Zbwinm7151tsMfAGOOTRJzvvnRldRyHzqZtF7TdC/L31z+xunjQ3hLE9aOeR3jPnO7H9hrvoNJWtG2s/ep5l3O7PnabnxT5s8f255d3b/beMMlXbbj48ie1OdAji7raz6iDz00Uly55rJS+22XI6pbfym8KjcdJnBm7mG+A2N0a5b8MbbkGSbw3Kaeab4Ds+kN83m1plknYEv0vV/lif8TbNeGV/kBcetG/t8PNf+msGvpcsvyEG/6aCm0TUueb9Jt4SL357D/rzJM+HIv8kFv2ucKeb1nYbsWjvJhpy1r1Ev2Psvysue36yjkrYrwLjQdDrudTnz7QafJN2bRUve8t046ESt3k7jtDcY9cGdOpMTOs3/PvKmvfLWG4w26an6Tf/7uvGHcBi3d+/VnTyj+pwteNt5rzGkb5/8aB8Vw2ofwulWYHiWst6FOuaXct7/NPFc/A1JerjXBMXdOG1aCGd5siyH/JHxXtr+H8tVx3sEOaLG3n9rxi1tzzfnxtObXtQOqKrbHjxJdW9mstujajM0D12Zux5cXOigJkeJrX15VrzPdZmaxW+2VDYv8HJtlRm82XwnAtKg6jc1Ct4s8yWBPG6/0Z0yPv47gEmW51bTvhzX/26ecFb9b5308ILjNg1q6/J/TJKDfk/JmnL7ueST5lqvLv7jJDns75o7f2CnXjDV3+s79d61dpKNOetgw16K9/99XvbqxhZg3Nk3HSbea16XrO/tlu/GIeZnlZ5/nPZ/DPuwTlmXrMsJq5r+3AvSW/xm0A3eOEM4pBrZ15F8zhbeOH6N8WMga0ZYeWa8IZzN2ZsPGvXiHfOTOe/+RlRRyHytmz7uNUGfvnTJEpvVhoRw5rI3JxvwXu3/nlz1R0rWlN7P3u8x13q152ty4z80dv7c8ons/lyDDBW1aW1Be6HOKArXDNnPbnvVbHRW/Sj5Ue5aNUnxXQVwUtPqN7NFh3BaZQZvPP0iTYzf1Ch44x4fGcMp42O7A5hkeW59mCEv0fXHJskTLqjhK+P9vuC4uQDOe3PtK4x8jV3+1znoTxzdVFbjkk+bYn27+JU57B+bOSWO/HguUDGMndwYXbPVZ3SzQzhz2ZujjHmJ3v+uJHnZn9bvlfFeCjAuXADnZTlTrTmWdV8CXvKW7wPDTdRqbDBOe7MhL8wp38kJezX5i8mbnpa3fs44s5T1w+70xhPCIanCk9mRfc4qfcPYffLkoRbMOoVwlietPOvzxrxExzwoSc6v6VYz3dRN//eaxv5WEWlo7rHeIZzlOeRsI923/f8iV73NQ8myGnt/zBTr257Py42fa+7cACrp+7fNh+GH3QvVou7Nk+s6TKv+M3c9YSJK38w11p6YFVLlqV38pnu9FRbCmS4zeGN3QsO06xa8EYGbeI975NhOGR/1HcDk1gMM+Ihcf2SecH1NbpQM+oLj1o19zsi1rzLsNXb5n+WgdypZU3w/l1xgcg3o4t/MYRc3cf445IPFPf8/try+05DDGhfP3px1vAEfkfe/OS87o34FGAeecse9MGd+xLBPrtec3M8t341DT92xPrc47TQDXrxTbsgJT27uc69pI0x6qn5TxJZv1CEcxurdv75Q6blyPmdLaUCfPvmm7oFuI6g8M94QzvJkJs/6qjEfhaPvzPk/Vp9T8JNsSKJ4HaPzpY/2l3us5c3V5TnkEkM9oP1fn6s+mEwrWVNwP3vLgw1qz6flxmuSVhPnD1A93/+X7e/pDbgX6oyicM2w/Wys92Ctuj53/coE5XjXnpIVJ7hGU5/4TXv7C6+AEE6rzOCN3QlpYvWbGgVvROAm2+NWji17M+o7gK3c+iQDPlLXPyFP+LcKvzI+ly6+r/s43LsOE+/y1+agDznMqcjGJV8wrYZy8WE57Nomzg1YyPO/vsAj5GaGcFbkrBMN+Ei9/1V52f+t8CvjixdgHHDKMale84HuE6Yeb/luLOJjfUzbidPeZcDLcsolOeFZjf2G8qYX5q0yimSp+E1xe8jRhXBI9UrPlfY5W+z29fjbjR/9KyJ7U4MQzlz25l+M9+gc/c2cv2/l72rOFhbWhRGsvXW6ubo8h9xgmIey/0ty1dk7S+Bo9NvY+zzTaih77psbv7l9AqcBjVuuyu77G16okO9/ddEten97oTrUvcnG7Pbc2g/Zqi8myV2/0fDSNw4FS12r3yx0BQ4VwmmVGbzxDhZpYvymRsEb9/iiUHUTzxTfMXvzdIM9Btf/bJI8YW2Vbot0X3AsfMrt81e59v8Y83q7/MU56Bwla4rp55JLTagCXLxPDvvXps2fI6/MBYrRkT4eITcqhLMiZ/2lwR6D9/9Wkrzs4loWYOx3yh33qznz08Z8IvX7fOiBgibzyJ9bnHamwS7XKWfnhJc09LmXSowsaX3xe8hRhHBItU5FLOlz1oMhquCTLywue1DlEM59efaDk3sN+KgdfU2SnH9MxU7BTzd1o3gdY/Klk4dae2twc3V5DvmOcS7A/s/KVZcskMBR+maAfva+0IQqwJ6/mBu/P5/AadT8ASrj+5/vPmIeci/UGUnhmqH72e3lzRm7VR/LXcdPRKB37Qez4iUu1tQnfrP4FThgCGe6zODNMlsT0rRnLfUK3vh6MMEeuzabWk08U3zH7M2xRnucrl+RJ7bG/cr4Ii84FjzlaICV3RvTjncatHHJzaZRoVYMVYy0ig0nfLCD51+89CPkJoRwVuQs5RrG6v2H5WXXjvuV8enkgUEKMPY35Zg8r7kwWdf3MWmFfb6PcDtx2geN9iic8sGc8PvN/M7yptflrW83wmRn1W/K2UOWG8Ih1TsVsZzP2eK3r5CBzs4ou/LMeL/yL8+zdzXS43T0eTn/BRXYPSbZkETxOhqy9lb35monh9xpjAuz/5Nz1Vc9rxy2sfclplJh9vzx3Hhv0ybJLd/J7o8ytjB+3/9EH9ukne2FalH3Zja7ndC0EVz1ntx1YqNL3zgULLWL37SXvhT7DuG0ygzebL5/AWlQ9ZsaBW9E4Nyta9iZ4jtmb37XSI/fdRvzxLHcBOntBceiptw+J+TaU4x2vV3+Kzno+u0TOErf9N7PJd8wiQp28U/ksPuSVrPmDwz6CLnGu9YVOevvjfT4vX+fvOxfx1mAMQ+MYsodd0jOVIZu0swscSTTAo2Nhc7zkTy3OM1COkKnnJYT/rSJz7086yJLxW/K3EOWFcIh1TsVsejP2TL2qMf/j8GjP598aunr5PhDOMvz7J8x1ON39Edz/u+M6RT8dGvdlD3foDdfek2Ra2/lbq7O5tAHGeSC7b93rvqW0jeD97P35SZRwfZ8SG56cDFfYaoyf5wzCKlrRHmBvVBnRIVrhuxnt79q5hiuOjl3va35yd6152XFMa7Y1KT6TW/XbR8hnFaZwRuVN0gT4zc1Ct64xzepHvuN7W8fNzCE08qtf2yoq+K6O/LEVaN61XugFxyLuQSov8ufkIP+TQ2cQRqXfNv0KcXFy3P48mR5c2bLkf+WC37WwDLv+R/u+xFy/XatK3LW+Ya6Kt7/83nZD0b1qvciBRhH8UWJSfKaW5L1/T/XeaDoD/qSdxGn/ZOhHrVT3pwTTm/ilxfYifWj2EMWH8JhfN79ttF9zip9w/itGd137fGEcJbn2XsY5qo4+m9z/p+OdIu4aXa095pgfGtvVW6udmRvyrL/o3PV7R5cDtLY+xrTpxR7/Cg3rWrWbAHG7funDR5R3roKXz3q3pzR5KFc9frc9b7mlr5xKFhqF7/p5+LsKYQzXWbwxkMvGqZdt+CNCFykwJsZwrn1Q8a4cq77dp64X8lr2tAvOA55CexzXK4901DX3uU/m4N+0N3rKn3TWz+X/D8Tp0QX3ZfDf6xZ8wcy7CPkuuxaz7I8Vs/7H5GXT5X8FbuHAoylflE6bnXOvNlQT4xl3QI4fT2z2VjYhJ8qLoGz4HOL0y4yxmNzymtywoeb9tzrTafmrW8wtmTR6jej2kMWGcIhY30eVPLnbIlJV+jHJ39pRBnFsYVwOnn2oca5Wo5+c84/veTT65NsSDKOe03Qgy89t8S1d8w3Vzs5dDcjXKYVSUvpm/762fsG86b0OdmY+XPLj7L7gw0qjM3331xAecCRFa4Ztp+NzR/QVS/PXZ9oeMR37Vey4pddu6l8/KY9yAW8RAinVWbwZvOtDUiDqt/UKHjjQctEeuwXl9iJ1j2Ec+s5Brmirrs6TzyytFe9N/RX7qasS4BGuPwROWjuuLvlDnxaunHJ90yZ0l10Ww7/heZMmyPX54K2USXP/6thHyFXfNd61hqDXFHv25SXd0p71Xs2ua8CX5SYDK/5Yfdl8X4f52wsLnjTLvHN4NMuMchjdsqLcsK5jfsWA1k8fjPaPWQxIRwy1udBpX3Olp50hfR/oNs4vmuPIoTTybOfaoyr6OjX5PwPl3Mq5eyisdsR3WuCaqy947m52smhjza65dr/wbn6IdV4E6kmjb1vNWvKtce3ctPewyZwKtRQxwDG5/t/UMQdvJrUvcnG7PaxiRjWVc/NXZ9vaOmbuca0azc1qX4z6OW6aAinVWbwZvM9DkiD4jc1Ct64xxenjDcthHPrlwxwpV13QZ74myUsZbPbPtse303nfX491/6TcW6Cy2dycKeY9xuaXfrmkjtMlhG56F9y+C83Zf64v0CKfIRczV3rR83zanvfnXn5o0r4ir2huykd9xel4/6/nKn40iQY+EHRA0UHb4Z+M3jH5xanXWGAU60DShvz3AsWs348e8hhQzhkrM+DSvicHUHS9fhvGTz68MmVI60PNuoQTifPfq5Brq6jX5Tzzy3o9Pp0UzdVuNcES/nS/qNbe0d8c/VQ1cZGYr97c/VPLvB1XumbHfvZ+5vmyyjs8dXc9NQBEzhVnD/AOHz/pb2+8dhL9qbqBXA2ZrcLJ2hwVz01d321yVnftd/Jike5iFP5+M1wV/ICIZzpMoM3m292QDO0axa8mf95mCSPPau/Z8n1CuHceqMRroHr/jFPfGWhr3rPlvim4yCXAGnie2aOgPLuWlXffXToODX1/FcX/Ai5UrvWjz7MCNfA+76Tl+9V6Kves1u9cFmFL0o03Wsfkk0Dn8S0sYTgTaFvBp/2FSNcFaf8Sk64vkG70Jm86f/mrb9lYMnC1W/Gt4ccPIRDxvo8qNDP2dElXSH9n51Rge/axYdwOnn2yw1w1R39jJz/5eFuQm5IUrF7TVC9tXc0N1cPfYahHZ39/idX/6KnnEs09v6OmTI6e3w+Nz2r+8uv+fy5tZ3H32lIYaS+/+wiszdVr3uzIbtdM3FDvGrv3PWtJpa+mVE5LTWJ37SLuYC3CeG0ygzeuM9Lmlj9pkbBm7mf5y4j55TxJoRwbv2u0a2N6/4uT3xjoUeMl/ymY1+XwD6H59qLDHITXPa9HPyYYRM4St9QoIu+kMOfM8i7jxWcP09blc/ZgtqU1v+wxoWzNz9rdGvjfTfk5U8u6Lv27Fb70o2V+KJ03MqcucYgN9rM/Flom2b7vwm8sZzgzaBvBm/33OK0G4xutZzyhJzwr8167gVZJH4z7jufg4RwGJN3X7nVPcmhP2dHnXSFnn3inmyaLq3yzHhDOJ08+/VGuB6OPjRJzv/nfk6vT7fWTTXvNcFOfelnxrY1LfXm6qEvMrajtt83c/W+g+8hG1/6Zu//NEdGbY+zc9NL+kvgVHceAiNWQvamsgVwdvvvCR3kVY/OXbc3NvS79p6s2MWVnGpXvykuRTcXwpl/u6vtzGzoOX5To+DN3D/y7uPEeOxJQ91rrnQIh7q57qQ88a+GftV7dqRvOvZxCdAUl30jB//yVjemnQW1VeMSb/SOw0WfzOEvbsREcrzHZHv+s8p9hDzOXWvH8NbM+y7Jy3916Fe9N2y7L91YmS9KNNdrfy5ZP38Xd5AQzgOlBW8KeTOY6jnl53PCD5rzdeZNX8xbf8WosoP1lbjh2XcIh1TvgewDpQVvCkq6Qvp/w6n4yjPjDuE8+zSjmwYWBk83dVPxe02QpWLhrcqdgzls9uY1xrUCi6eHm1s19v6+yTEmK5PpRtTAAUbo+3sPfeOuRnVv1k/0WK/aLXfd37jSN96QSV3iN4Vf0tPlb0qgMdp1C974VpDJe4o83YQzxbf7eabauXWD0a2f6/5PnnhGQUeMj/BNx14ugX1+Odd+xQg39Ma00jczmZrJJRvNjGrcmK71PCQeIdf4sMbFsjcf/UWjWz/v+3Re/sIhFrfZHfalD1Tli9IrZvLeaSPcUMvmC+BsvovbXwhnY5nBmz7fDFb6pl670IY89/Kgi4UMUnmmCiEcUr0HshvLDN4MnXQ9/maDRwaOJjYmhPPsfzK09XP0T+X8e5LWQqfXJ9nQzd7U4l4TpIey4ZU6B3PI7M2bDerY7Pf5XP2sQfaQzS59s/edpsbY7HF6bvqjrcaltvPw1j3y+JuMJ4zC9x9dYvamagVwdrvfgGfVg3L3Lg2NAZMqx2/aJeTqWuVPLEizqt/UKHhjZY9SjPUP4SS3Gtnauu5VeeL/HehV7w1jftNx6UuAprjsCzn4mdvemJ74Q6Fkb8bror/O4X/YiBlFPEKu62GNi2Zv9jW0dfW+j+TlvzfQq96zC+xLN22s0GkFNNJrD+kWtt3hdm6vIZyNJQdvBn0z+LSvGd7qOuXBOfEhRcwKZ5SSCkfEl9UwhEOq90B2Y8nBm+GSrtC7T1zf3XYua1QI59kXGdu6OnqXfPZB2y50GxeepVW/1wSLu+RH2dSq1jmYJnwadqab0je2xKnM2Ze1roHj3CsYie/vNkF1b7LcgM/b9Z7c/VPNKn0zk6lluWeX7HKP4U2Fq98Ufm23POuCPq7BmgVv3PKYJI992dBb0gqGcJKv/S9jW2/X/Vae+Nmhjxif3fbZdhVuOtPsG9MTXPrmS24mVvDGdD3n4dP2zOduNJaT6PmPq+eLEUtmb44wtvX2vr/Oy/+kz8Vtx+DNXGNdtU4roIGWemK0dAjngfKDN7291bH1c4vT/sXQVt3J9+bEH6t/6ZtlyUze9M28Vc06smiFhzqFcEj1Hsg+UH7wZpi3JyF9np1RdOWZ8YZwnq1qfc0ddX8+u6p7a3Rjcl/31n29Mgmw1NpboTtLQ0745ND3GNQx2+/Dufp3+ttDKn1DqfY4MTe9e9sBquk8BEr2/QePIntTlQI4y/OIlcZ8i13/M3c/tokxYFLl+E3hubppsXLo1VS7bsEbETinjNc6hJN87bHGtQmuOypPvLLnV71nFyl9Mxe/qcxN530emWv/y9g2xGUfycGv3uHG9MQeCkUFXPTGHH5G/WdUy0h6facpIZxOPvobxrUJ3vdnefk7en7Ve8HgzfptSjJW4VWJV/xH3vvTxjYT9L5vjyGcjSMJ3vTzZvBp3zGu9XDybTnxFxrxvcaxAmSh6jf9Vp6pQgiHcfi7qWzayQPZjSMJ3vSfdPU8iL584rz5smDFVp4Zbwjn2fLejXDU7fnso5IHkvuS2aRVw0wCLFWSsTp3loac8Id+zIimome6TepTzr0dOV+1OVnrGjhAmb53bza1htsL1ajuzUwe8f8Z8+3t+vXcfUBzSt/M9XPPz2aXfzO2qWT8pl3Ctd3yDh+kjxcg6hW8EYGbGI89svRTxkd/B/BrBxjYxt1h6f+I8W0aD1TspjONvzGt9A2VujFdx3nI5Hn+Q3t6fadeu9aP/oGBnbzyYosFbxYqyViFkqE0yWtf2N8N3oVDOBtHFbzZ6Vsdm583nObkgoZWYqz6cy/Iom861imEQ8bzJGiqncxm04IfwRtHFbzp/+3J468yePRsTfGVZ8YcwukY1OY46jv57G47vM1So3tNsIhLbl3giPf6hnAOvdyQVsV+b83Vb+11D9ng0jd7bzIXqmKPF+Smc3cYqbrNw1ufkcefazChFN/7ny2HjA+4F+qMsHDN0P08Yi9jvrBdr8zdRzUuD0wqW/2m8IBdy3yCPuM3NQreuMcXp4zXNYTztV8zqI1y3e554n9sSeAs/Kr37E5L3+zwpuPYbzrv08m164xtQ1x2Ug4+qb8ETvMaX1puIlTIRcfm8M+M5MuagxjI2F7fqcWu9aNvN6iN8r5X5OUfX/S18vlXvXcSvFm8JOMYX5V4xS157+7Gtlm3nvq/wbt9COeBEQZvlnqr47TbDGrNnHxdTnxyE77gvOnuvHVX48lW1vdfeaYKIRwyzsMQFw7hPDDC4E1vSVcPZOnXJ96zxKpYvxBOJ89WbjGNq4HzoGyazdR0De81QXb6QH+mWneWBvx5hB4rZr835ep3D57ibkjjRyZChezxjNz05Z0lcJRWBpuiwfdC9ap782TjnQKO865D6Zu5P7ln3+xyjXFNJeM3hV/k0+VvSiANeuhSr+CNJy6T4bFPHPUp46XfAXTDromu++k88a5k2dJHjC/a2Fi9m840yGVvzMFnLHRjejJK33xphSlQORc9PYd/qd4lmJ72zHzuHCM5QX5rNpseqOthjYvevaVx3vdrefmFi69pOw/eLFWScWyvStAUr/2TbmHb2eFCOBtHG7xZ6K2OLc8bSDMrMdbiuRdku+o3/VaeqUII58FGLmM/DHH7EM7G0QZv+np7EnpfEluFVp4ZdwjnOQ8yqA101P05f109C4PAoDvS2kz4Tg71TmFdvssrfcMYrVzordR6zUOgBN/7yqKbop72Qp2RFq4Zsp9HPMuAL2HXj+Xu4/tO4FS9QSoYv2mXELBrlTufnM71/7N35nF2FWXe/917uZ2mLwmOo8iaAEIWhKCAOjqMikIYlLATCLIFor46qINCAggqioQAwug4OmoghCWBBAUSFIOMjKOjg8NiUCEJEcgCKIMLCR0gze1+/+i+6dvddzlLnXOqTn2/n/ePmlcpYp66p6qeen7PD5Q/9xuHhDd80P1J1fU63FN8ZMLud6cQ1Hzy0Ot0kKQOqXPoZ6qd8KavrrWkXUnnLqLqR2Lah6ZQ4FBi2qFBiRDKu4biVTebNTbJ3t78dYKaT+YdrpkPNM5ftRHeBLNkzOAnALnBRNu2QkWqZtdBBuubXDB3qWaf7r4TI9ccGJlBDes8Y4MIB1Ln399ROw2Wm4hwqqkLb1orXSkOg2j396I555msP5jHk6X3QCrmWK4JoBH33xH0RGr/gn/vBuJpI393qv7nrqgqbscHaG/sZP+3acWaRiHjAR3AY/5wbzxBslO+N6oS8EBs/229eF7zdt5OWd9wJZTV7jfGf+SlJIU3/annTawcUK7kNw4Jb/igy69KRyd7io8Y/O58IiovSsmHthhvI7zpHqx0tCrpfNBf9eDrCGp++Nlp+oc7mySmsb6BLLj3AE15wnELJpBnJRFVB5s1Nhnc/D0iKq80t4GEN2EsGdP8CXxkub57OEHNYa/96IPeTJ+la+8N1/6FiDrM3Bs1+5/ctr6hLxg0yKCGdZ6xQYQD6dNR08T2NBHh9GYhvAlQPfmx+wgeBOL2z9ckDYacZzIW4YBPUjFnck0ADdloRx/M+Asew3A52NMt79Y3IPvz8B1137SyM+vwt5/Wvl8jigDG+MPtgeypm56FKqka18Sdp6o3ziTmQdn+ar14WVAFjv2Dl47Tdt8nqrJPfmNcaVdMUnjTP0B+A7mhyzXhDXJ8D9hnx+GVjk6LcH73L4Q05zy4UQeNrVPgBBTejKh0tCjpDP4kpnPaFOo/X0/UHUxMd7qzxsAbTlnb2JLRURHOzf9BSHPOvH0089k6BU5rvc2wQa+VpRLgPv98vdGeah0ZK3Cu7SakODFmP7ioosuRgYHqtOLhN9nsRTigLJ6BrN9n6awJiqln2FKXbnJahCMdvxcR9cD9xrlcE8AI7v9GaDW4tQv+fdsST3v5u0P0Pw+GVnFjfQPJsf+btOLluu9YxTUPnCIxBDDGH+ZJm+IJgJ3yvXnjecRccdt5O2p9Q8G2rJTfDDqbG/y1l5IU3pDwBeXR/cYh4Q1Nx+XNS0mvkz3FG3hEggc8uE4HvUUqhRHeNKl0tCHpfNDTenB3opoffvZ+/cP/Ni9uyKP1DVjOvTtqyuYmiWkX1uER/6x70NbKm3qInqaWjI6JcMAP5u2smZtqdTxbwihwqjaWSnzkNn33JKLqftLJVMq3mtmzdGHr/88WIuo8c+do9uUuW990kReFEefVqLttliIcsNCMrmpBHRjv+hCV2z9Vu78XDX+yMhHhHH8QIfVDfuNcrgkgzGJ2S4Tzvu2Jpdzq6Tb8KSd31jdv34aQ206hf002fN90Yh0CgAn+cHUU7c3gWShl45rY87zxMmIemu0/pRdvbK/AcWXw0ie03TeJqixzv+kxLcIpJSm8IeELyqP8xiHhDZcBP7J1fT1S1b2e4iMHv7uBcPrCg7/TQW8OI7zpsbuiF+RNYroT6xuQXYlp+wclAuif/MapZo0N/zw3P044fWHeaM38v5DWNz3RrUcT/wmAy/zzT2q2DEZSvr3ZCW+6pA5di99I3i9HLg0AVNfDKN5um40IB2SfILY3y49boYUCByB4Q7eeBo4izolwjj+acPqxYovu5ZpELTiMZJMFfTA5mvrB303Q/zw34n2zI9lipywHYD2TX9Ojo5sHkTUGwFkoSC9vh3xvevRGRBdR2f50vXhHLfpOW9/gnyY75Te1X6kxEU4xSeENCV/IGV2uCW+4DOSdSb3q69cqVF3rKT5Se3Mn8fSMniEymzbCmy12V/SCcldmUWqZmMb6BtJfk0XDR8RU1yF4wCm/CGHJaPmp9eaNxNPXQ2lwBU6vraUS4DRm35CqmQlvVNa1zxPO/DD3k5q9wGXrG648oKFycRPbbtoiHEiXfz83gCC2mqnwpqu5Bw5A8N4ZW2KZMFghwqkQS58MQ1zLNQEM4/5Px3JitGfBv28SwZRbdU1D3jc7DLxyYn0DitPq2pACJ+11CACx+UOcs1AlbeOamPO8cSEBl7GOYK5LhUFWyW+6hv9cDYhwSkkKb1hG4NWVwELhDZcBefNS0utYT3Ga5cCD63RQZ2DhTY/VFb0H/UIPvpuQ5oef7aZ/+Gu7xDTWN5Aiyzfq8F1IK4ALh9LmVnXOiHAo3/GPeTtr5oow1jdh1nnKP4GPXKPvfoaQupxxMthlrZpdHTBbv/L73OXmcfSit+nyR4gi1I6s5rbd9EQ4IPsEsVULhDcjqic/djvBg/bcfkLd/b2Y+F07URHO8WcQT5/kN87lmgAiCcksF+G871AC6Q5jVCg2et/syNUr59u3JdI5cle2eLH99hva9xxCCBCdP5xhQHvjjO/NDwl4XLY/VC8+2ECB45j1TVkq66XLtN3FhFQ2ud80+t3GEuGUkhTe4LwByqP8xiHhDTm+XDPpz00rHZ0T4fzuV8RTfvYa7+sOJryxv6IX5F9i2nHrm//ckTArV4lpm9ch5J1TflizvmlnVWe/COfml4mnl2ypW8NBzqVVi0slwE3+eX1tEZp66enNrA742tXEM2/MPU6zf+ys9Q3HUahns/kzZBoiHJB9gtheO4Q3w6onARSmoVuP+ULwVEU49M7wavsuOphrAhjGprot210RDrjD3xX0wHbtDpzuW9+AQ0x+XI++s11YrV2HJQIIEJ0/HG1Se2O7AU6VgJth+4P04uq6r7G7mmF2ENkmv2n+k44owikmKbzBeQOUT5NWZ4Q3vDHLm5eSqjs9xUdqb54hlp7yYFUHJlnpSNIZIvOzot5TCZCYdro7FDjF8pU6/B0sNrDe+iaYVZ21p9ZbdiOWnjLv7Zr5w8CC8KjrPKWfADhKR63dvqkua9Vs6oCv/R2xVF7bE4R9ROA4CpaeWpM5TCYrwgFZ9A6bwj4b8TWWbx1EuL+XUr10mxXhHH8RscQzxO5cE0BaB9HUFvz78BxTHnu6YX0DtrkrW7vqACASf3i/R743quqNDxDzpHYNF61veJuQdfKbrva/5NAinFKSwhve/kF5dL9xSHjDd5xKRydEOOAxD71eBz6ZbKVjOj+Bg5bowROJp3+Wd1jfgGs68EzW4RHf1T0fIX7KeSPS8FZ1Np5awWPmfVAzF5q3ZEz/J/CRz+q7XyWebu7ypl96sqkDhpwy952a/Ziz1jds8VCfSk3yMJmUCAcs3JSrNglvKAiDwNz+rqH392IGt28jIpzjrySY/slvnMs1AdRx/3sTP4imseBBDr5yloI9dGJ9A6mtySC9XexchwAQnj8cIG00r72x1gDnjauIuUm230kvvlRXl9Lpqmb4pXnabibxlDXuN8F+2yFEOKUkhTfkfMHDSlyrhDfcPPPLpN+Eq3S0VoRDb1zQlqGLOZlKxzR+AiD/evC42x0KRNPxFAeY6uaaU77b3pLRicKIW/YjmN7TM3Qxm7NkTPsnAK5x7rbqM97IrTeDOuBr/5tg+pUUjftkkOLgomN1+R2EEKTNaZwqzYtwwMJ32F7LhDekekDhG7r1RHQUyV6EAx5u30UHc00AJkyc7Fnw7/s0UXSPd67RA28L7KOI9Q0kz+S79OipwQJt4aoDgJD8Yc9EtDfWDt64mZibp7C1PGarX4Jz1jdsIrJNfhPmtx1IhFNMUnhDzhfke9PxjIU3SOD8eSmpOtJTfNifB9ECSA9N1IE/S6nSkc5PEJz/+r3e89bAiWmsbyB5li/V4R92z/qG46i8sr6JalWX/akVQJp3hmZelaAlY3o/AXCO8kB3tL4ec08+1SzqgEG+tCcwLrxJ490LoD+bmtbx0qQIB2TfO2zVMuFNWR/7OpGD8Pf3UsYvRNFEOMffTCDRLbiQawKoZ1Pdxu2oCAeU955uWN9AysmlSAqcLNchAIQlSe2NbQY4b3yNeCdzkOnVxteNOMy42KwWZIn8pivKj7yNCKeUpPCGgy8oj40eHRLeUAAhKh2tFuE89joCCZL00D/owGXpVTom9BM46F/04D8TTF/3faxvwG4nRlYdKGlNuAmrugxPrbccTiBBkuadr5mfS9aSMYWfwEem67uLCKaTZb4mRTjVtOuAr/0Bgcw5c1+v2T0uOd5wHIXGB9d0M59mRDiQIv9+X3r7LG0QIWVuHzvi/l60ok1bKBHO8fcTSV/lN87lmgAyEoEnseDf9w1CKIebC5fCPHRifQMpZEFLgSNOWgnAWf6wTVQPagd9b3bYgYAnyJg/a+O4EZ9lt6xvynrpHm13BMGUrHC/ifprbyrCKSUpvEG/BV6WPFokvCHHl1Mm/chApWPmIpzHdieSoKaGTslXOibyEwD52oOnjPUNpN103CXrGz6P+eWUSyNaMlp1ar3lLCIJatrmIBlLxsR/AiDXiiHqUrVmRDi9qdYBX3sHUfSCwphEhDcpvXsBKOrDf+YiHLCwB2KvTcIb1gmEv+n09Q9KoZ1nshfhgJ9Lt+herglgK/dvn4EI3PCCB2d55z164KQwp0qsbyBhJl+tRy8NE3Fr1uFvf6p930sAAQLx3Evq64h09qhkYFwTd55OAq5sqrboDibkN0rG9DysCKeYpPCG1QPK3euLU8KbgT8PyIOasKoLZutkn6E5D52sA/89g0pH7NfBWA8eV7pDgetrsoijLshe6xtzVnWpnloB6ph3rWbOSMmSMcGfALjDuQfWLS2DIpxqunXAQN9cjqNA3/HkRDhgYQ/Eqk3CG75yEOb+PiC86X9gKoVznslchHP8aqLosfsNuSZgDWe04N9Hu428Fzg554GD9U1Oel5HUuDQ9hrAfp57brD9Tbizh4O+N+rUDmOJeeKM+a02vrvRZ9kR6xs2EVkkv+ky8/sfIsIpJSm8YfWANzcBS4U3/X+evxI5Kh3tE+FUiCIodK9x6yt6D5qlB68kkPnhv76n95wZPjGN9Q0kxvIv6fCrHLS+4cnZK/O6qt3NGhvmcwHa3rbSXefxfwIfeY+++18EMg9lvtFFONV064DBD674ky7Yw03rm7IuulCXzyGGbPHZF5dHEeGAhT0QqzYJb9iLIQC3b6O+7jrhTU9dg84ed0Q44LN0wa1cE8sV6ujblF0fTCMLHlxnTPiebljfgFI3MWinwLFiHQJAO557XNpU99sJfvaoZGFcE3OeTu0wmZinvnc464Hz0m+13b4E0gb3G3MivH4RzsDS7KK3HEBg+Y1Dwpv+/wj5jah0tE6E89hhRBFGsKWdAseJil7wvAeP5d2hIKfHUfsHR/yP7vk7gicsGS0sjLjlEqIII+hpp8CpulAqATkq840iwulNrw742n8jiuKhy4FBkeDBYPdNx0Q4IPt6IPbaJLwp62NnETloQ193o/t7KYTzTPYiHPB5+y46lmvinQg0woAxgz6YRhY8eGtji7ctJJoLjZBZ4pEdwHqe+2UD7U2gs4eLvjdl7fAeYp4eY5Zr4wlNvs9OWN+UpRJhlKyQ3xj/IhQ5ggBE9GZ1QHjDFTSPTPrXZCsd08gA0mUcGvHQBTrws9lXOsb9CQBSh7Kl1jc8luTyOOqG9Q3LL6ec8mHzloxpn1oBGjHvDs38+2wsGU3+BMAFzp0eIosbToRTTbEOGHy7HxXds77hwwjaWn0e1nnGBhEOWNgDsWqL8Ia9GBS5oduWxo4i1opwjn+JKPrtfuNQrol3IqjjJ08NMWB0ToTzvgeIoa9SB1utb96+DRH1LrNUMKfAibsOAaA1zbU3rc4elSyMa2LPs8OxxFsWGfq50iYMspffdCWgxislv3oActcC3xnhDZ9vefNS0uuC2Xpt8NiZRBEUpde4ExW9ILo7W9od6j9fTzjznllokZjupCcZKA3rm+St6syeWm/5FlGEdofSRufSvqoLpRKgHLXYjyDCqaZUB3ztV4iiX1zxS10wxUHrG46jsDWn2uGgCAdkXw/EqjXCG7KREOf+XgzsPJO5CKcn+xoNyFh+406uiS8ztNWPuSTCAfd558V64GtRz5nc6yEBJh+rR+8L875ZscYDBwCa89ziAce/cGcPR31vZhDwDBhzvTZ+uvmH2nLrGy6Jssf9xvinocQRBCDEb9Ax4Q2fb1HpaJ8IB6A5D31dB57cvNe4CxW9Bx2jB+8kknR3rt3BsL4BJVCnW4qamM52HYJyqgnPwqrOzKkVP0ZozrxfaeYejYQ3WwaUOfaXSnxkJ333OSKZlxb7EUQ4vWnVAQMGoa5Y37BcoT+nGtZ5xgYRDqRIoatW6N96L+61RnjDIywEYMmTTe7vpaDOM5l/J0/YnjD6vX0X3ck10REDFLQNvP2Zpff9hfjlrcVwxCchrG8g9cxSq/fNDNchADThue+E0N4Mnj0yMq6JOc8O5xJwZd862U0PnJde0nbbCfmNC42XQg2KGCcBKMTri1vCG15fRKWjdSKcxy4ihKCIvcZdqegF+Sh1aJwc7KQpFCRwJSylLbyhHS9kaMmY3JZ9y1JCCC3ZMqTxwYDwZvOQdW57qQTkpsV+BBFONY064GvPJ4TCINSlAUB3eOcZG0Q4kBbf3nXgjtNehFO1RnjDIywoakO3LUEdRbIX4dA7g+275EyuCc8QaHv+dEmEAx430RjyxsQrJyiBx/c475uklQBs4rmro2hvHPW9UZWA210nY7P1Tb9LipDfZH4EMf5pKHEEAUi8M0RmwhteX3LHpE9lVuloJgPISwm046Hv6cD3NHkRdKWiF3LEf/0/vWdh7MS0BdY3/zmaYOaE5f+gw3+dgfDGwDqEfHHKO1K1ZDS/ZXMohXbMe0YzO0YIbxqtc3tLJcBuzp1rJsHbWIRTTaUOGDAIdcj6hhULkrrDO8/YIMKB1CgPUca2EuFUrRHe8AgLkRu69YRzFMlQhHPCPoQQ+Y0juSZ6tMFQfnJH0/OnEyIc4TQiH5toNH5jssD6hlRnrhjTILMU7n0zk3UIACN47uKa118k7Y1jBjhV7XAZMc9097hQG7/R7otteZswIb9R1o9bxmV5JTToAAl2hshYeEOOT968lFRdMFsv67F/I4TgwDqP+xMA+dKDJ0RimqZQkLAg3FLHG7IJvlnfZGdVF3bLvuUhQgjt6eseIbxpvs5tLJUYRQytP2SaS/AOF+H0Jl4HfO1HCKGnXPEtXTDLQeubsi5aqMtPIYDy3f8hrPOMDSIcyNSVrrEIp9ca4Q05H4hzfw/vKJKNCAc8v5hvVqHoRq6JdQsxvZusyiwd8gbi510TjTZvTFnf6w/qI5D5SoqWYr9v8soJkDXPnRNLe+OY702PdvgGMZedAs5mChy7rG9I80qyQn5j/BtR5AgCkEgBrhXCG15fqHS0TYQDEICHHtKBb3a4ovegt+jB3xFG+eZ91z4xjfUNJCMIT0F4Y2QdgvJXvDhCKNtXK0Sz0QaEMggIz3Vlnf1/4SwZrSqVmLlJ8zgDWL6hm34EGhThVJOvAwaOo25Z37BuoT+tGtZ5xgYRDnpaZa+MHS7CqVojvOnQx3YlctCKJcubWNduie4okqYI54SjiSHbt8WWs/RogwS8m2xZ8JBfqUP05m5Y34DBtFLJxPtmuusQAOp57lQz2htXDHB2WEjMrWDM6dp4R4Avtq1twrpHq/KCkN/kpC3i8ORaMosG2RZ4WIBrkfCGp2V5UenYugIMs3WQ+0qzvrrWkm68soBPtWUhEtNY34BRQbgDjjesQ2+s6vq21ExCqrbagNT/eSrED+Ldv6ru9CsF11rsGxPhVJOvAwafGV17U3DOAwc4wYZ1nrFBhAPWKGMHRThVK4Q33LUhVkO3rQ06e+wW4QDUBAyOiXAA+nNKxdT7YJJQguZSh+jvmzZ44LxKIHO1Jges7eK/b3LzAsgKr3xvfki8ZePbROtyawutb/oV0UJ+k6+2iMk9lQ2mnjfxuweaO2YkvCE/ki8m/ePwSsfgFWA2iHAeu5cYQmB6Blb7gPCme3Cdu/HKAn7UlkVJTKdvOUJCUDk01TWWmGYdQiRO+ZvBCp5B4c0Iqzprt+xbNhJDCMyWRgqcqjv9SkFOttg3MOhN9nhw7QeJn/cJ0qKD1jecSGFzeOcZG0Q4YJkyttBV22e77JAXAkRr6NYjlQx8qZIV4dA7A0YIGJwR4QBI2ph6H0xDg0P2J3i54p376oG1sd83wytwDFrfHNRHGHPF5IJ+s525C1Fa6/B32+ktLxE9AEl67r0hety01d5YboCzwy8IuF2MOVQbfxWgvqXT1jZhQn6jfLVFLCYpvOkfIL8B5a3XuDPCG56W5c1LSRWzdcgVD/1JB/TWCW/cqejlcUV+1JbFSkzT4xniUehyx/GGdag8d88dLrxpYslo45Y9ihBCUK7bW2f/Ipb1aMY/AbCVc39Wt6KSEOFU2dYh4QRpKfaTAY9bkMkhNvyWmr0IByxUxlZtuWsX2JQhpHXtkEHJ2JcqIRHOCZ8gflBzv7E/1zTszwOg0NpvizJLoJx2GY75vpmhBw7WN3S+tsQDBwCk5/Y3qb2xfVAl4I7Vbw8/51hlfcPjWubym0Fnc4Mfi1KSwhsWDeT3XuqG8IY7gLx5Kem13Wz9saeJH8Re8L3uvLJAfmvLzCSmU7Qc+c8iIczjibSUUirZ1Drkw5gz+robCW9aWjLas2UvHE0AIdKhNJ71aGY/AbB5N0/6WSg565t3Ez/fueI0XXBXlsKb6O9ewJ4edUvNUoQDFu7OVTuEN/2fVrw9oTlLvtHoOrN1UDT8yTIvwgHYKr+xO9fU4M8DEFX7bUVmCXJa5mTgfTOwAseg5YgqyG9E5+toChzD65D9HUB6bs9EtDeWGuBUtcMqYm4lY8I0ULasa233Qao8KOQ3WSZ/DYtwSkkKb3DeACT42QpvyPHlvvBrS21HqFpvtg4Qlp4RCpyqM68sB5b1EEeg3EkdDCemsRwBo45MDgxoDyMsGe3YsgEiH0pjW4+m/xOY+TPN+wdCaOtunmhvtl6OlyAb6iSscLzhnQLMNSDPRoQDqfDtWbVrTub7bNhPK/IbUKSGbj0NHEXsEuFUiB/Utu+i9bmmEX+ezKuKIHN+ckYs7XeWC57Pbx4pdJl738zEAwfofG2JBw6A3zz3emmjR743O/yRmFvKmLHa+JcwDZTtsb7pF2sI+Y0FT7PGRDjFJIU3HIVBSPAzFd5wB1DOKx0HdoFuqUqfJ8gbD79eB6x0raKX7lA5zQAWiskkprEcAROOTG5Y31SkV4icsGTMfsvm/RjCc90HdfYCk9ajaf8EwNrdPNH3oSovzZBxnURywptY717AIdbE3pq2CAfSof/UZMM+G/bTChC+odvAoJTgtyu+COeEa4kf1Lnf2Jxr4nkIYixdCzNLh5xB8JA6xFXgmLUcOegvxI/O11EUOOatb9jfwW+eKyarvbHNAGcHjNdy5uxnVddaIb+RLU+zBkQ4pSSFNyR/gXtptsIb7gA5YtKOQyodB4U3QyvA7BThPM46BJmQnPU69coCylFTqOQS01iOQAxHJpesbzgJ5Ijpa1tW8FTttQFRWQsPIIAgA5KzqiP9SqnZtZVzX61bVIn1ZktoW792HAEESdLops8K1jne8E4B9Ru6uU02PREOyD5lbNUO4U1ZH32cyIEiWtf2tHEUyV6EA1CvYbA418QChvhL167MEgipg2UeOEDna3s8cAA8pm/jUKeRHPvebNGbdiDgtlPof54IVcdlg/WN97uJBe43jX72sUQ4pSSFNxRaAffSbIU33AGUw5eS4cKbRhVg9HmCnLBl6Bth1alXFkDqEFWBY9By5H60N3ldk0XXrG84DMgP65t2VnXYgICr9Axd+VU3+pVyF7OX8hCH80QGvehpIYNbUgrCm7jvXkBy1fRum4YIBzJ9fk17nw37GgsQ5/5eSilPHkWEA1C/fRftzjXxPAQN2ZRqH0yTCx6E1CGWAse85QjQ+Tq8AicR6xu+kOAxz24YzKoFOntUsjSuiTnPm8YTcAcY/ao2vSH8552utUJ+0/z3H1GEU0xSeIMYHbiXZiu84Q6gXL2UNBbeNK8Ao88TuM7Df6cDlrlT0UuGGqmDhR44yG/yeiItuWZ9w2Egf+U7zSp4erEBgRxy3ad19ufirvPMfgJgH/1vP309STZpq9JzFFK9JVnteMMChvpzbDK7bbIiHLDg+TW9fTbsayxAnPt7KdWEeSgRzgl3EzwYaiFic66J5yFI3ncx1QUPSB1s88ABOl/b44ED4CXP/rZBR5tWZw+nfW/eQcDzfrzJ3PqmjPxGVrufhxbhlJIU3nBDAz7c2QpvuAPkiL7ulr3Kei3u8wQgQ2+EvS69shz4v3ro7cRPSB3CKnAMW468QvxwZLLD+oYTqXJoydj4XFq12AakQvDA0MqvOtKvtEPq0cx/1bxPEj/7jpflhEU41cTqgAGG3pLSFN4YePcCUkxJJoKSEuGANc+vSe+zUV5jAeLc34sZvBkFFeEADJPf2Gw5y8MopOW7mMKCP+RaIiekDnEUOMYtRw7aQPDofB3+XdKQAqfBegbwj2d/2epU0+DsUcnSuCbuPJ0E3ClGR63jomutfHa/CfZFCCHCKSUpvKHQCriXZiu84Q5ApaMFIpzH9yF4kH2lYzY/AUDqkLkHDuDIFC0x3YkgHNRGGdvsXFq11wZk4VkEDwyt/Koj/Uqp+7F5K68lZpMS4fQmUgd8TR/Bg8FlXCg54njD/QjSLYI0L8IBy55fk9hno7/GAjRnyVHt7u+ljPq1BRHhANRv30W7LWcxr4N0fReTXfAgpA6WeeAAna/Dvm9WkvTAAfCMZ++RNtX9ENqePVz2vVGn3vQeYu5NHVeG1jdldZ+lyvVCfmO9+3lAEU4xSeENhVbg/b00Y+ENdwAqHVEggOM8fJYOuMaBil6eCZE6GElMm7ccARyZ4iSmzVroQC6N6cJYMqJAAKe57js6e5rhdZ7eTwAsPF4OzdCaF+FUk6kD3kLwYIArirqwkmp608i710WbdXkX0aMI0jURDlj4/Fq1QHjD0w8oXkO3LbEcRRIV4ZywmuDBCPcbiy1neRiFkfxk+8R9F5Na8IDUIf6TkFnLEaDzdcz3TYPWNyxI8IxnFwXS3gyePbI1rok9z5uOIuaOMfoBbTo0xvZBmzB5KL/pivJBaSPCKSUpvKHGBTy+l1ohvOEOICodUSBAjrRnva69soCQOoRMDhq1HLn/DwSPTh7ZCG9IIghLRhQIkO8bWdWFfqUUT1h+vGyUxTUpwqkmUwf8F4IHaZfvkCYFw1t5urWPZkQ4YOHza9UC4Q3fNIjZ0K3HgKNIUiIcgJHyG8stZ3kYhcRkY2kveEDqEP+NyezkQOfr+O+bLEiA8Dz7rXDaG7d9b8p60wxi7uULRRbWN54n9LZxyf08oAinlKTwhkIr8PJeapHwhjtAXpj4G/OVjumkmB8/huiB7Kx0TOMnAEgdoiWmsb6BtByZkhPeNLByglww/btmLBnT37IXfp3ogYxpz6ou9CuleMJWPvOBus9mciKcXvN1wNc8RfQg1fKdpN69wPOtPIvax7giHLDw+bXXAuENywMUvaFbX/+g1MB5xgoRDsCw7btoveUsLWBgKH3dtW9sh2siHBBSBxNvTAYtR4CCaSPvm0asb1iQ4BWRtDeOGuC86Vzi7SyjY3dSppZbvslv4n1ZGohwikkKbyi0As/upbYJb0hVyxPrmxgVYKSYQX5XOib7EwCkDpET09zZIGFHppQcb1iQvlnfmLOqM79lA9hnyZjeTwAcrO6NK8KpJlAHDJBW+U6ygy1Ezu+tPLvax+giHLDw+bVqgfCG3Rki3d8HhDf9/1GpkfOMBSKczMsxwB8XkQSfh4AvcDEtqyWzCx6QOph6Y6LaEBJr6RLxfZMFCRCYZy8Kk0Nz3ffmUgLufSfl9K1vyshv5IL7eUARTilJ4Q2FVuDNvdRS4U3/n+evRI5KR1LM4DAPf10HnG53RS8VEkLqkEBiOr7lCJBHyEh4U2h4KgblS35gzpIxpS0bIDbX/Upnj09jnZv/CYCz1b3RRTjVBOqAAZIv30nc+qYL+Y33R9msax+jiHDAwufXqgXCG3ZnCHl/HyK86alr0NljlwjnxC4iB43kN5ZbzpKGguayMYdEOIfgeYvUwewbU2zLkYMeIXK0dDH6vhnT+ob9Hfzg2U/E0t44ZoBTJeBuM/rb2nSeieNN+tXdQn5jv/t5MBHOQMIi0WZ1ALm+l1otvOn/j5DfUOlIihny8ROouvbKAkgdYiamubOBUUemDBxvWJBYMtqzZQOYPZTa36+US5lyUd0bWYTTm0AdMECS5TvpDbqJnLxub9RjRXF5OBEOWPj82muB8IblAS1Z8obB+3sD4c2WWoXACOeZ7EU4AI1cRGy3nGUlQzvZmBsiHEDqYPyNiUclMNTSxdj7JuWvAC159lSPfG9U1Zu+QczpEVYrt07T+qZD3deqcq6Q39jtfh5wUKTQCiDivdQB4Q13ACodSTEDlY7Z/QQO/Jwe+grB81fqYCYxHcdyBHBkykJ4U2h2PAZhyZjplg1g8CfQa3u/0mGDmR/QvP8geG5W90YW4VQTqAMGSKZ8J1XrG1ay30RxnrFBhAMWPr9WLRDelPXRjxE2UOt0elPhTf+gkaNI9iIcgOYuIi49DwHpo2JafTANLnigMjWJN6Y4liNAS5ck3jcjW9+wv0PeefZIaVNtzcfQ3rhhgFPVm24m5vQIq9trOtMt8y4J9xs50R+x/aCU/KIByN291BnhDXcAKh0zTTE//m9EDlytdDSTBO8kcvJT6mA4MU0PHojhyJSx4w0LUlgyWrFlL3yIyIHRIraq9f1Khw04lLpb3RtZhFM1XAd8zR1EDpJqLJdytTr4vo93OCjCgeT5znZSl9SjvoCbcjXrTxlvr6AAgsOedu9KzR1FshThALRzEXHjeQhYt6W0+mAaXPBAZWpCb0w8KoGitHRJ8H2TKxjACJ49uE57s/W0kFffmx696W5inhdGh6icab/XpNlKTMhv3OmP2GpQotAKIMRv0DHhDXcAKh2zTTEDGHe/ceiVpdNfwbrPUoekEtPRLEfAb0emTIQ3BQThWDJWrVQgAMhoEVu39f1Kh2lvOJTKstfl2Onc9iKcXtN1wADJNJZLp1p9yLsXyO/eLmGdZ2wQ4UCKu3MhoAinN2vhDbszxG/o1tPeUSQbEQ5AMBcR25+HgAxqKS2rJYMLflsih3ttYm9M0SxHwNeWLmm8b0awvmFNQr4Zqb1pJsKpZG1cE3ueN/2CeHtXORNir0mt8FvIb1zrj9h4UGStAASl0OWa8IY7AJWO2aaYAYzLb1x5Zekvc9xC5LiwmUtM04MHFNSRySLHGxaksGS0Y8sGSMaS0QERTmetqA7s4DPfrmuukagIp2q6DhjAUPkO1eqQcXIprPOMDSIcSL31YXsRTjXrTxm7M8Rv6LYlqKNI2iIcgDAuIvaKcID0UTEtqyUEkJCAe20ib0w8KkGAli6pvm9yBQOo8ey4BkmzxiKcHPjePEbA5VXlTJS9JgXrmw7kN872Rxw+KFFoBZDUvTR74Q13gFww8ctWVDpGyQACGOLhlTpgR1sreltob/gCc2Ezm5gOYzly/38ROR8dmbIV3hRaH1DBfaZ/KDNLxrhbNoAhrt9eZ60dvs7tFeFs1d6gCbeHsvnmSo1FOFXTdcAACadJk6tWH/7uBfK7fjes84wNIhzIqPVhKxFONWvhDbszxG/o1hPOUSQdEc6JpxA5iOIiYqMIBzxnY4pWSwggwah7bbJvTGEtR0AetXTJ5n0zlPUN+zvklGe3D6C96R9UsjeuiTnPm54l4Hlj9AnadG8C55wUdiIhv8m6A5OZQYm1AmD+XmqL8IY7gLx5KalamWIGkNFmUVUXXlnqtTeI0PIudcggMc3uD00cmSx1vEEQ7pv1TXZWdW22bACzt7Oq9f1Ky+p7RYX6LCJYXN2biAin13QdMEBiaVKq1SHV02xY5xkbRDigLFsfNhbh9Gb9KWN3BiP39/COIomLcABG0LdZhaLFlrN0J4Twx057RTjgt3ttSm9MPCrBiJYuGb9vcgUDv3m2EEZ7s6X2W3DUAKdKwDnnhPnyJ2p9U0Z+k5s32iKFVgAmv9d2CW+4A1DpmG2KGUCJVzra9coyTHtDo/H8Sh2yTEwHtBwBbxyZLBHeFNqeVCE3mvDm59K+WiGabTYgKhI8MPpD6LW+X2m97w2acEeqew2LcKqm64ABEkiTplCt3uDdCzzfxMM6z9ggwhlF5LJvfThchFPNWnjD7gyx7+/aEt1RJEERDkCjxWyv5SzdCSHGsdPGzBL46l6b9htTcMsRyPuatKWxYEDrG/Z3yB3PvKi+0tCq1Lbamx5nDXCqetOrxJxzTsg9gjZhypn8Jok32lKyhxW6c4E/32sbhTfcAfx5Kem1L8UMYJS+bksregsttDd8gZVDqYMViWl2f06kJUccb6h09MaSsa9/ULOqs6swokLkQClbMmb8E6hpb/q21BnggCPVvcZEOFXTdcAARtOkVKtDZqfZsM4zNohwwJrWh4MinGrWnzJ2Z4hxfx8cxHMUSUSEA9BwMZestJzlhRRMHDvtyiyBf+61mb0x8ajkPYUuy943uYKBfzyzVtoU7H43MmfioAHOjtsSc845SSlwoljflJHf5OaNtpSk8KY/9byJXznk/Httr/CGO4A/LyVV61LMj68mcqAkKh0tfWVpqL2hWVS+pA52JabbWo5ArtdkoWhXYroQ5MgKObVkHBTejLBktGTLXvR6IgfZWDJm8xMY6XuDJtzB6l4Dg16TG/01nyByYCxNmma1euN3L/D8NBvWecYGEQ7IrtaHha7aPttFkwtw7P4+fFAy8KUyLMIBaLiYi/ZZzrb98wDrNjWrJY6dEMm9NvvmbkEsR4CWLum8bwZX4ADkhWdWDNHetLrfNXzRcM0AZ8fxxDzXjB5e0GX4nEObMOVJfmP8RbaYpPCmf4D8BvJ7L7VdeMMdwJ+Xkqp9KWYAJVjpaNcrS6f6+l/fRx63IB8ZwKKViWl2f3ncFMq2xHQngnAfLRmHC2+aWDJmv2UDGP8h9NpaKjFCezNogAMOVvfGGlRprg/WpUmzt4ngogTdUTbZ7EU4YGHrw6odHZoBAt/fGw9Kxr5UxkQ4AM3cb2zLNfFCCgkcO7PPLIEfUofs3zeDe+AALV1SeN+shPHAAcgNm4Ld71pUqjvke/MO4u1RQVdS5xzj1jcdyG+UUaFVv7O5wW9NKUnhDWdiQIKfrfCGO4A/LyW99qWYAZKvdLTilWWr703DNg+gXFSVlSxNTLeyHAEvHZkyTkxT6eiNJWNj4U1LS8Yst2wAJWLJaF2pRDPfGzThTlf3Rh5UkSuARWnSTIQ3Td+9wPPTbNTdNksRDljY+rCafVKoQPodgt3fW70rFQ1/sgyIcACayW9syzXxQgqJHTuzzCxB3u/vFr1vdtQ9cZKPEi1dbHrfpFQaPOCZuwOdVZo2IHbKAGfHKQTcl4KuxM85tAlTPtxvekyLcEpJCm84EwMS/GyFN9wB/Hgp6euRqtalmPn+g9KqdMzylWWr9qbc5P4JOZI62JiY7mT3x5HJBeENlY452otbCW8CWDJms2UDJGnJaEupRHPtzYABDjha3Rt50EtXF7AiTWqL4w0XJdiaWYq37WYjwgHZZ0/Xm7Xwpv/TupHIQcsv3pZ2CpxSIt+uWCIcgIaLuWhfrqntC+k2RI5jZ1pWSxw7QcE6fdv2vtkRIKsAtHTJ5H2TUmnINc/cHEwnXGnegNghA5xOAu7HOae/oCuFncWg9U0Z+U3Wb7TGRDjFJIU3nIlBSPAzFd6QK8n7S8nALtAtVa1LMQMo3UrHDH4Cddqb4T9PGo3nKwNYKNqdmCYD6LcjkwPCG06keaGvO0AFT68dzRp5OYZ0LRkzLpVo7XuDJtzp6t7IgypyBcg4TZqt8KbVuxd4vomb2H/TFuGAhfZ01ayFN/0D5DfQtqdb6/t7KcFvV0QRDkAz9xvbck28kEIqx860FzwgdcjqjYl8FC1dbHvfpPwVcsoz3wqjvSk7boDTqR2PIub0rrXYA0fIb5T9G60BEU4pSeENZ2LgXpqt8IZ35fy+lAwKb4ZWOlqUYgbIotIxvZ/ASO1No/vnge/RQ/9F8OR8Uyj7E9NkAL10ZHJGeMOJ1BtLxgH3GxuaNfJyDMrAkjGbUokA2pu+LZpZ0TyU4S5W90YeVI0eBgDCpEltdLzhogRbT7PmzpnpiXDAQnu6atbCG9LvYOT+Xkz8Ph5ahAPQTH5jW66JF1JI8diZ3oIHpA4ZvjGRjxItXSx736T8FXLHM3OkjSG0N00bEDthgNOpHU8n5vSuTVaBE8v6poz8xqY32lginFKSwhvOxMC9NFvhDe/KeXwpGS68aVTpaEWKGcAoj/yj3rbEmleWRtobDHCQOmScmCYDSAMPa4U3nEiVf0vGwUHVjmaNvBxDYlz/BZ31WWtKJYL43mCAYxP9vdn6epJ/XupFrgAZpEktEd60efcCz0+zpg+caYhwQPbZ0/VmLbzh7RVasvjCYPf3UkpPRQFFOCf+itBBk+27aF+uiRdSSP3YmcaCB6QO2b4xkY+ipYtt75tcwSBHPDM7kvbGWQOcHT9FzD1iuw16aZ90jzcmpup+TpWdhPzGog5MEUU4xSSFN5yJgXtptsIbciX5qnRsLLxpXumYcYoZQBn3i0rqJ9BCe9Pw/glIHVJLTJMBpIGHncIbTqS5tmQcPui1o1kjL8fgVBVFxJ9AGO1NH+dSm6p70xDhVI2eCgDapUltd7zhogRbT7PJHDiTFeGAhfZ01ayFN7y9Qnzrmy0hHEVSEuEAtHC/sS3XxAspZHTsTHbBA1KHzN+YyEfR+dq2902uYJAbImlvHDXA2fFS4i0qupMexLW+8XVb2cb+DkyhRTilJIU3nImBe2m2whvelfOSpGslvGlX6ZhZihlAVlQ6Gv4JtNTeNL5/AlKHNBPTZABxZLJQeMOJ1KsKnqodzRp5OQYHqyjC/QRC+d6gvbGyujdZEU6VTRxSSpPaJrxp/+4FdHXpcU2EA1m3Pkx8n438GgugGNa1PaEdRRIX4QC0kN/YlmvihRQyPXYmteABqYMNb0zko0SdtGXvm1zBwH2emR6g1KoSpgGxxQY4O36NgFPRnco5p5POd3LT/SbYtyaECKeUpPCGMzFwL81WeMO7ci7o6w7Qa7xqX4oZQBZVOpr5CQTR3oy8fwJSh5QT02QAcWSyTXjDiVQ+VfBU7WjWyMsxOFtFEegnEEF7wwXN1urepEQ4vWzikDiFin3CG6rVIV3/upREOCArWh8muM9Gfo0FiGNd2xPRUSRBEQ5As+27aF+uiRdSsODYaX7BA1IHS96YyEdRJ23b+yZXMHCZZ46Ipb1xywBnxwUEnIrudM85dL6Tc/KbMF+WQCKcYpLCG87E4P29NGPhDbkSKh0zTDEDyLpKx1g/gWDamwb3T0DqkH5imoWHI5NViWlOpF5V8PTa0ayRl2NwvIqi1U8gmvYGTbjd1b3mRThVo3XAAFmX71CtDjb71yUrwgHLWh8a32djvcYCxLGu3RLLUSQREQ5AC/cb23JNvJCCNcdOYwsekDpY9cbEsqRO2qr3Ta5g4CzPHGxCe+OKAU6VgIunigzOOagq5JD8pivKR6eNCKeUpPCGMzF4fC+1QnjDuzKVjhmmmAFkaaVjlJ9AKO3NsPsnIHXIJDENODJZlZhmTfpTwVO1o1kjDUchF1UUDX4CkbU3fIddqO41KcKpGq0D7iZykFn5DtXq4Ip/XSIiHLFoLW19aGSfNfAaC6AYDd16DDiKGBbhALSQ39iWa+KFFCw7dsZd8Bw7kTpY+MbEmhR10ta8b3awv4OTPLOvtKluGUfV3rhhgFPVjncTc54qMjrn0PlODrnfRP3WNBXhlJIU3nAmBi/vpRYJb3hXptIxwxQzgN2VjiF+AiG1N8N/pIDUIZPkIODIZFtiGoQlY0aFEQCOV1EM/gTiaG+4oLlT3WtGhNNrtA4Y+Q1kUb5DtTq46F9nUoQjdnDZ2/qwN+tPGZkfiNfQra9/UKpznrFBhNNF5KDJ9l20L9fECym0JFWrpfgLnmMnUgdr35iAOmlL3jd56AQHeWZXo9ob6w1wdvw5MWdbyfScE+3f8qqQ39jdgSmICKeYpPCG8wd4di+1TXhT2Jo0AVHpmHqKGUAOVDq2/wlE097U3z8BqUMmyUHAkcm2xDRgyZhVYQRALop3+15RoRJPjwFOVffGFeFUjdYBA6RbvkO1OrjuX2dAhCN2cLtbH1az/pSR+YGoDd0GhDf9T06lOucZG2rEAVq439iWa+ppV8gIrNuyIyIcjp1IHWx+YwLqpO0R3nBeBecwqr2x3ABnx8eIt3iqyP6cEzYx2IX8xv4OTEFEOKUkhTecP8Cbe6mlwpv+Pw/pEiodM0kxA8iZSsemP4Go2pshv1BA6pBJchBwZLItMQ1YMmZVGAGQg+LdmL43W/gOu1rdG12EUzVaBwyQVvkO1eqQJ/+66CIcsYNb3/qwmvWnjMwPKHRDtyHCm566Bp091ohwAFrIb2zLNbUtZATWbWpWS3EWPMdOpA6WvzGBqJO2RnhDjhScYkNfAtobWw1wdnyWgIPJrSHWXsNRR/a735hT/vWLcAYSFl2cPwAi3kutFt70/0d/JXJUOmaRYgZwrdJx+E8gpvZm6/0T/JY6ZJYcBByZbEtMg7BkzKgwAsD14t2a9qZvSzwDHHCxujeyCKfXaB0wQPLlO1SrQ17960KLcMQOLgdaH/Zm/Skj8wNhGro1EN5sqVUI1H2FshfhADTbvov25ZraFjIC6zYdq6UYC75B+SwgdbDtjQmok7ZHeEOOFNxhw1+k7pb3u0rsBsTWGODsuJmAg7GnCjN7TXDrmzLyG0feaNsMipw/ACLeSx0Q3vCuTKVjhiIcAKO87T0pVToO/ARia2/6Bw+9Quj8lTpknBwEHJlsS0yDsGTMqDACwChndaRbvGvE96ZH1+1P6Nys7o0swqkarQMGSLJ8h2p1SI1AzjPZinDU6KsOyVOoqC/U7lzN+lNG5gda0zNwf28qvOkfNHIUyVCEs3iFpnFtgWbuN7blmto2EQfWbQp9MOMM1KjxPAipg2VvTECdtD3CG3Kk4AgbnhpyDmlwv6uYaEBsiQFOlYCDJL30rdCZumT3mmD/ta4/CvmNHHqjbToocf4ACH0vdUZ4w7sylY4ZinAA3H1l6Wx3bww+APkodbAiOQg4MtmWmAYsGbMqjACQ6crdUlqlEiO0N9ENcMCeTTze/SKoCKdqtA4YIJnyHarVIRP/OntFOCKzlOUHrdAl9QQW4VSz/pSR+YGWTHtBt/W2FN701DXo7LFJhAPQ7GHItlxT2ybiwLpNoQ9mnBd8jp1IHZxo7gbyuqWLXcKb/j8PgN1sWNFYAzx4vzNi/GCJAU5VO21LzKF2zqlads7B+kbWut8Y/x6VKLQCCPMM45bwhndlKh0zFOEAOPrKstX3psfEcQs8kzpYlBwE7x2ZbEtMg7BkzKowAsD4D6GYSqmEId8bSiis28RNBLS9CKfXaB0wgOnyHarVIbNNvIXzTLYinBYKW1B6rQ+DinB6s/6UkfkBI/f3dr2uMhDhAKj5w1CPxSKcCndwaHrstE6Eo+aN5wH3WtvemMDXli42Cm/6/zwvETmwlw0/lTa1vN8ZakBshQFOVTvtRMyh7pzTa985h3c32Sm/Ma4FLFJoBRCUQpdrwhsS1lQ6ZijCAUig0jE97U3Z0P0TvJE6WJccBI8dmSxNTIOwZMyoMAIgMUvGBEslmmtvIhrggGXVvYmLcKpG64ABzJXvUK0OGW/izZxnshXhiMySXfZ07UU41aw/ZWR+wMj9PVivq1RFOABq9zBkoQinwh0c2h87bRHhcOxE6uCK8Ibjrq8tXewV3vQPkN+ArWy4q432ZuDI2mPobSJrA5ydJhFzGOF+Y+E5p4X1TQfyGzn/Rjs8uYYjJIDpe2n2whvelal0zFCEA5BYpWMK2ptA90YajQupg8XJQfDSkcnqxDQPeFgyZlUYAZCwJaP5UgmzvjeUUFhc3ZugCKdqtA4YIPk0KdXqkNIm3tB5JlsRjtopbCGj1oetRDjVrD9lZH7AyP09TK+rlEQ4AAEfhuwR4VS4g0OIY2fGIhy1azwPuNfa9sYE8qili+3CG3KkYDmbAlk15sMAZ6cpxBsayW/sPOfw7ibb3G+MiwJLOEICmL+X2iK84V2ZSscMRTgACVc6Jq69MXL/hFxLHaxOTINnjkwOJKb/SuSEJWM2hREAqVgyGiuVCKC9iWKAAxZX9yYiwuk1WgcMkGSalGp1SHUTb74RZyPCEZklWW5P11iE05v1p4zMDxi5v4fvdZW4CAdgBH3dKjR7GMpchFPhDg5Rjp3ZiHA4dnLcdUt4Q2Lfp5YubghvyJGCxWz4Rkvpb8V0A+JMDXB2mkbAodE5p9fic05D65sy8pvcvNEWaSkHYPJeapfwhoQ1lY7ZiXAmvkMrf0XwwBh9m5Ls/NRIe2Pm/gk5lTrYn5gGfxyZnElMg/JvydhXK0QrlC0S4Zxc1q1Fggfm2JhkqUQSvjeUUDhS3WtYhFM1WQf82av01fMJHphPk1KtDhmcZtvtyKmKcBRMYQsWtD4cLsKpZv0p65DK+u4GfWRXggcR7+/aEr3XVYIiHAA1eCFts+SyEuFUuINDrGNnqiIcBWs8D76619r7xvQSkcv5mnRJeLP1cwpgGRsuC6O9cd0Ap5OAQ3P3G5vPOewpskR+k8QbbSnZBVTg/AHe3EttFN7wruzPS0mvTWbrPJZAMj+EpDo/tdDexL9/gvImdXAmMQ0eODI5lpiGXFsy9vUPNg9YMibbrDHCAECpdjCN+BMIo70JbYADjlT3GhPhVE3XAQMYTZNmWK0Ovp9mg23NaYhwRGbJPXu6QRFONetPGd80iHF/HxwUY33NEhHhADRczKUASy7lXFOFOziYOXamIcLh2AnN3Wttf2NCfpNfCl2uCW946AQr2TA7nPbGbQOcTu10OjGH5vIbu885w61vyshvcvNGW0pSeNOfet7Erxxyfi+1V3jDG4w/LyXVLHuKN80AAsh8paPhit6W2hsD90/IkdTBscQ0j3y5XpOFooOJacipJeOg8GaEJaNFIhyALDqYhvsJJOd7QwmFg9W9Bga9GIaApWnS7KvVgcxS2QIRjsIobEF2tT4sdNX22S4L7uMAYe7vwwclA581wyIcgGbym4BLLkXtTZtG3cBHOJ0+mIa0NwPrGXxyr3WjuRvQ0sUe4Q0PnWAfGz4mbYwiF3fSAKdTO32KmEPzc06v9eecTvYUyQr5jfEX2WKSwpv+AfIbyO+91HbhDQlrf15KqhnXNTbOAAIoqUpHMxW9QbQ3Me+fkI8MYNHBxPRfiZzy3BTKxcQ05M6ScbjwpokloxUiHIDsOpgG+glE0t6EM8ABB6t7Yw2qNNcH69KkVthEsJjZxMMfJs2LcERmyX17uqoV93G+aRD8/t54UDJ26TYmwgFQoxfSYsgll63vDXdwiHrsNC/C4dgJjaQObghvSEbR0sU24c3W7yqAHWw4KaL2xlEDnJ0+T8yhnfuNE+cc7/eUbbIvtOp3Njf4IltKUnjD+QM8l+BnLrzhDcafl5LerHuKN8wAAhjirQ83rnSMVdEbTHsT9/4JykVVWcnBxDR46chkdWIacmTJ2Fh409KSMWMRDoAhZnwzYgfTVj+BpH1vKKGwia/up8+uSsUAp0pzfbAoTWqL8IbyHeiOfqo0JsJReIUtJM9H5uu7H810n438GgvQ7v7e6l2paPj2HV+Es/gcTfsGwYNG7jcRllzy2ptWjbqBdZtOH0xz2pu+nuybUUPS93eXhDcko0RLF8uENzx0gm1sjCUXd8sAZ6evEW9ofu4eJVXUV3XnnOP3nrKNDR2YDItwSkkKbzh/gLcSfEuEN7zB5IOeNgqcvh6pmnVP8YYZQIDkn1giVvSG0t7EuX9CjqQOjiWmwTNHJgcS05CLQ2lfd3PhTQBLxsxEOABmD6UGSyXiaW9CGOCAPDPA6aW5PliRJrVLeNP/5wH53T4/3qkyrghHZJbyYoDTa4Hwpv/T+jKRg+ZfvC3tFDilRK7hcUU4ACGv4emJcCr0ZYP0jp1xk6scO0EjOn27JbwhGUVLF9uENzx0gk1seFfzw0Yl+QbE6Rrg7LSAgEO7DaX/qdShc04H8ptMl0v/J8aYCKeYpPCG8wfIPwm+VcIbqs1ywar/0oSJzYU3W6RuqZp1T/GRGcBXpE6iB0qt0jHETyCk9ibW/RNycWErFB1MTIM3jkzOJKbBfW7dopM2G7BkTPvU2kvoQCbrJ4rmSiXS8b2hhMLp6t7IgyqNXSDjNKmNwpv+P083kfM7uWTieBlRhKOoCltI/fk1g3028mssQGv3m9b391KC9/GIIpwKkYOI1/DERTiVkI26gY9wOn0wDWpvOHYidbDwjQnofG2P8GbrBxYgazZMMqG9ccQAZ6e7CDgoUMO7qmvnnA7kN3b0RzQgwiklKbzh/AFe3UstFN7wBqPc9iobFN4MrXS0RYTTKZU0oVerigQPTLDJXOenaNqbyPdPUC6aQrmYmAYPHJkcS0yD/KjgqZpu1hhfe1PUyb/Qre8meGCCjSa7FRRMyDCCGuCAo9W9kQdVw4eBzz6mr+5D8CBQmtRe4U3/APmN50dZc+fMcCIcxfiqg+yzp6taILzpkMqaN1kzHyV40Pzy3vr+Xkz8qSicCKfCzQWat2YzsuTS8b3hDg6mj53hkqscO8EOqYOZNybwvPO1VcIbHjrBDjbsZEZ744YBTpWAQ+CGd1XOOUJ+E70/YiwRTilJ4Q3nD/DkXmqt8Ia2EHmsdBwuvGlU6ZixCKe+izNAFqnqpj+BqNqbiPdPLoRIHTK8sEG+12TRwcQ0eFLBUzXarNGE9oa2oyCzbRGM35jKyQ9wJZVd0u6+nuSD3ou1MmSQJrVdeMNKhs3mD5yBRDiKp7AFC+3perMX3nDXhrAN3RoMSim9GQUS4WytFQNoKL8xuORMa28aG+AAH+G0HuWHJFclnJNBWUsdTL4xAY5M9ghvuHyBBWzYzqj2xnIDnKp2+jkxh8AN73o55wj5Tdz+iBFFOMUkhTecPyD391LLhTe8KytXlY6NhTfNKx2zEeEMqyQDUGap6uE/gZjam/D3z4ePIXJIHbK7sEG+T6QlBxPT4EkFT6+5Zo0GtTdowsHgvczcjSmocU1sA5zr5hA5u86W/W9IyYpwqlgrQ6ppUjeEN6xk6E4qKdpKhKPYX3Ww0J6uaofwhrs2NOekq3XbzHb391KqjdtaKSLqf4AAIzNRxQR0X8n53rCSIcljZ4vkqoHyWUDqYNsbE+DIVLasKg8gO9a/pr5SgPtUPgxwqtrpt8QcFMLOuurYOafrm0J+Y6n7eWgRTilJ4Q3nD8jxvdQJ4Q3vynmhb3Nz4U27SsdURTgjuzgDxOatV8RKVQ/8BGJrb6LcPwGpQ4bJQcCRybbENChvloyNB1VDzRrNam9YgWCCGceGtmTM3veGS5nF1b3JinCqWCtDSmlSl4Q3rGToTjY72kCEIxMKW7Dm+TXZfTbyayxA5Pt7Md3Gbc0UEUNrxRYfq2l3EDwY4X6TkPmSIe1NAwMcYN2m/IFVEyOmUANA6mDbGxPgyGRbVR5ARqx/Qdokldvfp/JhgLPTBmIOwQ7dR46oT3DlnCPkN3a7n4cQ4ZSSFN5w/gDaQmQrvOFdmUrHNEU4DSvJAJRZezPV+d6kdG8kVY3UgQsbOO7IlOCpFfJ0KG1xLq0aaNYY99Q6UnuD/AAsKPppeGNKyQAHZG91b1IinN4E6oABhlKouCa8oXwHNqdR+zgowhEyWtcu2tnts7FeYwEi399LaWtvGigiKnz3INhNPDnzpbJp3xvehiCtY6dJu0U+v0gd7HxjAkrvbKvKA8iKTXVLse19ynEDnJ02E28In83rde2cI+Q39rufBxThFJMU3nD+AO/bQmQsvOFdOTf0tFPgVFPvKR6si/OEP2vV64kfxGNjXO3NgO9NOvdGUtVIHbiwgZx0ZEr81Ao5O5SGt2RMSYTTUHuzRSf/ULd+kPiBDL5wuOF7Q92PfVz9e503aXiMzItwqubrgM/r0NV/IYCQTfkONhEgU/W7aRVBGlTYqkjk0uAjR+u7P8xgn43/Gjvv45r5LQIIalz8vaXl/b2UjfZmsGisWaMrALPd2SKIcMIXMg43HgGOnVlob+Ia4ICQOlj2xgSU3tlWlQeQBesfaXy0yKYBccIGODvzQ4NoYoqqa+ccIb+R9e7nAUU4pSSFN5w/QP6+K1shvOFdOS+sfr3GrzRW6WhehNO6kgxA2bWJ2qq9KWdx/wSkDlzYwAVHppROrZALbvugTloQy5IxWRFOE+0NpQ+gzIsnmt+Y0jDAAbsNcBIR4VSTqQNGfgOpl+9gEwGGt3K3GpAjo7XWAKdqhfCGFBAEcr9pcX8vZqm9GaiS6eG7B8n70IYV4RhpIg6sW46dkF+pQ3pvTEDpnW1VeQCps/7+Ji9TlYwaECdqgFMl4BD1ra3q2jlHyG/sdz8PKMIpJSm84fwBXr4rWyS84V1Z3vQqq6bYUzxsF2eAGLz15BiVjnXam1TvjSx+pA5c2MARR6ZUT60gPyp4qubfkoOeWltrbyh9gHjM2CNG8USGvjcsfgere82IcHqTqQMGSLF8J6lqdaC9S1pFkKYUtpBBy8yE91nzr7EALS7vje7vff2DUnMFQjramyaNrhZP0bR7iR8Mld8YN19qJsJRsNLAtgY44Dfm+2B2BNXexDLAASF1sOyNCWjpYltVHkC6rL+rpfamnC8DnKp23omYQ5ib4sVDe9a7dc4R8hvLk7/BRTjFJIU3nD/As3dl24Q3ha3JF6DSMSERToBKsgl/0KodiR9EZZM57U2698+HLyF4SB24sIGsdWTK4NQKHlTwhLVkNHlqbau9Kevku3Tr0cQPorIxwRtTogY4191P8Jys7o0rwqkmUgd83t/r6v8mfpB4+U6y1eqAkZ1DDciR0dphT2dwn03oNXbeNzTzHOIHCtLQbUB40/8fldrZgCSsvWnV6AqgfiUn5tQ0/CegYKWByBgg2LEzWREOx07I2r02jTcmoKWLbVV5ACmyfkGTWqlKpg2IEzLAqWrnScQcYvS5q7p0zuk6VchvrE/+BhfhlJIU3nD+APnyrmyp8Kb/z0O6hErHhEQ4wbs4A6Rs0d5Ie5P2/ROQOmSbHAQcmWw7tYKwZExMhBNAe8MrMmTTLz9z3xs+v45X90YX4VQTqwMGSLJ8J41qdSDFlKL2xozCFuywp4u5z9IGEdLnpDW67Q1NhDc9dQ06e9IV4VSCNboCGOZ+k+SyHPgJdAUrDQxogAOsW1N9MMNrb6Ib4ABSB9vemICWLrZV5QGkxfqvBdPe5MUAZ+d3EXOI1+euisBYyG+MJn8Di3AGKre6OH8ARHxXtlp40/8f/ZXIiUpH8yKcUJVkAJF464GRKh1baG/SvH8CUodsk4OAI5Ntp1YQlozJiHCCa29YhxCVM3vUV0qyW0GiBjjgdHVvZBFOb2J1wADJlO+kV60OiGkdakDOVm6fPV2EfTZx4Q0fN2h3f28gvNlSqxBoYQOSivamWaOrxYdoGjaeUC+/ScG/ridQaSAJKIh27DQpwuHYCcrMvTbtNyagpYttVXkAqbEp1n3KLQOcnacRbwh/TVxU8zmPkalDYCwf5TfGL1FFzh8AEd+VHRDe8PRCpWNCIpywXZwBUntZaam9SfXeCN5LHTJODoJwZLLs1ApYMiYgwil0htHe8IoMilE2UUyyW0GiA3C6ujeyCKeaWB0wgOnynbSr1cFj+rpriypF7Y0BhS3YZ08XcJ9NSXjDxw1af/d6mnd2KzW3ASmnqL3BAAcC3MdT8K9rsA7jGOAA6dP4fTBjaG8iGuAAUgfb3piAli62VeUBpML68xoZOFcsaECcgAHOzh8l4BCJ8tA+d1UExkJ+YzT5G3xQ4vwBEPpd2RnhDU8veaKnpQKnN8me4rErySY8qVV7EkKQmaYOMbU3qd0bwWOpgxXJQRCOTJadWiF/h9LELBmDDnpDlzOevFC3nkIIITwbE+5WkKgBDtjH1d/SeZ+KGOKgIpxqUnXA5/2Trv43YghmyneyqVYH+V0H2ZGACEcJ62khLT7Spe++Fiw0VZuENx1SWfN+rpkHE0NQA93Club39+aSBvMinEr4RlcA9T3a0vGvM2iAA6zbmH0wOXaCNe61Wb4xgbxu6WJjVR5A8qyfGU5747QBzs6zCDjEONtEytQhMJbv7jfGL1ElCq0AQvwGHRPedPAbzA+rz9L4K9KudGyQAYzcxRkgJG8d0yZDHU17k969EbyUOliUHATvHZlsO7VCbrjtOzrp2DQsGdtqb8L53qCPhaic+Zi0OdluBckOIEcGOCFEOL1J1gEDxC7fybJaHeR3GXpt1zYmwlHyCltIkUKX1KO+tqHptUh4w6Ub1Na9ttn9vZ2kwZgIpxKl0dXigzXt54QQavKbFLQ3Rg1wMq8qAnuOncZEOIpkxMSxExTdvTb7NybwtaWLvVV5LxE5SJb1J0XS3jhqgNNJwCHqHfHBWreRMJk6BMZCfhPzabbxoEjOFyAohYprwhvvv9oe9SpLstJxMAMYp5IMINGuZqG0NyncG7kr+id1sC45CPLXkcnSxDR4UsHTm7b2JnQ5I4C5Wh+T3QoSMsCpEj+Ld/PYl5FWIpxqknXAADHKd7KvVgfP9/ShG3pcEY5S0dNC6j0Q24twqpYJb7h0Q+vLe7P7ezBJQ1wRTiVGoysASZtbOTWZ19CaMsABPr+R+2By7AQL3GtteWMC/1q62N4OG/kNJMn6w6WNRu9TNhvgdGrnzxNziMrI43EVgbGQ3yidp9nhgxI5X4As35XTKOcFKh2NiHBeiVUKNmGlVk0khBCCvk2BOz+F1N6kcG98eDEB9EjqYGlyEOSjI5PViWke8Dyp4Kla7HuzRSrr5AW69QxCCGHYlEq3gmQG160jflZX9xqJdWMRTjXBOuDzrtLV5xNCMHzmTK9aHTw/xDba0COKcJSWwhYy6oHYSoRTtUx4U5bKmrdBM3clhDCEk/fUrQ83v7+HkTREFOFU4jW6Agjbpi32Pm7KAAdYtxH7YBrV3oQ2wAHca217YwJ5VHpnu/CG0jtImPXvjKe9ccsAp6qdryHmYFRDUXXmnNO1g5Df5OFpdnBQQrAFkM27cnp99IFKx/iDTqkU+5wNEJj9/zDQHap956do2puk743gh9TB6sQ0eObI5EBi+q9ETlgyJqS9wQAHkuPMu4LWTMTsVpCUAQ64UN2biAinN+E6YIAw5Tu2CG8o34HNrTb0cCIcpainBWX5ft9YhNNrl/CGXBBEvL+HlzSEE+FU4ja6WvwOTfsVIfSdvm4VSilpb0wa4ADf3gh9MBu+h3LshLS6DNv4xgR+lN65IbwhIwpJsn5CXO2NWwY4O88n5hCd7o11zeubZ+qo4xLymxSeZgd729BSDiAIo1MxjDK+DUBeWP3vGn9yFpWO9V2cezDAAaXfZbypCCeq9ibxeyPkXepgf2IacswP99QH/8+9xPSRb9HdvyN6OeG2R3TSHg0qePpq6a2Clb43GOBAFDaGvzGVbRqArVz9MZ13vfmgD4pwqsnWAZ+3RFefSBhF+Y5jwhvet/xm7g8H+ry03tkDiXCUnsL2/IMJXarMXK15+zYIxHARTtU+4U2HVNZ12+js1wgjqEFPt4YKnKiShkAinIqhRlcAm6OaL0Xdx40Y4Cx7UVO3J3ie8uO5gY6dgUQ4sbU3wQ1wPvBxQidvuwzb+8b0EpFTvkvvXBLebP0sAyiVd6iKrcY1sefZ+S7iDfEoN/qBVKnjEvIbRTFOij9IWEtQ4PwBvva/t0J4w7uyvOlV1puK9qaMAQ4oQ2f24SKcmNqb5O6NncRPeasqKzmYmAYPHktITIM9FTx9/YPNA5aM7c3rTGtvMMCBLPuV1m5Mho1r4s9TlYqE0CMDnCEinGrydcAAFdeEN7xvsacXg548W4lwlK6eFmx6hx0U4VStE94M/nmQ30DDy3tDBU4x1lW9lSKiYq7RFUB37cZtRISjSOuQ91BI7NjZQoRT6OLYCYm719r+xoT8Jr8U+kvvHHrfpPQOEmP9tiPeoSr2GtfEnGfnnxJwMLCD9I1cbFXquIT8JtiZ2PhtqpRwqrdL2sQPH/zqf2+R8IZ3ZXnTq6yahvbGwDkbIAD7/6xVpeNARW9s7U1y98aHf0UMfRHfWp2Y5r0k32mFLteENySm81vBMyi8GWHJaFKEY8j3hhoICMWZVwXoV2qt780WXY/2Rq5W9xoY9GIhApmV79grvOF9i+NrKdwRtIEIR6krbMG+d9hCV22ftU140//neZkQwhBOPk63Xt9EgVMy8IrUQBFRMdnoavHbNO0RwsgOHtJ8KbZ/nREDHODYGVMqFty4xowBDnjmXutGczeg9M62qjwA06x7VX1J3qfsmqdKwCEum18v1fKrfc1fxKw952z7opDf5K4tYjHhVG8Z+Q141P/eOuEN78r+9CqrpqW9iXfOnvAbrdqPKEI7NtV9wRquz067743gQQbQgcT0X4kcvcZJTEOyfRyHC2+aWDIaEOEE096EKmc8+bu69SNEEYIdSsPcmOwywAHHq3tjDaqJnwHOW6Gr9yeKlO84JbyhfIecainKWXRQhKMs9LRg5zts1UrhTVkq67pJOvtxoggjfBi2NHpXKhl7ThpURFQSaJgFLOBiGPOl2NobYwY4wLEzaZsmjp0Q6UXJDeENL0qU3tlZlQdglHUvDHQlTvY+Zck8Ve38W2IOJrvaDRHhVB055yC/UeZNjvudzQ3epkrJpno5f4An/e8tFd6UpbJ2+a6eobYsL6z+H42f2OilpDcl7Q0GOJA0+9/arsv4Vt8ba41TIdcZQGcS00CvcRLTkCS39Wna5hCWjNFFOMZ9b1AmQDDOPFfqdtX3hpuXE1z9fp33s8SiX03lVACcSN0S3rBuhao2er40M4UtpM7MuzXvWDv22cifVgA16uk28v5eNNzTLaGGWRjgsICbGYmEEOHIROM28k6QyrGzfrmmaoADHtzfXRLebP05AKV3NlXlPX6OJn2D4IEZ1q0Z3pXY6gbEMecZrZ03EHOIy+YD6vIbw0Q4VZz9hPwmaFtEwyKcEqleACscMJPdBiDXvcr6eqRqvJ7iISvJMMABZZWY3qq9sdY4tZMQ5jYD6FhiGkSvcftOrSAPKnhaWjKGFuGE1N5ggAMm2RjxxmSLAU6VEPptgNObxqngvP/T1W8kigjC3RHebDUwAW/Prm41IKdy12YDnF5bhTcdUlnXHaqz7yOKMOLyPvL+XjLa062SZMMsQH4TxHzJ+D4e0wAHOHZy7ARrKHS5JrzhRYnSO2ur8gBMsO7B4dqbZO9TWc+z80vEHEzQ3CGqUMHZT8hvwuV8jYlwiomnegGEA2aGwht+hrmudBzYBbqlaoye4tG6OGOAAwmw/zUtE9N12htrjVMffp4w5jADWCg6mJgGeo1bmJgGHyp4AlgyBj21Jud7w7sytOPMadJml31vtuj6PQljLqp7Iw+qaR0PAEG4Q8Kb/j9PN5GTv/2M4hVBZqOwhay+b5bss5E/rQD19DS5v5dMa2/KGOBAMjt4AKempiIcGW3cFmoG4NhpQnuTngEO8KJk4RsTUHpnYVUegMy1JE7rPpXtPLv8DfEGE0fsI2vd6m3K1IXaa7Z9kDBmLr8Z8UUzIMIpJZ/qBcABM0PhDT9D5bPScVB4M7TSMa4IJ3AlGQY4oJS7jI/U3lh5/1SRKCqHTaFcTEyD973GLUxMH/lF3f1FgpdnS8YBw41gx842p9ao2hsMcEBJPH6EvDFZYYADykV1bxz7o1TOCed36CoKyyjfcUV40z9AfuMlcz8qdbvWgJzKXZvt6aoWC2/KUoeuO11n30ggYYCT5+jWmY3u70XD2ptkG2aB/Ha/CbYah4twZHodhplh2eOaOon4eceP38WxE3hRMvfGBJTeWViVBxCbdXcMPS1UbG9AHEt7swcBB0O0PjBXaaAs5DfRc76xRDil5FO9ADhgZii84WeoHPYq6+se4oEzstIxoggnbBdnDHDAKPt/tnlTqEbaG0vvn0AG0JLkIMjfXuMkpiEltjRS4FTDnT8bn1pT8L1BogDNOfPvm5dKuOB7w4XLIa7eTef9MZll0JtWHXCZSxDlO+4IbziOisb5cYsgM1DYQhbMvFbzZmW8zxr4tAJohHvtsPt7KQHtDQY4kJD8JsyyHBDhJNS4jdciSOXYmYEBDogXJfvemIDSOwur8gDisW5+S+1NvgxwdnkbAQdDR+yP1X44FmTqaKAst+U3zT9bEUU4xeRTvQB54dkvaeerXBPe8DPMHaur2jtYpWM4EU74SjIMcEDpdBlvob2x7f7ZSRTJAFqTHIR8M4bENGTP4rdr2g9HVPD0RqnaGXJqja29wQAHzBxK492YMjbAqRJF+W6AU02vDvj8HXTVUwTS9/IdN4Q3HEdF43ynGpCjp7XZAKdqt/CmLJV13YU6ew6BhKHym2H395J57Q0GOCB7xAwJrUN6vgDHTsiRe63tb0yQX/a5S4+d6tr7JssSYrPua220N7kywKF0CgxStiJTRwNlOS+/CfAiG1qEU6LHEkBKxqzZCG/KUod2eULP7E3wct2rrDdkT3FTXZwxwAGzCzuk9sa2++cjXURR+awqKzmYmAaWJYlpyKSCpxq9fKdvswqdKfreUAwBLRa20743W3T9+4liXqp7Iw+q6dYBg8c5UpeENyxX0fDFQBFk2gpbsLIZYkL7rHlNI8BWehrd34vJaG+Sa5gFiBnC7OMJNm7jGRRSOXambYAD1DhZ+MYELEv7qvIev12TTiB4EIV1lw5t/VZxpAFxtHk6tcu7iDmk+I5Wtf2cs+1CoihZ4X4T7EMWQoRTSj7VCyDfjVkzFN5wOxWVjm1FODEqyWKd1wHq2P+oRpWOQbQ3Vt0/Ia93uZKDiWlgWdopFwflrgVpAEvGoIPejAxDAOo4cwdps5kbU5YGOOAO/YUvfT2mRTi96dYBg7er1y3hDcuVhi9uNSBnT5fFzRB7rRfeIDiEoZx8j249aMT9vZSI9ia5hlmL99W03xJMX+U30fbxzA1wgGMnx05wucYp+zcmYFnaWZUHEJ515wbV3uTBAKdTuxxBzMEYm+dk8CJmfq8BSVbIb8J8/gKJcIrJp3oB8sSYNr8aG4U3fMflQa+yatCe4sNFOPG7OEc9r094WKsOIJZQY2NE7Y1d909QTnUORQcT05BrfnCdPvTPTiamj/yh7v4gAcwRW0YocHqja28y8L3pkbbo5G/q1k8QS1DTNqVO+d4gKnOOq17W+WMSEOFUU60DPv8QXXU/wRR1ErYLb0iQ+srcfZtY20UtgkxNYXv+HKKXGTM/oXnz0thnkxLelKUOXfdtnf0xggka0tOt/v5eSkx7gwEOyGjnl2LEfTxzA5xlv9RU2n77xL190ZdrtgY4H7ib6MkLmxGHhDc8dIrSO4ur8gBCsm5GSO2N4wY4u0wn5pC6YqJq/TkHJGUvv4n0QWwjwikln+oFUL6elkuuCW/4jueOJ/bT3j+JXuk4KMIxUUkW57w+4TdatR/xBO3/1hFdxkNpb+y4fz6CnMz7rd+u5CDwXkJiGpJn8Uc07fJwloxttTeZGIac/F3d+hHiCTrjVfUZ7VaQyXq+/gwi6erjgUkRTjXtOuDzp+mqxcSS46jdwhsSpPK7a75zDcjR09psgFO1XXgzqMD5vs4+jlhCnfym/v5eTEp7gwEOWLSPY4AD6S7XBn0wOXaCPfd3h4Q3W38pwPu7hVV5AIrU9M2C+1QK8+xyDvEGk2y+Mb0XseT2mm2vJpKyxv0m6newqQinlHyqFyBnV9OSY8Kb/j/PrhVt6CZ++e1VFr7Sse8VM6Vgcc/r4D37vzmu9saW+yd4vPXbmBwE3ktITEMmFTxVl3xv2MehnjP+T+o2360ggwHI7epeMyKc3izqgIHjqOXCG8p3hLWdsSLIlBS2YO2DbK8Dwhu+ezCMk9fp1jED9/e+/vt7SYVyYtqbxBpmLX6bpj1CPP2T30TdxzM3wAE/j51tRDgyaVxjZh7AvdbONybg/d3KqrzH12jSXsQPgrLu0DpP5opjDYjDzrPLxQQcTLL5noF326RfxBLfa0D2yG/i3aYaiHCKyad6AXJ2Byg6JrwZ/PMgv8kRT0zV3jfFqHTslEpWnNcxwIHhZRDRtDc23D/By63f3sQ0iPcS+xLTHVJZR67V3eOIX35Y/BVN+6eIlozNtDcY4ED2HcjMdSvIYD2Da1z1e50/aXgc44pwqhnUAZ//T7rq34gnx1GLhTeU73jJ3I7aM61bDcjZ0y1g5tGa90PD+2zawpuyVNZ1P9fZBxNPkCRtrglvNktbpJL6uqWOwCKcijUNs8CzddveqUlZrMNg/+Cyn2rqe4miF9y7avixs7EIh2MnKCfutWm8MQHv79ZW5QEEY91BEbU3ThrgVAk4mKYc2K2kavc5B2SJ/KbLzCVqiAinlHyqFyBHPHuAdn7CQeEND8zKe6/x3tDaG4vO6+Ax+3cOzUdH1d5kvp4feT/BFObXdiUHIfeMcSoxzauJ8l4JEc2S0RLfG16aQTpjRd0riLu+N2VdfxHBzIMBjgERTjWjOmAQ5TsWC29YpV7St1kqqpCA9iYNhS1Ya4BTdUN4w8MQDP8kbhl6f69JGgKJcCoWNczCAEceut/E2McxwIFspWJDRDhKwLjGyDyAe62db0yQa/aZocdud1B4ww0LArNuQjztjVsGOFXtci0xB6OH6wfDVO5V7T3nbHsuwZRN7jfmHub7RTgD1YRdHDsAIt5O3RDedEhl7fpWbfg18fO+0nFoJRkGOJAhk19RX6mu81NM7U226xkwv7YtOQhCGGal8IZXE+VXEx7WkrGl9gYDHEiTM34qbWxwY8pkHcadB3JW3RtZhNObTR3w+ZfrKjRglO9YK7zhIOonG6UO9XXXFpIrvjfkmuz50MXeZzMW3nRIZV33pM7ek3CCphe16I919/ehkoZWIpyKdQ2zFr9D035FSH2S38TU0GZqgANeHTub5UL7Npt5vuTYCcrUvTbtNyYgs2RrVd7Kgib2ET9oxbo31Z0NKk42IA4xT1W7zCfmYJLN6+rKD0y/iKW914Cskt8Yv00Vkz9/AOT0duqQ8IbfYy554jPa+/MhKx0bdnG24Lw+YaVWTSSk/rGprvNTbO1Nluu5k1hifm1fchAQhtkpvClLZU3t0DJe9XLE4sWaNiWkJaNtvje1wckLdOsZhFReV0g463szcCsEN7nqv3T+B9qEOJwIp5pZHfD539VVSBkp37FTeEP5jn9csVbaPHgEbSDCkcUKW3JNFjDzIM1bEX2ftUF4M6jAeUlnb0dIoVa/0r+YG0kaGohwKrY2zAJ57SgSah/P1gBn2X2aeiiBzDn33j3k2NlwuSZlXBN/Ho6dwr3W1jcmILNkc1XeS8QPmrJulCHtjSMGOLvcQczBNOWQv52qxecckD3ymyQ6IpRwhAQIyRgVig4Kb8pSh3Y9RhvuJITKYa/x3qjaG3vO6+AZk5+s81rtdMo4dcTgkVOIJx4j9iUHIe/8YKo+9J/uCW8KW/9/kN/ktYKnakx7k5nxCHjGGQvrKiRG3JjcMsC5/uvEU3k1wAktwqlmWgcMlO/YKbyhfEeetn0ZdhYdFOHIamHt+XcTP4sNcKouCW/4AMIQeuru78Wml/dBEU7F3oZZGOD45X4T378OAxxI/djpht1iWR9YS/zwGLFV/ADKf+ldiw6YlrfDXvlGTXyKEEJj+jY6cJ8yNc8uPyXgYJjNr0mbw3cntPKcs+004inL3G+MX6tKwhESIBSFLieFN1xTle/HkmpE7Q0GOKDMu4xv9b1xwjiVtxPhMeJIYhq8L3m0VHizteqom/jl91Dqpu8NBjiiQsJp3xs6GrjPVUt1/vFBY91ehNObZR3w+XfpqqMJKeU79glvyIvKy4LdJodSBxS2YAcz99K8tSH2WUuFN2UVOnT9tjrrZULqO9MnaNHPa6nvUpuebg40zAJ/5DexxQzZGuCAz8fO+uVqqQEOCI8RW8UP4GsHTMuFN6SYoDVr/zjQ8c3pBsQB59llBQEH8xQ61Bd2Zfbaes4B2Sa/Mf5CX6SjEkCqZbhZCm/4sueOJ76uvU8OUOnYrpLMkvP6hCe1ak+i6gWT/7PWZXyr9qbs7P2zSjw92PeLDiamweOSR9uFN2WpQ1PHa9lqQpgfFv9K0/YIYMkYUnuTVVnkyQt1K9Z2fnDG3FqFRPMbkzMGOBxKvTHACSTCqWZcB3z+L3TVu4moKN+xS3hDXtQzrrivznXZqQbk1Ok6YIBTdUx4s/XPc/0bddY6IipqxAcWc6llT7eKAw2zMMDxgs0jnJpkWeO2AP/gsns09QhimVvuvZZjJ+TNvdYW8QP4V3rnjPCGFBM0Ye2qWh1UxfEGxAHm2QUDPUiAl18v1Z5BQ4hwqraec0BWyW+6ErhNlXCEBAjHM3/SLru7KbzpkMradZY2XEkYlavUc+tKx4BdnC05r4MHTF7WQHvjhHFqw8Ej5xNS+dl6x/bENPjAaDsS05GrjkB5rOCpOux7Q7tx3zjjc+21Nw4Nrv8eIVUOq3sji3CqFtQBA+U7tglvePGSr67LTYogbVfYglV5oXKrfdYJ4Q03cdjK9MO16La6Bp0ttDcuNMxafLCm/ZyoeuB+02NAzIABDmR17EzQuMbEPJkXwYFV7rV2iR8g7+yzqx570U3hTYdU1srDNXE5YYRB1j44VHtTzrUBzmgCDuZ5eULt3bYnpAinauM5Z9uDCansc78x/kJf4rUVIOMH5gzKeSFPbJE2N690DFxJhgEOpMPkm6RNdYvTHePUpv9lwPXOzsQ0eGbN5JjwpiyVNfUQLbufKOaIHqm7uSVjVO0NBjiQEGf809BDqZXrMNw84D5XfUvnfyriwhguwunNvg74/Cd01d5ElfIdm4Q3lO/4xBULahUPLjYgx9TOMmZ2ad5rQ2PU66bwpiyVdf1BOutBoir0DOoZKmlopL1xpWHW4kM0jfxSfunrVqFkbh/HAAdMc+95HDtB+XCvtVH8AH4kl1wU3lB6ByNZe1/tyanifAPiIFKHXV4i5mCYl98pdTfQRwQS4fRaec4BWSi/MX6tKrKSABS917hzwpuy1KFdr9IG7BrywhM/0t4HNql0DNvF2Y7z+oT1WrUbgc0vzbU3Lt4/H/kqEfVL4eBQYhp84Aev14d6nBTeoBPLJYv/ohN7BtJbBad9b2qDk5fo1hMJrB+HUsd9b7RF1z9CRL02wGkgwqlaUQd8/ou6anuCKp/Ld+wS3nD+9HCjb1cEaa3C9vzVhNAuCl1Sj/rqC1UdFN4MKnCO0Fn3EFW/2SxtqXvlbKG9caVhFuR6ufZ1Sx3Wr0MMcDh2BtbeWGWAc+goQkhzYYvFD9R2+3DVGu2s8KYsdWjlqZp4M2EErb29ifYmlwY4Ve2KdR4kQbmVN0kbEU7VunPOtvsSUdknv+lK4Km+lHyqF8DvRvhWCW/o9ai89irrja29sem8PuEPWrUjcc0hky+Xultqb5y7f4L8qCorOZiYBj8oVJwV3nRIZU39sJbdQhiVqwqeqlRW3+a6z1Fs7U2GZZEn36VbjyauOeSMo+oOpdavw0DzQJ5OnrGvMIWKVLWlDnhWQVf2EdcccvH10iuuCW/oU+ANV/RnnxxtQE55rmx9D+qpE+FUXRXeDCpwpuusRcTVX6afo0WX1foNtdTeYIAD2bOxto9bvg4xwPGSe6dz7AS33Wttdx1BfkPpnRPtsMF71s5rqr3JpQHOrm8g5mCel48MtDKbinCq9p1zQHa63xi/VpWST/VuYuVA3njmP7TLMc4Kb8pSWbsu1IZTiGRe6KkreuiJ18XZnnM/5I7JF7TX3rh3/wS/E39WJ6ZZn/LMktE14Q2ph3yyRXpl8ETat1mFTid9b9jr880Zh4TW3jgwgLxw1SU6f66JhdFrUx0w39LccfH3pe6Ip9Dsq9VB3vQgD1YEaanCFizj7L/ouh0GYlToqu2zbgpvcAMDbe3pVgqmvXGkYdbiKZp2L3HNG3c+Jm0e2McdWIdkmTh2BtbeWGSAA/LUvdZ24Q3nVW+Y9IIe38NZ4U1ZKmvlbE2cSyQ5Dzh/nwqqvXkb8QbzvHyW1B1iHTYQ4fTad84B2Sm/Mf5CX0w+1Yv8BuSdQ6vNwptBBc6PteEwApkL/m9oo7IYlWQY4EBCTP5/0qZg2ht37p+PLCWw3uz4RQcT038lcv6uT2eEN2WpQ1NnadmVBDJHh9L68p1e6w1DMMDxjzPeJm2MeGOydj1f/xSBFQY4wwdVi+qAZ71OVz5PXPPDxT+RuqVK6GVmi00E5J0rPi51u9yAvP8bDrYa4Fiyzxr5tF7/KZ31deIq30vEAmhvHGqYtfhITbub0OaHO38xqL1xYx1igOMZ9x7MsROcLG1yQ3hD7zZK78outcNeebUmnkcgPWXtF2qZ0tw0IG6hvTmEgIN5Xv5MsB9RaxFO1a5zzrZ/Q2Blo/xm0Nnc4LWqlHyqF0C57jXuoPCGJ2fl0ns9tvbGtnP/hD9r1euJrvLznhdMe+PS/RPkTQVkycHENPjB3et05FtcFd4MKnCu0rLzCWbuynd63fe9qQ1O/qFu/SDRzdHVKWe+N3TPzR1XfVLnfzv2wqjaVQc86y268nfENg9c/HDtMSzMMrNFeEP5jgdccWqUIkjbFLbns7lbydlP6brx2e+zZj+t11+msy4mtj6y6HSpO4z2xqGGzZAX7lw+QnuTFwOcZfdp6qFE2Hnu3T+u9sYGA5xDJxBJeSVvcEl4w0OnKL1zrR02eMnaTweVDeTBAKeTgEMylGNZkgyIcKqWnXNA1rrf9JgW4ZSST/UC5PWOWnJZeNMhlbXrY9qwD7F0m702qa9UW0ImKsmsOvdP2KRVowmy80z+kPRKGO2NC/fPR/6DwHq34zuWmAbf+kK5KbwhB5EnTvxxXflOnfYmBwY46tHJP9atGIe6zxl/WzuUurkOG84zn01fGOA0GvRaVwc86+915X8TWuXkMSzwMrNLeNP/5wF506Kow8EG5NSOu2KA0+u88GZQgfMNnXUOoZWnvTMCa28wwIGUufM2aVOTa5H7BjjqIcIcOzl2gjLo9O2W8IaHTkrvHBLedEhlrVykidOJpV+snRHSssNpA5xO7YqFIyTAy3PMrOdCxaJzzrYFAiuL5Te1dWNMhFNMPtULkEee+ap2+aLDwht+oflgr/WDXcb7XjFTwmXbuX/CK1qFjN5lJv99aO2NG/dP8CnrVyg6mJgG+dcXylHhTVkqa+pCLTuFWDrMiUvqyndy5HtTPzj5p7r1vYTaYc4oxdXeWDqAPHLVaTr/tngLo2pjHfCsD+nKHxBeh7l4/dB7cdU14U3/n6ebSOaWKw6RNkcsgrRLYQu2cvYjuu4dGeyzSX9ar79ZZ51KeD1i0SF1jg2VXDXM6h8sPlbT7iDODnPnt5trbzDAATu49w3Rj512GeCAPGvi5pDwhodOn5h0nx4/1mHhDSvWT9YeK23K532qsfYGdRkkwMvfMvdUWrXpnAOyVn4z4qtnQIRTSj7VC8A11U7hTVnq0K5/1YbXEUu53aWs5nuTB8PKRoMJvVpVJNhOMvktUbU3dt8/H3mU2MqvplAuJqbBqxNp0WHhDZ3M8tY6t5H2Jh8GONqik3+hW99NsJ3k9E3q68zJOqwfzO8itsIAp/Ggamkd8KwP68pbiK6TXLxpRE+KqmvCm/4B8hsf0qT9N2JHhbVVAumCAU41J8KbQQXO3TrrSKLrBYsOiqi9cath8+JpmraYaDvJnXNbaW8wwAGOnRw7IVZdk0PCGx46Kb1zS3hTljq08qeaSAc3P1h7SGjtjdMGOLt+nJiDeV5eZPR8W7XlnNP5IrGV3e43jRZQLBFOKflUL4Dy3mvcTeENF1fX2et/pO5B7U0eDCubDyaWtJI8oGtM3iW69sb29Qx4XtufmAZvuHupjvyw48KbDqmsqT/VMhLTbnLi12rlOzn1vakfnPy/uvXtxNwxTl+fU98b6nV8qO6NvEJ67a0DnvVPuvLfCLBjXFJSX6X9MrNdeEMWNNdcMb6WJu2PsrMK21k7E0zrN+hU9tn0P63X/1xnHUyAPWBjDO2NUw2bF5+qaTcTbzmpauhyfx1igJNrlr+qvlJdZ+usjGtiz3Po4QRTfjV5cUt4w0OnKL1zSXhD0skr1r4tqvbGTQOcXS8m5mCel+8x/Wbaa805B/mNLJffNF9JEUU4xeRTvQCiHtdW4U1ZhbJ269B6qsndba7TOaSSLK8GOH39Gxa4w+QxsbU31q7nTsKLtYgLiWmgdZk7whvWrfJRvtNSe5MbAxwWqnOc/tig9iZX67CHNqU556r36/yfxetia3MdMDjFJX8r1Wq5+noaLzM3hDeU73hixijHFbZgN2ffreuOTXaf5UoOybFoJ2lzdO2Ncw3gFs/QtPmE3SXuPCcv65CGGh4cO/s2m3l25NgJct9aJMHKKKD0ruxYO+yVj2viJMKZZ9buEV1742JD7V2vJuZgnpcflDYn4OtoyTkHZLP8JsAVLrQIp5R8qhcgpzxzmna5023hzdY/z25v1PpnCKlL7LVE6h6uvcEAByxhv35leSWH61A9euR5IizvmkKVHExMg7zsC+Wu8KYsdWjqY1q2D+F0jBM/K232wvcGAxwXOf0XUndsFxFbB/P3JMLCAKeVOsviOuBZl+rKLxBgN7hkvPTK4OoaIsKpuia8oXwnv1yxbc2MUSi9IZUNupo74U1Z6tD1q3TWBAKcWxZtW1MqVvLYMKvJf2fxRzXtOwTfDe48NV/rEAOcnLJ8zeCxM0PjGjPzAB3cbBbe8NDpGZOu1uOXui28GVTgvKCJbyCkyrMK15v71K7ziDeY5+U10uYE2idVrTjndD5GhGW9+02wJRVChFNKPtULkGPGBOqIb7Pwhp+qi+x1fXPtKjIPFgAAhXFJREFUTa4NcCZ2aeUrxN929vuz1J3bdUiXcTruOJOYBp+4+6s68otuC28GFTjPatnOhNQZTvxoCO1NnoxHTl6hW/cn/rZz+g8baG/ysw7xY/SAqw7Q+b+JusB6ba8DnvU1Xflpgmw7l7yjsavtQFFXr2vCG8p3csqc19RXVKHDfd+bsma9k3g6wNk367qZeRPeDCpw/qiz3kSQ80nfJhXy2zCrxX9n8Tma9g3ibzt3Hpm7dRjsH1z2U019L/F3huWPmJF82zA4dCbxlHd9Bt0S3vDQKUrv3BPesHRzz9pt8tkIu/E8lEVBArz8QjLamwRexCLuNSD75Tdh1lYgEU4x+VQvgMcd8d0Q3nRIZe32Vq3/NRF1gL2ukTY21d7k2wBHPZo4Ris3sgrsZb8na2WOOV2HjxBjeSm/KTqYmAY/u5e5LLwZVOD0aBlr2AVOnCZtkjo98r2pH5z8mG7FrMliTl+YZ98blTWf8lwMcNp2DbC+DnjWAl15BjG2l0umNNbeJLHMUl2lkC/mvCBtlDryorAF5dqB1pEr+fWv6qxRxDhvLHwhzw2z2s6z+FxNu5ZVYC93HpzTdRjsH1z2S019F6vAAZbfP3DslCwwrok/D/B+ZLnwhodOUXrnpvCmQyprVUET+oho3nj6JfVVvLlPVbXrHcQcDPPya4lpb1J5qmi713T+giDLevlNpI9mGxFOKflUL0B+eebvtMtjzgtvBhU479P6/ySqVrPX5wNob8o5f0eZ+Lda+SfWgo3s93Cd9iaX65AeD+T7HEpMg3yt/nFZeLP1z3NURUu7CarVnDglivYmTwY46tHJT+jWvVkLNnL6N1tpb/KwDjmUesNVe+r89VFvLi7UAc+6S1ceTZxt5JJp7bQ3hpZZBqsUcsScNQ2KIB0esL+7w9nX6rrP51B4s/XPM39bzXiZOOeHhWty3jAryDyLZ2nalawFG7lz3/yuw8D/4LIHNfUg1oLVLL+DYycoD/Ibh4Q3PHT6x6SP6fFFzgtvtv55VpU14S9ENT88vSH/jbCHaG/uJ+ZgmFe2G2iflOD5NvNzDsgJ95uoi6ypCKeUfKoXQH61OnNReDOowDlG6+8kqBYTQHvjw7l/4o5SRSt/z4KwiP1+NER7k8t1+Os3Emdfs9IlBxPT4Bl3/z8duTAPwpvBPw/yG8vx2PemfnDyWqlLt3JCsInTL8257416NH8qccYAp92g15k64Fk/lUbrygOItEVc8tEA2pvYyyyzanXIWZq0Y7AI0nWF7SzkiG4xxoBVss1X8vmvk0Zrxmoi7TwLc98wK/A8iy/WtMtYERZx5w5SR97XIQ54OT12ZmxcE3ueQy8movKxz6BbwhseOkXpnavCm0EPnNdpwlMENQ88/VtfGmH3///s+ggxB8O8srP0iqSBTGkiIpzejM85nT8kznJEfhNvtTUQ4RSTT/UC5JpndtMuf82D8GZQgfNRrf8OgbWRvc6sFUDk9P0j7DwTJ2rlStaFFex3a2NlS67WYSdxlr8lj0UHE9NAYtpd4U1ZKuuo12kpiWlbOXGS9EpE7U3ODHAGRDgv6tbtWRdWcPq5HqxDepR6xlWv1/mbwq+rqlN1wCXNelJX7km0s+eSj9euEqUEl1nG1eqQF+b8RNosKUcKW3CKs8/Tdd/Op/Bm8D8qaf47NONXRNthFv5E2pTzhlmh5ll8qaZ9gXVhBXd2GNrHMcCB5Fn+NY6doJy43zgkvOGh00smHanHf5oH4c2gAuedmvAAgXWYp+/3rhH2rmsJOxjmlX2GFxUkIsKpZn3OATkhv+kys+yGiHBKyad6ATy4r+ZDeDOowJml9fiwW8Zex4TQ3vjzjjJxslY+yurImP3+vWVw87IOf70PoZa/TaFKDiamwXOpmOtVPv0KnLdpKS127OPEnaJrb3I8OHmzbu1idWTM6TO8WGzzzyLUGOAEk2m5VQdc0qw/68rXE+wsuWR6rTt+V7Be3VXXhDeU7+SIOd9vXATpsMIWea1cboGRP+FNvQJnimbcS7CdZOH3G2lv/DbAUY8WX65pF7E6MuaOzerr8GYdBp5h2QpN3Z/VYR3LL22vvXHMAIdjp8/yG4eENzx0IhVzXHgzqMA5XBOWE1cnefqOIT6iPtyndisQdjDMK+9uWlRgWIRTzfKc07mQUMsd9xtzb/b9IpyB7HCiqV6AvFMYnR/hDa/RdrLXB8Jrb7x5R5l4oFY+xBrJjP2uaCNoyck6JB/teaav5GBiGvzj7vfryP/NUZVPvwLnEC29n9haxIkVA9qbXBrgqEcn9+hWPr/ZcfqxfqxD/Bi95KqiZpXUF6qPQK+DdcAlzerVlUUCng2XHDH0RbkidZhcZlYIbyjfyQtzFuSuAXmPZn2CwLrH2afourvzK7ypV+BM04zFBNxBGmlvMMBRWYuv1rTzWB+ZcceztX3ck3UYZoZlj2vqJNaIRSw/L4fHzkO/RWDlaZ9Bt4Q3PHSKHgfOC28ovXOap+c31t7k+T5FQRSY5pUPti8qMCbC6c30nANySH5j/KJVTP78AZB3NryiXXfIkfCmLHVot6u0/nxiawV7HVg72Xvz/hF2nol/p5X/w0pJm/0+G/j9wP11+Ov3EXDhKOJYYhr8ZEzj5epqlU+/AmeallLoYwcn9NSKVrG7aTKYXtCiPlZK2pz+9wFqxPMymD+bgHvsulwZ6GIbtH2Ai3XAJc0eo7kbiXfaXHJgoxflipllZpHwhsewXDDna9KmmkdTnhS2IMeLw3IpvKlX4HxUM75DvF1i4ddo3NZqsPhrUkXTZrJS0uaOFYNiBo/WYZgZlq3R1L1YKVawfGabY6erBjiAo4gTwhseOn1l0gQ9/lyOhDdlqUOrTtWEm4mtSzx9bUvtTS7PsVXttg2RB2O88jFpU4iGngZEONXMzjmd3yTgckd+05XA430JR0gApfbQ4oTwZlCB812t/wihzZi93hxDe+NT/nrie7Tyv1gv6bHf2SFWpvPrkE4P8r4pVMnBxDR4yd0TdOSz+ary6VfgfFRLKfTJmhP+T9qcW+Mag/NMr2gRL9kpcvpbojcidW8dcij1mCs3atbfSuXAIpyqs3XAJc3eRXOfIebpccmbm7eo6GpZL1h1TXhD+Y77zLk0RBGkQ4NZVxNbVzn7vbru4VwLb+oVOOdpBmvVERZeSuO2YCKcBZp2BuslPe74qa/rMOQMy9Zq6jjWS8YsPyGfx85DlxNbeS2/cUh4w0OnKL3Lg/BmUIFzjiZ8g9C6wdMXttHe5PAcW9VubyDyYIxXZkubpM6g2hszIpxqducckFvuN8YvWiUcIQHsao1v1XV3tyVafyLRzYy9/jaW9sa3d5SJH5AqWrmUhZM4+x0VfmW6vA5/zWeQLb7kYGIavH9HyU+VT78CZ5aWXkl0M+OEJ6IrHDwcTK9IFS16noWTOKfv4NfKnP9VYu41V/5Js3YaWA/tRTi9btcBz36LNEZzf0nYk+WSMQEqAivNHcZ6XRPeUL7jOHM+FbQI0j2FLbjM2QfouidzLbypG8y/TBqtGZ8m7Faz8Fwat4X4pxYv1LRTWDWJc8ft3q/DkDMse05Td2LhZMbyQ6Job9wwwAF53GfQLeEND53y2wO8mB/hzaAC52JNuIzo2s7THw9aR5Snc+xuWC+COV65TNocRXsTV4TTm823vfNyYi7X5DfGX/GLOEICGGDDo9r173MlvBlU4PxY6w8jwhmwV8mE9sa/d5SJx2vl91g+SbHf3zWvvMnpOvz1Zwg7ab6IB+aME9Mgf/tCFUo5rPJRWUddrqUXEeAMOOF/hygcMMAJOM/0XbQI94bEOL1gJifm0DqcP5+ww/Dqn1YinKr7dcBFzT5Cc+8h6klx8atSV7CkU6W5JZdbwhvKd1xmzum51tyC64wZkjjKpfBmcFDS/AWagWGIrSycQeO20PMsvl3q0rQPsnyS4o5vtuwgjgFOk8GyFzSVNuRZsPxtHDtBue3a5pDwhodOj5lU0MrtciW8GVTgXK0J5xFhS3n6hPDHtlycY3c7xNWQ9Y1SX7e0WeqWmg22qMiPLi1euVHaKG2WeqNrb6KLcKoZfNs7LyXsck1+k4S9aQlHSACZNcHMjfBmUIHzv9JorZ9IjNPjzZvUVzZTwuXhO8rEk7XyVhaRefabGC/p7OI67CTsIHWF3t+tSEyDr9xd1NRKTqt8yjrqm1r6CYKcKif8GN+b6IPpe2jRUywi85z2Yu2u5M+KqhJ2kKQrf69Zk4avkMYinGouGvAXNXua5i4m8oa5eP1AW40QbZW7GjXtrromvKF8x1nmHBH6ROqQwnbWPCLsPGe/Qde96oHwpl6B833NOI7IW8fCY2ncFn2exfdp2qEsIvPccXmbhxgMcFoMlr2oqduziFJl+a6xEqGWG+Ac+gARlu/yG4eENzx0itK7XAlvBhU486TRmnASMbaLp98bpTV2Ds6xux3rWKT69h2qrhlW9zVysFm9s6VuqUfFb7PSE+SVpdJGqcOM9iaKCKeaxbcd5KL7jfFX/BKOkABm2PAj7Totb8KbwUFJu/1B63ckzmnw5icHDve8f0SeZ+LpUpdW/juryRj7/W3c6lsX1+GvsVmA/hN4ycHENIjOu3ms8inrqJu09DRinBInLGy8+2OAE3ye6eOlihY9wmoyxmlP1O5KPq3D+UuJPKh1b6bhIpze/DTgn/1RabTmfpXYm+Hi30S92ldGeOH2uia84VXMTea8K+9SW8gFhf76sNwLb7YOOjT/J9IYzTiI4FvBwoNp3GZgnsU/1bT3spqMcce5gTuIY4DTfLDsZU3dltWUEsu349gJuc4muSW86f/zgK9MfE4rJ+RNeFNferdquSYcTpyt4OlJIxKe3tyDdpvhUqT6Dq4Jb2r/M/u2BFPg9A+61Xuc1K3icla9eV65X+o2r70JJ8LpTfvb3nkukZeb8hvjF60iLeUAZF6FnyfhTb0C5xWtxwsiYd78MO8fxuaZ+Cmt/DprKi779qpQ9nId0mUctp7Ai+4lpsFnlj2nqePzW+VT1lHLtHQqcU6cE76Jg42xwfR3aNGvWFNxOe0XsWpWHB5wB4c6rnxIs97VdM0MinCq+WrAX9LsSzX3C8Q/Lhf/ZLj2Jlxb5cqIK7Nbwhv6FDjInEk5V9jOuo8g54Sztuj6N/ghvKlT4Kio+as0YwLxz5iF+9ZaNdO4LfY8i38hVTRtf5ZVXO44NUQHcQxwWg+Wvaap27CmEudHr5mpxbLWAOfQPxJk4X7jkvCm/8/zEpETpXe5Et7UK3Ae0IR3EuaMeXonHxsQO/fq1HfkcOFNnEHvO6VuFX/L8jfDK2ukTclqb4KKcKqpf9tBLspvuhJYo6XkU70A3rDhOu36z3kU3tRdA8Z2aB39URLjzT/h/cPwPBM/K1W08kssrijsu14qS92erp9f/wtLAGon8JKDiWkgMV3Kb5VPWUf9TBqjpdRDJMYJl2NcY3ie6X8vVbToXhZXFE5bInU0qN3xZP3M/yVLAIZw5S816z2tVlGhIlVz2IB/9tek0Zp7FksgChffFLT8sc2gq65wsOqa8IY+BU4x5w1+SG0hR5z1gq7fyw/hTb0Cp6z5f5RGa0YXSyAbFu4aXXtDA7imIpzHpIqmjWN9ReGOKZE6iGOA03Jwd0Gq6EjK0JPhR89x7AT5Ir9xSHjTP+C75zETH9TKQ/IovKlX4DyuCZMIdWY8vU1c7Y3D59hO7fZxB2LUd2pT4U0465sRg95dpc0q/pnfQXReebkmvCmnob1pL8Kppvpt75zBEpCz7jfGl2Yp+VTvJlYO+MQYY6ZSll53yxr7Oq17nkgb5s23Nk9J8/4Re56JX5YqWvkZFloI9n14aI2jZ+vn1zeyBKDuBF5yMDGNVtZvlj2kqYfkusqnLBV11FotpRjCNCeci19NgoPpH5IqWrSYhRaC075p6BXEzcH81SwBiGSQ3pvTBvwlzV4ijdHcw1kEQbn4mjbVfqHbKldq+ate14Q39ClwhznbxK4md0FhOwuFrejQ7PKVvGOIT90N20ijdeZfWASpsrDDwNeSBnBNRTjPatrOrLIQ3LGvVI54f8cAJ4iByd1/oyP5zJrmR48PfkitNa6JP89hGChBl2vCG9xrQSZL76ytylv1nCbsRKTT5qk/ShX1VXy9B3VqtwsdCFPfWcYcb5oNeovq61ZpW34ToXl1lPrq019paW9aiXB60/u2d57KEpDL8hvjK7KYfKoX+Q34xIYvaderciq8qfvzjB0vjda6hwi4Gd78r61S0rx/mJpn4r9q5SdZbu3Z90cNxGB+rZ8qqwCGnsCLDiam/0rkRN1PCnU/GRdQFnXUi1q6PcE2xgkfDlG7gwFO5Hmmf1iLbmG5tee0S71fPxxKoQlX3qNZR7VcRdXcCW/qB0XN/oXmvpuF0IaLP9vYOszAoBJlmWUvvKF8xxEu/7P6KmZqDW0fQO446xFd/x5vhDfDFDj9IpyxOnMdCyENbnmxpomlcVuS8yx+QerSNMydAnDHDhgxJWuA0z+4+0068o8sN2P86KdmJN8cO0GuuN84JLzBvRakiXdp5am5Fd4MKnBeVmG0xr9GwNPgqd8OPZJ5eQ/aba7tYer7jNQtdTdVzsS0vhk2T/U5qUelsfw+AvHqntJGaXOW2pvGIpxqit92kLPym0KX1KM+syuylHyqF0C+FjvmUXhT39Js7Ae07j+Idyze/HnyzqnOM/HfpYpWnsbSa8q+NzUXg3mzfn79AxYCaEhTqJKDOzV4z7KlmvrhvFf59CtwerW0SMDjcsIUM3UADAIOps+QurTo31h6TTntn7ypgWg+mP8nFgIoYpOmak6FN3WD2Y9JozV3N5ZCYy4+PUTr8ShtlbukTtfOjTyPucDlTw4+gedboT1rDdEWHZrzcCXvqP1hugb+zxsmS2N05s9ZCglyy5qBuxIN19KZZ/FrmoZxRHO+/9pABQvrJwUDHG3R3bvqyA2sOwP86K4G6zaXBjiH0dMdavIblyqReOgExS29c6gqTyWtfp3Gv0C8E+Sp5Q26FHl4D9ptnu2R6pvdSniT1KBb1QelHpXexW+lFa/uL3VLHVKPCmX1bc5SezNchFNN6dveeSQLQY673/SYFuGUkk/1AnjGhv+nXRfmWnhTr8A5RuvuJOYRefOngpaU8f5hdp6Jt0oVrZzKGhzCvle0aZjnyfr59aOsBRhxAi85uFMDKKm6H7sKKMsqlHX0GGm07nqGkEfkhHdEbI2PAU7MeaafK3Vp0VdYg0M47VgpTO1OXtfP/D7WArTiykWadXrzVdSbZ+FNfVZq9ovSaM1FiFvHxUek9b7VIXVKnU6dGynfsZjLH/BMDQ455ay7df2pySpwbPy0jvCpu+EIabTOXMyKMM8tD9JwLYN5lhSkik58iQU4hO8/K3WwftI2wFGP7t5DqujI37IGI/KjeRw7wTsKXQ5WIvHQCdLEb2nl7DwLbwr1Cpw9NP4pYp4IT91MA2KprN1utz1SfRe3t7Uxa30z5D/qVnWptEWlE/jRDOfVI6VNg9qb/o9YobPmPGPBibdQSePb3jmFtSD35Te1dWNMhFNMPtULII9V+HkV3mwddGjsmdIYrfs6UQ/Bm4+XyiHbOZO/Nj3PxB9JFa38B99X477/T+oIXOPow/oBGHECLxQd3KkBpGXf0tRZHlT5dA7kpo+eJI3WXb8i8iE4YZcGDZ8YpO2Ec6nUpUXn+74aT3ubVPbd7obyCAjFlTdq1tlNVlE178Kb+n97SRdUpDG64jnfl8TFk6SuiNZh0dsqd0jFmg7H/nNj/98PWMbl3298Is2xQns2osFcc9bNuv7jPglvugafioapZG+YKY3WmdeyKMxwy10NtngarqU5z5K/kSpSl05c7ftq/P6DUnmwipH1k7IBzoAI521SRUfiNhaGH13aPhGaMwOcwyYRdpDkbCUSgMKV3rldldeh1W+Txmj8T4m6MZ6aSwPiuvcCu+n7ktSdouNNs8FmVb+l0sf59UjSq5+RNkqbpe7ax6qmven3vRlwnrHhXTWdFzGQ6/KbEV9YAyKcUvKpXgD/2DBVu/5n3oU3ddcAFTX2c9JorbuA4Lfnze+JUuNI/jqheSb+j1TRyv18XIr7HjXkjYT1o7J+/Xs+UaAGTaFc3KkBjDqz217ls/X/lXT0B6QxuusOYt+eEzrCHQMwrkl0nulfk7q06CM+LsXTdgjfmyDv6+eGcXyiQMGd0husoqoXwpthjfYvGC+N1hUP+bgQLh5jgXyxPCDCKXTafW5EfmMTl38jdGIqJwPgJp6/K3lHk3+kpBs+L43RmeexLKJzyzwartk1z5J9pS6d6GX/l+/f3kTvzfpJ1wBnUIRziFTRkXfzpWzDjz7GsROQ3zhYiQQgTbxYK7+Wd+HN0NK71UdKozV+EcGPxVOfpgHxEGXCbvdbHa++OVJ3JMsaU9Y3QwfVOVK3Spf5+wt69eoGdjfDtDdDnGcyF+Ek/yLW+Q6+rMqF+02jBRRLhFNKPtUL4CdjWrlL5UR4M+xZpaSx35RGa91phL8xb35zvHoI8teJzTNxpVTRyt18WYr7HhijxjG/6+fXf+IrBU1O4CUHd2oASdKySzT1a35U+ZSHFOAefbruupH4N+X4/5Mq2IxY6YSzQOrSohN9WYqn9qiA/9JI7c3+fKUgKFd+XbM+22g59foivCl01PpV1RJTFxwijdYVS71YAJ/7c803zKr2zFUVKjU/HAvPjWANl3++fWIqlwrt2aMIfv4560pdf7k3vTDaKnA6pKJu+LY0WmeewuoIxy2Xtk/j03Atq3mWHCx16cR7fVmN3/8a69A6A5xBEc6xOpJWRM350bHh3kNzY4Bz2EEEHzTY6dvFSiQAtS+9y1s77FqGc/XHpNEafzXhD8dTR9eSpZw/t85T1W6PWB21vqvNiGqMD6rnSJtVut6vH9Gri2rCm3Ig7Y0tIpyEX8Q638b3VXmR3zRfSRFFOMXkU70AXrLhAO36hAfCm5HPKiWNvVMao3XvZxUM8uZOAyVl5K+TnmfiHwbKVlYWc7sU9/1bqRKrxjGv68d+u1XI8gRedHCnBlBcZ3b3qnzKQ/7Poz8ljdZdX2EFDOH4FYMNnzCcsXae6XdJXVJFi96d26V46hNSRdpM3EcMOvlQQTiu/KpmXdjoduOD4025aaP9Cz4sjZG6dMVX8xn3z/1Gsl++2CEVazoce86NYAGXzwzcgjSXA/CDsy7S9d/wTHjTWoHT74RztzRaquhMCoLbcctHw+z1NFzLbp4lR0pdOnFxbpfi98+tlTASd1sNcPoHd58kdenI+Xw+h/Cjd3LsBKhzv3GuEglAkjRxhlbe7oHwplHp3epLpTEafy6roD1P7d/EpNH78+duT1kfPEOWNQnNUz1uwJmn9JOc/4he/S9po7S57osUWHuTvQinmvCXHJQP+U2A6tLQIpxS8qleAHlf7Jhv4U3DZ5Wixv6vNFrrJvq+CvbcFDg3Td7ZmnkmlaSKHt+Yn3X4lk1S2UwpYV7j/mv2LGhxAi85uFMD1Fh2lqYu8abKpzy8uOfoudJo3fUJFoKO/7HUgbuIY4Pp/ytVtGif/KzDU/vXoc+lD+0GN7yTzxWE5so5mvX5ocup6oXwZrj1zYjElEq64FJptK74TH7C/bllA/JFyZ32zOWaCKfTgnMjZMrlR4Qug8iZUnf2rqwCjzjrHF1/s2fCm7YKnLJUkoq6YZU0WmfuzDJpzC3HDt/rabhm+TxLTh1oonHitflZh9+fFk7vzfrJ1gBnQITzMalLR17Ld1Q/2jWWR2gODHAOO4JVABouv3GuEglAjUvvciu8aVJ6t3qeNFrjT2IdNOapN8Q1Bs/x+XNswfbwWWt9M3zQreq+0mZpi0obcvULevW5mt1NdxPJTWDtTZYinGqS1jd78KFVjtxvgi2pECKcUvKpXgBf2bCjdt3sh/Cm2bNKSWP/IFW0brR30d/z4ZrqpluqkHd2cp5J/UYxXXp8pavr8C2sw2CDFa9ny4KWJ/CSgzs1gKI4s+ehyqfcoLjn6JukMbrraB+Df/w3a4eBRrU7GI84Mc/0JwYcGhdt7+o6PJV1GFB780F2LDBkmd7rgfAm+J+npAu+K1Wk0bpiqqsR/tw1AwkK5+WLW3U4Wa0KyIjLJ9tt1pTaSzAIN1oPruQdwf4LJd3wktSlwhid8RJrRZJu2XdAwkHDLHfnWTJr4P5+4nmursPvb12HYTRgrB8bDHAGRTizpS4d+QVPv6U/KnDs5NgJatBn0MVKJIAaEw/Xyl/6IbxpXnq3erlU0fiDWQ4DPPkXqYsGxK0GDmhvvi51W21902CwWdVR6uvWNtu4/Qvasp20WX1t7W7Ca2+yEeH0JvVJ76SVknImvwmztgKJcIrJp3oBPKbQ/77ig/Cm+TVAJY2TNEZrN3oR9D2/38TUkryzs/NMmjzw3vD4f7ixCN9ya62tOOswiPZmTzYraHcCLzq4UwPUsexwTf2FT1U+5cYt8I/+yUDp7V37eBH342cNSnAxFcnHYPpmFSpSlxZ2u7EITz13iBScCLbR3pzCfgXRuXK2Zl1Tt66qCG8aZ6gu+Kk0WqroigkOhPVzZ9eu9pXctWfutyfa6oeT5qqAdLl8jAHju9wodWfvz4rwjrOO1vU/TaUNop2Wd4G97BbsNLBBn/GIj+vklu1q9yYaZuVoniVfG9BOn+jIRe/7HQPCIeLuugHOoAhnzsBV4siZXnxL71k7cOzsqzhvXBN/nsNO5RQGjdxvnKtEAlCg1ga5bYfdqPRu9QppjMb7asXw5M9rV6cK58922pu/cSGiljvetBy89oK0WerWNpNc+hFtOUDqrtndFNtJbmJob9IW4VQT+aR37sDuq3zJbyJ9WNuIcErJp3oBPGZ9VbuN9kZ40/pZpahxuwyUPK59KIex3vOaNm8knPtzMM+kf6zd5br0+L9btwjf8vn2bcmIOy2gIMoJvOTgTg0Q2Jk9n1U+5VYt8I9eL42RunRXHp9wjp9WO5RiOJPfeU75m9qpr6KF9hWonTqlZtHQHbR2h7hzKIX4XPkZzfrXumsOwpvmJwEVdcGzAxmqQkVzXrYrlJ97TyvHsLwN6v1w0lkVkApf+WNdPYSQ2kpbpE7Whaec9V5d/7CXG25HaJWsSlrwnoENWhWdMT//y+PmFwZvdjTMyus8S24fiPKJ77VuBX5vTW2/7jLXMoO422GAUz+4e8HAd+bII3L4Ib3nPp9uTxw7QfHkN85VIgHUMXFfrVzrjfCmXend6hekigqjtfdrXkT/yW/XLk0NG71x/nSzCMpJ65tG87z2S6m7JsWZbunf9paTapKb7iZSxmS0N+mJcKrJfNtB+XO/ibrImopwSsmnegH8Zv1ftdvu3ghvGl0DCv1pr7pCh3HvG3xEWXudw8Hd8/S63HSQ2jLO/TmaZ9KnBt/GHv9MZovwLUeFf6Ij7nWDFW9nm4IAJ/CSgzs1wFCW7aep64crcHJe5VNu+V8oSiUds+3AifTOp9yO7/Hj6wocsRnxbHDKOwZrZRYuzmwRnrqD6ZIdzwY3fJKdCgxw5Sc169vSFqkX4U2wmUtSly7cYTBJNeeX2cTuc9vWXe2jbuVOt2ceosNJdFVAknzlJ8OXMQrbrYPZh7JA/OWsA3T9kx5vuO2sb5pKcT5VJ8X5dH7Ww833Dc/n0zDLk3mW/GKwuduJO2e2Ar+3cPCPUf+sSbxyaYAzbHD3fQOhP9J9R757vtbq9uT8zSjePIedy+EL1KDPoIuVSABDmThOK1/0RngTpKNBSU+MHrw07f1gfmL95My6R892jsqcP0fqEMbuJaxvMhm89q1BKY66tc03Mv0LnlNndLO5sdKmUFbf5sS1N2mIcHrNf9s7eUpQLuU38VZbAxFOMfnUKgCMGfJby7nwJnhjs5JU0rh/rpPiuFBytOfkkJIbzv0ezDPpX+vKDfu9cf4ukeX3ls66S2bUrnjEa1B7cxz7EwQ7gRcd3KkBRrBsN0190buy2hb/hQGJeEkq6pjJgydSdenOWxwI6HGbpbIKJiQ3lEXmZp5TPjz8rLgwmTK1D68YcvQlXjHnueEL7FEgw97pVYQ3EV1xLtzq3zVm4EM350vmo3TRA0MbjVcimt7nc9Avk97qh2N8VYBRvjI3RD2Ez4PZJ7FYeCFK5TXW2g03zj/bL8W5vvapqV3bz9jHpfjffHW7fD4NszybZ8kLtat07UB4QjJ9Yb73Ualj6Jmzh3j5aIAzbHD344OrotClD/U58CG951SOnYEGh13GqQuau984V4kE0OhiVSh6I7xpeZ8a0gW7JJX0xCF1Upx5LkX1yXEjMqVhHz05f9Zrbw4S1jeWzPPaqYNSHG3WNg8n+Fe65cHav2vT4L9xsDFrC4FNOSXtTbIinKrhD29ngR1XeZTfGHqHGyLCKSWfWgXwnvWPare/90l4U3cNGG5901qKc8PwR5T+/3Pt69MO2R7/MzwlXahElNxw7vdznkkPN1k/Famixx5tuvb2+fcRApthA/6eDc2z4ix2Jwh8Ai85uFMDNGS0CiX/ympD1t2qpGM+Xtt2Rw/uwneemEHEjvtao/JcXG4YBPfG+Warg+XCrqZr78Mzmh9HK/z1GvW9uZbNCUxy5WmadZtURXgT7F/R1cYoTyVdeFXjVNWAOKdJwuqi41te7Udkljxvz9x4UO+HY3BVQFS+clDEEynKalVZPqCz3qDrX5OKHitdw27E7a7tCzYMfIsKoxtstaffm0GUbx4f/QJFwyzmuX18q9PjCRc1XXi3vzigoGj8j2+WxN8zBjht5vlBo4X3oeWZbZr3jDKQCPX0hsWxE9RSfuNcJRLACCYWtGo7n4Q3EToa9Etxzm2cz9z7kAyi9vubh2pohw4K8WvwOH/WDca64r2cR+ubtoPX9hwUxvR1D/HJGRz0qDy98d9Zz8HD//t9m4b+48VaXVNbyU0QA5xktDdJiXCqJr/to15jv1V+3W/MreN+EY5SqL4CAEmjEynetVd4E7OxWWmw0EFFjevPJQ07iNc9qzz971FissfpzUvKRqSkOa8zj8F59jmweRUOxqnpzNPJtgRhTuAlB3dqgEYsK+qoipf97Fv3hWqXpx7Q5Cxvkheudce/Y3XEuBw3PkR5LuWMzGNwnlN6hqvEowls+HuOPg+FEZAAV56kWXchvEnKHqf+bKCSLmz2Ie2VqlKVgYmBao5/XR6V73x5r5Y62JaDSyK1MbpseYMJC4hvTQxmf4KtCSTprG00f1u/N9yEpi012KNvPKHRF7Ku8uz090YJ4k33NWiQUTBlxUDDLOZpPrj96nb92vh7xgDH9OAHR7Y5dn7oiIgb4g+vDnCy5SQZaXDYtzhwgZr2GXSxEgkg09I766ryIjxxjshnPvHgiCfOoaV3e/0ySkx+v3/Lnb21hpZzo7l5xs5w40fc9y1pU6DkcF9V6jaQZHZpnlfU841Gspx6gU0potImhAFOwtob8yKcXqPf9hfZa5Vf+Y3xdVxM/gQAANL6H2m3aX4JbwrmnlUaXx7qjhS7z5K6pDF6+jNtArHHgXXCes7rzMM8vs6zgtIHCHUCLzq4UwOoqTN7GndAC8tqk5u/luo69sDBPPUdi9vE4dieWq9fHGwYMPB4cMONbEuQ8Ds0wpuy0Y77zJPtPEZuUpbxpYeb+G/H2GK+/NLAPBe/3Obfftk1df92lLEJzYPUFiwrFMv4AJDtRlNXeXbjwwP399N3bh+3m77WqkEGja6Yh3mYJwcGOBHm+cF9g5W1H9qrzYf0hzPaHDsxrjEwD8dOaOt+41wlEkAjJjynVRM8E96k2NFgzeEDpXd7LWgTiN9vE6P0jnNjAvOMPdedn3Fg3UhTY5YeQwYvzNNwnrS0NyZFOFVj3/ZRL7DTKr/ymyQ6PZRwhARIifWLtdtHfRLeVJK/Boyofdz9uwOvJk9PHf73v8ffRjGn5rzOPMyTv3lWXMKOBCFP4CUHd2qAJix9TkdNykyBk3GZb4S+UFEl4seeLY3RHdc2CMGxTwx4LVLOyDzM4/k8N9zPpgRJceX7NevhVgocHG8YuDqIf6XKmi9d08Z/2+DgsjED/66L1wz/Y1z2qcT/7Qz6B7O/wKYEg8x4XvPHZ6nAsWLDtWpbKenGfsniGJ320vB43XRubeuh0RXzMA/zeGmAE3zwg7VSRR96Q4O974eHcOxMaXDY7Ry1QG3kN85VIgE0YcIqrXqnZ8KbuvtUsk+ctdK7NecMlN7tdfHwv/81G6SK+rrMPJ1wbjQzT6dTv+FyPGMWUwYvzNNwntS1N2ZEOFUz3/ZRz7LHKu/uN8aXb0k4QgLIsv6juRLexH5WiXJ5KGn3/5TG6OkDJGn3Vzj3Mw/zME9Ne/NVtiIIfwIvObhTAzRn6eM66h2+ltWWU1WGH/t5abTuOH/gb/7Yn0pdeXhTZ8CAgQHfm0fYjiBZrjxAs55scI5FeIPVjPPzxLxbpc6Xptd1Aw1wFExC+XnZJKmiix+UpMtOCHciRWEbZ57Z89iOYDgzVmv+OzJQ4Fh1ALBzo7lpJ2m0TlstSTdNkzpCtHKjYRbzMA/z+GmAM1yE86JU0YdqFVU/nBA9EYoBTth5DnuAQxaoTZ9BFyuRAFIsvXOoKi/Vf2NJa74mjdFeMyRpzQNDrkic92yZp1NjL3Tmt9u3VNqI4Yyt82SnvYkrwuk18G0ftZbNVR7Ib4yv2iKOkADpsf6r2u3LZq4BLglvsmpsVtTuTw6k9jivMw/zMI/KWnEdGxFEOoEXHdypAVqy9Fc6aoqn/ezT6As1tJnusd+WRje+zlPOyDzM4+c8NzzFRgRpcOWemvXnwRwUwhsGeOCkeVH60uSa5KY7ma5q4QeXvSuZByYGzbQ3NCCHJsz4leZPSU+BY+kBwM79paSb3hHVpYGGWczDPMzjtwHO1sEPC7VjMGfC1HxvVnG8gmDuN85VIgE0Z8J9WnVC4gocS6vyyik+cW41w7mjiaqW817m83Rq7Fynfr1FDGcsnafQGdV5xgYRTjXut33UGrZWeSC/6Upg1ZZwhARIlfWXaLd/8U94E/UaELc+siiVpJIKxZp9Qe3/J9qAeZiHedyeByDaCbzk4E4NoMCtoXyr8unM4s8Qe3djwIBBrgYAaXHl6zWrB+ENVjN5nCfybStJvrRN7c8Wz/AQRWse5ulkC4JWzLhX80/wVXjTZaZiLKmNhgsLAwYMshrw98CALBMoYfmNc5VIAC2ZcLtWzfBMeFPJsvk1266dg7Hfdu2ni+GMnfP0SsWozjM2iHCqsb/tIE/cb4wv1hKOkACpM8bNPvqm/jw06WTAgEEWgxWL2X4g6gm85OBODdCOpd/TUTN8rfIpp9sXinmYh3mYp26eG9axBUGqXFnW7ArCGwZ44CRbvnPpBqlLfRUV6PPNYItU1uy72X+gDTNu1/yZHl/JeSpiwIABg2ED/h4YRBocRqNuULA+gy5WIgEkVnqXk6o8nmC8n2fszQ7+bMsYztg3T69UjOE8Y4MIpzfWt33Ug2yo8kZ+Y3yNFpM/EwDAUNafpd2+H+7XlxPhTchrAIds5mEe5jE1z4o72Xwgxgm86N5ODRCEpfN11Lm+VvmUeaBlwIBBBoMbnmPzgQyY263Zr0N4g9VMHueJcP8yyqU/r/0xMIphnrp5Zv+SnQcCMWOe5p/n8ZW8g42PeZiHeZhnaKIy2nt9RWbe/ZnHwXkOW8t5CsK43zhXifQSkYM2TPiaVn3BWOGrk1V5vLx4PBh7m5u/WwxnbJtnqPbGVRFONfq3dNQv2E7ljfymK4E1Wko+tQoAI1h/nHb7sZfCG64BDBgwSH2w4gdsOxDvBF5ycKcGCMhoY4ao7lX5lJGwMg/zME+q89zwJ3YdyIy5z2j2W3C8YYAHjpkf1KXXS/0Vk93JdExj4PSgyp4DIZhxteZf5vGVnKciBgwYMMD6hkGcAYDCyG+cq0RCfgMBmHCpVl3tpfAm6n2Kp5x8zDP2Dmd/tBjOWDVPE+2NeyKcasRv6aifspHKM/cb40uzlHxqdRMrB6AB6w/Tbv/rpfAm2DWAQzbzMA/zGJlnxb1sOBD7BF5ycKfeQuQgEEu/pKOuiXsrdLjKBw8cBgwYpDW4YSN7DmTM3N9p9t97LbyhA3du5wl1I4vHpZ+XKtJmSRjFME+jeaqavZoNB8Ix42LN/4bHV/IONj7mYR7mYR6sXZgH6xtQ4n0GXaxEAgjGhPO0ap6Xwhs6Gvg6GHu3y7/YMoYz1szTTnvjkginN8q3dNR9bKHyT35jfEUWk0+tIr8BULt2474Jb7gGMGDAIJXBiv9kpwETJ/Cigzv1X4kcBGXpZ3TUdz2u8ikjYWUe5mGexOe5gUb4YAdz/1uzP+Sr8AYHHjxwYpTvXHp6ze6mB4MXBq0Gs59nq4EozDhH82/2fsNlL2PAgAHWNwwYBB4c9hwHKAjvfuNcJRJA7NI7j9ph85TjzTxjlzv+a8VwxpJ5Amtv3BDhVEN/S0f9kL1T3slvCl1Sj/rMrshS8qlVAGjC+ona7Q9DfoYeCW9aXgM4ZDMP8zBP/HlW/Df7DMhMUygXd2qAMCz9iI5a4ndZLW+3DBgwSGyA9gbsYkwizZj8Ed7QydveeQLe0UJy6Xva291gFMM8A9qb19hjwES5mM8bLhsf8zAP82B9g7UL8wSY57AXODmBIshv3KtEAgjMhJO0annQCtjcVuXxFuPBYOz97v9cMa6xYZ7w2hvbRTjVcN/SUXexc8pX95se0yKcUvKpVQBozvodtdtmX4U3XAMYMGCQ2GDFr9hhwNwJvOTgTg2gpIpxc1tWi4SVeZiHeRKYZ0GRDQbsYu4izf54KnboON4wsM8DpxCmfOfSvbC7YRBmgNoW4jHjaM3/aaAX25xvuOxlDBgwwPqGAYNkLD3BZwpdblYiAYRhwuFa9UtfhTfB7lM85bg+z9if5+K3Wsa4Jut5YmhvrBbhBP6WjrqdPVMey29q68aYCKeYfGoVAFqyvktjvRXeNLoGcMhmHuZhnpjzrPg1ewuYPIEXig4m4wBCsvRwHfVAm+th/stqebtlwICB0cGCUWwvYCNzv6XZF5pU4PgjvKGTtwPzVFquior0UvvfyKXbDnmIweCFeYJoby7Ynu0F4jLjvZq/opUCx5cNl42PeZiHebC+wSKGebC+gQTcb9yrRAIIyYR3adXjvgpv6GiQ98HYB/LyQ8W4Jtt5TGhvbBThVIP+mkYtZLeUx/KbruELyIAIp5R8ahUA2rFui8a+zlfhDdcABgwYGB2s+B27CshwUygXk3EA4Vn6Th21qnExrkf97JHCMg/zMI+heRaMZmMBe5k7R7PnptKVCccbBll74BTq/z/LbeQ3X/yzVDGgvWHgm+/NBePYWMAMM/bX/LUNFDjebbjsZQwYMMD6hgGDRoPDXuS4BIouv3GuEgkgPBMmadVzvgpvWt6neMpxep6xj+ToV4pxTYbzGNXe2CXCqQb6fY1awD4p791vGi2gWCKcUvKpVQAIwLrnNXa8r8KbumsAh2zmYR7miTPPitXsJ5DACbzkYDIOIBJLJ+ioPw4pxvWxrJbXXAYMGMQeLHg9WwrYztzZmv3t6AocD08IdPJ2aZ5KI+FNy+65X1xVezTB4IV5wmpv9mdLAZPMGKf5Lw5movxVurLxMQ/zMA/WN1jEMM/QeQ57jYMSKHqnbxfFBgCRmLCTVr3sq/CGjgZ5HIz9bb5+omWMazKaJxntjS0inN72v6ZR89ghhfym1UqKKMIpJp9aBYBgrFutse/wVXjDNYABAwaxByueZieBZE7gRQeTcQBRWfomHfWqVPS7nz1SWOZhHuaJMc+CN7GZgBvM/ZgkzV6C8IZBDgeFSpMqtxF88SdSh9TdtPcZAwYtBhe8l80EzDNje0m6YRvvN1w2NQYMGGB9w4BBbYD2Bgy43zgnNgCIyoRttXqUr8KbRvcpnnLcnWfsqtz9PjGuyWSehLU32Ytwqm1+VqO+yd4o5De1fhg9RkU4peRTqwAQnNHptdi3VOtf5pDNPMzDPFHmWfEMWwgkdgIvOZiMA4jB0lE6usP7slqedRkwYBBpsGA3thFwjLknavaPEd7QgTt381SarI2hfPE2aXPt6ReDF+YJOc8Fp7KHQIKc+ZpueJ33Slc2PuZhHubB+gaLGOYpa0qBkxHIgPzGObEBgCOld/ZW5fFe4/hg7FM5/GkWtlPfXzCuSXeetLQ3WYpwqq1+TaO+xqYo5De1M3GwJRVChFNKPrUKAIFZ9x8ae3zi1wAHTDY5STNgwCDMYMXzbCCQ5Am85GAyDiAed23R0a/zvp89UljmYR7mCTlYsCcbCDjJ3MM0+38R3jDI16B/PHKR1PjiNdjdMIjne3MOuwckzpkv6Ia9vN9w2dQYMGCA9Q0DvwdTRnEmAhnoM+ii2AAgBuNf0Oq9slTg2FKVx1OOm/OM/Yv0l/z+PjGuSXOe1LU32Yhwepv+rEZdzZYo5Dd1xX9h1lYgEU4x+dQqAIRh3fc09uykrgEOCG9iP6twWGce5vFtnhV/ZeuAhE/gRQeTcQCxuet5HT3e+7JaHnoZMGAQeLBgAlsHOMzct2v2Ewhv6OSdI+ubZgoc6YvnSV1SDwYvzBN9ngsuZt+AlDhzjW44yHelKxsf8zAP82B9g0WMt/NM2Y7TEJhzv3FObAAQj/FrtPogN5ts0tHA78HYl/L+4+zAuCatebLT3qQtwqk2/jWNupzNUMhvNESSHn6RtRHhlJJPrQJASNZdp7GfNXwNcEl4wzWAAQMGgQcrutk0IPkTeMnBZByACe5araPf4Xs/e6SwzMM8zBNksGA/Ng1wnrl7a/b/IbxhkCPrm0YKnC/OxLyFQWzfG5omQrqc+aBuONTjKzlPRQwYMMD6hoGvgyl/wzkIZFJ+45zYACA24x/U6kPTU+BYWpVX5inHpXnG9uX/h1noUN9LGNckPk+hMy3nGRtEONUGP6tRl7INCvnNiDNx1EXWVIRTSj61CgDhWfdVjf2ymWuAk8KbqNcADuvMwzz+zPMoZwxI7QRecjAZB2CIu36lo6f4XeXTyYsvAwYMWgpv/oG9AvLD3Ddqdq8KJYQ3dPLOi/XNSAVOUSpJJQYMIg4u+Dp7BWTAmffphmmJd4exXXnLxsc8zMM8WN9gEePTPFPexAkIZLLPoItiAwATjL9Pq09w863f7J+HpxwXBj5ob4QBTjrz9ErFtJxnbBDh9CK8EfKbYMV/8VZbAxFOMfnUKgBEYt0lGvuvsa4BbgtvuAYwYMCg+eDRLnYJSPEEXnQwGQdgjrvu1dHT/K7yKQspLPMwD/M0HCx4P7sE5I25RV0wJr2ukDjeMEjc+qaRBw6FgMwTbZ4LvsMuAZlx5mLd8NGkFDjOWN6xzTFgwADrGwZ+DKbsytkHEnC/cU5sAGCI8bdr9cyksp0uVeXxJGT3POO2kV81+BjXJDdPr1RM0XnGBhFOdfDvbdTF7HvIb9Rckm5i2Q0R4ZSST60CQFTWfVJjb4pyDciJ8CbkNYDDOvMwjyfzPPo69gdI9wRecjAZB2CUuxbr6I/6XeVT5umXAQMGwwcLDmd/gHxyxUZdMDZjBY4lJwQ6eefE+iaqAocBg/rBBfPZHyBjzvyObphlOEnl0pW8g42PeZiHebC+QUHtxTxT9uDUA0pEfuOc2ADAHOPnafV5hrOdTlblkeGxdTBuW79+koWi+rZgXJPMPEO1N76IcKoD//NHzWLHE/Kblmdic+u4X4QzcLZINLUKADFYd5rGLgtxDcib8IZrAAMGDIYOHn0jOwOkfgJ3MRkHYJq7vqOjZ/ld5VNGCss8zMM8g4MFU9kZIM9csU4XTM5GgYPjDYNErG9CKnAoBGSeYf/RBTezM4AVnHmlbrjcjALHySs5T0UMGDDA+oZB3gdTJnDeASXSZ9BFsQGAUcZfrdWXmcl2ul2Vx5OQffOM216eluFjXGN8nibam/yLcHqlskady16H/KZt8Z/xdVxMfr8HgHism6qxP2t/Dcit8CbYNYDDOvMwjw/zPLozewJkcQIvOpiYBkiAu67U0Zf7XeVDr3QGDBiUpQ4tOI49AfLPFY9K0gWH+Cu8oZN33qxv8MBhEHVwwWL2BLCIMy+SpBu+7euVvIONj3mYh3mwvmGe3M4zZV9OOpCk+41zYgMA04y/WKu/EUuBk5OqPFI91gzGjfP394gBjvl52mlv8izCqWrUOexyQn6j9pJ04+u4lPyGAQCxWfcPGvubpteA/AtvuAYwYOD94NF92AoguxN4ycHENEAy3HWRjv6m31U+ZSS1zMM8Xs+z4Cy2AvCLK+7XBccnnkDOyQmBgf3WN8EUOBQCMk/9f3TBHWwFYCNnfkw33B66X0yuNlw2PgYMGGB9wyBfgylv44ADSlZ+45zYACABxp+j1TdHUeDkrSqPJyEL5hm3l++/x0KH+l7CuMbQPIG1N/kT4YyazuYm5DeBz8TGl28p+Y0fAEywbj9JGvusr8KblteAEIfaklSSigwYMHBnUNajb2UTgExP4C52wQFIjLs+oaNv87vKx0ivdLZ4BgycG5S14GNsAuAjV3xPki74KMIbOnnnwvoGDxwGYQYX3M0mAPZy5gmSdMNPPN5w09loSlJRhVLNHzvetYJ5mId5Ep+nrKPXmfjIvjw4XHoE1jfMk/g8U97J0QaUbJ9BF10+AJJh/KmStPoeX4U3dDSwYDDuIH6INTowrjExT3jtTU5EOJ0aNYVfkZDfKETxn/FVW0x+5wAAc6zbWWM3+yq8iXMNkNQjvSKV2n0bewx9Y12cp1NPfDLAKnxF+lPgu+uPG+TBC8VaOXu8fDrzeDLPo2/n2w9Zn8CLDiamAZLkrpN09PKgP43cltVG63skaUttm7Mgh2XpoKrFt4Rfl1ukvzT9D0/6MgISBnEHCz7J5x+85orv6IJZCG8Y5ML6pqUCh0JA5tn6H11wL99+cIAz368bHvZ4w03uD1ySqtIrAyUsfT0qdBm48OZvnulvqK3Fl6SXTKzpl3TbaC6hDCIOjja1Dody1D2StPR0rG8YJDWYcjAnGkjF/cY5lw+AJBl/hFb/0lfhTbD7FJY1Cc0z7l38/oQBjsl5Ymhv3BbhdGrUO/gNCfmNwknSja/aEo6QAI6xrkvjvBXeNLoGtDnUbpEk9UidAbQ3Pr+jdOqJi8wv19WHSdL4X5M8ZRBl8OgH+eSDrGgKVXIwMQ2QMHcdrqMfaKPAyX9Zbah/pEfqlsq1Q2nIE11fLdMUMwngwDxVLV5qfsXedokknfRt3gCYJ8o8C77EVx9Akq64UhfMNdDLyR/hDZY19lrf4IGDH2PrQYcuuJ+vPjjDmQfohrUNrJt92XCNbzSSXpGqtfQajduaDaqavlciS/qk53TbZB5HGIQeHP1ash/bo27U0k9hfRN1HroQNndannIIZxlQSvIb51w+ABJm/Lu0+nFfhTfxOxqQO4owKGvce/nlDaewnfr+ggFO1HlMaG9cFOGMmsxPR8hvIp2JjS/WEo6QAO6xdovGvc5X4U2oa8ArUm8I7Y237yhP3Jjsil39Vo1/lro95gn3Tz16DB97sCYrXXIwMQ2QPHe9U0evalyD61E/+4B7X3/tTlTtjT+DxY8ku2hv+5hO+j6FKQzCDRbM4XsPMMgVsyXpgu8ivGHgvvVNIwWOL9Yuiu7H6IUmvFMX/JzvPTjGmeMk6YaXfN1wzVZ5bq4lOkTjtpbamwMSXNInPSpJtx2K3ph5gg6OKabxsT3q61p6GdY3IZ0reqRXhr/R9/WoUDGQTnR+nqqmHM4pBpRSn8EOB10+AJJn/CStfs5X4U3L+1TT8p6tm3vRXwvQaPOMO5YfXFMKf6O+5zHACT+PUe2NMyKcqkb9DT8aIb9RxOI/42u0mMq9GgBMs/Z5jZuYioGVzdfv1jX9VWmzVA2pvfHv9P/E0jRW7OqdJWl8D3UhDAINHj2RzzzIIvlN0b3ENEA63DVBko7+P7/Latv+F3ql7rpDaY6Na+LNs/ipNBbtbcdJ0kk/QwLNPIHmWfBVvvQADbjiI7pgCcIbSiTdt74ZqsAp+OCBE8+P0YfBBS/wjQeHOXM7LdjGV6WrqY3mlVqZuGjc1lJ78/40lvRJ9+m26TyXMGgnvHl9ql/aoy7W0m9gfRPgn9oiKXx/TJ8GU2ZycoHU3W86XHP5eInIQRqM30mrX5VKXgpvQnU06M8pRav49/wmVdW4GfzU2lDYQX0bMMAJM08y2hvbRThVjSrwcxHyG0WXpBtfo6XkU6sAkAxrV2rc36WtwLGuvLj16b9aO3lUpV6pymD44IkfpbpoV5c14XXU/zFPS+HNR/i6g6xrClVyMDENkCJ3vVFH9/jdz7713rf1UNrB4bPpYPFfUl20t/2DTlpFqQqDlsKb6/i6A7TiihN1wU8CuUTieMPAauubrYe3rrpqwrxa3xjyY8yrJlxVXbCRrzs4zxmvacHrM+valvGGa8T6pv/yrsZX176qChUDV2DX55l+XHpL+qRFknTbp9AbM0/jwTFvyuBLe9Q5krT0NqxvWkoZe9tob7w2wOnUlPM4s4AykN84JLzpHyC/gbQYP0pPbOur8KbRfapBeU9/Tilqxb/XBjhVjfs0P7JgdGCAE3iehLU3dopwOv4sob0R8puYZ2LjS7OUbGr1+SrLBiBB1v6PJI37kI/Cm0LbZxVJnUggWs3zxH9nsGhX/VWSJoynQIRBg8Gjn+C7Dtbx47/TYY85mJjeQuggVe4q65gxCd4uHSirbV3B02muHiiPg8VZ5A1umyBJJ/0ZCTTzNPiPFtzIdx2gPVe8X5IuWIHwhhJJx61vtgpUugxLeuwaGPJjzO2gqgv6+K5DTjjjeUlaMMlLpWvMjWbrFb7Evtx4MP2cbFb1SV/XbZeRQmEwfHDMrll+bI86SUuXY33TaFCVNtcdOzlqjtTeXMppBVJn9PC3G/tdPiZvIGyQKnu/LElP7Oql8KZt6V1V6pZ641X8e2mAM+5qflvCAMf8PGlpbywS4VTVsYafiJDfyID8xvgaLSacWn2FZQOQOGt/oHGnJ/JzduX63fi/WZJKtbaO5KNHDJ74VZaLdtVqTfh76v+Yp054cxHfcpDVBjjO7Yx/JWyQNndulKRj9vC4n32zva9YO5R2cFRoMFhSzHLd3vZ6nVziasCgTnizlM85QDiu2F8XrB9epYrjDQO3rG8GB135LZTEj7H54MJd+ZZDDjnjcS04OME3I3s33Jj/rJLtXOn0YPpnslzSJ10sSbd9G90y80hlHbOvFV/aow7X0oexvhkx2HrsLLc5ifX1qtBl4ETn0DxT5nNCAWVWalh0531z66kMIHX23qAn9k/7GmXXb7Ph298WqbdWaUw2KfBg3Dx+UqEp7Kq+pzDAaTlP6tqbzEU4HQ/wyxDyG0OfmC6pR31m12gp4dTqn1g2AGmw9kaN+5T5a4Az1++G/0hn7RpAXeOIeZ74dfaLdtV/S9KEY3i+YqBHv8hXHFywZScxDRCAO5/SMW/zuKy24f9/Z+3h2Ug9UL4GS0Zlv2hvrUov6+TXIaVmHi24h684QBSu2E2SLtiM8IYSSZetb8wpcCwdCD/GxoML9+ErDrnljJ9L0oKjvFO6Rt9oulp1rvR8X54+24pVfdLHdNv32b98HxxzgEVf2qMOkKSlG7C+qRv0Hztz/z8z/DxTbudsAsqyyWDJqcqfMjGDzNh7hZ54b6oKHNt+m41/j7359YtOYDDubn5J0SnsIUl9j2CA02ie7LQ32YhwOtXxQ34TQn5jjOd7tEPFtAinlHBqFQDSYu3XJWncF/0T3jS7BnTWOutwxK8bPPG0Xet21Z2a8FHq//yd59F/4eMNcsWW3aGdcfnviBlkyZ2P6JgPGG704FA/+wZ7X0NNuPdHhSVvsmvd3vqcTp7MZcHfwYJf8vEGiMsVXZJ0YUU43jBw1fomtgLH6so/Q36MOSuUvHB/Pt6Qf85YKkkLZnpzJY/5lesw37kyB4PpF1u0pE86TpJu+zn6KB/nOeb9ln5pj9pVS1/F+qY2KNWOnXw/6wZT7uJIAlny1lFaMcq1yh+A7Nj7p5L0xLHeCW8KzV4wS1IxlgLHn2qocT/nB2SGwtvU9ysMcIYMCp0ZOM9kJsKpqmMBvwMhv1EiqvSy1GNOhFNMOLUKAOmy9osa96+xlHVOCm8aXgP6ezpWOfQPzvPEMzYu2lXfkaQJXyT96pnjzQ18sMGd631FKjm1MwJkzZ3/IUnHTPNMeFOvAB9mydhQE+7xMWDJbjau21sflaSTj+DxwK95FjzONxvAJHO6deHfGuv35OIJgRJJt61vcuyBgx/jMOHNe/lgg1+cMU8LZhlWldhueRfH0rbEvlwT3lxt6ZI+6WBJuu1JdjSPBsccbvVn9qhRkrRsjPfWN+UmfYg8tr6Z8lOOISBbDHDcqvwByJq979ATM5NKcjpQlVf/XyiOeOXkjNpoMO4BfjcmKbxDfT/HAKc26JWK6TrPZCfC6biG5S/kN4lRGbLaDIhwSgmmVp//H9YMQAas/aQkjVvomfCm2TWgl7O+1KEnuqVuq9ftqi9K0oRvUkfoxTyP3sKnGlzi3qqmjHZqZwSwgzsX65iPJ2LRbnuVT7nRw3M1mId73o8KS/azfd3eeo8knXw6TwVeDBb8nk81gHnmrJOkC9+G4w0DN61voipwbK/8M+HHmJtCyQsP5VMNPnLGlZK0YK4fV/LICpxKg86VhXKt15tnW+30r9u+qk/aU7e9hG45//Mcc5IzX9qpG7VsB7+tb1r0IfJyMAWzZbCHMYm81CRU+TP5bgIGVrD3PEl6YrZnwpuR96mRLV2ohho6z7hV/FwSoXCw+u7HAGdAe5Oe80yGIpyqOi5m4Qv5jZKV34xYf7FEOKUkU6sAkB1rT9G4HwWV2OVEeNPwGlDl0K8n3Fm3qz4hSRPupJokt4NHf8DnGdyk4tTOCGANd35Lko75nE/Cm4YKnM7mmnCfjgFLDnBm6d56oySdfCGPB7mdZ8GfpD/xkQZIkDmPSNKFU/wS3vhTIvml/9bnj8qv9U0uPXDwY+wX3pzA5xl854zZkrTgeg+u5HG+cqW6u4MhuaBz54Tp33JjSZ+0nSQtHsP7S24Hx5zq2Gd26hotO8hj65uOml6x6rv1zRTMlkH2ud+U3Kn8AbCJvefqibkGfkFOVuXVa2t7U++M44TjzR/5iSRL4RBJ6rvDYwOcodqb3IpwOtXxUda7kN8kzvO/0w5vbbwQI4pwikmmVgEgU9b+oySN+1+fhDcjrwHy/dD/hINLd9UxmvAL6gjzNs+j/81XGVxmtDOJ6eV3Ei2wjju/omOuiWvR7l6VT3now7Mi1gPl5qiw5J3uLd1b5+jka3hFyJ3jTVXayIcZICXm3KsLpyfbYBXHm5QHX/qdhnQoyKv1TUgFjhsVhPH8GHNQKHnhKXyVAQY44ywtuCvcJd3JK3lkBU7JsPDGrcH0Re4t6WkbJWnxXuioczXPMee4+o2d+qAkLTvC44tDsXkfIj8GU9Zw1gDr2P9xrXinO5U/AJax92xJemKeT8KbkaV31SgJuhxXQ43rk17lx5EShWPVt9hLA5wm2puciXA6TmeNC/mNsjXAiS7CKSWVWn3+eywYACtY+3ZJGve0N8KbYdcAjyUQa17n8Lpd9W5JmvA01S25cLz5HV9icJ57V2rKOxzZGQGs5M7PSNIxN0VRsjlc5VMOeXDN6WDJ4Q4v3Vs/I0kn34aUOg/z3DiajzFABsxZJEkXfiquENeNE0KuSyS/9IyGt87Nt/VN/jxwPPZjvPATfIwBhnPG0ZK04BftL+luX8nDf+UKFaloXnjjyjlh+u0Or+ppayRp8Xt4kXHf8ebiPHxmp94jSctmemZ9U25ZoeuB9c2UF6QXOGWAbO8zaHflz+RvEyqwlL1nStITd3kjvKm/T3U2t7bz8tQ6ro8fRNoUpklS33d8MsBpp73JgQin4z0sbSG/SZvn/1s7vK/N0gwhwikl9pYJADaxdneN2zTwk8+/8Kb+GuBlA9Q1u+dk3a7aXZIm9FBH6Oo8jz7D1xdITKe6My6/gTiB1dx5miQd80M/hDfDFDiVKPVArh8VlpyUk6V760mSdPLPKIJxdXDjbnyAATJmztcl6cIvm7GUzMkJwSHHm26pWw16hOXe+iaYAseZCsIYfozuFkpeeBEfYIBWnPFuSVqwprFVXa423LCF4/7dm6bfl5NVPe2/JGnxdHTUTs5zzNV5+8xOnadlF/qXh+k/dvrmePOa9CInC7Ca/e/TimNdqPwBsJu9j9YTP29fM5C3qrytm3uYTF0uq6F2354fQZYUPipJfVd6YIATWHvjqAinYxLLWchvZKcBTjgRTjGRVObz17FaAKxj7WhJ2t0T4U0YBU7ODv1r9s7b0l1VlqSJFcoHnXK8aVidA+Ay9/6Hphxj/c4I4AJ3flDHPJDUVdTSstoYChx3B0tOy9vSvfUfJOnkJ5FkuzTPjfvx0QWwiDmXSNKF325zDPBZeGNbieSXyy1fKHywvsmfB45PfowXfoHvLkAgzthLkha8OFhDls8NN/iG1WlYgWO5BGL6gzlc1dMWSdLi83iscWlwzNfz+Y2dOkeSln3DG+ub1m2GDD6j2PTXdXiB0wQ4wpjoCZl0Kn8mzyVI4AB7HyxJTzzuh/DG2l45qQ92H8fat4XCLPVdlmsDnPDaG4dEOB1jWcJCfpMxz/9AOxwTdB23EeGUkkllAoCtPL1F2qLdd/HjiB9AgVPI0aF/zdvzvHRXPi9JE99KHaHt8/yGYwCQmM5oZ1z+L0QInOHOd0rSMU82aBCV27La8Aocd48KSz6Z59V7656SdPKr1MdY73jzD3xrASxlzsck6cLvh/OWxPEm5cGX39gukFn9b8/wb6aRAsexQsmoanDn6kEvvJZvLUBozthekm7skEr53XBDdXf2wwNn+qN5XtXTrpakxddgNWP7PMfcmP9v7NRzJGnZHd5kZroaCW8qOfzfe/jfcIIAl9h/gVacY3flD4A77D1Jkp54wXvhTZOUXZ6qoXbfn/VuHYWLJanvvDwa4MTQ3lguwin3snKF/EZuGeC0F+EkUO30/FdZKgC28/QzkrT7Wz044jdX4Jj9k2R76F9zmC9Ld+WvJWnihygotHHwmzfycYWcc++NmvJPFu+MAK5x556SdMymgWtp/stqPfDAWXKJL6v31lGSNP1vkWTbOM+NU/m+AjjAnOMk6cKfNW0O5aHwxpISyS/vHfh5wh/rmzx54OTdj/HC+XxfAWJx+hZJuvFvE2xAk/GGG3zDMqTAsVYCMX2dL6t62mckafFtvONY6Xiz1K9v7NRjJWnZz/NufVN3ck5CeGPJ/8zD9+DUAG4yun0eJqvKn8kXEh5wj73fIElrCn4Lb/LrgbP7e1njVlO4WpL6ZubIAMeE9sZCEU75j6xWkKyS3zx/i3Y4M/SCbiDCKSaQygQAR3j615K0+5S8H/FHKHBs6zoQy/HmRB+X7sofDAwm/hP1iFbM85u9+aACiemMd8blXyQ24Cp3jpakY7f1o5994KpH544KS7xsw7HoTwOD6QdSOmOH481pfFMBHGNOzajqwidwvLHA8ebtIbuDlb18xa9bAK4WSoZU4LjyP/PCO/imAhjj9A0DgxsPyuOG670HzvSN0kbvVvW0kyRp8QNYzVgxzzEPev2NnXqwJC17Kv+5mkJXTh1v3sZJARxm/zlaMcfWyh8AZ9mrT3pVa17nsfBmaO7O9Wqo3aezqF2iME+S+k5w3wDHqPbGChFOVeUVrFCQle430vM3aIePRFnZQ0Q4ptsMP38J6wTAMZ6+V5J2/3Cuj/gddZm+BP4kmRz613yExauV/yZJEy+n1jA7x5u3swzBL+69QlOuMKDAMbszLr+IyIDz3PGyJB37tw0MWvNWVpu7vuNLrmP9atFDkjT9KKTdmc1z4ydZhgBuM2dvSbrwRX+FN9mWSH45gqlyl3/WNw07eeOBY4Pjzf18RAGS4vQHJenGI3KndA2+YcVT4NgmgTil6PuSnvZOSVq8gZedzAbHrOHLOsDUPSRp2as5tb7ZOk9XAiUH2f3PPPwQVi7kgf0v1IpvWVf5M/njRAacZ68/StKafX0V3uTCA2d3vkXOUrh9YND3bjcNcJLR3mQmwqmqfB+rEmS1/EaSKtHXer8IZ6C2ydC99/kLWCQArvL0LZK0+z/n94jf0aBLpauON+ezYIew8iJJmriQesT05vnNMaw78Jd7L9CUb9IRCiAR7lgnScceaNJmysZ+9i2rHgvmqh6TPios+R5rdgiLlkrS9E9RVZPe4MY5rDuAXDFne0m6aFscb1IafPmMeA8THj/eD+nk7WgFYTAFjuX1oBc+wocTIA1Ov0eSbpyRYL+MDDZcnzxwTtmVVTyEabW/kCXbYFmT0jzHvCa9zNJrwNRRknR3V66zN7n4X3f4saxWyBejo5zrkqv8mTyTkEB+2Ou3krTmEC+FN/WpG9eqoXa/kMWbEwq/kKS+fZwywElYe5OmCKf8fdYgyBn5zfP/oh3Oj7foi8Y20ec/ywoBcJ6n/0WSdr88p0f8ZBQ4aR7613yFRdqUlacMDCb+gnrEBAe/OZO1BqB7P6EpC23ZGZd/goBA3rjjIUk69giT11XrymobVT02+EpY63jzH6zTpiz6+sBg+jVIuxOc58ZvsdYAcsvl/ZV53bpoD1+EN+mXSH750zLQF8xP65uGnbzxwEnf8eYpPpYAaXP6/IHBjRfmRekafMOKpMCxQQJxyr6s3Fac+Jq0UUt24PUnwcGxo1ho7TnyOUm6+6DcWd+YVuBk8j/z8BmsUMgh+5+qFXeHUOAkWvkz+QwCAjlkr/slac1J/glvDCXxUnW8mcuCzSGFxwYGfdtbb4CTlvYmWRFOVeWrWXcg19xvpOev0g6fi7H6DTUVfv6TLA+A/PD0RZK0+/URSx6tPuK76YGz5gZWZQhWvntgMPH/qGs0Ns9vLmJlAQzh3lM05YfZ74zLP0IoILfccc/A4NgZOe1nX1f12OorYdNRYcnjLMwQLPrMwGD6MgpujA1uXMrKAvCIy2vl9Rf9PY43ZgZfvtJceLr8tb5pXEfoaKFkJcA50KZCyQv7pC3SX/hAAmTJ6TULyhu/4f6Gm1MPnFMOZ52G4MQ1A4MlR2BZY2yeY/dkZYXmyAcHBnefgAdO9oPDL2ZJQs7Z/0it+Hl7BU7SlT+TpxMKyDN73SZJaz5tvtugA1V51ldD7X4zK9QLCi9KkjrU+5KVBjipa28Mi3CqKp/LKgM5LL+R9PxXtMMXo/4MTBiFP///WBsAOeTpswYGu/8oqFTPjSO+UQVOoof+NfeyDGOx8o2SNKlCqWL0wW/+jXUE0JR7P6gpv8hyZ1x+JkEAL7ij1mH32M/lrqy2/w9TafeVyPo8sGSjtJGVGJ1FUyVp+m+Qdkef58aHWEcAXnP5f0vSRccb6yRl1QkhnRLJL3/HdFQqAe5Bnfm1vjGnwLHTA6dQ/x9Z8Oe86A18CAFs5PRzJOnG20MXk1mldA2xEYdR4GQigTjlLFZlLE6sNYJZ8nFeiCIZ3aD7MsSRt0vS3Z/Oi/WNIQVOOv8zD8dsGXxi/4O14rdNiwZTqPyZfAJBAC/Y62sDgzVzDeQ2XarKs/LUuvv9LElPKW43MOhdbY0BTnbam/ginDICWlBe5DeSnv+idvhKpF9RbH3t82ezMAByztP/ODDY/dd5OeLb7YGz5ncsOpM83i1J+qsmvZW6xqDz/OZOFg5AIO59t6Y8ls3OuPwU/vrBO+74iiQd+6+x0tO29bMf2Isr5jrymjsq3D6aRWeSRfsNDKa/SlFO0MGNz7FwAGCQy783MLjoU2ZaSuXe8ebLiT4nV1K8BznUydst65tGCpxCQ01Odn+8i/bi4wdgO6fX6iZv/EX727p1V/JceOCcgkWDaU6s1d8vuQbrmwBGN+i+kuHIWqnu3d/AAyeNweGLWHTgI/vvqxUbhudY0qn8mXw0f/3gHXvNHhisWeCB8CZGWi+JaqjdV7EAYYDi+MFx792ZGeAUOmM7z2Qhwim/hxUEyqH8RtLzn9MOV4X/FcWT1T5/GqsCwCOefqsk7f6HIZ8OV4/4JhQ4Zg/9a/4q/ZVVliCP/3pwPOnDlDM2GPzmVywTgNDcu4+mPJt28mv5ifzFg7/c8cmBwbFLHBfebK3dad53PBMPnNsnsMqSZdGo2uhlnfI6rG8aDG4qDvz9AAA05PKvDwwummugt1S2J4QkSiS/vDqVMHSlUQRgu/VNvjxwCq0Ppen+qS56L586APc4/d0DgxvXNhDKWnol7wr/lQugwElHAnEKFg3Jc+JnBgZLlvOKNNToZg6rIz2OPGdgcPdyl61v4ilwkvvjHf5Tlhj4zv67asVLA4e31Cp/Jh/BXzx4zV5nSNKa5UGrdt2uysvQ6KZPekl6iRUHTSkeOTDo/U66Bji9UjG680z6IpzyZBYLKOfyG0nPny8ppAgnRqfA509mSQD4yNM7Dgz2KEkll4/4WXvg/H73ur/WblZWqjx+y8Bg0uW+W9/8Bt0XQGzu3VlTXpFKCG8AUuWO2s/h2F+4KbwZVqZpToET9qhw+0mspsxY+PuBwSlH+V7BcxO6LwAIz+WzB8cX3RZaipMzx5svd6ebXKqkVQTgYidvt6xvgs+T/B/vIlxeAXLB6eMGxzcVai/RNl/JjSpwCv3/hYSMbu5jfWXDiYcPjpds8NT65tjbWQgZc2RtHd79FB44cQeHr2FBAQyy/3aS9OiolCp/Jh/KXzmAJO1V29nX/LZp+a7zwpvw+b341VB77MTigtAUPzow6P1C8gY4vVIxivNMyiKc8hjWBcgv+Y1qIpwd/iXwb6aI8AYAIvJUVapKWyRpjzfHkvNldsSPocCJduj//WEsHLt4/KLB8aQ7fSlw/O0bhe4LwCz3dkrS4Qknv5Yfw980QAPuePfg+NhnXRPeJKPAaTu4/RIWjl0sXDo4PuVCX6xvbppK5AHAGJfXqUkveqBN0tuSE0L8EsnLds7ub7ySeBGAM9Y3+fLASd+P8aIv8AEDyDOn9UmvSa9JL+umPbJ8RQp0AIinwCkE/JaGPCecso51ZBcn7jowuH1Mzp+TjkWfYCtH7jEw+MG25t7ZUz54d2Xwx/vHgiTpZekFFhFAAya/qkdfH9SLA+ENgEH22ndwvCZ1N6qUqvKS/0PucRBLCQxQvHTI/9l7tGkDnKHaG9tEONv8WU7pJEDIbxLh+X+WFEyEE/7o/PzxrAQAGM5Tvx8c7/GB9B5RWh/xn/y1JO35viw9cH5/PqvDGR4fWtc+6f9yZX3z23cTYYDEWd6tw8dG1LcjvAEwwh11RajH2dFM8fvbD/x5jm/75zFR9djsqHD791gdzrBwzpD/85RluarguekzRBgAEufydw6OL/rjkPN5DhxvLnuvFX/Jha5UigCc7uRtmfXNxTMl6bIftpvHnAKnxR/vopv5UAH4yGlPDY5vOiRVKU7AA8Cp90nSzTNDK3DMCm8+/PraX9NGaSMLx15OGBqd249w3vrmuO1q/2NeJrxu8KGXpZelFyXpB++y4lR8xIsDf557DrLCA+cfMVsGCMPk5yTp0X0T+T1Ofi9/wQDt2Wu7wfHvR2fcv2BremfPPkl6sivxRF+oaqg9ZrJeIHGKdw35P3vHxTPAaaK9yVaEs83DxBmE/EYRRTglhDcAYJin/mNwvMfZSd0Hgghv+nnyPyVpz2kmFTjNDv2/v5P454fH6yxi9nmjexU5v/0EMQTIgOXrJOnwA41tfwhvACLz/S3SlgGrt+PGZym86ed7W6QtOv51iStwVNbtzxH//LCwziLmlD+6Z31z043EEACy5PI3Dfk/PzfGinfrUCWSl33ayr/ZSvJ/PxX3O3nbkSC6+LzBuF38QUm6bEUGHjgX/YoPEgAMctr9Q/7Pmz6aVKv1UMKbfk6dJ0k3fz6QAqfQGVd48+EjWQ454YR7hvyft3/e6lek444jYnnjQ78cHP/g4xkcmD9YGPLnOeJBSbrn6LgKnAh/vH/kuwoQj8m/laRHD0F4A5Axb66za/v9QRmkNLcKb/rZ8y+S9OSEzFrt7PENFgVkTHFtbVSQpOpfTGpvUhPhbHM9kYRsKLj7Rx8U4fQMHQRozv38yYQeAIyxxzVxbQEKzf+jJ3/X5t++56da/tsrATJ9XVJFhYrUpd//lXh6zT7/VFszlTaDQoD/Tpx5fvsDogFgKYd/COENgKUcd2x6wpuRHH9g89Kiztou3/pfVHce+B59HP3mwwdGP2EWYh9Q6+e56U9EAwCc5HPvyaIBf12Wqf67etkdbvylfWGnGH8Jne03l0Il2URK4vPUS1ka/k+L/QdrO8/F7YoSLntRKjefJ/BZtOHgc118WgAgLjd9M5YmpxDgv3Pqf7X/Y9x8fbuvcWfQXe/D3yKqXnP7A8PPBmav5M3+O8fN4+8e9IPbEjwwf/BNbf7t93y65QGydcOXdn+Gf7ya8AIkyKPTo5/HJh/K3x9Agvz+jLildy0Gb27nUPDke2P824OdSfb4LUEGV6nOl7qlzVJ3bfBKo7r9AIO+SP/U1sE2nyIaIOQ3htnhK3W/tOYH5edPI+IAkBJ7/DiW8ObJ1VH+pXteFUiB8+Q+xAfCsc8vEqxr/O0W/oIBnOTw/xcoQ738FP6qADLjuM/HKr39/s4R/73HHxtIgfO9swgRhOPD1yRYkXzzAfwFA0D++dy5SQlvLut2/i/nC2+O97fR2a6ENBWBSrLzNKkqSFoRdHEkBddXdo2lwPkcZVUAkCI3PRBXeHPqL6P8e29uoZ0YqsD5MH5fEIbv7RVI2tr6rHLcy/xFQmh+8Gr0A/MHD474L73n20EVOIVGPQv+8ZfEDSAzHp0d6Mo/+Qj+qgAy4/dXx0pgvnnbKP/SJ0+NqMDZ811EDPyielZiIpyqtjmYv2AQ8hsAAAAAAAAAAAAAAABL+cLk2Hqkzvxa3zRX4MRXBF0yjtUHAAAAAAAAAAAAAADOsA1/BQAAAAAAAAAAAAAA4C8Vw9ZAQywLTExeKFswT70CJ+Q/fsknWGQAAAAAAAAAAAAAACDkNwAAAAAAAAAAAAAAAM7SZV54E1mpYvWg7i+qrZLnkmtZWAAAAAAAAAAAAAAAIOQ3AAAAAAAAAAAAAAAAyo/7DdY3gRU4hSbKokvuZjEBAAAAAAAAAAAAAICQ3wAAAAAAAAAAAAAAACif8husb4INCl11f2P9RjePsIYAAAAAAAAAAAAAAEDIbwAAAAAAAAAAAAAAAPJLF9Y3Ieep/Y1d8hSrBwAAAAAAAAAAAADg/7d3h6GVpfd9x3/a5GrNVWhICDEF01AT4jfGxSE0UIyLg3GIMYSUhZCwNKSYmgZDkGZGGgdHpWa7M7Oe0SXBuNQsCTEmIcWkuJiEFtNCX9SkGAeMIRgWQ4IhbDGEzlpy0fW56otntKvZ1Wh0pXuecx7p83n1353Zu0LnnpdffkR+AwAAAAAAkGuxfmP6Zpnjd7/jewMAAAAAAER+AwAAAAAAkGuU36yoTlkr//i2Kzt987t/n/y9Lw0AAAAAABD5DQAAAAAAwLUxXWl4M318AOcqLd4cJd/zdQEAAAAAACK/AQAAAAAAyHVcv1lteHPpAmdU0ze7P+pbAgAAAAAARH4DAAAAAACQa53frDy8uRIbOLs/5fsBAAAAAACQyG8AAAAAAIBrbdpbeHPRAmcM0ze7/8Q3AwAAAAAAIPIbAAAAAACA40Clp/CmzQ2c3Z/ztQAAAAAAAIj8BgAAAAAAIMkS+zAXDG+WLHAGn77Z/We+EwAAAAAAAJHfAAAAAAAAHJv2H940soGz+2HfBgAAAAAAgMhvAAAAAAAAcsr6Td/hzfkKnAGnb3Z/2VcBAAAAAAAg8hsAAAAAAICcnt9UCG9GvIGz+5zvAQAAAAAAQOQ3AAAAAAAAp5lWDG/OLHCGmr7Z/XVfAgAAAAAAgMhvAAAAAAAActb6TbXwZmQbOLu/4RsAAAAAAAAQ+Q0AAAAAAEDOzm+qhjenFTj1p292f9uzBwAAAAAAiPwGAAAAAADgKdY2hghvht7A2b3pyQMAAAAAAER+AwAAAAAAcA5DhTcnCpzK0ze7v+OpAwAAAAAARH4DAAAAAABwPhvDhTdDbODs/luPHAAAAAAAIPIbAAAAAACALJffDBTerJXjbZWmb3Zf8LwBAAAAAAAivwEAAAAAAFjGdNDwZlp3AwcAAAAAAIDIbwAAAAAAALL8+s2w4c2lCxzTNwAAAAAAAJHfAAAAAAAApL/8ZvDwpucNnN2XPGkAAAAAAIDIbwAAAAAAAJY3HU14c9EC56nTN7szjxkAAAAAACDyGwAAAAAAgFx8/WYk4U0PGzi7n/GMAQAAAAAAIr8BAAAAAADIpfKb8YQ3SxY4Z0/f7H7OAwYAAAAAAIj8BgAAAAAA4BKm4wtvVriBAwAAAAAAQOQ3AAAAAAAAufT6zdjCm/MVOKZvAAAAAAAAIr8BAAAAAABIhfxmhOHN5TZwdv/QowUAAAAAAIj8BgAAAAAA4NKmIw5vzixwzp6+AQAAAAAAIPIbAAAAAACArGr9ZrThzYU2cEzfAAAAAAAARH4DAAAAAACQFeY3Yw5vTitwTN8AAAAAAABEfgMAAAAAAFDDtIXwZpkNHNM3AAAAAAAAkd8AAAAAAABktes34w9vThQ4pm8AAAAAAAAivwEAAAAAAEjN/KaJ8OYcGzimbwAAAAAAACK/AQAAAAAAWKVpS+HNo5/nbaf/hd0veJwAAAAAAACR3wAAAAAAAGT16zethDfTMzdwAAAAAAAAiPwGAAAAAAAgPeQ3bYU3pxU4pm8AAAAAAAAivwEAAAAAAFi9aZvhzVsLHAAAAAAAACK/AQAAAAAASC/rN02GNycKHNM3AAAAAAAAkd8AAAAAAAD0YW2j5fDm9QMAAAAAAIDIbwAAAAAAAPrQenhTDgAAAAAAACK/AQAAAAAA6MNG4+HNJLu/7ykCAAAAAABEfgMAAAAAAJAe85s2wxvTNwAAAAAAAJHfAAAAAAAA9Gvacngzye6nPEIAAAAAAIDIbwAAAAAAANLv+k2D4Y3pGwAAAAAAgMhvAAAAAAAAUie/aTG8KQcAAAAAAACR3wAAAAAAAPRn2mx4M8nuxzw/AAAAAACAyG8AAAAAAADS+/pNa+GN6RsAAAAAAIDIbwAAAAAAAFItv2kuvCkHAAAAAAAAkd8AAAAAAAD0atpmeFMOAAAAAAAAIr8BAAAAAABI/+s3zYU3k+z+gocHAAAAAAAQ+Q0AAAAAAEBq5DdNhTembwAAAAAAACK/AQAAAAAAqGTaYHhTDgAAAAAAACK/AQAAAAAASJX1m7bCm3IAAAAAAAAQ+Q0AAAAAAECq5DdthTflAAAAAAAAIPIbAAAAAACAvk0bDG/KAQAAAAAAQOQ3AAAAAAAAqbJ+01Z4M8nus54cAAAAAABA5DcAAAAAAACplN+0E948+nkAAAAAAACI/AYAAAAAAKCCaWvhTfl5HnpyAAAAAAAAkd8AAAAAAACk0vpNQ+FNOeQ3AAAAAAAAkd8AAAAAAACkVn7TUHhT/ggAAAAAAIDIbwAAAAAAACqYthbelAMAAAAAAIDIbwAAAAAAAFJp/aal8KYcAAAAAAAARH4DAAAAAADQv7WN1sKbcgAAAAAAABD5DQAAAAAAQAXNhTflAAAAAAAAIPIbAAAAAACACjZaC2/KAQAAAAAAQOQ3AAAAAAAAqZXfNBTelAMAAAAAAIDIbwAAAAAAACqYthbelAMAAAAAAIDIbwAAAAAAAFJr/aah8KYcAAAAAAAARH4DAAAAAACQWvlNQ+FNOQAAAAAAAIj8BgAAAAAAoIJpa+FNOQAAAAAAAIj8BgAAAAAAILXWbxoKb8oBAAAAAABA5DcAAAAAAACpld80FN6UAwAAAAAAgMhvAAAAAAAAKpi2Ft6UAwAAAAAAgMhvAAAAAAAAUmv9pqHwphwAAAAAAABEfgMAAAAAAJBa+U1D4U05AAAAAAAAiPwGAAAAAACggmlr4U05AAAAAAAAiPwGAAAAAAAgtdZvGgpvygEAAAAAAEDkNwAAAAAAAKmV3zQU3pQDAAAAAACAyG8AAAAAAAAqmLYW3pQDAAAAAACAyG8AAAAAAABSa/2mofCmHAAAAAAAAER+AwAAAAAAkFr5TUPhTfl5AAAAAAAAiPwGAAAAAACggmlr4U35eR56cgAAAAAAAJHfAAAAAAAApNL6TUPhTTnkNwAAAAAAAJHfAAAAAAAApFZ+01B4U/4IAAAAAACAyG8AAAAAAAAqmLYW3pQDAAAAAACAyG8AAAAAAABSaf2mpfCmHAAAAAAAAER+AwAAAAAA0L+1jdbCm3IAAAAAAAAQ+Q0AAAAAAEAFzYU35QAAAAAAACDyGwAAAAAAgAo2WgtvygEAAAAAAEDkNwAAAAAAAKmV3zQU3pQDAAAAAACAyG8AAAAAAAAqmLYW3pQDAAAAAACAyG8AAAAAAABSa/2mofCmHAAAAAAAAER+AwAAAAAAkFr5TUPhTTkAAAAAAACI/AYAAAAAAKCCaWvhTTkAAAAAAACI/AYAAAAAACC11m8aCm/KAQAAAAAAQOQ3AAAAAAAAqZXfNBTelAMAAAAAAIDIbwAAAAAAACqYthbelAMAAAAAAIDIbwAAAAAAAFJr/aah8KYcAAAAAAAARH4DAAAAAACQWvlNQ+FNOQAAAAAAAIj8BgAAAAAAoIJpa+FNOQAAAAAAAIj8BgAAAAAAILXWbxoKb8oBAAAAAABA5DcAAAAAAACpld80FN6UAwAAAAAAgMhvAAAAAAAAKpi2Ft6UAwAAAAAAgMhvAAAAAAAAUmv9pqHwphwAAAAAAABEfgMAAAAAAJBa+U1D4U35eQAAAAAAAIj8BgAAAAAAoIJpa+FN+XkeenIAAAAAAACR3wAAAAAAAKTS+k1D4U055DcAAAAAAACR3wAAAAAAAKRWftNQeFP+CAAAAAAAgMhvAAAAAAAAKpi2Ft6UAwAAAAAAgMhvAAAAAAAAUmn9pqXwphwAAAAAAABEfgMAAAAAANC/tY3WwptyAAAAAAAAEPkNAAAAAABABc2FN+UAAAAAAAAg8hsAAAAAAIAKNloLb8oBAAAAAABA5DcAAAAAAACpld80FN6UAwAAAAAAgMhvAAAAAAAAKpi2Ft6UAwAAAAAAgMhvAAAAAAAAUmv9pqHwphwAAAAAAABEfgMAAAAAAJBa+U1D4U05AAAAAAAAiPwGAAAAAACggmlr4U05AAAAAAAAiPwGAAAAAAAgtdZvGgpvygEAAAAAAEDkNwAAAAAAAKmV3zQU3pQDAAAAAACAyG8AAAAAAAAqmLYW3pQDAAAAAACAyG8AAAAAAABSa/2mofCmHAAAAAAAAER+AwAAAAAAkFr5TUPhTTkAAAAAAACI/AYAAAAAAKCCaWvhTTkAAAAAAACI/AYAAAAAACC11m8aCm/KAQAAAAAAQOQ3AAAAAAAAqZXfNBTelAMAAAAAAIDIbwAAAAAAACqYthbelAMAAAAAAIDIbwAAAAAAAFJr/aah8KYcAAAAAAAARH4DAAAAAACQWvlNQ+FN+XkAAAAAAACI/AYAAAAAAKCCaWvhTfl5HnpyAAAAAAAAkd8AAAAAAACk0vpNQ+FNOeQ3AAAAAAAAkd8AAAAAAACkVn7TUHhT/ggAAAAAAIDIbwAAAAAAACqYthbelAMAAAAAAIDIbwAAAAAAAFJp/aal8KYcAAAAAAAARH4DAAAAAADQv7WN1sKbcgAAAAAAABD5DQAAAAAAQAXNhTflAAAAAAAAIPIbAAAAAACACjZaC2/KAQAAAAAAQOQ3AAAAAAAAqZXfNBTelAMAAAAAAIDIbwAAAAAAACqYthbelAMAAAAAAIDIbwAAAAAAAFJr/aah8KYcAAAAAAAARH4DAAAAAACQWvlNQ+FNOQAAAAAAAIj8BgAAAAAAoIJpa+FNOQAAAAAAAIj8BgAAAAAAILXWbxoKb8oBAAAAAABA5DcAAAAAAACpld80FN6UAwAAAAAAgMhvAAAAAAAAKpi2Ft6UAwAAAAAAgMhvAAAAAAAAUmv9pqHwphwAAAAAAABEfgMAAAAAAJBa+U1D4U05AAAAAAAAiPwGAAAAAACggmlr4U05AAAAAAAAiPwGAAAAAAAgtdZvGgpvygEAAAAAAEBFa34FAAAAAADA9fTv/zhZXCK8mQwR3kzyO+/06AAAAAAAAGL9BgAAAAAAIDWmb7p2Fm9M3wAAAAAAAER+AwAAAAAAkOr5TUPhTTkAAAAAAACI/AYAAAAAAKCCabJoKrwpBwAAAAAAAJHfAAAAAAAApNb6TTvhzaOfBwAAAAAAgMhvAAAAAAAAUiu/aSi8KT/P9z05AAAAAACAyG8AAAAAAAD6N00WTYU35Y8AAAAAAACI/AYAAAAAACC11m8aCm/KAQAAAAAAQOQ3AAAAAAAAPXtxPUclv2kovCkHAAAAAAAAkd8AAAAAAAD0bT1r02TRVHhTDgAAAAAAACK/AQAAAAAA6Ns0mSRdU+FNOQAAAAAAAIj8BgAAAAAAoG8byTzpmgpvygEAAAAAAEDkNwAAAAAAAOk/vzlMFk2FN+UAAAAAAACgrjW/AgAAAAAA4Lp58QPJ/vH6zYDhzfL/+Sde9vQAAAAAAABi/QYAAAAAAKBnk2TjOL9pYvHG9A0AAAAAAEDkNwAAAAAAANWU9uYwWbQT3pQDAAAAAACAyG8AAAAAAADSf35zmEySrp3wphwAAAAAAABEfgMAAAAAANCnFzeT/WSSzJOunfCmHAAAAAAAAER+AwAAAAAA0KtJspHMk8Nk0U54Uw4AAAAAAAAivwEAAAAAAOjV6+3NJOnaCW/KAQAAAAAAQHVrfgUAAAAAAMD18eJnk4PkMJkn86TrIbyZ9BPeTPKJX/UAAQAAAAAAYv0GAAAAAACgT2VAZnI8gLNoYfHG9A0AAAAAAEDkNwAAAAAAAHVMT7Q3k6RrJLwpBwAAAAAAAJHfAAAAAAAA9ObFP0/mJ9qbedI1Et6UAwAAAAAAgMhvAAAAAAAA+rPxeHtzmCwaCW/KAQAAAAAAQOQ3AAAAAAAA6TO/OdneTJKukfBmkk+8y/MDAAAAAACI/AYAAAAAAKAvL77ylvZmnnQNhDembwAAAAAAACK/AQAAAAAA6N30Le3NYbJoIbwpBwAAAAAAAJHfAAAAAAAA9OPFg2T+lvZmknQthDflAAAAAAAAIPIbAAAAAACAfqxt5Oit7c086VoIbyb5xDOeIQAAAAAAQOQ3AAAAAAAAvbjzY8k8a9Nk/pYIZzH28ObRzwMAAAAAAEDkNwAAAAAAAD3ZeCO5eXOE040+vCk/z/c9RQAAAAAAgMhvAAAAAAAAVu/Oux+fu3lThNONPrwpfwQAAAAAAEDkNwAAAAAAAH2Yvrm9eSzCWYw+vFnP7Vc8RQAAAAAAgMhvAAAAAAAAVu/Oh5L56e3No6MbdXhj+gYAAAAAACDyGwAAAAAAgJ7ceT7ZP7O9mSfduMObcgAAAAAAABD5DQAAAAAAwMpNko0z25vDZDHu8KYcAAAAAAAADGrNrwAAAAAAALh67mwnB8lhMj8ubU49ukHDm3P85dt/4WECAAAAAADE+g0AAAAAAMCqrR8P4MzPHMDpxrp4Y/oGAAAAAAAg8hsAAAAAAIB+3Ll/ZnJz8liMOLwpBwAAAAAAAENb8ysAAAAAAACukjt/lOwn8+PA5uyjqxjeLP+f337Z8wQAAAAAAIj1GwAAAAAAGJHZv0wOkv1k/83H0Yl/s/VOv6qRuvOlZD/ZOMfuzeQ4vxnh4o3pGwAAAAAAgMhvAAAAAABgNGYvPN7bHD59OGXv64/+8tYv+v2NzGSZ9uYwWYw1vCkHAAAAAAAAI7DmVwAAAAAAwLU1+8zpQzdnT9+ccsyz9TG/zuHd+V9PT6fefHS9hTeX/pzbn/JIAQAAAAAAYv0GAAAAAACGMfvCG+XMcrXGqcd+9l5IDrOllxjOnVeOH+g5d28mx/nN2BZvTN8AAAAAAADE+g0AAAAAAAxn9uXzLt6cd/rmTcc8Wy/7Ndd257sn2pulAqrFuBZv3pi+2fJUAQAAAAAAYv0GAAAAAABqm/3X1S3ePOnYz95z2fqiX3Zdk2Rjyd2bcnQjW7wxfQMAAAAAABD5DQAAAAAADGH2l8cDNUtGNUeHy/9X+9l7f7b+p996JXfXcnSx9maedOMLb8oBAAAAAABA5DcAAAAAAFDL7OsXCW8ueey9J1vf8Lvv3d0fS+ZZmybzHM2Xj3AW4wtvJrn9qx4sAAAAAABA5DcAAAAAAFDJ7JvJ/gUTmotM35wscP5Rtv7WE+jR3X/8WE5zkQinG1d4Y/oGAAAAAAAg8hsAAAAAAKhp9q1kv97izSkFzj9I5tn6vkexenffe3pXs1yE040svCkHAAAAAAAAkd8AAAAAAED/Zt++1HbNJadv3vic/TyY58azHsgq3f3AU7qa80Y4i5GFN+u5/T6PFwAAAAAAIPIbAAAAAADo3ew7yf4wizenHPt58GpuvN1jWY27v/K0TZvzRzjdiMIb0zcAAAAAAACR3wAAAAAAQD2XnKxZ1fTN65+znwffyo13eTCXdfc3z9venCvC6cYU3qzn9rs9YQAAAAAAgMhvAAAAAAAg12v65uQGzl/mxs97Phd3d3Pp9uYpEc5iLOGN6RsAAAAAAIDIbwAAAAAAoI7Zq8n+yKZvThY4X86Nj3hKF3H33128vXlihNONJrxZz+13eMgAAAAAAACR3wAAAAAAQP9GtXhz2vHgC7nxvOe0hLt/kLy2gvbmlAinG0V4Y/oGAAAAAAAg8hsAAAAAAIjpm5MFzmeSw9zY8sSe7u6fJa8lGytrbx6LcBbjCG/Wc/tHPGoAAAAAAIDIbwAAAAAAIKZv3jgO8mA3Nz7lmZ3l7leS/V7am0dHN3x4Y/oGAAAAAAAg8hsAAAAAAIjpmycVOP8mN/6DR3eKu99KXuu5vZkn3fDhzdp6dn7ggQMAAAAAAER+AwAAAAAAMX1z6vHg13LjTzy8x9x9NXktmfTc3hwmi4HDm0ySafLQMwcAAAAAAIj8BgAAAAAAYvrmiQXOLyXz3PiKx5gkdw+SgyrtzSTphg5v1rPzXc8cAAAAAAAg8hsAAAAAAIjpm6cc+3nwnmSeG399fZ/hvZ9IHuZoPZlXaW/mSTdkePPojwAAAAAAAIj8BgAAAAAAKjhsdfrmsWM/D34iN67fHMq99ySvJfvJetYmOZpXaW8Ok8Wg4c16dl7x6gIAAAAAAER+AwAAAAAAqbR+c9j+Bs48OcyDH87RYW4+c10e3b33J68dlyrzZCNr02ReJcLpBgtvTN8AAAAAAABEfgMAAAAAANXMvn2pzZmxTN88/jn3X83Nt1/xB3fv145Hb060N68XMjUinG648GY9O1/z7gIAAAAAAER+AwAAAAAAMX1z4eP+t5L93PzZK/jE7t1MHiYHJ6KUx9ubShHOYpjwJpPsfNV7CwAAAAAAEPkNAAAAAACkXn5ztaZvTv6b+/89OUgOc/NfXIVndW/vePGmJDdntje9RzjdAOHNowMAAAAAAIDIbwAAAAAAoJqrOH3z5uMg9/9jMs/Nj7f6lO796XF4M1muvekxwumGCG8m2fkLLy0AAAAAAEDkNwAAAAAAkKrrN1d0+ubNx37u7yYHuXm/mYdz7+vH1c3BiQRl+famlwhnUTu8MX0DAAAAAAAQ+Q0AAAAAAGSQ/GZ+PTZwjo/7H032k/3c/C8jfSb3vpfsP3nu5qLtzYojnK56eDPJzp94YwEAAAAAACK/AQAAAACAuq7J9M1px/33JwfJYW5+YxSP4qV/+Ki6OXom+aEnzN1cur1ZWYTTVQ1vMsnO572uAAAAAAAAkd8AAAAAAEAGWL85vI4bOG8cB7lfupeDHO3n1rNVf/0v/dKJoZuD4+rmScnN6tqbFUQ4i3rhzaMDAAAAAACAyG8AAAAAACBD5DfXcvrmSZ/z6VePS5j9ZJ5b71vx7/ulF5L9pyQ3a5Mc7ddoby4V4XQVw5tJdn7fuwoAAAAAABD5DQAAAAAADOGaT9+cfezn0392nOLsP34c5tbnz/q9vvTtx//+wxP/+EPnXrmp0t5cMMLpKoU3pm8AAAAAAAAivwEAAAAAgCEtki7pHEse/y+f/shpWc5+jl7/N88clzbPLF3anD6A02d7s3SEs6gV3kyy8ykvKgAAAAAAQOQ3AAAAAAAwkMlFZ1gclY8q7c0SEU5XI7zJenY+6S0FAAAAAACI/AYAAAAAADJkfrOSYRaf0+vn1G1vzhXhdL2HN5lkZ8crCgAAAAAAEPkNAAAAAAAMafPDmX3JvIzdm+UjnEW/4c2jAwAAAAAAgMhvAAAAAAAgBnB8zpM/Zz5we/PECKfrObyZZOdjXk4AAAAAAIDIbwAAAAAAYATMy4x49+b05ZkxRDhdj+FNJtn5V95MAAAAAACAyG8AAAAAAGAUNj+Y2Z8bnBnf52w8eXlmDBHOoq/wJuvZed57CQAAAAAAEPkNAAAAAADEAI7jPO3NSCOcrpfw5tEBAAAAAABA5DcAAAAAABADOD5nifZmdBFO1094s56dj3gjAQAAAAAAIr8BAAAAAIAYwHFcoL0ZUYSz6GX6ZucXvYoAAAAAAACR3wAAAAAAQAzg+JzLtDejiHC61U/f7PyCFxEAAAAAACDyGwAAAAAAiAEcx0ram4EjnG7F0zc77/MGAgAAAAAARH4DAAAAAAAxgONzVtveDBbhLFY5fbPz894/AAAAAACAyG8AAAAAAKABmx/O7Eu2aJrZvRkywulWNn2z87PePAAAAAAAgMhvAAAAAACgHYZrKn/OxuoLmRoRTrey6RsAAAAAAAAivwEAAAAAgBjAcdRqbypFOIsVTd+80zsHAAAAAAAQ+Q0AAAAAADRm85cz+6Lhmv4/p8/2pvcIp1vB9M3OO7xtAAAAAAAAkd8AAAAAAECTNp/L7I+t07S6e1MjwukuO32z83bvGQAAAAAAQOQ3AAAAAADQsM1fz+yPDNf08zl125teIpzFpaZvdn7cGwYAAAAAABD5DQAAAAAANG/zNzJ72V5N27s3fUU43cWnb3Z+xLsFAAAAAAAQ+Q0AAAAAAFwRmx/N7LOGa1b3OfOB25uVRTjdBadvdp71VgEAAAAAAER+AwAAAAAAV8rmb2X2e4ZrVrN7s5rlmTFEOIuLTN/sPON9AgAAAAAAiPwGAAAAAACuoM3fzuy+AZzLtjcrW54ZQ4TTLRferK1n+wfeJAAAAAAAgMhvAAAAAADgytq8mSSzT5qyuWx7c0UinG6J8CYT7Q0AAAAAAEDkNwAAAAAAcC1svpDZtgGcFbQ3zUc4i2XCG+0NAAAAAABA5DcAAAAAAHBtbL6U2aZNm9W0Nw1HON3Tw5tMs/3QGwMAAAAAABD5DQAAAAAAXDubs8w+bgBnZe1NkxFO95TwJuvZ/q53BQAAAAAAIPIbAAAAAAC4pjY/k9m/Nm6zyvamsQhncVZ4k0m2/85bAgAAAAAAEPkNAAAAAABca5ufy+w3DeCsuL1pJsLpnhjeZJLtv/V+AAAAAAAAIL8BAAAAAIBk8w+TZPYr5m5W3N40EOF0p4c3Wc/2K94MAAAAAAAAEvkNAAAAAAC8bvM/Z/YRAzirb29GHeEshDcAAAAAAABEfgMAAAAAAOe1+eXMPmT3ppf2ZqQRTvdYeJNJtv/aewAAAAAAAEDkNwAAAAAA8ESb/y1JZv/0Gg/gbNRanhlDhNO9Ed5kku1veAMAAAAAAACI/AYAAAAAAJ5u839n9l67N9cgwlkIbwAAAAAAAIj8BgAAAAAALmLzrzJ79zUbwNkYJoMZMsLpkvVsf833HQAAAAAAgMhvAAAAAABgaZvfTJLZO+zeXN0Ip8v2V33TAQAAAAAAiPwGAAAAAAAubvM7mf3kVR/AmQ/c3gwS4Wx/2bcbAAAAAACAyG8AAAAAAGAFNv9PkszWr+zuzTDLMwNGOF22P+97DQAAAAAAQOQ3AAAAAACwSpuHmV29AZyNYZZnBoxwtme+ywAAAAAAAER+AwAAAAAAvdg8SqbZ+79XZ/dmgOWZ4SKc7Rd8hQEAAAAAAIj8BgAAAAAAerf1o0my9zeND+BsDLA8M1iE02X7Y765AAAAAAAARH4DAAAAAAD1bP1U9l65Urs3VzXC2X7OtxUAAAAAAIDIbwAAAAAAYABbP50ke19rbQBno+7yzHARzvY/9yUFAAAAAAAg8hsAAAAAABjY1s8lyd5XrtTuTfMRztuy/W7fTQAAAAAAACK/AQAAAACAsdj6YJLsfXHcAzgb9ZZnBotwumy/3fcRAAAAAACAyG8AAAAAAGCMtp5Lkr2Xr9TuTTMRTpftZ3wHAQAAAAAAiPwGAAAAAADGbuujSbJ3f0wDOBtVlmcGOm59L0mivQEAAAAAAKAHa34FAAAAAADQq71PJvvJfnLwxOPo4Ol/5zzHEz+nxCrzHo+j/v8Xpx63vukrBgAAAAAAQOQ3AAAAAADQvL2PPyWeObp0e/PEz6nYw9SMcG79D18rAAAAAAAAIr8BAAAAAIArZe/56gM4Q4zS9B3h3PpPvkoAAAAAAABEfgMAAAAAAFfZ3geqDOAM0d70F+HcmvniAAAAAAAAEPkNAAAAAABcL3s/09sAzqDtzSojnC63dnxTAAAAAAAAiPwGAAAAAACur72fXPUAzjjam0tFOIvcet5XAwAAAAAAgMhvAAAAAACANzz4wSoGcFa4PDNEhHPrg74IAAAAAAAARH4DAAAAAACc5cHfXLa9aSzC6XLrXR47AAAAAAAAkd8AAAAAAABLe/CVi7c3o45wutx61uMFAAAAAAAg8hsAAAAAAGBlHnz2Iu3NiCKcLjf/zmMEAAAAAAAg8hsAAAAAAKB3DzaXa28Gi3C63PyqxwUAAAAAAEDkNwAAAAAAwPAefGjgCOfm5zwEAAAAAAAAIr8BAAAAAACa8eC9fUU4N3/LbxcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK6O/w9OUSVoxZ2yfgAAAABJRU5ErkJggg==" },
  { W: 3253, H: 900, maxT: 15877.0,
    uri: "data:image/png;base64,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" }
];
const W1_SPAN = FIELDS[0].maxT / SPEED2;              // word 1 fills in 6.419 s
const W2_START = START_PAUSE + W1_SPAN + WORD_GAP;    // word 2 starts at 7.369 s
const TOTAL = W2_START + FIELDS[1].maxT / SPEED2 + 0.12;
const FINISH = TOTAL - 0.12;
const NS = "http://www.w3.org/2000/svg";
// ---- END constants; functions below ----
function el(tag) { return document.createElementNS(NS, tag); }

function buildGuide() {
  const defs = el("defs");
  const gGuide = el("g");
  gGuide.setAttribute("id", "guide");
  gGuide.setAttribute("opacity", params.has("guide") ? "0.35" : "0");
  gGlyph = el("g");
  gGlyph.setAttribute("visibility", "hidden");   // shown at FINISH
  svg.appendChild(defs);
  svg.appendChild(gGuide);
  svg.appendChild(gGlyph);

  // The guide: two left-aligned lines sharing one margin, replicating
  // the app hero's stacked, left-aligned wrapped spans.
  const texts = ["Nonograms", "Original"].map((w, wi) => {
    const t = el("text");
    t.setAttribute("x", MARGIN);
    t.setAttribute("y", wi === 0 ? BASE1 : BASE2);
    t.setAttribute("font-size", FS);
    t.setAttribute("letter-spacing", LS);
    t.setAttribute("text-anchor", "start");
    t.style.fill = "var(--espresso)";
    t.textContent = w;
    gGuide.appendChild(t);
    return t;
  });
  svg.getBoundingClientRect();            // force layout so char positions exist

  // Placement comes from the BAKE, not the DOM. OCC holds the shaped advances
  // the fields were rasterized from; deriving origins + viewBox from it makes
  // canvas and FINISH vectors agree on EVERY engine by construction. Live
  // measurement is NOT trustworthy across engines: WebKit ignores the
  // letter-spacing attribute on SVG text (and may shape calt differently), so
  // getStartPositionOfChar/getComputedTextLength drifted from the bake by up
  // to 22 viewBox units on iOS — the FINISH vectors landed compressed against
  // the flood canvas (his round-40 report). Width rule matches
  // getComputedTextLength: sum(adv) + letter-spacing per glyph, incl. trailing.
  // OCC's `word` field is the word NAME ("Nonograms"/"Original"), not an
  // index — derive the numeric index from the name transitions (all of one
  // word first, then all of the next).
  const wordIdx = [];
  {
    let wi = 0;
    OCC.forEach((o, i) => { if (i > 0 && o.word !== OCC[i - 1].word) wi++; wordIdx.push(wi); });
  }
  const widthOf = wi => OCC.filter((o, i) => wordIdx[i] === wi)
    .reduce((a, o) => a + o.adv * S + LS, 0);
  viewW = Math.max(widthOf(0), widthOf(1)) + MARGIN * 2;
  svg.setAttribute("viewBox", "0 " + VB_Y + " " + Math.ceil(viewW) + " 480");

  // Per occurrence: closed-form origin — margin + running advances, reset at
  // each word. (The v3 "guide and dark layer coincide by construction"
  // invariant only holds where the engine shapes the guide like the bake.)
  let cx = MARGIN;
  OCC.forEach((o, i) => {
    if (i > 0 && o.word !== OCC[i - 1].word) cx = MARGIN;
    origins.push({ x: cx, word: wordIdx[i] });
    cx += o.adv * S + LS;
  });

  // Drift guard, repurposed: placement no longer reads the DOM, but a wide
  // gap between DOM shaping and the bake still means the ?guide overlay and
  // the flood disagree — so keep measuring and keep warning, for diagnostics
  // only (fires on WebKit, silent on Blink).
  let worst = 0;
  let mi = 0;
  texts.forEach((t, wi) => {
    for (let k = 0; k < t.getNumberOfChars(); k++, mi++) {
      worst = Math.max(worst,
        Math.abs(t.getStartPositionOfChar(k).x - origins[mi].x));
    }
  });
  if (worst > 0.25) console.warn("origin drift " + worst.toFixed(3) +
    " viewBox units — font/OCC mismatch, flood and FINISH will disagree");

  // The finished wordmark: every occurrence's shaped outline at its DOM
  // origin. Hidden during play; FINISH reveals it (crisp vectors, the
  // ratified final frame by construction).
  for (let i = 0; i < OCC.length; i++) {
    const { name } = OCC[i];
    const { x, word } = origins[i];
    const base = word === 0 ? BASE1 : BASE2;
    const inst = el("path");
    inst.setAttribute("d", OUTLINES[name]);
    inst.setAttribute("transform", "translate(" + x + " " + base + ") scale(" + S + ",-" + S + ")");
    inst.style.fill = "var(--espresso)";
    gGlyph.appendChild(inst);
  }

  if (params.has("dump")) {
    const pre = document.createElement("pre");
    pre.id = "dump";
    pre.textContent = JSON.stringify({
      W: viewW,
      o: origins.map(o => [Math.round(o.x), o.word]),
      w: [[+START_PAUSE.toFixed(3), +(START_PAUSE + W1_SPAN).toFixed(3)],
          [+W2_START.toFixed(3), +(W2_START + FIELDS[1].maxT / SPEED2).toFixed(3)]],
      t: +TOTAL.toFixed(3)
    });
    document.body.appendChild(pre);
  }
}

// Compile the threshold program once; per-word buffers/textures come from
// loadField. One quad per word: aPos in field pixels, aUV 0..1.
let glProg = null, glU = null, glAttr = null;   // composite program + state
let glA = null, glB = null;                     // threshold + reduce programs
function initGL() {
  if (!gl) return;
  // 16-bit levels need exact integer math past 65k -- half-float mediump
  // would reband the fill, so the flood demands true highp (universal on
  // every shipping phone/desktop GPU; without it, finished wordmark).
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!hp || hp.precision < 23) {
    console.warn("highp fragment precision unavailable -- flood disabled");
    return;
  }
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("flood shader: " + gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  // pass A: threshold per texel, then 2x2 box -> half-res premultiplied
  // coverage. Four NEAREST taps at the block's four texel CENTERS take each
  // texel's EXACT distance value -- thresholding exact values is what kills
  // the dotted-outline ghost on unreached letters (any interpolation toward
  // background invents sub-threshold pixels at ink edges). Each texel's cov
  // uses a smoothstep ramp uRamp levels wide (the round brush's wet edge)
  // over its 16-bit distance; the box then averages COVERAGE, i.e. true
  // antialiasing: a lone filled texel in the block paints 25% ink.
  const vsA = sh(gl.VERTEX_SHADER,
    "attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}");
  const fsA = sh(gl.FRAGMENT_SHADER,
    "precision highp float;uniform sampler2D uTex;uniform vec2 uIn;" +
    "uniform float uThr,uRamp;uniform vec3 uInk;" +
    "float tx(vec2 q){vec4 c=texture2D(uTex,q/uIn);float g=c.r*65280.0+c.g*255.0;" +
    "if(g<0.5)return 0.0;float t=clamp((uThr-g)/uRamp,0.,1.);" +
    "return t*t*(3.0-2.0*t);}" +
    "void main(){vec2 p=floor(gl_FragCoord.xy)*2.0;" +
    "float cov=0.25*(tx(p+vec2(.5,.5))+tx(p+vec2(1.5,.5))+" +
    "tx(p+vec2(.5,1.5))+tx(p+vec2(1.5,1.5)));" +
    "gl_FragColor=vec4(uInk*cov,cov);}");
  // pass B: 2x2 box -> quarter FIELD res (one LINEAR tap on the exact corner
  // the four texels of each 2x2 block share, so each weighs 25%). Averaging
  // pass A's already-thresholded coverage is true AA downsampling — the r32
  // four-tap 4:1-stride version was twice the blur the screen footprint needs
  // (his round-33 zoom-ins: mid-play looked softer than the final frame).
  const fsB = sh(gl.FRAGMENT_SHADER,
    "precision highp float;uniform sampler2D uTex;uniform vec2 uIn;" +
    "void main(){vec2 p=floor(gl_FragCoord.xy)*2.0;" +
    "gl_FragColor=texture2D(uTex,(p+vec2(1.0,1.0))/uIn);}");
  // pass C: composite the quarter-res coverage onto the page at uMap.
  const vsC = sh(gl.VERTEX_SHADER,
    "attribute vec2 aPos;attribute vec2 aUV;uniform vec4 uMap;" +
    "varying vec2 vUV;void main(){vUV=aUV;" +
    "gl_Position=vec4(aPos.x*uMap.x+uMap.z,aPos.y*uMap.y+uMap.w,0.,1.);}");
  const fsC = sh(gl.FRAGMENT_SHADER,
    "precision highp float;varying vec2 vUV;uniform sampler2D uTex;" +
    "void main(){gl_FragColor=texture2D(uTex,vUV);}");
  if (!vsA || !fsA || !fsB || !vsC || !fsC) return;
  const link = (v, f) => {
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn("flood link: " + gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  };
  glProg = link(vsC, fsC); glA = link(vsA, fsA); glB = link(vsA, fsB);
  if (!glProg || !glA || !glB) { glProg = null; return; }
  glU = { map: gl.getUniformLocation(glProg, "uMap"),
          tex: gl.getUniformLocation(glProg, "uTex") };
  glAttr = { pos: gl.getAttribLocation(glProg, "aPos"),
             uv: gl.getAttribLocation(glProg, "aUV") };
  glA.u = { tex: gl.getUniformLocation(glA, "uTex"),
            in: gl.getUniformLocation(glA, "uIn"),
            thr: gl.getUniformLocation(glA, "uThr"),
            ramp: gl.getUniformLocation(glA, "uRamp"),
            ink: gl.getUniformLocation(glA, "uInk") };
  glB.u = { tex: gl.getUniformLocation(glB, "uTex"),
            in: gl.getUniformLocation(glB, "uIn") };
  gl.activeTexture(gl.TEXTURE0);
  gl.clearColor(0, 0, 0, 0);
  // full-clip quad reused by passes A/B (drawn as TRIANGLE_STRIP)
  glA.vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, glA.vbo);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  glA.pos = gl.getAttribLocation(glA, "aPos");
  glB.pos = gl.getAttribLocation(glB, "aPos");
}

// Decode a word's distance-field PNG and stage it: the decoded canvas becomes
// the GPU texture the shader thresholds (gray = red channel of the gray8 PNG).
function loadField(F, dx, dy) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = F.W; cv.height = F.H;
      cv.getContext("2d").drawImage(img, 0, 0);
      const W2 = { F, tex: null, vbo: null, dx, dy, dw: F.W * S, dh: F.H * S,
                   A: null, B: null };
      if (gl && glProg) {
        const mkTex = (w, h, filt) => {
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          const f = filt || gl.LINEAR;
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
                        gl.RGBA, gl.UNSIGNED_BYTE, null);
          return t;
        };
        W2.tex = mkTex(F.W, F.H, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                      gl.UNSIGNED_BYTE, cv);
        // supersample chain: A = half field res (2x2 box), B = half of A
        // (2x2 box) = quarter field res, 4x4 box over the field total. The
        // composite then lands ~1:1 on a 1x display (fx.width ≈ B.w) instead
        // of r32's 2.3x-4.7x upscale of a 1/8-res texture — the mid-play
        // softness he zoomed into. (r30 got this quality by letting the
        // browser downscale a field-res canvas.)
        const aw = Math.ceil(F.W / 2), ah = Math.ceil(F.H / 2);
        const bw = Math.ceil(aw / 2), bh = Math.ceil(ah / 2);
        const mkFbo = (t) => {
          const f = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, f);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                  gl.TEXTURE_2D, t, 0);
          const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) ===
                     gl.FRAMEBUFFER_COMPLETE;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return ok ? f : null;
        };
        const texA = mkTex(aw, ah), fboA = mkFbo(texA);
        const texB = mkTex(bw, bh), fboB = mkFbo(texB);
        if (!fboA || !fboB) {
          console.warn("flood FBOs unavailable -- showing finished wordmark");
          glProg = null; resolve(W2); return;
        }
        W2.A = { tex: texA, fbo: fboA, w: aw, h: ah };
        W2.B = { tex: texB, fbo: fboB, w: bw, h: bh };
        const quad = new Float32Array([            // TRIANGLE_STRIP: (pos, uv) ×4
          0, 0, 0, 0,  F.W, 0, 1, 0,
          0, F.H, 0, 1,  F.W, F.H, 1, 1]);
        W2.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, W2.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      }
      resolve(W2);
    };
    img.onerror = () => reject(new Error("field decode failed"));
    img.src = F.uri;
  });
}

function buildFields() {
  // Field col c <-> font x = c - 2; row r <-> font y = TOP - r. Place the
  // canvas so its top-left sits at (originX - 2, baseline - TOP) in font
  // units, i.e. (originX - 2*S, base - TOP*S) in viewBox units.
  const starts = [origins[0].x, origins[origins.findIndex(o => o.word === 1)].x];
  const dys = [BASE1 - TOP * S, BASE2 - TOP * S];
  return Promise.all(FIELDS.map((F, wi) => loadField(F, starts[wi] - 2 * S, dys[wi])))
    .then(ws => { words.push(...ws); });
}

function fitFx() {
  const r = svg.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr));
  const scale = w / viewW;
  fx.width = w;
  fx.height = Math.max(1, Math.round(480 * scale));
  if (gl) gl.viewport(0, 0, fx.width, fx.height);
}

// Threshold one word's field at time t. uMap carries the same placement the
// 2D canvas used — dx/dy in viewBox units, minus VB_Y (the r31 y fix: the
// viewBox starts at y=100, and the canvas's top edge IS that line, so every
// field row was landing 100 units low until FINISH swapped in the SVG).
function paintWord(W, t, start) {
  const el = t - start;
  if (el <= 0 || !gl) return;
  // pass A: threshold + 2x2 box into the half-res FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, W.A.fbo);
  gl.viewport(0, 0, W.A.w, W.A.h);
  gl.useProgram(glA);
  gl.uniform1i(glA.u.tex, 0);
  gl.uniform2f(glA.u.in, W.F.W, W.F.H);
  gl.uniform1f(glA.u.thr, 65535.0 * el * SPEED2 / W.F.maxT);
  gl.uniform1f(glA.u.ramp, 80.0 * 65535 / W.F.maxT); // 40 font units of wet edge
  gl.uniform3fv(glA.u.ink, INK);
  gl.bindTexture(gl.TEXTURE_2D, W.tex);
  gl.enableVertexAttribArray(glA.pos);
  gl.bindBuffer(gl.ARRAY_BUFFER, glA.vbo);
  gl.vertexAttribPointer(glA.pos, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // pass B: 4x4 box into the quarter-res FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, W.B.fbo);
  gl.viewport(0, 0, W.B.w, W.B.h);
  gl.useProgram(glB);
  gl.uniform1i(glB.u.tex, 0);
  gl.uniform2f(glB.u.in, W.A.w, W.A.h);
  gl.bindTexture(gl.TEXTURE_2D, W.A.tex);
  gl.enableVertexAttribArray(glB.pos);
  gl.bindBuffer(gl.ARRAY_BUFFER, glA.vbo);
  gl.vertexAttribPointer(glB.pos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function compositeWord(W) {
  const s = fx.width / viewW;                 // device px per viewBox unit
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, fx.width, fx.height);
  gl.useProgram(glProg);
  gl.uniform4f(glU.map,
    2 * S * s / fx.width,
    -2 * S * s / fx.height,
    2 * W.dx * s / fx.width - 1,
    1 - 2 * (W.dy - VB_Y) * s / fx.height);
  gl.uniform1i(glU.tex, 0);
  gl.bindTexture(gl.TEXTURE_2D, W.B.tex);
  gl.bindBuffer(gl.ARRAY_BUFFER, W.vbo);
  gl.enableVertexAttribArray(glAttr.pos);
  gl.enableVertexAttribArray(glAttr.uv);
  gl.vertexAttribPointer(glAttr.pos, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(glAttr.uv, 2, gl.FLOAT, false, 16, 8);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function paintAt(t) {
  const done = t >= FINISH || !glProg;
  if (done) {
    if (gl) gl.clear(gl.COLOR_BUFFER_BIT);
    gGlyph.setAttribute("visibility", "visible");
    return true;
  }
  gGlyph.setAttribute("visibility", "hidden");
  paintWord(words[0], t, START_PAUSE);
  paintWord(words[1], t, W2_START);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, fx.width, fx.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  // Composite ONLY words that have started. paintWord early-returns while
  // el <= 0, leaving that word's A/B FBOs holding stale ink from the previous
  // playthrough — compositing them anyway is his round-33 replay bug: on
  // Replay (or speed change, or scrubbing back over a word's start) the second
  // word sat fully drawn for seconds, then popped empty when its start came.
  if (t > START_PAUSE) compositeWord(words[0]);
  if (t > W2_START) compositeWord(words[1]);
  return false;
}

function frame(now) {
  if (t0 === null) t0 = now;
  const t = (now - t0) / 1000 * speed;
  lastT = t;
  if (paintAt(t) || t >= TOTAL) { running = false; return; }
  raf = requestAnimationFrame(frame);
}
// ---- END verbatim from logo-intro.html ----

  function boot() {
    // Watchdog: catastrophic backstop only — the wall-clock timer in play()
    // normally lands the finish (TOTAL ≈ 11.1 s of animation ≈ 2.8 s of wall
    // clock at the 4× ruling, plus the boot beat). Whatever hangs (font
    // download, PNG decode, a GL driver that never calls back), Play must not
    // stay hidden forever. finishNow is a no-op if the intro already finished.
    setTimeout(() => { if (!finished) finishNow("watchdog"); }, 9000);
    document.fonts.load("500 " + FS + "px Aghja").then(async () => {
      if (finished) return; // skipped during the font-load beat
      buildGuide();
      initGL();
      if (!glProg) console.warn("WebGL unavailable — showing the finished wordmark without the flood");
      try { await buildFields(); }
      catch (e) { console.warn("hero intro fields failed", e); finishNow("fields"); return; }
      if (finished) return; // skipped while the fields decoded
      fitFx();
      window.addEventListener("resize", fitFx);
      if (REDUCED || !glProg) finishNow("reduced-or-no-gl");
      else play();
    }).catch(e => { console.warn("hero intro font load failed", e); finishNow("font"); });
  }

  return {
    onScreen(name) {
      if (name !== "home" || booted) return;
      booted = true;
      if (!document.body.classList.contains("user-mode")) return;
      screenHome.classList.add("flood-live");
      // Tap the wordmark = skip, like the page. The canvas sits on top, so
      // listen on the stage wrapper and let clicks bubble up.
      const stage = document.getElementById("heroStage");
      if (stage) stage.addEventListener("click", () => finishNow("tap"));
      // Backgrounding mid-intro: resume = finish. The page restarts play()
      // from t=0 on visible-again; in an app a 13 s intro replaying every
      // notification swipe is hostile, and the finished vectors are the
      // landing state anyway.
      document.addEventListener("visibilitychange", () => {
        if (finished) return;
        if (document.hidden) {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
        } else if (running) {
          finishNow("backgrounded");
        }
      });
      boot();
    },
  };
})();

// Scroll watchdog (batch C8): whatever vector produces an offset while in
// solve — a fling's momentum tail landing after the entry resets, a lazy
// clamp, a programmatic shift — it is re-zeroed within a frame, for as long as
// we stay in solve. Deliberate inner scrollers (modal content: .givens-slides,
// the settings list, win-card facts) are untouched — zeroSolveScroll only
// touches the five whole-screen shifters, and every write is conditional on
// the offset being non-zero, so benign scrolls are a no-op (no event loop).
// scroll events don't bubble, hence the capture phase to see element scrolls
// as well as the document's. Guarded on currentUserScreen so the puzzles-list
// restore (Back from solve) is never fought.
document.addEventListener("scroll", () => {
  if (currentUserScreen !== "solve") return;
  zeroSolveScroll();
}, { capture: true, passive: true });

// === DEV-ONLY shift telemetry (batch C9, 2026-09-01) ===
// The dog-glitch family survived overflow:clip + the watchdog, which means the
// surviving offset either lives at a layer JS can't see (a compositor/ghost
// offset — the renderer shifted while every DOM scrollTop reads 0 and no scroll
// events fire) or the phone is running a stale PWA build. So: measure, don't
// model. The badge shows, live, on the solve screen in dev mode: the build
// stamp (proves WHICH build the phone is running — settles the stale-build
// question in any screenshot), every scroll offset the shift could live on
// (window/html/body/.layout/main/.puzzle-and-ref), the visualViewport pan/zoom,
// and #solveBack's live getBoundingClientRect().top — that one moves WITH the
// rendered header, so a compositor-level shift the DOM can't see still shows up
// here. .bad (red) = an anomaly is present right now. While the givens modal is
// open, a second line shows the last few taps as "x,y>target" — the "arrow
// closed the popup" report needs to know whether the tap landed on #givensNext
// (logic bug) or on .modal-backdrop (hit-test desync). closest() walks up, so a
// tap on the arrow's SVG path still reports the button. Strip at ship with the
// rest of the dev bundle (grep dev-mode / dev-only).
(function initDevShiftBadge() {
  if (!DEV_BUILD) return;
  const badge = document.createElement("div");
  badge.id = "devShiftBadge";
  badge.setAttribute("aria-hidden", "true");
  document.body.appendChild(badge);
  // Dev builds self-label on every screen: the stamp-only readout needs no
  // dev-mode unlock (which is desktop-only since F1), so the phone can always
  // answer "which build am I on" — the stale-binary confusion class dies here.
  document.body.classList.add("dev-build");
  const buildMeta = document.querySelector('meta[name="build"]');
  const build = buildMeta ? buildMeta.content : "?";
  const taps = [];
  const TAP_KEYS = "#givensNext, #givensDone, #givensBack, #givensNever, .modal-backdrop, .modal-content, button";
  document.addEventListener("pointerdown", (e) => {
    const hit = e.target;
    const key = hit && hit.closest ? hit.closest(TAP_KEYS) : null;
    let label;
    if (key) label = key.id ? "#" + key.id : "." + String(key.className).split(" ")[0];
    else if (hit && hit.id) label = "#" + hit.id;
    else label = hit && hit.tagName ? hit.tagName.toLowerCase() : "?";
    taps.push(Math.round(e.clientX) + "," + Math.round(e.clientY) + ">" + label);
    if (taps.length > 4) taps.shift();
  }, { capture: true, passive: true });
  setInterval(() => {
    const full = document.body.classList.contains("dev-mode") &&
                 document.body.dataset.screen === "solve";
    if (!full) {
      badge.textContent = "b" + build;
      badge.classList.remove("bad");
      return;
    }
    const layout = document.querySelector(".layout");
    const main = document.querySelector(".layout main");
    const pnr = document.querySelector(".puzzle-and-ref");
    const back = document.getElementById("solveBack");
    const vv = window.visualViewport;
    const v = {
      y: Math.round(window.scrollY || 0),
      h: Math.round(document.documentElement.scrollTop || 0),
      b: Math.round(document.body.scrollTop || 0),
      L: layout ? Math.round(layout.scrollTop) : 0,
      m: main ? Math.round(main.scrollTop) : 0,
      p: pnr ? Math.round(pnr.scrollTop) : 0,
      vvo: vv ? Math.round(vv.offsetTop) : 0,
      vvs: vv ? vv.scale : 1,
      sb: back ? Math.round(back.getBoundingClientRect().top) : 0,
    };
    const bad = v.y !== 0 || v.h !== 0 || v.b !== 0 || v.L !== 0 || v.m !== 0 ||
                v.p !== 0 || v.vvo !== 0 || Math.abs(v.vvs - 1) > 0.01 || v.sb < -2;
    let text = "b" + build +
      " y" + v.y + " h" + v.h + " b" + v.b +
      " L" + v.L + " m" + v.m + " p" + v.p +
      " vv" + v.vvo + "/" + (Math.round(v.vvs * 100) / 100) +
      " sb" + v.sb;
    const givens = document.getElementById("givensModal");
    if (givens && !givens.classList.contains("hidden") && taps.length) {
      text += "\ntaps " + taps.join(" | ");
    }
    badge.textContent = text;
    badge.classList.toggle("bad", bad);
  }, 400);
})();

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
      maybeShowOneShotNotes(puzzle); // batch E: landscape / dpad intro, once ever
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
  // dpadEffective(): the tutorial forces the dpad off without touching the
  // saved setting (batch E).
  document.body.classList.toggle("dpad-on", inSolve && dpadEffective());
  // "Disable action button": removes dpad's center square and repurposes Fill/Cross
  // to execute the action directly on the cursor cell. Only takes effect when dpad is on.
  document.body.classList.toggle("disable-action-btn-on", inSolve && dpadEffective() && settings.disableActionBtn);
  // Cursor bootstraps to (0,0) as soon as dpad is on, so the user sees the target
  // cell before pressing anything.
  if (inSolve && dpadEffective() && activePuzzle && !selectedCell) {
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
  const dpadOn = dpadEffective();
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
  // Tutorial v2: the hold-to-skip bar owns the bottom strip while the lesson
  // runs, so reserve its height up front — the board shrinks a hair and the
  // bottom bar can never slide under it on any profile. 2 top buttons tall
  // (his sizing) + the bar's bottom offset and a small gap. tutCoachExtra
  // adds whatever the current puzzle's coach height exceeds the absorption
  // threshold by (see tutCoachReserve) — the coach may not cover the board.
  const tutReserve = document.body.classList.contains("tut-active")
    ? Math.round((parseFloat(getComputedStyle(document.body).getPropertyValue("--solve-btn-h")) || 35) * 2 + 36) + tutCoachExtra
    : 0;
  const availH = container.clientHeight - 4 - topReserve - tutReserve;
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
      if (givenCells.has(`${r},${c}`)) cell.classList.add("given");
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
  if (dpadEffective() && e.pointerType !== "mouse") {
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
  if (tutorialModeLock()) return; // scripted tutorial beats pin the mode (batch E)
  currentMode = currentMode === "fill" ? "cross" : "fill";
  updateModeButton();
  if (tutorial) tutorialCheck(); // the cross-toggle beat advances on the flip itself (v2)
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

// Given (hint) cells for the active puzzle: a Set of "r,c" keys, planted at
// loadPuzzle and re-planted by clearBoard. paintCell refuses to change them,
// so they never enter the undo stack — the one guard covers tap, drag, and
// dpad commit, since every solve-mode change funnels through paintCell.
let givenCells = new Set();

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
  // === 1.1 dpad revamp (batch G2): press-to-move, hold-to-repeat ===
  // v1 dispatched on click: the cursor moved on finger-UP (reads as lag next
  // to the ripple, which has always fired on pointerdown), and any finger
  // slide between down and up made iOS retarget the click to the nearest
  // COMMON ancestor of the two touch points — closest(".dpad-btn") then found
  // nothing and the tap vanished. Both halves of his "slow to respond and
  // occasional unread input" (Citrus playtest) trace to that one choice. Now:
  //  - dispatch on pointerdown: press = move, no release dependency;
  //  - hit-test by coordinate math, not DOM shape: every point on the pad
  //    resolves to a direction (dominant axis from center, 45° seams — what
  //    the trapezoids already approximate), so seam/gap taps can't drop, and
  //    the aesthetics pass can redraw the shapes without touching input;
  //  - direction buttons auto-repeat while held (400ms delay, then 90ms
  //    steps, keyboard-like); the center toggles, so it never repeats;
  //  - the click listener survives only as a fallback for activations that
  //    arrive without pointer events (assistive tech) — the dedup window
  //    swallows the synthetic click that follows every real tap.
  const REPEAT_DELAY = 400, REPEAT_RATE = 90;
  let _dpadFireAt = -Infinity, _dpadPointerId = null;
  let _dpadRepeatDelay = null, _dpadRepeatTick = null;
  function _dpadStopRepeat() {
    if (_dpadRepeatDelay) { clearTimeout(_dpadRepeatDelay); _dpadRepeatDelay = null; }
    if (_dpadRepeatTick)  { clearInterval(_dpadRepeatTick);  _dpadRepeatTick = null; }
  }
  // viewBox-units point -> direction. The center square spans 35..65 on both
  // axes; outside it the dominant axis wins. With "disable action button" on
  // there IS no center (the arrows are redrawn to fill it), so the middle
  // resolves by dominant axis too — otherwise that mode would grow a dead zone.
  function _dpadHit(x, y) {
    const dx = x - 50, dy = y - 50;
    if (!(dpadEffective() && settings.disableActionBtn) &&
        Math.abs(dx) <= 15 && Math.abs(dy) <= 15) return "center";
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
    return dy > 0 ? "down" : "up";
  }
  function _dpadDispatch(dir) {
    if (dir === "up")         moveCursor(-1, 0);
    else if (dir === "down")  moveCursor(1, 0);
    else if (dir === "left")  moveCursor(0, -1);
    else if (dir === "right") moveCursor(0, 1);
    else if (dir === "center") commitCursorAction();
  }
  dpadEl.addEventListener("click", e => {
    if (performance.now() - _dpadFireAt < 600) return; // pointerdown already fired
    const btn = e.target.closest(".dpad-btn");
    if (!btn) return;
    _dpadDispatch(btn.dataset.dir);
  });
  // Ripple feedback fires on pointerdown (immediate visual response, feels
  // snappier than waiting for click). Inserts a <circle> into the ripples
  // group clipped to the button's shape; CSS animates it and it self-removes.
  const RIPPLE_SVG_NS = "http://www.w3.org/2000/svg";
  // Buoyant press: scale the SVG down on pointerdown, spring back on release.
  // (The idle bob lives on the container; see the CSS note.)
  const _dpadSvg = dpadEl.querySelector("svg");
  const _dpadRelease = (e) => {
    // Multi-touch: only the pointer that pressed the pad releases it.
    if (_dpadPointerId !== null && e.pointerId !== _dpadPointerId) return;
    if (_dpadSvg) _dpadSvg.classList.remove("dpad-press");
    _dpadStopRepeat();
    _dpadPointerId = null;
  };
  window.addEventListener("pointerup", _dpadRelease);
  window.addEventListener("pointercancel", _dpadRelease);
  // The pad must never grow an iOS long-press callout: contextmenu arrives as
  // a pointercancel mid-hold and would kill the auto-repeat.
  dpadEl.addEventListener("contextmenu", e => e.preventDefault());
  dpadEl.addEventListener("pointerdown", e => {
    const svg = _dpadSvg;
    if (!svg) return;
    // Map the tap into viewBox units with plain rect arithmetic — no CTM.
    // v1 used clientX-vs-bounding-rect linear math: wrong under rotate-app
    // (the rect is the axis-aligned bbox of a 90°-rotated element). v2 used
    // getScreenCTM + DOMPoint.matrixTransform: on-device (2026-09-02) the
    // ripples VANISHED on landscape — iOS WebKit's CTM can't be trusted
    // under ancestor CSS transforms, and that's more exotic API surface
    // than this needs. Rect + the known orientation is exact in the only
    // two states this app ever has, and can't fail silently. Read BEFORE
    // adding dpad-press so the math uses the resting geometry.
    const rect = svg.getBoundingClientRect();
    if (_dpadSvg) _dpadSvg.classList.add("dpad-press");
    sfx.tap();
    let x = 50, y = 50;  // degenerate rect (hidden dpad) → center
    if (rect.width > 0 && rect.height > 0) {
      // viewBox is 0 0 100 100 (index.html).
      if (document.body.classList.contains("rotate-app")) {
        // App rotated 90° CW: the svg's local +x axis points DOWN the screen,
        // local +y points LEFT (the rotate-app rule: (x,y) -> (-y,x)).
        x = ((e.clientY - rect.top) / rect.height) * 100;
        y = ((rect.right - e.clientX) / rect.width) * 100;
      } else {
        x = ((e.clientX - rect.left) / rect.width) * 100;
        y = ((e.clientY - rect.top) / rect.height) * 100;
      }
    }
    const dir = _dpadHit(x, y);
    _dpadPointerId = e.pointerId;
    _dpadFireAt = performance.now();
    _dpadDispatch(dir);
    // Hold-to-repeat on the direction buttons only — the center toggles, so
    // repeating it would flicker the cell on/off.
    if (dir !== "center") {
      _dpadStopRepeat();
      _dpadRepeatDelay = setTimeout(() => {
        _dpadRepeatTick = setInterval(() => _dpadDispatch(dir), REPEAT_RATE);
      }, REPEAT_DELAY);
    }
    const group = svg.querySelector(`.dpad-ripples.${dir}`);
    if (!group) return;
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
  if (dpadEffective() && settings.disableActionBtn) {
    modeBtn.classList.add("mode-fill");
    modeBtn.classList.remove("mode-cross");
    return;
  }
  modeBtn.classList.toggle("mode-fill", currentMode === "fill");
  modeBtn.classList.toggle("mode-cross", currentMode === "cross");
}

function paintCell(cell, r, c) {
  const key = `${r},${c}`;
  if (givenCells.has(key)) return; // hint cells are locked — no paint, no undo entry
  if (tutLocks.has(key)) return;   // tutorial beat-locks: earlier steps stay put (batch E)
  if (tutorial && !tutorialGate(r, c, brushTarget)) return; // the lesson refuses this move
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
  if (settings.autoCross && !tutorial) autoCrossAfterPaint(r, c); // auto-cross forced off in the tutorial (his D1 spec)
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
  if (tutorial) tutorialCheck(); // advance scripted beats at stroke end (batch E)
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
  // His pass-5: the tutorial spotlight lifts the MOMENT the puzzle is solved,
  // not when the interstitial card lands after the ripple.
  if (tutorial) tutDimHide();
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
    // Batch E: during the tutorial the win card is replaced by the coach's
    // interstitial ("Well done. Let's try another puzzle.") or closing card.
    if (tutorial) showTutInterstitial(); else showWinModal();
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
    setTimeout(() => { if (tutorial) showTutInterstitial(); else showWinModal(); }, 700);
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
    t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
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
  // Batch H4 (his dictation 2026-09-10): NO hyperlinks anywhere in the app —
  // they "challenge the theme subtly." Creds render as plain text. The photo
  // credit sits under the photo and fades with the Photo/pixel toggle (CSS
  // keys it on .show-photo); the fact's source goes in the credit's old spot,
  // also plain text. (URLs stay in the seed as provenance, just never render.)
  const src = activePuzzle.source;
  document.getElementById("winPhotoCred").textContent = (src && src.attribution) ? src.attribution : "";
  document.getElementById("winFactSrc").textContent =
    activePuzzle.factSource ? "Source: " + factSourceName(activePuzzle.factSource) : "";

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

  // Round 5: exact-fit preview — the border hugs the pixel art, no foam matte
  // (Dre's zebra screenshot). The wrap's slot is stretched at this point, so
  // its width IS the space the card offers; for height we collapse the canvas,
  // read the card's text-stack height, and give the preview whatever is left.
  // Synchronous after unhide = one forced layout, no visual flash.
  const cardEl = modal.querySelector(".win-card");
  const rotated = document.body.classList.contains("profile-wide-nodpad") ||
                  document.body.classList.contains("profile-wide-dpad");
  cv.style.width = ""; cv.style.height = "0px";
  wrap.style.width = ""; wrap.style.alignSelf = ""; wrap.style.justifySelf = "";
  const availW = wrap.clientWidth - 3;                        // wrap border
  const chromeH = cardEl.offsetHeight;                        // card with zero-height preview
  // Batch H4: in landscape the credit holds a line inside the preview's own
  // column (so toggling never reflows) — subtract it from the preview's
  // budget or wrap+cred overflow the card by that line. Portrait counts it
  // already via chromeH (it's in the text stack). :empty → offsetHeight 0.
  const credEl = document.getElementById("winPhotoCred");
  const credSpace = (rotated && credEl && credEl.offsetHeight) ? credEl.offsetHeight + 8 : 0;
  const availH = rotated
    ? modal.clientHeight - 53 - credSpace                     // modal pad 24 + card pad 26 + borders 3, minus cred line
    : modal.clientHeight - 24 - chromeH - 3;                  // whatever the text stack didn't take
  const aspect = activeW / activeH;
  let fitW = Math.max(60, availW), fitH = fitW / aspect;
  if (fitH > availH) { fitH = Math.max(60, availH); fitW = fitH * aspect; }
  fitW = Math.round(fitW); fitH = Math.round(fitH);
  cv.style.width = fitW + "px";
  cv.style.height = fitH + "px";
  wrap.style.width = (fitW + 3) + "px";
  wrap.style.alignSelf = "center";
  wrap.style.justifySelf = "center";
}

// factSource values are URLs in the seed (61/61 en.wikipedia.org at batch H4)
// but the win card shows a NAME, not a raw URL: "Source: Wikipedia".
function factSourceName(v) {
  try {
    const h = new URL(v).hostname.replace(/^www\./, "");
    return h.endsWith("wikipedia.org") ? "Wikipedia" : h;
  } catch { return v; }
}

function hideWinModal() {
  const modal = document.getElementById("winModal");
  if (modal) modal.classList.add("hidden");
  modal?.querySelector(".win-preview-wrap")?.classList.remove("show-photo");
}

// --- Givens explainer (recurring until "Don't show again" is ARMED) ---------
// Opens EVERY time a puzzle carrying hint cells opens, unless the "Don't show
// again" toggle is armed. The toggle (batch C7, Dre) only ARMS/DISARMS — the
// card stays open and the check (or backdrop) closes it; the flag writes at
// toggle time so any close path commits the armed state. Settings → "Hint-cell
// guide" replays the card on demand — the recovery path for an armed device
// (Dre hit exactly this: armed it expecting a toggle, locked himself out of
// re-reviewing). (The retired picross.givensSeen key from the one-shot era is
// inert.)
function maybeShowGivensExplainer() {
  if (editorMode || givenCells.size === 0) return;
  try {
    if (localStorage.getItem("picross.givensHidden")) return;
  } catch {}
  showGivensExplainer();
}

function showGivensExplainer() {
  const modal = document.getElementById("givensModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  // Reflect the current flag on the toggle — a settings replay can open the
  // card with suppression already armed.
  try {
    modal.querySelector("#givensNever")?.classList.toggle("selected", !!localStorage.getItem("picross.givensHidden"));
  } catch {}
  startGivensAmbigDemo(modal);
  // iOS Safari often never STARTS CSS animations living in a subtree whose
  // display just flipped (Dre, batch C5: slide 1's demo "isn't animated
  // until I go to slide 2, then back"). Clear -> reflow -> restore forces
  // the entrance wave + hint breathe to begin on FIRST open too.
  const demoCells = modal.querySelectorAll(".givens-demo .demo-cell");
  demoCells.forEach((c) => { c.style.animation = "none"; });
  void modal.offsetWidth;
  demoCells.forEach((c) => { c.style.animation = ""; });
}

function hideGivensModal() {
  const modal = document.getElementById("givensModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  stopGivensAmbigDemo();
  // Reset to slide 1 + the slide-1 nav state for the next show (the flag makes
  // re-shows rare, but a fresh profile/new device should never land on the
  // slide-2 state).
  const slideIdx = 0;
  givensSlideIdx = slideIdx;
  if (givensSlideTimer) { // cancel a mid-flight travel cleanup (see its comment)
    clearTimeout(givensSlideTimer);
    givensSlideTimer = null;
  }
  modal.querySelectorAll(".givens-slide").forEach((s, i) => {
    s.classList.toggle("hidden", i !== slideIdx);
    s.classList.remove("exit-left", "exit-right", "enter-left", "enter-right");
  });
  document.getElementById("givensBack")?.classList.remove("show");
  document.getElementById("givensNever")?.classList.remove("show", "selected");
  document.getElementById("givensNext")?.classList.add("show");
  document.getElementById("givensDone")?.classList.remove("show");
  modal.querySelector(".givens-bar-dot")?.classList.remove("pos-1", "moving");
  // The solve screen can't scroll by design — the board must FIT. A fit
  // measured while this modal (or Safari's URL bar) was settling can leave the
  // board a hair too tall, clipping the top controls with no way to scroll
  // (Dre's unreproducible dog-puzzle report, batch C5). Re-fit on close.
  requestAnimationFrame(() => { try { resizeBoardToFit(); } catch {} });
}

// --- 2×2 ambiguity demo (slide 2) -------------------------------------------
// A tiny slideshow inside the slideshow: in a 2×2 with every clue equal to 1,
// BOTH diagonals are valid solutions. The demo cycles solution A -> solution B
// -> A wearing the hint ring, landing on why hint cells exist. Under
// reduce-motion nothing here runs — CSS swaps in the static side-by-side.
const GIVEN_AMBIG_STATES = [
  { cells: [0, 3], hint: -1, blink: -1, verdict: "This solution fits every clue", ms: 2000 },
  { cells: [1, 2], hint: -1, blink: -1, verdict: "…but so does this one!", ms: 2000 },
  { cells: [0, 3], hint: 0, blink: 3, verdict: "The hint cell breaks the tie", ms: 2400 },
];
let givenAmbigTimer = null;

function startGivensAmbigDemo(modal) {
  stopGivensAmbigDemo();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cells = [...modal.querySelectorAll(".ga-anim .ga-cell")];
  const verdict = modal.querySelector(".ga-anim .ga-verdict");
  if (cells.length !== 4 || !verdict) return;
  let i = 0;
  const apply = () => {
    const s = GIVEN_AMBIG_STATES[i];
    cells.forEach((c, idx) => {
      c.classList.toggle("filled", s.cells.includes(idx));
      c.classList.toggle("given", idx === s.hint);
      c.classList.toggle("blink", idx === s.blink); // the cell the hint FORCES — flashes on the tie-break beat (packet I)
    });
    verdict.textContent = s.verdict;
    i = (i + 1) % GIVEN_AMBIG_STATES.length;
    givenAmbigTimer = setTimeout(apply, s.ms);
  };
  apply();
}

function stopGivensAmbigDemo() {
  if (givenAmbigTimer) {
    clearTimeout(givenAmbigTimer);
    givenAmbigTimer = null;
  }
}

// Slide-travel state (batch C6): tracked, not derived from .hidden — during a
// transition BOTH slides are unhidden, so a findIndex would report the old
// slide and eat a fast Back tap. The timer is shared with hideGivensModal:
// closing mid-travel must cancel the cleanup, else the stale timeout would
// re-hide slide 1 behind the closed modal and the next open would show a
// blank card (both slides hidden).
let givensSlideIdx = 0;
let givensSlideTimer = null;

{
  const givensModal = document.getElementById("givensModal");
  const givensNext = document.getElementById("givensNext");
  const givensDone = document.getElementById("givensDone");
  const givensNever = document.getElementById("givensNever");
  const givensBack = document.getElementById("givensBack");
  if (givensModal && givensNext && givensDone) {
    const barDot = givensModal.querySelector(".givens-bar-dot");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const SLIDE_TRAVEL_MS = 340; // 0.32s keyframes + a hair
    const TRAVEL_CLASSES = ["exit-left", "exit-right", "enter-left", "enter-right"];
    // One slide-switch path for arrow/back: slots use VISIBILITY so the row's
    // geometry never changes (packet J), the bar dot's squash-stretch trip
    // derives from the target index, and the slides themselves travel
    // DIRECTIONALLY (batch C6) — forward sends the old slide off left with
    // the new one coming in from the right; back mirrors it.
    const showGivensSlide = (idx) => {
      const slides = [...givensModal.querySelectorAll(".givens-slide")];
      const current = givensSlideIdx;
      const last = idx === slides.length - 1;
      givensBack?.classList.toggle("show", idx > 0);
      givensNever?.classList.toggle("show", last);
      givensNext?.classList.toggle("show", !last);
      givensDone?.classList.toggle("show", last);
      if (idx === current) return;
      givensSlideIdx = idx;
      if (barDot) {
        barDot.classList.toggle("pos-1", last);
        barDot.classList.remove("moving");
        void barDot.offsetWidth; // restart the stretch on every trip
        barDot.classList.add("moving");
      }
      const oldSlide = slides[current], newSlide = slides[idx];
      if (givensSlideTimer) { // a travel is already mid-flight — take it over
        clearTimeout(givensSlideTimer);
        givensSlideTimer = null;
      }
      slides.forEach(s => s.classList.remove(...TRAVEL_CLASSES));
      if (reduceMotion) { // instant swap, nothing to animate
        oldSlide.classList.add("hidden");
        newSlide.classList.remove("hidden");
        return;
      }
      const forward = idx > current;
      void oldSlide.offsetWidth; // restart both travel animations fresh
      oldSlide.classList.add(forward ? "exit-left" : "exit-right");
      newSlide.classList.remove("hidden");
      newSlide.classList.add(forward ? "enter-right" : "enter-left");
      // Park the exited slide once its trip ends — a timer, not animationend,
      // so cleanup can't be stranded if the animation never starts.
      givensSlideTimer = setTimeout(() => {
        oldSlide.classList.add("hidden");
        oldSlide.classList.remove("exit-left", "exit-right");
        newSlide.classList.remove("enter-left", "enter-right");
        givensSlideTimer = null;
      }, SLIDE_TRAVEL_MS);
    };
    givensNext.addEventListener("click", () => {
      if (givensSlideIdx < givensModal.querySelectorAll(".givens-slide").length - 1) showGivensSlide(givensSlideIdx + 1);
    });
    givensBack?.addEventListener("click", () => showGivensSlide(Math.max(0, givensSlideIdx - 1)));
    givensDone.addEventListener("click", () => {
      hideGivensModal(); // the check dismisses WITHOUT suppressing — it repopulates next open
    });
    givensNever?.addEventListener("click", () => {
      // TOGGLE (batch C7, Dre): arm/disarm only — the card no longer dismisses
      // itself; the check (or backdrop) closes it. The flag writes immediately
      // either way, so any close path commits the armed state. Re-arming
      // replays the spectacle (removing the class restarts the one-shots).
      const armed = givensNever.classList.toggle("selected");
      try {
        if (armed) localStorage.setItem("picross.givensHidden", "1");
        else localStorage.removeItem("picross.givensHidden");
      } catch {}
    });
    givensModal.querySelector(".modal-backdrop")?.addEventListener("click", hideGivensModal);
  }
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
  // Batch H4: no hyperlinks anywhere (Dre) — plain-text cred, and
  // #solveFactSource/#solveFactSourceRef are spans now. (This card is
  // superseded by the win modal in user mode; admin/editor paths only.)
  const src = activePuzzle.source;
  sourceEl.textContent = (src && src.attribution) ? src.attribution : "";
  const refEl = document.getElementById("solveFactSourceRef");
  if (refEl) refEl.textContent = "";
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
  // Plant hint cells before the first render so they appear from the start.
  // Seed format: "givens": [[x, y], ...] (0-based col, row); every one is a
  // filled truth cell by construction (asserted in the edit scripts).
  givenCells = new Set();
  tutLocks.clear(); // tutorial beat-locks belong to the previous board (batch E)
  for (const [gx, gy] of activePuzzle.givens || []) {
    if (gy < h && gx < w && activePuzzle.truth[gy][gx]) {
      board[gy][gx] = STATE_FILLED;
      givenCells.add(`${gy},${gx}`);
    }
  }
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
  maybeShowGivensExplainer();
}

function clearBoard() {
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) board[r][c] = STATE_EMPTY;
  }
  // Reset restores the hint cells too — they're part of the puzzle's starting state.
  for (const key of givenCells) {
    const [r, c] = key.split(",").map(Number);
    board[r][c] = STATE_FILLED;
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
  // Batch E: during the tutorial a reset also rewinds the lesson to its first
  // beat. The beat locks simply dissolve — they never entered givenCells, so
  // the replant loop above already restored only real givens.
  if (tutorial) {
    tutLocks.clear();
    tutorial.beat = 0;
    tutorialShowBeat();
  }
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
    // library.tutorial predates this key on older devices — heal the play order.
    if (!Array.isArray(parsed.tutorial) || parsed.tutorial.length === 0) {
      parsed.tutorial = [...LIBRARY_DEFAULT.tutorial];
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
  // The tutorial trio is classified by library.tutorial (batch E) — without
  // this the sweep below would dump all three into Standby as "unclassified".
  if (!Array.isArray(library.tutorial)) library.tutorial = [...LIBRARY_DEFAULT.tutorial];
  for (const id of library.tutorial) if (id in PUZZLES) present.add(id);
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

// === Tutorial (batch E, 2026-09-03; v2 device-pass rebuild 2026-09-04) ===
// One chronological window — arrow → heart → diamond — never a category (his
// E1 ruling: "one unique window thats a chronological collection of puzzles
// rather than individual puzzles in a category"). Play order comes from
// library.tutorial (the seed is source of truth); ids 0003/0001/0002 =
// arrow/heart/diamond — id order is NOT play order.
//
// V2 (his device-pass dictation): the whole screen is "dampened" behind an
// svg overlay (#tutDim — one even-odd path dims everything EXCEPT the
// spotlight holes) so the screen visibly "is not going to respond to just any
// action". Showcase beats (welcome, the 4 top buttons, the board, the
// crossing-matters card) spotlight their subject, block ALL input via a
// transparent catch-all rect, and advance from the coach's gold arrow; action
// beats pass input only through their holes and advance from done(board) at
// stroke end (the cross-toggle beat instead checks currentMode, re-checked on
// every toggleMode). The arrow's tip is walked row-group by row-group (3s,
// then 2s, then 1s) WITH crossing allowed; the heart is a little less
// hand-holdy (free board, wrong moves refused); the diamond hides the coach
// after its opener. Skip moved OUT of the coach into #tutSkip — a board-width
// bar at the bottom, 2 top-buttons tall, that must be HELD ~2s (the meter
// drains if released early). Dpad + auto-cross stay forced OFF via
// effective-value READS (dpadEffective / the paintCell guard); the saved
// settings are never touched. Replay lives in Settings → "How to play"; the
// first-open offer is once-ever (picross.tutorialOffered).
// `tutorial` itself is declared up top with the rest of the boot-time state —
// do NOT redeclare it here (batch G5; a second `let` is a parse error anyway).
const tutLocks = new Set(); // completed-beat cells ("prior moves locked", D1)

const TUTORIAL_FALLBACK_ORDER = ["0003", "0001", "0002"];

function tutorialOrder() {
  const o = (typeof library !== "undefined" && library && library.tutorial) || null;
  return (o && o.length === 3) ? o : TUTORIAL_FALLBACK_ORDER;
}

// Every dpad read in the app goes through here so the tutorial can force it
// off (his D1 spec) without mutating settings.dpad.
function dpadEffective() {
  return !!settings.dpad && !tutorial;
}

// Arrow geometry (0-based): shaft = rows 4,5 full width; tip cells sit in
// rows 1,2,3,6,7,8 cols 6-8; shaft columns 0-5,9 hint [2].
const ARROW_SHAFT_COLS = [0, 1, 2, 3, 4, 5, 9];
const ARROW_NONSHAFT_ROWS = [0, 1, 2, 3, 6, 7, 8, 9];

// The coach must never cover INTERACTIVE content — his standing pass-3 rule
// ("the most important part is obviously that they don't cover any additional
// content"). The board fit already absorbs a coach up to ~104px tall (every
// arrow beat cleared the board on device), so reserve only the EXCESS of the
// puzzle's tallest PLAY-TIME card over that. Only action beats count: cards
// that stay up while you play. Showcase cards sit over a dimmed, input-blocked
// board (the approved pattern), and the heart's opener is centered on purpose
// (his pass-5 — it obstructs the dimmed board so the board can't draw the eye
// first). Measured on the real coach element, visibility-hidden so nothing
// flashes; once per puzzle, before its first fit, so the board never resizes
// mid-lesson. The gold-arrow button holds its slot whether shown or not, so
// text length is the only variable.
let tutCoachExtra = 0;
let tutBtnTimer = 0;
const TUT_BTN_PATHS = {
  arrow: "M7 16 H24 M16 7 L24 16 L16 25",
  check: "M9 17 L14 22 L24 10",
};
function tutCoachReserve(id) {
  const coach = document.getElementById("tutCoach");
  const text = document.getElementById("tutCoachText");
  const beats = (TUTORIAL_BEATS[id] || []).filter(b => b.kind === "action" && !b.hideCoach && b.text);
  let max = 0;
  if (beats.length) {
    const prevText = text.textContent, prevHidden = coach.classList.contains("hidden");
    coach.classList.remove("hidden");
    coach.style.visibility = "hidden";
    for (const b of beats) { text.textContent = b.text; max = Math.max(max, coach.offsetHeight); }
    text.textContent = prevText;
    coach.classList.toggle("hidden", prevHidden);
    coach.style.visibility = "";
  }
  tutCoachExtra = Math.max(0, Math.ceil(max - 104));
}

// Spotlight measurement: live DOM rects (viewport coords = fixed coords). A
// row/col spotlight pairs the hint with the board band so the clue and its
// line light up as one unit. Holes are EXACT element bounds — no inflation
// ("no crust": the dim stops at the outline, his pass-2 rule for every
// spotlight). Hints light up as a circle centered on the clue digits
// themselves ("have 10 be perfectly centered in the little circle"), so a
// hint hole is {cx, cy, rad} instead of {x, y, w, h}. Rounded elements
// (buttons, the board) carry their corner radius in cr so the hole doesn't
// leave undimmed slivers at the corners (his pass-3 "crust" report).
function tutRectOf(el) {
  const b = el.getBoundingClientRect();
  const r = { x: b.left, y: b.top, w: b.width, h: b.height };
  const cr = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  if (cr > 0.5) r.cr = Math.min(cr, r.w / 2, r.h / 2);
  return r;
}
function tutUnion(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function tutCellEl(r, c) { return boardEl.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`); }
function tutRowBand(r) { return tutUnion(tutRectOf(tutCellEl(r, 0)), tutRectOf(tutCellEl(r, activeW - 1))); }
function tutColBand(c) { return tutUnion(tutRectOf(tutCellEl(0, c)), tutRectOf(tutCellEl(activeH - 1, c))); }
// Circle around the clue digits, centered on the glyph INK, not the line box.
// The hint font's digits sit below the line-box center (the round-6 lesson),
// so a span-rect-centered bubble reads off-center — his pass-3 "the 10 isn't
// perfectly centered in its bubble". Canvas TextMetrics give the real ink
// bounds; the baseline comes from the em box centered in the span's line box.
// The ink-tight radius (+2.5) also shrinks the bubble, ending the slight
// overlap with the row band he flagged on the same screenshot. Falls back to
// the span-rect union if metrics are unavailable.
let _tutInkCtx = null;
function tutHintInkRect(span) {
  try {
    if (!_tutInkCtx) _tutInkCtx = document.createElement("canvas").getContext("2d");
    const cs = getComputedStyle(span);
    _tutInkCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = _tutInkCtx.measureText(span.textContent);
    const vals = [m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent];
    if (!vals.every(v => typeof v === "number" && isFinite(v))) return null;
    const r = span.getBoundingClientRect();
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const fba = isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : m.actualBoundingBoxAscent;
    const fbd = isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : m.actualBoundingBoxDescent;
    const baseline = r.top + (lineH - fba - fbd) / 2 + fba;
    return { x: r.left - vals[0], y: baseline - vals[2], w: vals[0] + vals[1], h: vals[2] + vals[3] };
  } catch { return null; }
}
function tutHintCircle(el) {
  const spans = [...el.children].filter(s => s.getBoundingClientRect().width > 0);
  if (spans.length) {
    const inks = spans.map(tutHintInkRect);
    const allInk = inks.every(Boolean);
    const box = inks.map((k, i) => k || tutRectOf(spans[i])).reduce(tutUnion);
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    // Multi-number hints (the heart's "2 2") get an OVAL hugging the ink —
    // his pass-5: "an oval now, to encompass both numbers in a centered,
    // spacially satisfying way". Single numbers keep the pass-3 ink circle.
    if (spans.length > 1) return { cx, cy, rx: box.w / 2 + (allInk ? 5 : 7), ry: box.h / 2 + (allInk ? 4 : 6) };
    return { cx, cy, rad: Math.hypot(box.w, box.h) / 2 + (allInk ? 2.5 : 5) };
  }
  const box = tutRectOf(el);
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rad: Math.hypot(box.w, box.h) / 2 + 5 };
}
function tutRowSpot(r) { return [tutHintCircle(rowHintsEl.children[r]), tutRowBand(r)]; }
function tutColSpot(c) { return [tutHintCircle(colHintsEl.children[c]), tutColBand(c)]; }
function tutModeBtnSpot() { return tutRectOf(document.getElementById("modeBtn")); }
const tutTopButtonSpot = () => ["solveBack", "solveReset", "undoBtn", "solveSettings"].map(id => tutRectOf(document.getElementById(id)));

// Per-puzzle beat scripts (v2). kind "showcase" = a read-only card: input is
// fully blocked and the coach's gold arrow advances. kind "action" = only the
// spotlighted holes respond; done(board) advances at stroke end. spot()
// returns the hole rects — [] dims everything, null skips the dim entirely
// (the heart's free play). mode pins fill/cross (toggle refused); setMode
// only pre-selects it — RETIRED his pass-4 (puzzle 1 never switches modes
// for the player), the mechanism stays but no beat uses it. center: true
// sits the card in the middle of the screen (the heart's opener — meant to
// obstruct the dimmed board). btnFade ms gives a showcase beat the corner
// advance: the gold button leaves its in-row slot for the card's bottom-right,
// bigger, fading in after the delay so the card is read first; btnIcon swaps
// its glyph ("arrow" default, "check" on the last intro card).
// EVERY beat carries an explicit allow() — v1 left it off the heart/diamond
// beats and the gate's blind beat.allow() call threw, freezing all painting
// on puzzles 2 and 3 (the bug Dre hit on the device pass).
const TUTORIAL_BEATS = {
  // arrow — "hold your hand". His pass-4 rule: puzzle 1 NEVER switches
  // fill/cross for the player — every switch is text-prompted and performed
  // by them (mode pins only hold a mode they already chose; no setMode from
  // the tip on). One spotlight subject per beat: rows OR a column, not both.
  "0003": [
    { kind: "showcase",
      text: "Welcome to your first puzzle. Here are the different pieces of solving a nonogram.",
      spot: () => [],
      allow: () => false },
    { kind: "showcase", undimUndo: true,
      text: "These 4 buttons at the top are back, reset, undo, and settings, respectively.",
      spot: tutTopButtonSpot,
      allow: () => false },
    { kind: "showcase",
      text: "This is the puzzle board, where you solve the puzzle using the numerical hints on the side. Puzzles come in different shapes and sizes.",
      spot: () => [tutRectOf(boardEl)],
      allow: () => false },
    { kind: "showcase",
      text: "This row has the number 10, which means 10 cells in this row are to be filled, back to back.",
      spot: () => tutRowSpot(4),
      allow: () => false },
    { kind: "action", mode: "fill", rowSwipe: 4,
      text: "This puzzle board is 10x10, which means the entire row is meant to be filled. Swipe along this row to fill it in.",
      spot: () => tutRowSpot(4),
      allow: (r, c, t) => t === STATE_FILLED && r === 4,
      done: b => b[4].every(v => v === STATE_FILLED) },
    { kind: "action", mode: "fill", rowSwipe: 5,
      text: "One more full row, just below it.",
      spot: () => tutRowSpot(5),
      allow: (r, c, t) => t === STATE_FILLED && r === 5,
      done: b => b[5].every(v => v === STATE_FILLED) },
    { kind: "action",
      text: "This is the Fill/Cross button. Fill marks the cells you know are true; Cross marks the ones you know are false. Tap it to switch to Cross.",
      spot: () => [tutModeBtnSpot()],
      allow: () => false,
      done: () => currentMode === "cross" },
    { kind: "action", mode: "cross",
      text: "A 0 means no filled cells at all. Cross out both 0 rows, top and bottom.",
      spot: () => [...tutRowSpot(0), ...tutRowSpot(9)],
      allow: (r, c, t) => t === STATE_CROSSED && (r === 0 || r === 9),
      done: b => b[0].every(v => v === STATE_CROSSED) && b[9].every(v => v === STATE_CROSSED) },
    { kind: "showcase",
      text: "It's important to cross out cells when you know they are false, so you can't accidentally fill in incorrect cells.",
      spot: () => [],
      allow: () => false },
    { kind: "action", mode: "cross",
      text: "These columns say 2, and both of their cells are already filled. Cross out everything left in them.",
      spot: () => ARROW_SHAFT_COLS.flatMap(c => tutColSpot(c)),
      allow: (r, c, t) => t === STATE_CROSSED && ARROW_SHAFT_COLS.includes(c),
      done: b => ARROW_SHAFT_COLS.every(c => ARROW_NONSHAFT_ROWS.every(r => b[r][c] === STATE_CROSSED)) },
    { kind: "action",
      text: "Now the arrow's tip. Switch back to Fill and fill the rows that say 3.",
      spot: () => [...tutRowSpot(3), ...tutRowSpot(6), tutModeBtnSpot()],
      allow: (r, c, t) => t === STATE_FILLED && (r === 3 || r === 6),
      done: b => [3, 6].every(r => [6, 7, 8].every(c => b[r][c] === STATE_FILLED)) },
    { kind: "action",
      text: "The 9th column has its 4 now. Switch back to Cross and cross the remaining cells in that column.",
      spot: () => [...tutColSpot(8), tutModeBtnSpot()],
      allow: (r, c, t) => t === STATE_CROSSED && c === 8,
      done: b => [1, 2, 7, 8].every(r => b[r][8] === STATE_CROSSED) },
    { kind: "action",
      text: "Switch back to Fill and fill the 2 cells left in the rows that say 2.",
      spot: () => [...tutRowSpot(2), ...tutRowSpot(7), tutModeBtnSpot()],
      allow: (r, c, t) => t === STATE_FILLED && (r === 2 || r === 7),
      done: b => [2, 7].every(r => [6, 7].every(c => b[r][c] === STATE_FILLED)) },
    { kind: "action",
      text: "Last ones: the rows that say 1. Cross the extra cell, then fill the single cell.",
      spot: () => [...tutRowSpot(1), ...tutRowSpot(8), tutModeBtnSpot()],
      allow: (r) => r === 1 || r === 8,
      done: () => false }, // the puzzle completes on this beat — the win intercepts
  ],
  "0001": [ // heart — a little less hand-holdy. His pass-5: the teaching all
    // happens UP FRONT ("i'd rather do it at the very beginning so as to not
    // interrupt the user") as a dimmed card sequence — the big opener sits
    // CENTERED and obstructs the dimmed board on purpose (so the board can't
    // draw the eye before the card is read), the corner advance fades in a
    // beat late (arrow, arrow, check — the check starts the solving and the
    // screen undims) — then free play with NO card. Wrong moves refused.
    { kind: "showcase", center: true, btnFade: 1400,
      text: "Puzzle two. You're more on your own now: start with the biggest clues, cross out what you know is false, and one more thing.",
      spot: () => [],
      allow: () => false },
    { kind: "showcase", btnFade: 1000,
      text: "See the row that says 2 2? That's two separate runs with a gap of at least one crossed cell between them: the heart's two lobes.",
      spot: () => tutRowSpot(1),
      allow: () => false },
    { kind: "showcase", btnIcon: "check", btnFade: 1000,
      text: "Solve the heart your way. Wrong moves won't count in this one.",
      spot: () => [],
      allow: () => false },
    { kind: "action", hideCoach: true,
      text: "",
      spot: () => null,
      allow: () => true,
      done: () => false },
  ],
  "0002": [ // diamond — "solve it on ur own": one card, then the coach hides
    { kind: "showcase",
      text: "Guardrails off: you can make any move, right or wrong. Solve it your way.",
      spot: () => [],
      allow: () => false },
    { kind: "action", hideCoach: true,
      text: "",
      spot: () => null,
      allow: () => true,
      done: () => false },
  ],
};

function tutorialCurrentId() { return tutorialOrder()[tutorial.idx]; }

// The paintCell gate (batch E5): erases are always free; before the diamond,
// incorrect moves are impossible (fills must land on truth, crosses off it);
// the arrow additionally restricts you to the current beat's scope.
function tutorialGate(r, c, target) {
  if (target === STATE_EMPTY) return true;
  const id = tutorialCurrentId();
  if (id !== "0002") {
    if (target === STATE_FILLED && !activePuzzle.truth[r][c]) return false;
    if (target === STATE_CROSSED && activePuzzle.truth[r][c]) return false;
  }
  const beat = (TUTORIAL_BEATS[id] || [])[tutorial.beat];
  return beat && beat.allow ? beat.allow(r, c, target) : true;
}

// Scripted beats pin the fill/cross mode; free-play beats leave it alone.
function tutorialModeLock() {
  if (!tutorial) return null;
  const beat = (TUTORIAL_BEATS[tutorialCurrentId()] || [])[tutorial.beat];
  return (beat && beat.mode) || null;
}

const TUT_INTERSTITIALS = [
  "Well done. Let's try another puzzle.", // his verbatim wording
  "Well done. One more, and this one is all yours.",
];
const TUT_CLOSING = "Well done completing the tutorial. Take a look around and pick a puzzle you like.";

// --- Spotlight overlay + hold-to-skip bar (v2) ---

// The dim is TWO layers. PAINT: #tutDim, a fullscreen svg whose even-odd path
// darkens everything except the holes (plus #tutDimPulse, a second path that
// re-paints just the hole shapes so CSS can breathe a slow veil over the
// spotlighted elements — his "slow blink" ask). pointer-events:none on the
// whole svg: iOS WebKit paints fill-rule:evenodd correctly but does NOT honor
// it for hit-testing, so the path swallowed the taps its holes revealed —
// Dre's pass-2 dead-row bug. HIT: #tutDimHit, transparent html divs covering
// exactly the dimmed region (viewport minus the holes as plain rects — html
// hit-tests transparent boxes fine, no svg quirks). Showcase beats cover the
// full viewport so even the holes are read-only. Z: 750/751, below the coach
// (800) and the skip bar (850), above the app.
// Rect hole subpath, rounded when the element carries a corner radius (cr):
// straight H/V runs joined by quarter arcs. Paint-side only — the hit layer
// keeps the plain square, which is the safe direction of the difference: the
// only rounded holes in the scripts are showcase holes (input fully blocked),
// and if a rounded hole ever lands on an action beat, a hair of dim corner
// that taps through beats a lit corner that is dead (the pass-2 lesson).
function tutRectSub(x, y, x2, y2, cr) {
  if (!(cr > 0.5)) return `M${x} ${y}H${x2}V${y2}H${x}Z`;
  return `M${x + cr} ${y}H${x2 - cr}A${cr} ${cr} 0 0 1 ${x2} ${y + cr}V${y2 - cr}A${cr} ${cr} 0 0 1 ${x2 - cr} ${y2}H${x + cr}A${cr} ${cr} 0 0 1 ${x} ${y2 - cr}V${y + cr}A${cr} ${cr} 0 0 1 ${x + cr} ${y}Z`;
}
function tutDimShow(holes, blockAll) {
  const dim = document.getElementById("tutDim");
  const hit = document.getElementById("tutDimHit");
  if (!holes) { tutDimHide(); return; }
  const W = window.innerWidth, H = window.innerHeight;
  const rects = [], circles = [];
  for (const h of holes) {
    if (!h) continue;
    if (h.rad > 0 || h.rx > 0) circles.push(h);
    else if (h.w > 0 && h.h > 0) rects.push(h);
  }
  let d = `M0 0H${W}V${H}H0Z`, pd = "";
  for (const r of rects) {
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    const x2 = Math.min(W, r.x + r.w), y2 = Math.min(H, r.y + r.h);
    if (x2 <= x || y2 <= y) continue;
    const cr = Math.min(r.cr || 0, (x2 - x) / 2, (y2 - y) / 2);
    const sub = tutRectSub(x, y, x2, y2, cr);
    d += sub; pd += sub;
  }
  for (const c of circles) {
    const rx = c.rad || c.rx, ry = c.rad || c.ry; // circles and hint ovals share the arc subpath
    const sub = `M${c.cx - rx} ${c.cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    d += sub; pd += sub;
  }
  document.getElementById("tutDimPath").setAttribute("d", d);
  document.getElementById("tutDimPulse").setAttribute("d", pd);
  dim.classList.toggle("pulsing", pd.length > 0);
  hit.replaceChildren();
  const cover = blockAll ? [{ x: 0, y: 0, w: W, h: H }] : tutSlabs(rects, circles, W, H);
  for (const r of cover) {
    const el = document.createElement("div");
    el.style.left = `${r.x}px`; el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`; el.style.height = `${r.h}px`;
    hit.appendChild(el);
  }
  dim.classList.remove("hidden");
  hit.classList.remove("hidden");
}
function tutDimHide() {
  document.getElementById("tutDim").classList.add("hidden");
  const hit = document.getElementById("tutDimHit");
  hit.classList.add("hidden");
  hit.replaceChildren();
}

// Viewport-minus-holes as non-overlapping rects: sweep the holes' y-edges,
// then cut each y-slab's x-runs around every hole crossing it. Circles and
// ovals enter as 12 chords (thin rects) — a ~1px staircase at the rim,
// invisible to a finger, and it keeps every hit surface a plain rect.
function tutSlabs(rects, circles, W, H) {
  const hs = [];
  for (const r of rects) hs.push({ x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h });
  for (const c of circles) {
    const rx = c.rad || c.rx, ry = c.rad || c.ry;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const y0 = c.cy - ry + (2 * ry * i) / N;
      const y1 = c.cy - ry + (2 * ry * (i + 1)) / N;
      const hw = rx * Math.sqrt(Math.max(0, 1 - ((y0 + y1) / 2 - c.cy) ** 2 / (ry * ry)));
      hs.push({ x: c.cx - hw, y: y0, x2: c.cx + hw, y2: y1 });
    }
  }
  for (const h of hs) {
    h.x = Math.max(0, h.x); h.y = Math.max(0, h.y);
    h.x2 = Math.min(W, h.x2); h.y2 = Math.min(H, h.y2);
  }
  const live = hs.filter(h => h.x2 - h.x > 0.5 && h.y2 - h.y > 0.5);
  const ys = [...new Set([0, H, ...live.flatMap(h => [h.y, h.y2])])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    if (y1 - y0 < 0.5) continue;
    const spans = live.filter(h => h.y < y1 && h.y2 > y0).map(h => [h.x, h.x2]).sort((a, b) => a[0] - b[0]);
    let x = 0;
    for (const [hx, hx2] of spans) {
      if (hx - x > 0.5) out.push({ x, y: y0, w: hx - x, h: y1 - y0 });
      x = Math.max(x, hx2);
    }
    if (W - x > 0.5) out.push({ x, y: y0, w: W - x, h: y1 - y0 });
  }
  return out;
}

// The on-row swipe visual ("the little swiping motion visual ON the row"): a
// track + traveling dot laid over the spotlighted row. pointer-events:none —
// it never intercepts the swipe it is demonstrating.
function tutRowSwipeApply(beat) {
  const el = document.getElementById("tutRowSwipe");
  if (beat.rowSwipe == null) { el.classList.add("hidden"); return; }
  const band = tutRowBand(beat.rowSwipe);
  el.style.left = `${band.x + 4}px`;
  el.style.top = `${band.y + band.h / 2 - 11}px`;
  el.style.width = `${Math.max(40, band.w - 8)}px`;
  el.style.setProperty("--tut-swipe-w", `${Math.max(20, band.w - 34)}px`);
  el.classList.remove("hidden");
}

// Re-measure and re-apply the current beat's overlay a frame out, so a fresh
// loadPuzzle layout has settled before the holes are cut. Also the live
// resize/orientation re-cut while a beat is on screen.
function tutSpotApply() {
  if (!tutorial || won) return; // the spotlight is done once the puzzle is (pass-5)
  // The interstitial cards lift the dim; a resize mid-card must not revive it.
  if (document.getElementById("tutCoach").classList.contains("tut-interstitial")) return;
  const beat = (TUTORIAL_BEATS[tutorialCurrentId()] || [])[tutorial.beat];
  if (!beat) return;
  requestAnimationFrame(() => {
    if (!tutorial || won) return;
    const cur = (TUTORIAL_BEATS[tutorialCurrentId()] || [])[tutorial.beat];
    if (cur !== beat) return; // a newer beat already owns the overlay
    try {
      tutDimShow(beat.spot ? beat.spot() : null, beat.kind === "showcase");
      tutRowSwipeApply(beat);
    } catch (err) {
      tutDimHide(); // fail OPEN — a broken spotlight must never strand input
      console.error("tutorial spotlight failed", err);
    }
    tutSkipSize();
  });
}
window.addEventListener("resize", tutSpotApply);

// The skip bar: board-width and 2 top-buttons tall, both measured live (his
// sizing), bottom-centered. Press-and-hold ~2s fills the meter and skips;
// letting go early drains it back. --tut-skip-lift keeps the coach + the
// app's bottom bar clear of it (consumed in style.css).
function tutSkipSize() {
  const el = document.getElementById("tutSkip");
  if (el.classList.contains("hidden")) return;
  const bw = boardEl.getBoundingClientRect().width;
  const btnH = document.getElementById("solveReset").getBoundingClientRect().height || 35;
  const h = Math.max(44, Math.round(btnH * 2));
  el.style.width = `${Math.round(bw)}px`;
  el.style.height = `${h}px`;
  const lift = h + 26;
  document.documentElement.style.setProperty("--tut-skip-lift", `${lift}px`);
  // On the portrait no-dpad profiles the Fill/Cross bar parks in the strip the
  // coach used to occupy (--tut-skip-lift margin) — lift the coach above the
  // BAR too, or beats spotlighting the toggle (6/11/12) soft-lock behind the
  // card. Other profiles keep the toggle clear of the coach already.
  const portrait = document.body.matches(".profile-square-nodpad, .profile-tall-nodpad");
  const bar = portrait ? document.querySelector(".solve-bottom-bar") : null;
  const barH = bar ? bar.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty("--tut-coach-lift", `${Math.round(lift + (barH ? barH + 12 : 0))}px`);
}
function tutSkipShow() {
  document.getElementById("tutSkip").classList.remove("hidden");
  tutSkipSize();
}
function tutSkipHide() {
  const el = document.getElementById("tutSkip");
  el.classList.add("hidden");
  const fill = el.querySelector(".tut-skip-fill");
  fill.style.transitionDuration = "0s";
  fill.style.width = "0%";
  document.documentElement.style.removeProperty("--tut-skip-lift");
  document.documentElement.style.removeProperty("--tut-coach-lift");
}
let tutSkipTimer = 0;
const tutSkipEl = document.getElementById("tutSkip");
const tutSkipFillEl = tutSkipEl.querySelector(".tut-skip-fill");
tutSkipEl.addEventListener("pointerdown", e => {
  if (!tutorial) return;
  e.preventDefault();
  tutSkipEl.setPointerCapture?.(e.pointerId); // a release anywhere still drains
  tutSkipFillEl.style.transitionDuration = "2s";
  tutSkipFillEl.style.width = "100%";
  tutSkipTimer = setTimeout(() => tutorialExit("home"), 2000);
});
function tutSkipRelease() {
  clearTimeout(tutSkipTimer);
  tutSkipFillEl.style.transitionDuration = "0.3s";
  tutSkipFillEl.style.width = "0%";
}
tutSkipEl.addEventListener("pointerup", tutSkipRelease);
tutSkipEl.addEventListener("pointercancel", tutSkipRelease);
tutSkipEl.addEventListener("contextmenu", e => e.preventDefault()); // no iOS long-press callout

function tutorialStart() {
  tutorial = { idx: 0, beat: 0 };
  document.body.classList.add("tut-active"); // before loadPuzzle: the fit reserves the skip strip
  tutCoachReserve(tutorialOrder()[0]); // before the first fit: coach clearance reserve
  loadPuzzle(tutorialOrder()[0]);
  setUserScreen("solve");
  tutSkipShow();
  tutorialShowBeat();
  applySettings(); // dpad/auto-cross read effectively-off while tutorial is set
}

function tutorialShowBeat() {
  const beat = (TUTORIAL_BEATS[tutorialCurrentId()] || [])[tutorial.beat];
  if (!beat) return;
  const coach = document.getElementById("tutCoach");
  coach.classList.remove("tut-interstitial");
  coach.classList.toggle("hidden", !!beat.hideCoach); // the diamond plays coachless
  document.getElementById("tutCoachText").textContent = beat.text;
  const coachBtn = document.getElementById("tutCoachBtn");
  coachBtn.classList.toggle("show", beat.kind === "showcase");
  // Corner advance (his pass-5 heart intro): the gold button leaves its
  // in-row slot for the card's bottom-right, bigger, fading in after
  // beat.btnFade ms so the card is read first; btnIcon swaps the glyph
  // (the arrow advances the sequence, the check starts the solving).
  const corner = beat.kind === "showcase" && beat.btnFade != null;
  coach.classList.toggle("tut-corner-btn", corner);
  coach.classList.toggle("tut-center", !!beat.center);
  const glyph = TUT_BTN_PATHS[beat.btnIcon] || TUT_BTN_PATHS.arrow;
  coachBtn.querySelectorAll("path").forEach(p => p.setAttribute("d", glyph));
  clearTimeout(tutBtnTimer);
  coachBtn.classList.remove("tut-btn-in");
  if (corner) tutBtnTimer = setTimeout(() => coachBtn.classList.add("tut-btn-in"), beat.btnFade);
  // His pass-5: during the 4-buttons card the undo icon sheds its disabled
  // dim so all four read identical; the class leaves with the beat.
  document.getElementById("undoBtn").classList.toggle("tut-undim", !!beat.undimUndo);
  const pin = beat.mode || beat.setMode;
  if (pin) { currentMode = pin; updateModeButton(); }
  tutSpotApply();
  coach.classList.remove("tut-coach-in");
  void coach.offsetWidth; // restart the entrance animation on each new beat
  coach.classList.add("tut-coach-in");
}

// Stroke end (from endBrush) and mode flips (from toggleMode): advance the
// scripted beats. Showcase beats never advance here — their gold arrow does.
// The arrow's completed beats lock behind you ("prior moves locked", D1).
function tutorialCheck() {
  if (!tutorial || won) return;
  const beats = TUTORIAL_BEATS[tutorialCurrentId()] || [];
  const beat = beats[tutorial.beat];
  if (!beat || beat.kind === "showcase" || !beat.done(board)) return;
  if (tutorial.beat >= beats.length - 1) return;
  if (tutorialCurrentId() === "0003") tutorialLockBoardCells();
  tutorial.beat++;
  tutorialShowBeat();
}

// The just-finished beat's cells join tutLocks (paintCell refuses them) and
// the undo history is dropped, so earlier steps can't be reopened mid-lesson.
// Kept OUT of givenCells so locked cells don't render the golden hint ring
// and don't get replanted by clearBoard.
function tutorialLockBoardCells() {
  for (let r = 0; r < activeH; r++) {
    for (let c = 0; c < activeW; c++) {
      if (board[r][c] !== STATE_EMPTY) tutLocks.add(`${r},${c}`);
    }
  }
  undoStack.length = 0;
  updateUndoButtonState();
}

// The win intercept (both showWinModal sites in startWinSequence): the coach
// morphs into the interstitial, or the closing card after the diamond. The
// dim lifts so the finished board shows clean; the skip bar stays for every
// card but the closing one.
function showTutInterstitial() {
  const coach = document.getElementById("tutCoach");
  const last = tutorial.idx >= 2;
  tutDimHide();
  document.getElementById("tutRowSwipe").classList.add("hidden");
  // Interstitial cards are plain bottom-anchored arrow cards: clear any
  // corner/center state a beat left behind and restore the arrow glyph.
  clearTimeout(tutBtnTimer);
  coach.classList.remove("tut-corner-btn", "tut-center");
  const coachBtn = document.getElementById("tutCoachBtn");
  coachBtn.classList.remove("tut-btn-in");
  coachBtn.querySelectorAll("path").forEach(p => p.setAttribute("d", TUT_BTN_PATHS.arrow));
  document.getElementById("tutCoachText").textContent = last ? TUT_CLOSING : TUT_INTERSTITIALS[tutorial.idx];
  document.getElementById("tutCoachBtn").classList.add("show");
  if (last) document.getElementById("tutSkip").classList.add("hidden");
  else tutSkipShow();
  coach.classList.remove("hidden");
  coach.classList.add("tut-interstitial");
  coach.classList.remove("tut-coach-in");
  void coach.offsetWidth;
  coach.classList.add("tut-coach-in");
}

// Leaves the tutorial. screen=null only tidies state (we're already inside a
// setUserScreen); otherwise navigates there. Restores the player's real
// dpad/auto-cross behavior via applySettings.
function tutorialExit(screen) {
  tutorial = null;
  tutLocks.clear();
  tutCoachExtra = 0;
  clearTimeout(tutSkipTimer);
  clearTimeout(tutBtnTimer);
  document.getElementById("tutCoach").classList.remove("tut-corner-btn", "tut-center");
  document.getElementById("tutCoachBtn").classList.remove("tut-btn-in");
  document.getElementById("undoBtn").classList.remove("tut-undim");
  document.body.classList.remove("tut-active");
  document.getElementById("tutCoach").classList.add("hidden");
  tutDimHide();
  document.getElementById("tutRowSwipe").classList.add("hidden");
  tutSkipHide();
  applySettings();
  if (screen) setUserScreen(screen);
  scheduleResize(); // hand the reserved skip strip back to the board fit
}

// The gold arrow: advances a showcase beat, or from an interstitial moves to
// the next puzzle (done → categories after the diamond).
document.getElementById("tutCoachBtn").addEventListener("click", () => {
  if (!tutorial) return;
  if (document.getElementById("tutCoach").classList.contains("tut-interstitial")) {
    if (tutorial.idx >= 2) { tutorialExit("category"); return; }
    tutorial.idx++;
    tutorial.beat = 0;
    tutCoachReserve(tutorialOrder()[tutorial.idx]); // reserve before the next puzzle's first fit
    loadPuzzle(tutorialOrder()[tutorial.idx]);
    tutorialShowBeat();
    return;
  }
  tutorial.beat++;
  tutorialShowBeat();
});

// === First-open offer + one-shot notes (batch E) ===
const TUT_OFFER_KEY = "picross.tutorialOffered";
function maybeOfferTutorial() {
  if (tutorial) return;
  try { if (localStorage.getItem(TUT_OFFER_KEY)) return; } catch {}
  document.getElementById("tutOffer").classList.remove("hidden");
}
function dismissTutOffer(start) {
  try { localStorage.setItem(TUT_OFFER_KEY, "1"); } catch {}
  document.getElementById("tutOffer").classList.add("hidden");
  if (start) tutorialStart();
}
document.getElementById("tutOfferStart").addEventListener("click", () => dismissTutOffer(true));
document.getElementById("tutOfferClose").addEventListener("click", () => dismissTutOffer(false));
document.querySelector("#tutOffer .modal-backdrop").addEventListener("click", () => dismissTutOffer(false));

// One-shot notes — landscape orientation + the dpad intro (his E6): once ever
// each, NO replay, with a ~1.5s no-dismiss window so an accidental tap can't
// close the card before it's read ("unclickoutability"). If both qualify on
// one open the landscape note goes first; the dpad note rolls to the next
// qualifying open. A givens explainer already on screen also rolls it forward.
const ONESHOT_FLAGS = { landscape: "picross.landscapeNoteSeen", dpad: "picross.dpadNoteSeen" };
const ONESHOT_COPY = {
  landscape: "Some puzzles are landscape. You can see the orientation in the puzzle list.",
  dpad: "The dpad moves a cursor around the board, and its center button fills or crosses that cell. It can be helpful for larger puzzle boards since the cells are smaller. Turn it on in Settings to try it.",
};
function maybeShowOneShotNotes(puzzle) {
  if (tutorial || !puzzle) return;
  let which = null;
  try {
    if (puzzle.width > puzzle.height && !localStorage.getItem(ONESHOT_FLAGS.landscape)) which = "landscape";
    else if ((puzzle.width > 10 || puzzle.height > 10) && !localStorage.getItem(ONESHOT_FLAGS.dpad)) which = "dpad";
  } catch {}
  if (!which) return;
  // Let the solve screen settle first; if another card owns the moment, the
  // note stays unseen and rolls to the next qualifying open.
  setTimeout(() => {
    if (tutorial) return;
    if (!document.getElementById("givensModal").classList.contains("hidden")) return;
    document.getElementById("tutNoteText").textContent = ONESHOT_COPY[which];
    const modal = document.getElementById("tutNote");
    modal.dataset.which = which;
    const ok = document.getElementById("tutNoteOk");
    ok.disabled = true;
    modal.classList.remove("hidden");
    setTimeout(() => { ok.disabled = false; }, 1500);
  }, 450);
}
function dismissOneShotNote() {
  const modal = document.getElementById("tutNote");
  if (document.getElementById("tutNoteOk").disabled) return; // the no-dismiss window
  try { localStorage.setItem(ONESHOT_FLAGS[modal.dataset.which], "1"); } catch {}
  modal.classList.add("hidden");
}
document.getElementById("tutNoteOk").addEventListener("click", dismissOneShotNote);
document.querySelector("#tutNote .modal-backdrop").addEventListener("click", dismissOneShotNote);

// Dispatch sits at the very bottom so every `let`/`const` binding
// (including editor state) is past TDZ before init runs.
if (userMode) {
  document.body.classList.add("user-mode");
  initUserNav();
  setUserScreen("home");
  setTimeout(maybeOfferTutorial, 700); // batch E: first-open offer, once ever
} else if (editorMode) {
  initEditor();
} else {
  loadPuzzle("0001");
}
applySettings();
// DEV-ONLY (batch H9, the headless sim loop): deep-jump into a solve screen
// via #dev-solve=NNNN[&dpad=1] — boots straight past the library so a
// screenshot loop can reach any board state without taps. Pre-marks the
// once-ever modals (tutorial offer, one-shot notes) as seen so they never
// cover the shot. Stripped from release by the DEV_BUILD strip.
if (DEV_BUILD && userMode) {
  const devJump = location.hash.match(/dev-solve=(\d{4})/);
  if (devJump && PUZZLES[devJump[1]]) {
    try {
      localStorage.setItem(TUT_OFFER_KEY, "1");
      localStorage.setItem(ONESHOT_FLAGS.landscape, "1");
      localStorage.setItem(ONESHOT_FLAGS.dpad, "1");
    } catch {}
    document.getElementById("tutOffer").classList.add("hidden");
    if (/dpad=1/.test(location.hash)) { settings.dpad = true; saveSettings(); applySettings(); }
    // Board-theme preview: &theme=NAME adds body.theme-NAME (visual prototype
    // only — theme SELECTION is a settings row, his call, not built yet).
    const devTheme = location.hash.match(/theme=([a-z-]+)/);
    if (devTheme) document.body.classList.add("theme-" + devTheme[1]);
    loadPuzzle(devJump[1]);
    // &play=1: light mid-solve state for theme screenshots — fill each row's
    // first truth cell, cross each row's first blank. Writes state directly
    // (no stroke machinery: no undo, no sfx, no win check). Deterministic.
    if (/play=1/.test(location.hash)) {
      const T = PUZZLES[devJump[1]].truth;
      for (let r = 0; r < T.length; r++) {
        let filled = false, crossed = false;
        for (let c = 0; c < T[r].length && (!filled || !crossed); c++) {
          if (givenCells.has(r + "," + c)) continue;
          const el = boardEl.children[r * activeW + c];
          if (T[r][c] && !filled) { board[r][c] = STATE_FILLED; applyCellState(el, STATE_FILLED); filled = true; }
          else if (!T[r][c] && !crossed) { board[r][c] = STATE_CROSSED; applyCellState(el, STATE_CROSSED); crossed = true; }
        }
      }
      updateHintCompletion();
    }
    setUserScreen("solve");
  }
}
// Boot watchdog handshake (1.1, batch G4): reaching the end of the top level
// proves boot completed; the inline watchdog in index.html disarms on this.
window.__bootOK = true;

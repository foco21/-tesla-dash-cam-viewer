function resolveTauriCore() {
  const w = window;
  const candidates = [
    w.__TAURI__ && w.__TAURI__.core ? w.__TAURI__.core : null,
    w.__TAURI__ && w.__TAURI__.tauri ? w.__TAURI__.tauri : null,
    w.__TAURI__ || null,
    w.__TAURI_INTERNALS__ || null,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.invoke === "function") {
      return candidate;
    }
  }
  return null;
}

function isTauriNativeMode() {
  return Boolean(resolveTauriCore());
}

function invokeNative(command, payload) {
  const core = resolveTauriCore();
  if (!core || typeof core.invoke !== "function") {
    throw new Error("Tauri native bridge not available");
  }
  return core.invoke(command, payload);
}

function resolveTauriEventApi() {
  const w = window;
  const candidates = [
    w.__TAURI__ && w.__TAURI__.event ? w.__TAURI__.event : null,
    w.__TAURI_EVENT__ || null,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.listen === "function") {
      return candidate;
    }
  }
  return null;
}

async function listenNativeEvent(eventName, handler) {
  const eventApi = resolveTauriEventApi();
  if (!eventApi) {
    throw new Error("Tauri event API not available");
  }
  const unlisten = await eventApi.listen(eventName, (event) => {
    const payload = event && typeof event === "object" && "payload" in event ? event.payload : event;
    handler(payload, event);
  });
  return typeof unlisten === "function" ? unlisten : () => {};
}

function convertNativeFileSrc(path) {
  const w = window;
  const convertFns = [
    w.__TAURI__ && w.__TAURI__.core ? w.__TAURI__.core.convertFileSrc : null,
    w.__TAURI__ && w.__TAURI__.tauri ? w.__TAURI__.tauri.convertFileSrc : null,
    w.__TAURI_INTERNALS__ ? w.__TAURI_INTERNALS__.convertFileSrc : null,
  ].filter((fn) => typeof fn === "function");

  for (const fn of convertFns) {
    try {
      return fn(path, "asset");
    } catch {
      try {
        return fn(path);
      } catch {
        // Try next converter.
      }
    }
  }

  const raw = String(path || "");
  const normalized = raw.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return encodeURI(normalized);
}
const hasLeaflet = typeof window !== "undefined" && typeof window.L !== "undefined";

const els = {
  loadFolderBtn: document.getElementById("loadFolderBtn"),
  folderInput: document.getElementById("folderInput"),
  folderPath: document.getElementById("folderPath"),
  scanPathBtn: document.getElementById("scanPathBtn"),
  themePrimary: document.getElementById("themePrimary"),
  themeApplyBtn: document.getElementById("themeApplyBtn"),
  themeResetBtn: document.getElementById("themeResetBtn"),
  exportPath: document.getElementById("exportPath"),
  exportBrowseBtn: document.getElementById("exportBrowseBtn"),
  exportBtn: document.getElementById("exportBtn"),
  exportScope: document.getElementById("exportScope"),
  exportProgressBar: document.getElementById("exportProgressBar"),
  exportProgressText: document.getElementById("exportProgressText"),
  slot1Select: document.getElementById("slot1Select"),
  slot2Select: document.getElementById("slot2Select"),
  slot3Select: document.getElementById("slot3Select"),
  telemetry: document.getElementById("telemetry"),
  mapCanvas: document.getElementById("mapCanvas"),
  leafletMap: document.getElementById("leafletMap"),
  snapRoadsToggle: document.getElementById("snapRoadsToggle"),
  osrmEndpoint: document.getElementById("osrmEndpoint"),
  mapStatus: document.getElementById("mapStatus"),
  mapPointsPanel: document.getElementById("mapPointsPanel"),
  mapPointsSummary: document.querySelector("#mapPointsPanel > summary"),
  mapPoints: document.getElementById("mapPoints"),
  eventWindow: document.getElementById("eventWindow"),
  terminalOutput: document.getElementById("terminalOutput"),
  clearLogsBtn: document.getElementById("clearLogsBtn"),
  eventList: document.getElementById("eventList"),
  stats: document.getElementById("stats"),
  eventMeta: document.getElementById("eventMeta"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  speedSelect: document.getElementById("speedSelect"),
  seek: document.getElementById("seek"),
  timeNow: document.getElementById("timeNow"),
  timeTotal: document.getElementById("timeTotal"),
  videos: {
    front: document.getElementById("frontVideo"),
    back: document.getElementById("backVideo"),
    left: document.getElementById("leftVideo"),
    right: document.getElementById("rightVideo"),
  },
  cameraTiles: Array.from(document.querySelectorAll(".camera-tile")),
  driveOverlays: Array.from(document.querySelectorAll(".drive-overlay")),
};

const state = {
  events: [],
  activeIndex: -1,
  focusCamera: "front",
  syncing: false,
  mediaSyncing: false,
  mapLoadToken: 0,
  mapPoints: [],
  mapRoutePoints: [],
  mapRouteCurrentIndex: -1,
  mapRouteHitPoints: [],
  mapPointLabelsContext: null,
  routeSnapCache: new Map(),
  leaflet: {
    map: null,
    layers: null,
    staticLayer: null,
    markerLayer: null,
    baseTileLayer: null,
    routeKey: "",
    pointKey: "",
    boundsKey: "",
    prefetchKey: "",
    prefetchTimer: null,
    centeredEventIndex: -1,
  },
  sei: {
    initPromise: null,
    ready: false,
    cache: new WeakMap(),
    nativeCache: new Map(),
    activeTimeline: [],
    activeSourceName: "",
  },
  ui: {
    playbackRaf: 0,
    forcePlaybackUpdate: false,
    lastMapMarkerMs: 0,
    lastMapMarkerTime: -1,
  },
  ffmpegLogUnlisten: null,
  logCount: 0,
  previewSlots: ["left", "right", "back"],
};

const CAMERA_MATCHERS = [
  { key: "front", pattern: /(^|[-_])front(?=\.|[-_])/i },
  { key: "back", pattern: /(^|[-_])back(?=\.|[-_])/i },
  { key: "left", pattern: /(left_repeater|left-repeater|left)(?=\.|[-_])/i },
  { key: "right", pattern: /(right_repeater|right-repeater|right)(?=\.|[-_])/i },
];

const CAMERA_COLORS = {
  front: "#22c55e",
  left: "#60a5fa",
  right: "#f59e0b",
  back: "#f87171",
};

const THEME_DEFAULTS = { primary: "#6750a4" };
const THEME_STORAGE_KEY = "tesla_viewer_theme_v1";
const DASHCAM_PROTO_TEXT = `syntax = "proto3";
message SeiMetadata {
  uint32 version = 1;
  enum Gear {
    GEAR_PARK = 0;
    GEAR_DRIVE = 1;
    GEAR_REVERSE = 2;
    GEAR_NEUTRAL = 3;
  }
  Gear gear_state = 2;
  uint64 frame_seq_no = 3;
  float vehicle_speed_mps = 4;
  float accelerator_pedal_position = 5;
  float steering_wheel_angle = 6;
  bool blinker_on_left = 7;
  bool blinker_on_right = 8;
  bool brake_applied = 9;
  enum AutopilotState {
    NONE = 0;
    SELF_DRIVING = 1;
    AUTOSTEER = 2;
    TACC = 3;
  }
  AutopilotState autopilot_state = 10;
  double latitude_deg = 11;
  double longitude_deg = 12;
  double heading_deg = 13;
  double linear_acceleration_mps2_x = 14;
  double linear_acceleration_mps2_y = 15;
  double linear_acceleration_mps2_z = 16;
}`;

function nowTimeLabel() {
  const d = new Date();
  return d.toLocaleTimeString();
}

function logLine(level, message) {
  state.logCount += 1;
  const line = `[${nowTimeLabel()}] [${level}] ${message}`;
  const out = els.terminalOutput;
  out.textContent = `${out.textContent}\n${line}`;
  out.scrollTop = out.scrollHeight;
}

function hexToRgb(hex) {
  const cleaned = String(hex || "").trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return null;
  }
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) {
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    } else if (max === gn) {
      h = ((bn - rn) / d + 2) * 60;
    } else {
      h = ((rn - gn) / d + 4) * 60;
    }
  }

  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }) {
  const hh = ((h % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ln - c / 2;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hh < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hh < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hh < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hh < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function shiftRgb(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return hex;
  }
  return rgbToHex({
    r: rgb.r + amount,
    g: rgb.g + amount,
    b: rgb.b + amount,
  });
}

function mixHex(a, b, ratio = 0.5) {
  const c1 = hexToRgb(a);
  const c2 = hexToRgb(b);
  if (!c1 || !c2) {
    return a;
  }
  const r = Math.round(c1.r + (c2.r - c1.r) * ratio);
  const g = Math.round(c1.g + (c2.g - c1.g) * ratio);
  const bb = Math.round(c1.b + (c2.b - c1.b) * ratio);
  return rgbToHex({ r, g, b: bb });
}

function toneFromSeed(seedHex, hueShift, satScale, satMin, satMax, lightness) {
  const rgb = hexToRgb(seedHex);
  if (!rgb) {
    return seedHex;
  }
  const hsl = rgbToHsl(rgb);
  const h = (hsl.h + hueShift + 360) % 360;
  const s = Math.max(satMin, Math.min(satMax, hsl.s * satScale));
  const l = Math.max(0, Math.min(100, lightness));
  return rgbToHex(hslToRgb({ h, s, l }));
}

function deriveThemeFromPrimary(primaryHex) {
  const primary = /^[#][0-9a-fA-F]{6}$/.test(primaryHex || "") ? primaryHex : THEME_DEFAULTS.primary;
  const secondary = toneFromSeed(primary, 28, 0.5, 16, 42, 52);
  const tertiary = toneFromSeed(primary, -52, 0.62, 20, 52, 56);
  const neutral = toneFromSeed(primary, 0, 0.24, 8, 24, 96.8);
  const neutralVariant = toneFromSeed(primary, 0, 0.34, 10, 30, 92.8);
  const outline = toneFromSeed(primary, 0, 0.42, 14, 34, 80);
  const text = toneFromSeed(primary, 0, 0.45, 16, 36, 14);
  const muted = toneFromSeed(primary, 0, 0.32, 12, 28, 40);
  const primaryStrong = toneFromSeed(primary, 0, 1.0, 38, 86, 38);
  const primarySoft = toneFromSeed(primary, 0, 0.36, 10, 30, 90);
  const bgAccent = toneFromSeed(primary, 0, 0.42, 18, 52, 88);
  const bgAccent2 = toneFromSeed(primary, 52, 0.42, 18, 52, 90);

  return {
    primary,
    primaryStrong,
    primarySoft,
    secondary,
    tertiary,
    bg: neutral,
    surface: neutralVariant,
    bgAccent,
    bgAccent2,
    text,
    muted,
    border: outline,
  };
}

function applyTheme(theme) {
  const t = deriveThemeFromPrimary(theme.primary);
  const root = document.documentElement;
  root.style.setProperty("--md-primary", t.primary);
  root.style.setProperty("--md-primary-strong", t.primaryStrong);
  root.style.setProperty("--md-primary-soft", t.primarySoft);
  root.style.setProperty("--md-secondary", t.secondary);
  root.style.setProperty("--md-tertiary", t.tertiary);
  root.style.setProperty("--md-bg", t.bg);
  root.style.setProperty("--md-bg-accent", t.bgAccent);
  root.style.setProperty("--md-bg-accent-2", t.bgAccent2);
  root.style.setProperty("--md-surface", `${t.surface}cc`);
  root.style.setProperty("--md-surface-strong", t.surface);
  root.style.setProperty("--md-surface-2", mixHex(t.surface, t.bg, 0.58));
  root.style.setProperty("--md-text", t.text);
  root.style.setProperty("--md-muted", t.muted);
  root.style.setProperty("--md-border", t.border);
}

function readThemeSettings() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) {
      return { ...THEME_DEFAULTS };
    }
    const parsed = JSON.parse(raw);
    return { ...THEME_DEFAULTS, ...parsed };
  } catch {
    return { ...THEME_DEFAULTS };
  }
}

function writeThemeSettings(theme) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
}

function currentThemeFromInputs() {
  return { primary: els.themePrimary.value };
}

function syncThemeInputs(theme) {
  els.themePrimary.value = theme.primary || THEME_DEFAULTS.primary;
}

function toSecondsText(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function parseTimestampFromText(text) {
  const raw = String(text || "");
  const isoLike = raw.match(/(\d{4}-\d{2}-\d{2})[T _](\d{2}[:-]\d{2}[:-]\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?/i);
  if (isoLike) {
    const hhmmss = isoLike[2].replace(/-/g, ":");
    const zone = isoLike[3] || "";
    const d = new Date(`${isoLike[1]}T${hhmmss}${zone}`);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  const compact = raw.match(/(\d{4}-\d{2}-\d{2})[_ ]?(\d{2}-\d{2}-\d{2})/);
  if (compact) {
    const d = new Date(`${compact[1]}T${compact[2].replace(/-/g, ":")}`);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  const direct = new Date(raw);
  return Number.isNaN(direct.getTime()) ? null : direct;
}

function parseTimestampFromClipLike(text) {
  return parseTimestampFromText(String(text || ""));
}

function clipIdentityText(clip) {
  if (!clip) {
    return "";
  }
  if (clip.mode === "web" && clip.file) {
    return clip.file.name || "";
  }
  if (clip.mode === "native" && clip.path) {
    return clip.path || "";
  }
  return "";
}

function updateEventWindowUi(durationSec, range) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !range) {
    els.eventWindow.style.width = "0";
    return;
  }

  const start = Math.max(0, Math.min(durationSec, range.start));
  const end = Math.max(start, Math.min(durationSec, range.end));
  const leftPct = (start / durationSec) * 100;
  const widthPct = Math.max(0.6, ((end - start) / durationSec) * 100);

  els.eventWindow.style.left = `${leftPct}%`;
  els.eventWindow.style.width = `${widthPct}%`;
}

function computeEventWindow(evt, durationSec) {
  if (!evt || !Number.isFinite(durationSec) || durationSec <= 0) {
    return null;
  }

  const jsonTs = evt.eventJson && evt.eventJson.timestamp ? new Date(evt.eventJson.timestamp) : null;
  const activeClip = activeMainClip();
  const clipStart =
    parseTimestampFromClipLike(clipIdentityText(activeClip)) ||
    (evt.date instanceof Date ? evt.date : null);
  const jsonMs = jsonTs && Number.isFinite(jsonTs.getTime()) ? jsonTs.getTime() : null;
  const clipMs = clipStart && Number.isFinite(clipStart.getTime()) ? clipStart.getTime() : null;

  if (jsonMs !== null && clipMs !== null) {
    const offset = (jsonMs - clipMs) / 1000;
    if (offset >= -8 && offset <= durationSec + 8) {
      const center = Math.max(0, Math.min(durationSec, offset));
      return { start: Math.max(0, center - 2), end: Math.min(durationSec, center + 2) };
    }
  }

  if (evt.eventMp4 || (evt.eventJson && evt.eventJson.timestamp)) {
    return { start: Math.max(0, durationSec - 8), end: durationSec };
  }

  return null;
}

function refreshEventWindow() {
  const dur = getEventDuration();
  updateEventWindowUi(dur, computeEventWindow(getActiveEvent(), dur));
}

function detectCamera(fileName) {
  const base = fileName.replace(/\.[^/.]+$/, "").toLowerCase();

  if (/(^|[-_])front$/.test(base) || /(^|[-_])front(?=([-_]|$))/.test(base)) {
    return "front";
  }
  if (/(^|[-_])back$/.test(base) || /(^|[-_])back(?=([-_]|$))/.test(base)) {
    return "back";
  }
  if (/(left_repeater|left-repeater)$/.test(base) || /(left_repeater|left-repeater)(?=([-_]|$))/.test(base)) {
    return "left";
  }
  if (/(right_repeater|right-repeater)$/.test(base) || /(right_repeater|right-repeater)(?=([-_]|$))/.test(base)) {
    return "right";
  }

  for (const camera of CAMERA_MATCHERS) {
    if (camera.pattern.test(base)) {
      return camera.key;
    }
  }
  return null;
}

function stripCameraSuffix(stem) {
  return stem
    .replace(/[-_](front|back|left_repeater|right_repeater)$/i, "")
    .replace(/[-_](left|right)$/i, "");
}

function detectEventKey(relativePath, fileName) {
  const path = relativePath.replace(/\\/g, "/");
  const segments = path.split("/").filter(Boolean);
  const normalizedStem = stripCameraSuffix(fileName.replace(/\.[^/.]+$/, ""));

  if (!segments.length) {
    return normalizedStem || "unknown";
  }

  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}/${normalizedStem}`;
  }

  return normalizedStem || segments[0].replace(/\.[^/.]+$/, "");
}

function detectEventDirPath(relativePath) {
  const path = relativePath.replace(/\\/g, "/");
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return ".";
  }
  return segments.slice(0, -1).join("/");
}

function sortEventsByDate(events) {
  return events.slice().sort((a, b) => {
    const ta = a && a.date instanceof Date && Number.isFinite(a.date.getTime()) ? a.date.getTime() : null;
    const tb = b && b.date instanceof Date && Number.isFinite(b.date.getTime()) ? b.date.getTime() : null;
    if (ta !== null && tb !== null) {
      return tb - ta; // newest first
    }
    if (ta !== null) {
      return -1;
    }
    if (tb !== null) {
      return 1;
    }
    return String(a?.key || "").localeCompare(String(b?.key || ""));
  });
}

function buildEventsFromFiles(fileList) {
  const grouped = new Map();

  for (const file of fileList) {
    const relPath = file.webkitRelativePath || file.name;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!["mp4", "mov"].includes(ext)) {
      continue;
    }

    const camera = detectCamera(file.name);
    if (!camera) {
      continue;
    }

    const eventKey = detectEventKey(relPath, file.name);
    const eventDirPath = detectEventDirPath(relPath);
    if (!grouped.has(eventKey)) {
      grouped.set(eventKey, {
        key: eventKey,
        date: parseTimestampFromText(eventKey) || parseTimestampFromText(file.name) || parseTimestampFromText(relPath),
        clips: { front: null, back: null, left: null, right: null },
        eventDirPath,
        eventJson: null,
        source: "web",
      });
    }

    const evt = grouped.get(eventKey);
    evt.clips[camera] = { mode: "web", file };

    if (!evt.date) {
      evt.date = parseTimestampFromText(file.name) || parseTimestampFromText(relPath);
    }
  }

  return sortEventsByDate(
    Array.from(grouped.values()).filter((evt) => Object.values(evt.clips).some(Boolean)),
  );
}

function parseEventJsonText(raw) {
  try {
    const obj = JSON.parse(raw);
    const estLat = Number.parseFloat(obj.est_lat);
    const estLon = Number.parseFloat(obj.est_lon);
    return {
      timestamp: obj.timestamp || null,
      city: obj.city || null,
      street: obj.street || null,
      est_lat: Number.isFinite(estLat) ? estLat : null,
      est_lon: Number.isFinite(estLon) ? estLon : null,
      reason: obj.reason || null,
      camera: obj.camera || null,
    };
  } catch {
    return null;
  }
}

async function ensureSeiDecoderReady() {
  if (state.sei.ready) {
    return true;
  }
  if (state.sei.initPromise) {
    return state.sei.initPromise;
  }
  state.sei.initPromise = (async () => {
    if (typeof window.DashcamMP4 === "undefined" || typeof window.DashcamHelpers === "undefined") {
      throw new Error("Dashcam parser scripts not loaded");
    }
    try {
      await window.DashcamHelpers.initProtobuf("dashcam.proto");
    } catch {
      const dataUri = `data:text/plain;charset=utf-8,${encodeURIComponent(DASHCAM_PROTO_TEXT)}`;
      await window.DashcamHelpers.initProtobuf(dataUri);
    }
    state.sei.ready = true;
    return true;
  })();
  try {
    return await state.sei.initPromise;
  } catch (err) {
    state.sei.initPromise = null;
    throw err;
  }
}

function eventPrimaryClip(evt) {
  if (!evt || !evt.clips) {
    return null;
  }
  const preferred = [evt.clips.front, evt.clips.left, evt.clips.right, evt.clips.back];
  return preferred.find((c) => (
    c && (
      (c.mode === "web" && c.file instanceof File)
      || (c.mode === "native" && typeof c.path === "string" && c.path.length > 0)
    )
  )) || null;
}

function decimatePoints(points, maxPoints = 2500) {
  if (points.length <= maxPoints) {
    return points;
  }
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i]);
  }
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

function haversineMeters(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const sa = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
}

function sanitizeSeiTrack(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return points || [];
  }
  const cleaned = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = cleaned[cleaned.length - 1];
    const cur = points[i];
    const dist = haversineMeters(prev.latitude, prev.longitude, cur.latitude, cur.longitude);
    const frameDelta = Number.isFinite(cur.frameSeq) && Number.isFinite(prev.frameSeq)
      ? Math.max(1, cur.frameSeq - prev.frameSeq)
      : 1;
    const speedHint = Number.isFinite(prev.speedMps) ? prev.speedMps : 0;
    // Reject implausible GPS jumps but keep aggressive cornering.
    const maxJump = Math.max(22, speedHint * 0.9 + frameDelta * 0.85);
    if (dist > maxJump) {
      continue;
    }
    cleaned.push(cur);
  }
  return cleaned;
}

async function extractSeiGpsPointsFromFile(fileOrClip) {
  if (!fileOrClip) {
    return [];
  }

  let file = null;
  let nativePath = null;

  if (fileOrClip instanceof File) {
    file = fileOrClip;
  } else if (fileOrClip.mode === "web" && fileOrClip.file instanceof File) {
    file = fileOrClip.file;
  } else if (fileOrClip.mode === "native" && typeof fileOrClip.path === "string" && fileOrClip.path.length > 0) {
    nativePath = fileOrClip.path;
  } else {
    return [];
  }

  if (file && state.sei.cache.has(file)) {
    return state.sei.cache.get(file);
  }
  if (nativePath && state.sei.nativeCache.has(nativePath)) {
    return state.sei.nativeCache.get(nativePath);
  }

  await ensureSeiDecoderReady();
  const pb = window.DashcamHelpers.getProtobuf();
  if (!pb || !pb.SeiMetadata) {
    return [];
  }

  let buf;
  if (file) {
    buf = await file.arrayBuffer();
  } else {
    const src = convertNativeFileSrc(nativePath);
    const resp = await fetch(src);
    if (!resp.ok) {
      throw new Error(`Failed to read native clip (${resp.status} ${resp.statusText})`);
    }
    buf = await resp.arrayBuffer();
  }
  const parser = new window.DashcamMP4(buf);
  const messages = parser.extractSeiMessages(pb.SeiMetadata) || [];
  const points = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] || {};
    const lat = Number(m.latitudeDeg ?? m.latitude_deg);
    const lon = Number(m.longitudeDeg ?? m.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    const speedMps = Number(m.vehicleSpeedMps ?? m.vehicle_speed_mps);
    const throttlePos = Number(m.acceleratorPedalPosition ?? m.accelerator_pedal_position);
    const steeringAngle = Number(m.steeringWheelAngle ?? m.steering_wheel_angle);
    const frameSeq = Number(m.frameSeqNo ?? m.frame_seq_no);
    const blinkerLeft = Boolean(m.blinkerOnLeft ?? m.blinker_on_left);
    const blinkerRight = Boolean(m.blinkerOnRight ?? m.blinker_on_right);
    const brakeApplied = Boolean(m.brakeApplied ?? m.brake_applied);
    points.push({
      latitude: lat,
      longitude: lon,
      speedMps: Number.isFinite(speedMps) ? speedMps : null,
      throttlePct: Number.isFinite(throttlePos) ? throttlePos : null,
      steeringDeg: Number.isFinite(steeringAngle) ? steeringAngle : null,
      frameSeq: Number.isFinite(frameSeq) ? frameSeq : i,
      blinkerLeft,
      blinkerRight,
      brakeApplied,
    });
  }
  const sorted = points.sort((a, b) => a.frameSeq - b.frameSeq);
  if (file) {
    state.sei.cache.set(file, sorted);
  }
  if (nativePath) {
    state.sei.nativeCache.set(nativePath, sorted);
  }
  return sorted;
}

async function extractSeiGpsPointsForEvent(evt, eventIndex) {
  if (!evt || !evt.clips) {
    return [];
  }
  const clips = [evt.clips.front, evt.clips.left, evt.clips.right, evt.clips.back]
    .filter((c) => (
      c && (
        (c.mode === "web" && c.file instanceof File)
        || (c.mode === "native" && typeof c.path === "string" && c.path.length > 0)
      )
    ));
  if (!clips.length) {
    return [];
  }

  const tracks = await Promise.all(clips.map((clip) => extractSeiGpsPointsFromFile(clip)));
  const mergedByFrame = new Map();
  for (const track of tracks) {
    for (const p of track) {
      const key = Number.isFinite(p.frameSeq) ? p.frameSeq : null;
      if (key === null) {
        continue;
      }
      if (!mergedByFrame.has(key)) {
        mergedByFrame.set(key, []);
      }
      mergedByFrame.get(key).push(p);
    }
  }

  const merged = Array.from(mergedByFrame.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([frameSeq, pts]) => {
      const lat = pts.reduce((s, p) => s + p.latitude, 0) / pts.length;
      const lon = pts.reduce((s, p) => s + p.longitude, 0) / pts.length;
      const speeds = pts.map((p) => p.speedMps).filter((v) => Number.isFinite(v));
      const speedMps = speeds.length ? speeds.reduce((s, v) => s + v, 0) / speeds.length : null;
      return {
        eventIndex,
        camera: "sei",
        latitude: lat,
        longitude: lon,
        creationTime: `frame ${frameSeq}`,
        speedMps,
        frameSeq,
      };
    });

  const cleaned = sanitizeSeiTrack(merged);
  return decimatePoints(cleaned, 12000);
}

function overlaySetSample(overlay, sample) {
  if (!overlay) {
    return;
  }
  const speedEl = overlay.querySelector('[data-role="speed"]');
  const throttleEl = overlay.querySelector('[data-role="throttle"]');
  const steeringEl = overlay.querySelector('[data-role="steering"]');
  const brakeEl = overlay.querySelector('[data-role="brake"]');
  const leftEl = overlay.querySelector('[data-role="left"]');
  const rightEl = overlay.querySelector('[data-role="right"]');
  const speedMph = sample && Number.isFinite(sample.speedMps) ? sample.speedMps * 2.236936 : null;
  const throttleRaw = sample && Number.isFinite(sample.throttlePct) ? sample.throttlePct : null;
  const throttlePct = throttleRaw === null
    ? null
    : Math.max(0, Math.min(100, throttleRaw <= 1.01 ? throttleRaw * 100 : throttleRaw));
  const steeringDeg = sample && Number.isFinite(sample.steeringDeg) ? sample.steeringDeg : null;
  if (speedEl) {
    speedEl.textContent = speedMph !== null ? `${speedMph.toFixed(1)} mph` : "-- mph";
  }
  if (throttleEl) {
    throttleEl.textContent = throttlePct !== null ? `THR ${throttlePct.toFixed(1)}%` : "THR --%";
  }
  if (steeringEl) {
    steeringEl.textContent = steeringDeg !== null ? `STR ${steeringDeg.toFixed(1)}deg` : "STR --.-deg";
  }
  if (brakeEl) {
    brakeEl.classList.toggle("is-on", Boolean(sample && sample.brakeApplied));
  }
  if (leftEl) {
    leftEl.classList.toggle("is-on", Boolean(sample && sample.blinkerLeft));
  }
  if (rightEl) {
    rightEl.classList.toggle("is-on", Boolean(sample && sample.blinkerRight));
  }
}

function activeSeiSampleForPlayback() {
  const timeline = state.sei.activeTimeline;
  if (!Array.isArray(timeline) || !timeline.length) {
    return null;
  }
  const master = getMasterVideo();
  const duration = getEventDuration();
  if (!master || !Number.isFinite(duration) || duration <= 0) {
    return timeline[0];
  }
  const ratio = Math.max(0, Math.min(1, master.currentTime / duration));
  const idx = Math.max(0, Math.min(timeline.length - 1, Math.round(ratio * (timeline.length - 1))));
  return timeline[idx];
}

function updateDriveOverlay() {
  const sample = activeSeiSampleForPlayback();
  for (const overlay of els.driveOverlays) {
    overlaySetSample(overlay, sample);
  }
}

async function loadSeiTimelineForActiveEvent() {
  const evt = getActiveEvent();
  state.sei.activeTimeline = [];
  state.sei.activeSourceName = "";
  if (!evt) {
    updateDriveOverlay();
    return;
  }
  const primary = eventPrimaryClip(evt);
  if (!primary) {
    updateDriveOverlay();
    return;
  }
  try {
    const track = await extractSeiGpsPointsFromFile(primary);
    state.sei.activeTimeline = track;
    state.sei.activeSourceName = primary.mode === "web"
      ? (primary.file?.name || "")
      : (primary.path || "");
    if (track.length) {
      logLine("info", `SEI overlay loaded (${track.length} samples) from ${state.sei.activeSourceName}.`);
    }
  } catch (err) {
    logLine("warn", `SEI overlay unavailable: ${String(err)}.`);
  }
  updateDriveOverlay();
}

async function enrichWebEventsWithEventJson(events, files) {
  const jsonByDir = new Map();
  const eventMp4ByDir = new Map();

  await Promise.all(
    files.map(async (file) => {
      const relPath = file.webkitRelativePath || file.name;
      const lower = file.name.toLowerCase();
      const dir = detectEventDirPath(relPath);
      if (lower === "event.mp4") {
        eventMp4ByDir.set(dir, file);
        return;
      }
      if (lower !== "event.json") {
        return;
      }
      const text = await file.text();
      const parsed = parseEventJsonText(text);
      if (parsed) {
        jsonByDir.set(dir, parsed);
      }
    }),
  );

  return events.map((evt) => {
    const eventJson = jsonByDir.get(evt.eventDirPath || ".") || null;
    const jsonDate = eventJson && eventJson.timestamp ? parseTimestampFromText(eventJson.timestamp) : null;
    return {
      ...evt,
      date: jsonDate || evt.date,
      eventJson,
      eventMp4: eventMp4ByDir.get(evt.eventDirPath || ".") || null,
    };
  });
}

function buildEventsFromNative(events) {
  const out = events.map((evt) => ({
    key: evt.key,
    date: evt.date_iso ? new Date(evt.date_iso) : parseTimestampFromText(evt.key),
    clips: {
      front: evt.clips.front ? { mode: "native", path: evt.clips.front } : null,
      back: evt.clips.back ? { mode: "native", path: evt.clips.back } : null,
      left: evt.clips.left ? { mode: "native", path: evt.clips.left } : null,
      right: evt.clips.right ? { mode: "native", path: evt.clips.right } : null,
    },
    eventJson: evt.event_json || null,
    eventMp4: evt.event_mp4 || null,
    source: "native",
  }));

  return sortEventsByDate(out);
}

function clearVideo(video) {
  if (video.dataset.url && video.dataset.mode === "web") {
    URL.revokeObjectURL(video.dataset.url);
  }
  video.removeAttribute("src");
  video.load();
  delete video.dataset.url;
  delete video.dataset.mode;
}

function clipToSrc(clip) {
  if (!clip) {
    return null;
  }
  if (clip.mode === "web") {
    return { src: URL.createObjectURL(clip.file), mode: "web" };
  }
  if (clip.mode === "native" && isTauriNativeMode()) {
    return { src: convertNativeFileSrc(clip.path), mode: "native" };
  }
  return null;
}

function setVideoClip(video, clip) {
  clearVideo(video);
  const resolved = clipToSrc(clip);
  if (!resolved) {
    return;
  }
  video.preload = "metadata";
  video.src = resolved.src;
  video.dataset.url = resolved.src;
  video.dataset.mode = resolved.mode;
}

function getActiveEvent() {
  if (state.activeIndex < 0 || state.activeIndex >= state.events.length) {
    return null;
  }
  return state.events[state.activeIndex];
}

function getLoadedVideos() {
  return Object.values(els.videos).filter((video) => Boolean(video.src));
}

function getLoadedCameraKeys() {
  return Object.entries(els.videos)
    .filter(([, video]) => Boolean(video.src))
    .map(([key]) => key);
}

function getMasterVideo() {
  const main = els.videos[state.focusCamera];
  if (main && main.src) {
    return main;
  }
  const loaded = getLoadedVideos();
  return loaded.length ? loaded[0] : null;
}

function getEventDuration() {
  const loaded = getLoadedVideos().filter((v) => Number.isFinite(v.duration) && v.duration > 0);
  if (!loaded.length) {
    return 0;
  }
  return Math.max(...loaded.map((v) => v.duration));
}

function schedulePlaybackUiUpdate(force = false) {
  if (force) {
    state.ui.forcePlaybackUpdate = true;
  }
  if (state.ui.playbackRaf) {
    return;
  }
  state.ui.playbackRaf = window.requestAnimationFrame(() => {
    state.ui.playbackRaf = 0;
    const forceNow = state.ui.forcePlaybackUpdate;
    state.ui.forcePlaybackUpdate = false;
    updateSeekUi(forceNow);
  });
}

function updateSeekUi(forceMapUpdate = false) {
  const master = getMasterVideo();
  if (!master) {
    els.seek.disabled = true;
    els.seek.max = 0;
    els.seek.value = 0;
    els.timeNow.textContent = "00:00";
    els.timeTotal.textContent = "00:00";
    updateEventWindowUi(0, null);
    updateMapMarkerForPlayback(forceMapUpdate);
    updateDriveOverlay();
    return;
  }

  const dur = getEventDuration();
  els.seek.disabled = false;
  els.seek.max = dur;
  els.seek.value = master.currentTime;
  els.timeNow.textContent = toSecondsText(master.currentTime);
  els.timeTotal.textContent = toSecondsText(dur);
  refreshEventWindow();
  updateMapMarkerForPlayback(forceMapUpdate);
  updateDriveOverlay();
}

function syncCurrentTime(source) {
  if (state.syncing || state.mediaSyncing) {
    return;
  }

  state.syncing = true;
  const target = source.currentTime;

  for (const video of Object.values(els.videos)) {
    if (!video.src || video === source) {
      continue;
    }
    if (Math.abs(video.currentTime - target) > 0.15) {
      video.currentTime = target;
    }
  }

  state.syncing = false;
}

function setPlaybackRate(rate) {
  for (const video of Object.values(els.videos)) {
    video.playbackRate = rate;
  }
}

function cameraColor(camera) {
  return CAMERA_COLORS[camera] || "#e5e7eb";
}

function themeColor(varName, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function syncMapCanvasSize() {
  const canvas = els.mapCanvas;
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = Math.max(300, Math.floor(canvas.clientWidth || 900));
  const cssHeight = 280;
  const targetWidth = Math.floor(cssWidth * ratio);
  const targetHeight = Math.floor(cssHeight * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

function fitBounds(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const p of points) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLon = Math.min(minLon, p.longitude);
    maxLon = Math.max(maxLon, p.longitude);
  }

  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) {
    return null;
  }

  const latPad = Math.max(0.0003, (maxLat - minLat) * 0.15);
  const lonPad = Math.max(0.0003, (maxLon - minLon) * 0.15);
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
  };
}

function pointTimeSeconds(points) {
  const parsed = points.map((p) => {
    if (!p.creationTime) {
      return null;
    }
    const ts = new Date(p.creationTime).getTime();
    return Number.isFinite(ts) ? ts : null;
  });

  const valid = parsed.filter((v) => v !== null);
  if (!valid.length) {
    return points.map((_, idx) => idx);
  }

  const base = Math.min(...valid);
  const normalized = parsed.map((v, idx) => {
    if (v !== null) {
      return Math.max(0, (v - base) / 1000);
    }
    return idx;
  });

  let carry = 0;
  return normalized.map((v, idx) => {
    if (Number.isFinite(v)) {
      carry = v;
      return v;
    }
    carry += idx === 0 ? 0 : 1;
    return carry;
  });
}

function interpolateMarkerPoint(points, playbackSec, durationSec) {
  if (!points.length) {
    return null;
  }
  if (points.length === 1) {
    return points[0];
  }

  const tSec = pointTimeSeconds(points);
  const maxT = tSec[tSec.length - 1];
  if (!Number.isFinite(maxT) || maxT <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) {
    const idxF = (Math.max(0, playbackSec) / Math.max(1, durationSec || 1)) * (points.length - 1);
    const i = Math.max(0, Math.min(points.length - 2, Math.floor(idxF)));
    const frac = Math.max(0, Math.min(1, idxF - i));
    return {
      latitude: points[i].latitude + (points[i + 1].latitude - points[i].latitude) * frac,
      longitude: points[i].longitude + (points[i + 1].longitude - points[i].longitude) * frac,
    };
  }

  const targetT = Math.max(0, Math.min(maxT, (playbackSec / durationSec) * maxT));
  for (let i = 0; i < tSec.length - 1; i += 1) {
    if (targetT >= tSec[i] && targetT <= tSec[i + 1]) {
      const span = Math.max(0.000001, tSec[i + 1] - tSec[i]);
      const frac = (targetT - tSec[i]) / span;
      return {
        latitude: points[i].latitude + (points[i + 1].latitude - points[i].latitude) * frac,
        longitude: points[i].longitude + (points[i + 1].longitude - points[i].longitude) * frac,
      };
    }
  }

  return points[points.length - 1];
}

function clearMapCanvas(message) {
  const { ctx, width: w, height: h } = syncMapCanvasSize();

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b1222";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#1f2b45";
  for (let x = 0; x <= w; x += 100) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 70) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (message) {
    ctx.fillStyle = "#93a3bf";
    ctx.font = "15px Segoe UI";
    ctx.fillText(message, 20, 28);
  }
  state.mapRouteHitPoints = [];
}

function setMapRenderMode(useLeaflet) {
  if (useLeaflet) {
    els.leafletMap.style.display = "block";
    els.mapCanvas.style.display = "none";
    if (state.leaflet.map) {
      // Let layout settle before recomputing map size; avoids bad centering on show.
      setTimeout(() => state.leaflet.map && state.leaflet.map.invalidateSize(), 0);
    }
  } else {
    els.leafletMap.style.display = "none";
    els.mapCanvas.style.display = "block";
  }
}

function ensureLeafletMap() {
  if (!hasLeaflet || !els.leafletMap) {
    return null;
  }
  if (state.leaflet.map) {
    return state.leaflet.map;
  }

  const map = window.L.map(els.leafletMap, {
    zoomControl: true,
    preferCanvas: true,
    updateWhenZooming: false,
    updateWhenIdle: true,
    maxBoundsViscosity: 1.0,
  }).setView([32.22, -110.97], 12);

  const esriStreetLayer = window.L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
      keepBuffer: 64,
      updateWhenIdle: true,
      updateInterval: 0,
      noWrap: true,
    },
  );
  esriStreetLayer.addTo(map);

  state.leaflet.map = map;
  state.leaflet.layers = window.L.layerGroup().addTo(map);
  state.leaflet.staticLayer = window.L.layerGroup().addTo(state.leaflet.layers);
  state.leaflet.markerLayer = window.L.layerGroup().addTo(state.leaflet.layers);
  state.leaflet.baseTileLayer = esriStreetLayer;
  map.on("zoomend", () => {
    if (typeof map.getMaxBounds !== "function") {
      return;
    }
    const locked = map.getMaxBounds();
    if (locked) {
      prefetchLeafletTilesForBounds(locked);
    }
  });
  return map;
}

function clearLeafletLayers() {
  if (!state.leaflet.layers) {
    return;
  }
  state.leaflet.layers.clearLayers();
  state.leaflet.staticLayer = window.L.layerGroup().addTo(state.leaflet.layers);
  state.leaflet.markerLayer = window.L.layerGroup().addTo(state.leaflet.layers);
  state.leaflet.routeKey = "";
  state.leaflet.pointKey = "";
  state.leaflet.boundsKey = "";
  state.leaflet.prefetchKey = "";
  if (state.leaflet.prefetchTimer) {
    clearTimeout(state.leaflet.prefetchTimer);
    state.leaflet.prefetchTimer = null;
  }
  state.leaflet.centeredEventIndex = -1;
  if (state.leaflet.map) {
    state.leaflet.map.setMaxBounds(null);
    state.leaflet.map.setMinZoom(2);
  }
}

function lngToTileX(lng, z) {
  const n = 2 ** z;
  return Math.floor(((lng + 180) / 360) * n);
}

function latToTileY(lat, z) {
  const n = 2 ** z;
  const rad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(y * n);
}

function prefetchLeafletTilesForBounds(bounds) {
  const map = state.leaflet.map;
  const layer = state.leaflet.baseTileLayer;
  if (!map || !layer || !bounds || !bounds.isValid()) {
    return;
  }

  try {
    const z = Math.max(0, Math.min(19, Math.round(map.getZoom())));
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const key = `${sw.lat.toFixed(4)},${sw.lng.toFixed(4)}|${ne.lat.toFixed(4)},${ne.lng.toFixed(4)}@${z}`;
    if (state.leaflet.prefetchKey === key) {
      return;
    }
    state.leaflet.prefetchKey = key;

    const zl = z;
    const n = 2 ** zl;
    let xMin = Math.max(0, Math.min(n - 1, lngToTileX(sw.lng, zl)));
    let xMax = Math.max(0, Math.min(n - 1, lngToTileX(ne.lng, zl)));
    const yMin = Math.max(0, Math.min(n - 1, latToTileY(ne.lat, zl)));
    const yMax = Math.max(0, Math.min(n - 1, latToTileY(sw.lat, zl)));
    if (xMax < xMin) {
      const tmp = xMin;
      xMin = xMax;
      xMax = tmp;
    }

    const maxTiles = 1200;
    let count = 0;
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        const img = new Image();
        img.decoding = "async";
        img.src = layer.getTileUrl({ x, y, z: zl });
        count += 1;
        if (count >= maxTiles) {
          logLine("debug", `Tile prefetch capped at ${maxTiles} in locked area.`);
          return;
        }
      }
    }
    logLine("debug", `Prefetched ${count} map tile(s) in locked area at z${zl}.`);
  } catch (err) {
    logLine("warn", `Tile prefetch disabled due to error: ${String(err)}`);
  }
}

function applyLeafletViewportLock(latlngs, forceFit = false) {
  const map = state.leaflet.map;
  if (!map || !Array.isArray(latlngs) || !latlngs.length) {
    return;
  }
  const bounds = window.L.latLngBounds(latlngs);
  if (!bounds.isValid()) {
    return;
  }

  const padded = bounds.pad(0.24);
  const sw = padded.getSouthWest();
  const ne = padded.getNorthEast();
  const key = `${sw.lat.toFixed(5)},${sw.lng.toFixed(5)}|${ne.lat.toFixed(5)},${ne.lng.toFixed(5)}`;
  const changed = state.leaflet.boundsKey !== key;
  if (changed) {
    state.leaflet.boundsKey = key;
    map.setMaxBounds(padded);
  }
  if (changed || forceFit) {
    map.fitBounds(padded, { padding: [24, 24], maxZoom: 16, animate: false });
    const minZoom = Math.max(2, map.getZoom() - 2);
    map.setMinZoom(minZoom);
  }
  if (changed) {
    if (state.leaflet.prefetchTimer) {
      clearTimeout(state.leaflet.prefetchTimer);
    }
    state.leaflet.prefetchTimer = setTimeout(() => prefetchLeafletTilesForBounds(padded), 50);
  }
}

function ensureLeafletLayerGroups() {
  if (!state.leaflet.layers) {
    return;
  }
  if (!state.leaflet.staticLayer) {
    state.leaflet.staticLayer = window.L.layerGroup().addTo(state.leaflet.layers);
  }
  if (!state.leaflet.markerLayer) {
    state.leaflet.markerLayer = window.L.layerGroup().addTo(state.leaflet.layers);
  }
}

function pointsDatasetKey(points) {
  return points.map((p) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}@${p.eventIndex ?? ""}`).join("|");
}

function osrmSnapEnabled() {
  return Boolean(els.snapRoadsToggle && els.snapRoadsToggle.checked);
}

function normalizeOsrmEndpoint() {
  const raw = String((els.osrmEndpoint && els.osrmEndpoint.value) || "http://127.0.0.1:5000").trim();
  return raw.replace(/\/+$/, "");
}

function routeCacheKey(points) {
  const keyPoints = points.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join("|");
  return `${normalizeOsrmEndpoint()}::${keyPoints}`;
}

function normalizeSnappedLatLngs(snappedCoords) {
  if (!Array.isArray(snappedCoords)) {
    return null;
  }
  const out = [];
  for (const pair of snappedCoords) {
    if (!Array.isArray(pair) || pair.length < 2) {
      continue;
    }
    const lon = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      continue;
    }
    out.push([lat, lon]);
  }
  return out.length >= 2 ? out : null;
}

async function fetchSnappedRoute(points) {
  if (!osrmSnapEnabled() || points.length < 2) {
    return null;
  }

  const key = routeCacheKey(points);
  if (state.routeSnapCache.has(key)) {
    return state.routeSnapCache.get(key);
  }

  const coords = points.map((p) => `${p.longitude},${p.latitude}`).join(";");
  const endpoint = normalizeOsrmEndpoint();
  const url = `${endpoint}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;

  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const json = await resp.json();
    const route = json && json.routes && json.routes[0] && json.routes[0].geometry
      ? json.routes[0].geometry.coordinates
      : null;
    if (Array.isArray(route) && route.length >= 2) {
      state.routeSnapCache.set(key, route);
      return route;
    }
    return null;
  } catch (err) {
    logLine("warn", `OSRM snap failed (${String(err)}). Falling back to straight line.`);
    return null;
  }
}

async function renderLeafletRoute(points, activeEventIndex, forceStaticRedraw = false) {
  const map = ensureLeafletMap();
  if (!map) {
    return false;
  }
  setMapRenderMode(true);
  ensureLeafletLayerGroups();
  const staticKey = `${pointsDatasetKey(points)}::${osrmSnapEnabled() ? "snap" : "raw"}`;
  const needsRebuild =
    forceStaticRedraw ||
    state.leaflet.routeKey !== staticKey ||
    !state.leaflet.staticLayer ||
    state.leaflet.staticLayer.getLayers().length === 0;

  if (needsRebuild) {
    state.leaflet.routeKey = staticKey;
    state.leaflet.pointKey = "";
    state.leaflet.staticLayer.clearLayers();

    const pointLatLngs = points.map((p) => [p.latitude, p.longitude]);
    let routeLatLngs = pointLatLngs;
    const snapped = await fetchSnappedRoute(points);
    if (snapped && snapped.length >= 2) {
      const normalized = normalizeSnappedLatLngs(snapped);
      if (normalized) {
        routeLatLngs = normalized;
      } else {
        logLine("warn", "Snapped route contained invalid coordinates. Using raw route.");
      }
    }

    const primary = themeColor("--md-primary", "#6750a4");
    const secondary = themeColor("--md-secondary", "#7c6f96");

    try {
      if (routeLatLngs.length >= 2) {
        window.L.polyline(routeLatLngs, {
          color: "#0b1222",
          weight: 8,
          opacity: 0.7,
          smoothFactor: 1.8,
          lineJoin: "round",
        }).addTo(state.leaflet.staticLayer);
        window.L.polyline(routeLatLngs, {
          color: primary,
          weight: 5,
          opacity: 0.95,
          smoothFactor: 1.8,
          lineJoin: "round",
        }).addTo(state.leaflet.staticLayer);
      }
    } catch (err) {
      logLine("warn", `Route render failed (${String(err)}). Falling back to raw route.`);
      routeLatLngs = pointLatLngs;
      if (routeLatLngs.length >= 2) {
        window.L.polyline(routeLatLngs, {
          color: "#0b1222",
          weight: 8,
          opacity: 0.7,
          smoothFactor: 1.8,
          lineJoin: "round",
        }).addTo(state.leaflet.staticLayer);
        window.L.polyline(routeLatLngs, {
          color: primary,
          weight: 5,
          opacity: 0.95,
          smoothFactor: 1.8,
          lineJoin: "round",
        }).addTo(state.leaflet.staticLayer);
      }
    }

    // Draw raw point-to-point connector too so the route is always visible.
    if (pointLatLngs.length >= 2) {
      window.L.polyline(pointLatLngs, {
        color: secondary,
        weight: 2,
        opacity: 0.75,
        dashArray: "5 6",
        lineCap: "round",
      }).addTo(state.leaflet.staticLayer);
    }

    // Persist all GPS dots in the static layer so they do not blink/disappear between updates.
    points.forEach((p, idx) => {
      const dot = window.L.circleMarker([p.latitude, p.longitude], {
        radius: 6,
        color: "#0b1222",
        weight: 2,
        fillColor: secondary,
        fillOpacity: 0.98,
      }).addTo(state.leaflet.staticLayer);
      dot.bindTooltip(`${idx + 1}. ${p.creationTime || "unknown time"}`, {
        permanent: false,
        direction: "top",
        offset: [0, -8],
        className: "gps-dot-label",
      });
      dot.on("click", () => {
        if (Number.isInteger(p.eventIndex)) {
          selectEvent(p.eventIndex);
        }
      });
    });

    if (pointLatLngs.length) {
      applyLeafletViewportLock(pointLatLngs, true);
    }
  }

  // Marker layer is reserved for the currently active event highlight.
  state.leaflet.markerLayer.clearLayers();

  const activePoint = points.find((p) => p.eventIndex === activeEventIndex) || null;
  if (activePoint) {
    window.L.circleMarker([activePoint.latitude, activePoint.longitude], {
      radius: 10,
      color: "#ef4444",
      weight: 3,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(state.leaflet.markerLayer);
    window.L.circleMarker([activePoint.latitude, activePoint.longitude], {
      radius: 16,
      color: "#ef4444",
      weight: 2,
      fillOpacity: 0,
      opacity: 0.9,
    }).addTo(state.leaflet.markerLayer);
    map.panTo([activePoint.latitude, activePoint.longitude], { animate: false });
    state.leaflet.centeredEventIndex = activeEventIndex;
  }
  return true;
}

function renderLeafletPoints(points, currentPoint = null) {
  const map = ensureLeafletMap();
  if (!map) {
    return false;
  }
  setMapRenderMode(true);
  ensureLeafletLayerGroups();

  const latlngs = points.map((p) => [p.latitude, p.longitude]);
  const primary = themeColor("--md-primary", "#6750a4");
  const secondary = themeColor("--md-secondary", "#7c6f96");
  const pKey = pointsDatasetKey(points);
  if (state.leaflet.pointKey !== pKey) {
    state.leaflet.pointKey = pKey;
    state.leaflet.routeKey = "";
    state.leaflet.staticLayer.clearLayers();
    state.leaflet.markerLayer.clearLayers();

    if (latlngs.length >= 2) {
      window.L.polyline(latlngs, {
        color: primary,
        weight: 3,
        opacity: 0.9,
        smoothFactor: 0,
        noClip: true,
      }).addTo(state.leaflet.staticLayer);
    }

    points.forEach((p) => {
      window.L.circleMarker([p.latitude, p.longitude], {
        radius: 4,
        color: "#1e3a8a",
        weight: 1.5,
        fillColor: secondary,
        fillOpacity: 0.9,
      }).addTo(state.leaflet.staticLayer);
    });

    if (latlngs.length) {
      applyLeafletViewportLock(latlngs, true);
    }
  }

  const cp = currentPoint || points[points.length - 1];
  state.leaflet.markerLayer.clearLayers();
  if (cp) {
    window.L.circleMarker([cp.latitude, cp.longitude], {
      radius: 8,
      color: primary,
      weight: 3,
      fillColor: "#f8fafc",
      fillOpacity: 1,
    }).addTo(state.leaflet.markerLayer);
  }
  return true;
}

function getEventJsonRoutePoints() {
  return state.events
    .map((evt, idx) => {
      const j = evt.eventJson;
      if (!j || !Number.isFinite(j.est_lat) || !Number.isFinite(j.est_lon)) {
        return null;
      }
      return {
        eventIndex: idx,
        key: evt.key,
        camera: "event_json",
        latitude: j.est_lat,
        longitude: j.est_lon,
        creationTime: j.timestamp || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.creationTime || "").localeCompare(String(b.creationTime || "")));
}

function setMapPointsSummaryLabel(label) {
  if (els.mapPointsSummary) {
    els.mapPointsSummary.textContent = label;
  }
}

function renderMapPointLabels(points, mode, activeEventIndex = null) {
  if (!Array.isArray(points) || !points.length) {
    return "No GPS points detected.";
  }
  if (mode === "route") {
    return points.map((p, idx) => {
      const ts = p.creationTime || "unknown time";
      const marker = p.eventIndex === activeEventIndex ? "*" : " ";
      return `${marker}${idx + 1}. lat=${p.latitude.toFixed(6)} lon=${p.longitude.toFixed(6)}  ${ts}`;
    }).join("\n");
  }
  return points.map((p, idx) => {
    const ts = p.creationTime || "unknown time";
    const speed = Number.isFinite(p.speedMps) ? ` speed=${(p.speedMps * 2.236936).toFixed(1)} mph` : "";
    return `${idx + 1}. ${p.camera}  lat=${p.latitude.toFixed(6)} lon=${p.longitude.toFixed(6)}${speed}  ${ts}`;
  }).join("\n");
}

function setMapPointsMessage(message, summary = "GPS points") {
  setMapPointsSummaryLabel(summary);
  state.mapPointLabelsContext = null;
  if (els.mapPoints) {
    els.mapPoints.textContent = message;
  }
}

function setMapPointsList(points, mode, activeEventIndex = null) {
  const total = Array.isArray(points) ? points.length : 0;
  setMapPointsSummaryLabel(`GPS points (${total})`);
  state.mapPointLabelsContext = { points, mode, activeEventIndex, cacheText: "" };

  const panelCollapsed = Boolean(els.mapPointsPanel && !els.mapPointsPanel.open);
  if (panelCollapsed) {
    els.mapPoints.textContent = `${total} point(s). Expand to view details.`;
    return;
  }
  const text = renderMapPointLabels(points, mode, activeEventIndex);
  state.mapPointLabelsContext.cacheText = text;
  els.mapPoints.textContent = text;
}

function refreshMapPointsList() {
  const ctx = state.mapPointLabelsContext;
  if (!ctx || !els.mapPointsPanel || !els.mapPointsPanel.open) {
    return;
  }
  if (ctx.cacheText) {
    els.mapPoints.textContent = ctx.cacheText;
    return;
  }
  const text = renderMapPointLabels(ctx.points, ctx.mode, ctx.activeEventIndex);
  ctx.cacheText = text;
  els.mapPoints.textContent = text;
}

async function renderEventJsonRoute(points, activeEventIndex, forceStaticRedraw = false) {
  state.mapRoutePoints = points.slice();
  state.mapRouteCurrentIndex = activeEventIndex;
  state.mapPoints = [];
  state.mapRouteHitPoints = [];

  if (!points.length) {
    setMapRenderMode(false);
    clearMapCanvas("No GPS points found in event.json.");
    setMapPointsMessage("No GPS points detected.");
    return;
  }

  if (await renderLeafletRoute(points, activeEventIndex, forceStaticRedraw)) {
    const activePoint = points.find((p) => p.eventIndex === activeEventIndex);
    els.mapStatus.textContent = `GPS dots: ${points.length}${activePoint ? ` | Active: ${activePoint.latitude.toFixed(4)}, ${activePoint.longitude.toFixed(4)}` : ""}`;
    setMapPointsList(points, "route", activeEventIndex);
    return;
  }

  setMapRenderMode(false);
  clearMapCanvas("");
  const { ctx, width, height } = syncMapCanvasSize();
  const bounds = fitBounds(points);
  if (!bounds) {
    setMapPointsMessage("GPS points could not be projected.");
    return;
  }

  const pad = 20;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const lonRange = Math.max(0.000001, bounds.maxLon - bounds.minLon);
  const latRange = Math.max(0.000001, bounds.maxLat - bounds.minLat);
  const project = (pt) => ({
    x: pad + ((pt.longitude - bounds.minLon) / lonRange) * plotW,
    y: pad + (1 - (pt.latitude - bounds.minLat) / latRange) * plotH,
  });

  function drawSmoothPolyline(projected) {
    if (projected.length < 2) {
      return;
    }
    if (projected.length === 2) {
      ctx.beginPath();
      ctx.moveTo(projected[0].x, projected[0].y);
      ctx.lineTo(projected[1].x, projected[1].y);
      ctx.stroke();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(projected[0].x, projected[0].y);
    for (let i = 0; i < projected.length - 1; i += 1) {
      const p0 = projected[Math.max(0, i - 1)];
      const p1 = projected[i];
      const p2 = projected[i + 1];
      const p3 = projected[Math.min(projected.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    ctx.stroke();
  }

  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "#93c5fd";
  const projected = points.map((p) => ({ ...project(p), eventIndex: p.eventIndex }));
  drawSmoothPolyline(projected);

  state.mapRouteHitPoints = [];
  points.forEach((p) => {
    const xy = project(p);
    const isCurrent = p.eventIndex === activeEventIndex;
    state.mapRouteHitPoints.push({ x: xy.x, y: xy.y, eventIndex: p.eventIndex });
    ctx.fillStyle = isCurrent ? "#f8fafc" : "#22c55e";
    ctx.strokeStyle = isCurrent ? "#ef4444" : "#166534";
    ctx.lineWidth = isCurrent ? 2.4 : 1.2;
    ctx.beginPath();
    ctx.arc(xy.x, xy.y, isCurrent ? 7 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  setMapPointsList(points, "route", activeEventIndex);
}

function renderMap(points, playbackSec = null, durationSec = null) {
  state.mapPoints = points.slice();
  state.mapRoutePoints = [];
  state.mapRouteHitPoints = [];
  if (!points.length) {
    setMapRenderMode(false);
    clearMapCanvas("No GPS points found in this event.");
    setMapPointsMessage("No GPS points detected.");
    return;
  }

  const markerSource = interpolateMarkerPoint(
    points,
    Number.isFinite(playbackSec) ? playbackSec : 0,
    Number.isFinite(durationSec) ? durationSec : 0,
  );

  if (renderLeafletPoints(points, markerSource)) {
    setMapPointsList(points, "telemetry", null);
    return;
  }

  setMapRenderMode(false);
  clearMapCanvas("");
  const { ctx, width, height } = syncMapCanvasSize();
  const bounds = fitBounds(points);
  if (!bounds) {
    setMapPointsMessage("GPS points could not be projected.");
    return;
  }

  const pad = 20;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const lonRange = Math.max(0.000001, bounds.maxLon - bounds.minLon);
  const latRange = Math.max(0.000001, bounds.maxLat - bounds.minLat);

  const project = (pt) => {
    const x = pad + ((pt.longitude - bounds.minLon) / lonRange) * plotW;
    const y = pad + (1 - (pt.latitude - bounds.minLat) / latRange) * plotH;
    return { x, y };
  };

  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "#93c5fd";
  ctx.beginPath();
  points.forEach((p, idx) => {
    const xy = project(p);
    if (idx === 0) {
      ctx.moveTo(xy.x, xy.y);
    } else {
      ctx.lineTo(xy.x, xy.y);
    }
  });

  if (markerSource) {
    const marker = project(markerSource);
    ctx.fillStyle = "#f8fafc";
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.stroke();

  points.forEach((p, idx) => {
    const xy = project(p);
    ctx.fillStyle = cameraColor(p.camera);
    ctx.beginPath();
    ctx.arc(xy.x, xy.y, idx === 0 ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
  });

  setMapPointsList(points, "telemetry", null);
}

function updateMapMarkerForPlayback(force = false) {
  if (state.mapRoutePoints.length) {
    // Route mode is static-per-event and should not be overwritten by per-frame playback updates.
    return;
  }
  if (!state.mapPoints.length) {
    return;
  }
  const master = getMasterVideo();
  if (!master) {
    renderMap(state.mapPoints);
    return;
  }
  const nowMs = performance.now();
  if (!force) {
    const dtMs = nowMs - state.ui.lastMapMarkerMs;
    const dtVideo = Math.abs(master.currentTime - state.ui.lastMapMarkerTime);
    if (dtMs < 90 && dtVideo < 0.08) {
      return;
    }
  }
  state.ui.lastMapMarkerMs = nowMs;
  state.ui.lastMapMarkerTime = master.currentTime;
  renderMap(state.mapPoints, master.currentTime, getEventDuration());
}

function updateButtons() {
  const hasEvent = Boolean(getActiveEvent());
  els.playPauseBtn.disabled = !hasEvent;
  els.prevBtn.disabled = !hasEvent || state.activeIndex <= 0;
  els.nextBtn.disabled = !hasEvent || state.activeIndex >= state.events.length - 1;
  els.exportBtn.disabled = !hasEvent;
}

function sanitizeFileStem(input) {
  return String(input || "export").replace(/[<>:\"/\\|?*\x00-\x1F]/g, "_");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 800);
}

function setExportProgress(percent, text = null) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (els.exportProgressBar) {
    els.exportProgressBar.style.width = `${p.toFixed(1)}%`;
  }
  if (els.exportProgressText) {
    els.exportProgressText.textContent = text || `${Math.round(p)}%`;
  }
}

function getEventsInSameFolder(evt) {
  const dir = evt && evt.eventDirPath ? evt.eventDirPath : null;
  if (!dir) {
    return evt ? [evt] : [];
  }
  return state.events
    .filter((e) => e.eventDirPath === dir)
    .sort((a, b) => {
      const ta = a.date instanceof Date ? a.date.getTime() : 0;
      const tb = b.date instanceof Date ? b.date.getTime() : 0;
      return ta - tb;
    });
}

function getExportSegments(scope, activeEvent) {
  if (!activeEvent) {
    return [];
  }
  if (scope === "all") {
    return state.events
      .filter((e) => Object.values(e.clips || {}).some((c) => c && c.mode === "web"))
      .sort((a, b) => {
        const ta = a.date instanceof Date ? a.date.getTime() : 0;
        const tb = b.date instanceof Date ? b.date.getTime() : 0;
        return ta - tb;
      });
  }
  return [activeEvent].filter((e) => Object.values(e.clips || {}).some((c) => c && c.mode === "web"));
}

function drawVideoContain(ctx, video, x, y, w, h) {
  if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(x, y, w, h);
    return;
  }

  const srcAspect = video.videoWidth / video.videoHeight;
  const dstAspect = w / h;
  let drawW = w;
  let drawH = h;
  let dx = x;
  let dy = y;
  if (srcAspect > dstAspect) {
    drawH = w / srcAspect;
    dy = y + (h - drawH) / 2;
  } else {
    drawW = h * srcAspect;
    dx = x + (w - drawW) / 2;
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, h);
  ctx.drawImage(video, dx, dy, drawW, drawH);
}

function canvasRoundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawOverlayPill(ctx, text, x, y, opts = {}) {
  const padX = Number.isFinite(opts.padX) ? opts.padX : 9;
  const h = Number.isFinite(opts.height) ? opts.height : 24;
  const radius = Number.isFinite(opts.radius) ? opts.radius : 12;
  const bg = opts.bg || "rgba(9, 12, 22, 0.66)";
  const border = opts.border || "rgba(255, 255, 255, 0.24)";
  const color = opts.color || "#f8fafc";
  const minW = Number.isFinite(opts.minWidth) ? opts.minWidth : 0;

  ctx.save();
  ctx.font = "700 14px sans-serif";
  const textW = Math.ceil(ctx.measureText(text).width);
  const w = Math.max(minW, textW + padX * 2);
  canvasRoundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
  return w;
}

function sampleFromSeiTimelineAtTime(timeline, currentTimeSec, durationSec) {
  if (!Array.isArray(timeline) || !timeline.length) {
    return null;
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return timeline[0];
  }
  const ratio = Math.max(0, Math.min(1, (Number(currentTimeSec) || 0) / durationSec));
  const idx = Math.max(0, Math.min(timeline.length - 1, Math.round(ratio * (timeline.length - 1))));
  return timeline[idx] || null;
}

function drawExportTelemetryPill(ctx, text, x, y, opts = {}) {
  const padX = Number.isFinite(opts.padX) ? opts.padX : 14;
  const h = Number.isFinite(opts.height) ? opts.height : 36;
  const radius = Number.isFinite(opts.radius) ? opts.radius : 18;
  const bg = opts.bg || "rgba(9, 12, 22, 0.66)";
  const border = opts.border || "rgba(255, 255, 255, 0.24)";
  const color = opts.color || "#f8fafc";
  const minW = Number.isFinite(opts.minWidth) ? opts.minWidth : 0;

  ctx.save();
  ctx.font = "700 21px 'Segoe UI', sans-serif";
  const textW = Math.ceil(ctx.measureText(text).width);
  const w = Math.max(minW, textW + padX * 2);
  canvasRoundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
  return w;
}

function drawExportTelemetryOverlay(ctx, sample) {
  const speedMph = sample && Number.isFinite(sample.speedMps) ? sample.speedMps * 2.236936 : null;
  const throttleRaw = sample && Number.isFinite(sample.throttlePct) ? sample.throttlePct : null;
  const throttlePct = throttleRaw === null
    ? null
    : Math.max(0, Math.min(100, throttleRaw <= 1.01 ? throttleRaw * 100 : throttleRaw));
  const steeringDeg = sample && Number.isFinite(sample.steeringDeg) ? sample.steeringDeg : null;
  const brakeOn = Boolean(sample && sample.brakeApplied);
  const leftOn = Boolean(sample && sample.blinkerLeft);
  const rightOn = Boolean(sample && sample.blinkerRight);

  const x0 = 15;
  const y = 1029;
  let x = x0;
  x += drawExportTelemetryPill(ctx, speedMph !== null ? `${speedMph.toFixed(1)} mph` : "-- mph", x, y, { minWidth: 114 });
  x += 11;
  x += drawExportTelemetryPill(ctx, throttlePct !== null ? `THR ${throttlePct.toFixed(1)}%` : "THR --%", x, y, { minWidth: 135 });
  x += 11;
  x += drawExportTelemetryPill(ctx, steeringDeg !== null ? `STR ${steeringDeg.toFixed(1)}deg` : "STR --.-deg", x, y, { minWidth: 168 });
  x += 11;
  x += drawExportTelemetryPill(ctx, "BRK", x, y, {
    minWidth: 69,
    bg: brakeOn ? "#ef4444" : "rgba(9, 12, 22, 0.66)",
    border: brakeOn ? "rgba(248, 113, 113, 0.9)" : "rgba(255, 255, 255, 0.24)",
    color: brakeOn ? "#fff7f7" : "#f8fafc",
  });

  const rightStart = 1430;
  const rW = drawExportTelemetryPill(ctx, "R", rightStart - 45, y, {
    minWidth: 45,
    bg: rightOn ? "#f59e0b" : "rgba(9, 12, 22, 0.66)",
    border: rightOn ? "rgba(245, 158, 11, 0.8)" : "rgba(255, 255, 255, 0.24)",
    color: rightOn ? "#111827" : "#f8fafc",
  });
  drawExportTelemetryPill(ctx, "L", rightStart - rW - 9 - 45, y, {
    minWidth: 45,
    bg: leftOn ? "#f59e0b" : "rgba(9, 12, 22, 0.66)",
    border: leftOn ? "rgba(245, 158, 11, 0.8)" : "rgba(255, 255, 255, 0.24)",
    color: leftOn ? "#111827" : "#f8fafc",
  });
}

function buildNativeTelemetryPngFramesForExport(durationSec) {
  const timeline = state.sei.activeTimeline;
  if (!Array.isArray(timeline) || !timeline.length || !Number.isFinite(durationSec) || durationSec <= 0) {
    return null;
  }

  const total = timeline.length;
  const frames = [];
  let lastKey = "";
  const canvas = document.createElement("canvas");
  canvas.width = 1440;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  for (let i = 0; i < total; i += 1) {
    const s = timeline[i] || {};
    const timeSec = total > 1 ? (i / (total - 1)) * durationSec : 0;
    const speedMps = Number.isFinite(s.speedMps) ? Number(s.speedMps) : null;
    const throttlePct = Number.isFinite(s.throttlePct) ? Number(s.throttlePct) : null;
    const steeringDeg = Number.isFinite(s.steeringDeg) ? Number(s.steeringDeg) : null;
    const blinkerLeft = Boolean(s.blinkerLeft);
    const blinkerRight = Boolean(s.blinkerRight);
    const brakeApplied = Boolean(s.brakeApplied);

    const key = [
      speedMps !== null ? speedMps.toFixed(2) : "n",
      throttlePct !== null ? throttlePct.toFixed(2) : "n",
      steeringDeg !== null ? steeringDeg.toFixed(1) : "n",
      blinkerLeft ? "1" : "0",
      blinkerRight ? "1" : "0",
      brakeApplied ? "1" : "0",
    ].join("|");
    if (key === lastKey && i !== total - 1) {
      continue;
    }
    lastKey = key;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawExportTelemetryOverlay(ctx, {
      speedMps,
      throttlePct,
      steeringDeg,
      blinkerLeft,
      blinkerRight,
      brakeApplied,
    });
    frames.push({
      timeSec,
      pngDataUrl: canvas.toDataURL("image/png"),
    });
  }

  return frames.length ? frames : null;
}

function drawDriveOverlayOnCanvas(ctx, rect, sample) {
  if (!ctx || !rect) {
    return;
  }
  const speedMph = sample && Number.isFinite(sample.speedMps) ? sample.speedMps * 2.236936 : null;
  const throttleRaw = sample && Number.isFinite(sample.throttlePct) ? sample.throttlePct : null;
  const throttlePct = throttleRaw === null
    ? null
    : Math.max(0, Math.min(100, throttleRaw <= 1.01 ? throttleRaw * 100 : throttleRaw));
  const steeringDeg = sample && Number.isFinite(sample.steeringDeg) ? sample.steeringDeg : null;
  const brakeOn = Boolean(sample && sample.brakeApplied);
  const leftOn = Boolean(sample && sample.blinkerLeft);
  const rightOn = Boolean(sample && sample.blinkerRight);

  const x0 = rect.x + 10;
  const y = rect.y + rect.h - 34;
  let x = x0;
  x += drawOverlayPill(ctx, speedMph !== null ? `${speedMph.toFixed(1)} mph` : "-- mph", x, y, { minWidth: 76 });
  x += 7;
  x += drawOverlayPill(ctx, throttlePct !== null ? `THR ${throttlePct.toFixed(1)}%` : "THR --%", x, y, { minWidth: 90 });
  x += 7;
  x += drawOverlayPill(ctx, steeringDeg !== null ? `STR ${steeringDeg.toFixed(1)}deg` : "STR --.-deg", x, y, { minWidth: 112 });
  x += 7;
  x += drawOverlayPill(ctx, "BRK", x, y, {
    minWidth: 46,
    bg: brakeOn ? "#ef4444" : "rgba(9, 12, 22, 0.66)",
    border: brakeOn ? "rgba(248, 113, 113, 0.9)" : "rgba(255, 255, 255, 0.24)",
    color: brakeOn ? "#fff7f7" : "#f8fafc",
  });

  const rightStart = rect.x + rect.w - 10;
  const rW = drawOverlayPill(ctx, "R", rightStart - 30, y, {
    minWidth: 30,
    bg: rightOn ? "#f59e0b" : "rgba(9, 12, 22, 0.66)",
    border: rightOn ? "rgba(245, 158, 11, 0.8)" : "rgba(255, 255, 255, 0.24)",
    color: rightOn ? "#111827" : "#f8fafc",
  });
  drawOverlayPill(ctx, "L", rightStart - rW - 6 - 30, y, {
    minWidth: 30,
    bg: leftOn ? "#f59e0b" : "rgba(9, 12, 22, 0.66)",
    border: leftOn ? "rgba(245, 158, 11, 0.8)" : "rgba(255, 255, 255, 0.24)",
    color: leftOn ? "#111827" : "#f8fafc",
  });
}

function preferredRecorderMimeType() {
  const chromium = isChromiumEngine();
  const firefox = isFirefoxEngine();
  const candidates = chromium
    ? [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=h264,aac",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ]
    : firefox
      ? [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ]
      : [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=h264,aac",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "";
}

function extensionFromMimeType(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("mp4")) {
    return "mp4";
  }
  if (m.includes("webm")) {
    return "webm";
  }
  return "webm";
}

function isChromiumEngine() {
  const ua = navigator.userAgent || "";
  return /Chrome|Chromium|Edg\//.test(ua) && !/OPR\//.test(ua);
}

function isFirefoxEngine() {
  const ua = navigator.userAgent || "";
  return /Firefox\//.test(ua);
}

function supportsWebCodecs() {
  return typeof window.VideoEncoder === "function"
    && typeof window.VideoDecoder === "function"
    && typeof window.VideoFrame === "function";
}

async function loadWebVideosForSegment(segment) {
  const entries = Object.entries(segment.clips)
    .filter(([, clip]) => clip && clip.mode === "web" && clip.file instanceof File)
    .map(([camera, clip]) => ({ camera, file: clip.file }));

  const out = {};
  await Promise.all(entries.map(async ({ camera, file }) => {
    const v = document.createElement("video");
    const src = URL.createObjectURL(file);
    v.src = src;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        v.removeEventListener("loadedmetadata", onLoaded);
        v.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        v.removeEventListener("loadedmetadata", onLoaded);
        v.removeEventListener("error", onErr);
        reject(new Error(`Failed to load ${file.name}`));
      };
      v.addEventListener("loadedmetadata", onLoaded);
      v.addEventListener("error", onErr);
    });
    out[camera] = { video: v, src, name: file.name, file };
  }));
  return out;
}

async function exportWebCombinedTimeline(scope = "selected") {
  const active = getActiveEvent();
  if (!active) {
    return;
  }

  const segments = getExportSegments(scope, active);
  if (!segments.length) {
    els.stats.textContent = "Export failed: no web clips to combine.";
    logLine("warn", "Browser combined export aborted: no web segments.");
    setExportProgress(0, "Idle");
    return;
  }

  if (!window.MediaRecorder) {
    els.stats.textContent = "Export failed: MediaRecorder unsupported in this browser.";
    logLine("error", "MediaRecorder is not available.");
    setExportProgress(0, "Idle");
    return;
  }

  const mimeType = preferredRecorderMimeType();
  if (!mimeType) {
    els.stats.textContent = "Export failed: no supported recorder format.";
    logLine("error", "No supported MediaRecorder MIME type found.");
    setExportProgress(0, "Idle");
    return;
  }
  const outExt = extensionFromMimeType(mimeType);
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const exportFps = 30;
  const frameMs = 1000 / exportFps;
  const stream = canvas.captureStream(exportFps);
  const recOpts = mimeType
    ? { mimeType, videoBitsPerSecond: 12_000_000 }
    : { videoBitsPerSecond: 12_000_000 };
  const recorder = new MediaRecorder(stream, recOpts);
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack && "contentHint" in videoTrack) {
    videoTrack.contentHint = "motion";
  }
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  let stopResolve;
  const stopped = new Promise((resolve) => { stopResolve = resolve; });
  recorder.onstop = () => stopResolve();

  els.exportBtn.disabled = true;
  const prevText = els.exportBtn.textContent;
  els.exportBtn.textContent = "Exporting...";
  setExportProgress(0, "0%");
  logLine("info", `Browser export started [scope=${scope}] (${segments.length} segment(s)).`);
  const useChromiumCodecPath = isChromiumEngine() && supportsWebCodecs();
  logLine(
    "debug",
    `Export mode=${useChromiumCodecPath ? "chromium-codecs" : "legacy"} scheduler=${useChromiumCodecPath ? "chromium-frame-callback" : "fixed-timer"}.`,
  );
  recorder.start(1000);

  try {
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      els.stats.textContent = `Exporting segment ${i + 1}/${segments.length}...`;
      const loaded = await loadWebVideosForSegment(seg);

      const mainCam = loaded[state.focusCamera]
        ? state.focusCamera
        : (Object.keys(loaded)[0] || "front");
      const sideOrder = ["left", "right", "back", "front"]
        .filter((c) => c !== mainCam && loaded[c]);
      const overlaySourceCam = loaded.front ? "front" : mainCam;
      const shouldDrawOverlay = mainCam === "front" || !loaded.front;

      const sideH = 720 / 3;
      const startMs = performance.now();
      const master = loaded[mainCam].video;
      const segDuration = Number.isFinite(master.duration) && master.duration > 0 ? master.duration : 0;
      let overlayTimeline = [];
      if (shouldDrawOverlay) {
        try {
          const timelineSource = loaded[overlaySourceCam] || null;
          if (timelineSource && timelineSource.file instanceof File) {
            overlayTimeline = await extractSeiGpsPointsFromFile(timelineSource.file);
          }
        } catch (err) {
          logLine("warn", `SEI overlay unavailable during export: ${String(err)}.`);
        }
      }
      Object.values(loaded).forEach((x) => { x.video.currentTime = 0; });
      await Promise.allSettled(Object.values(loaded).map((x) => x.video.play()));

      let running = true;
      let frameTimer = null;
      let frameCallbackId = null;
      let nextTick = performance.now();
      const canUseFrameCallback = useChromiumCodecPath
        && typeof master.requestVideoFrameCallback === "function"
        && typeof master.cancelVideoFrameCallback === "function";
      const renderFrame = () => {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 1280, 720);
        drawVideoContain(ctx, loaded[mainCam]?.video, 0, 0, 960, 720);
        for (let s = 0; s < 3; s += 1) {
          const cam = sideOrder[s];
          drawVideoContain(ctx, cam ? loaded[cam].video : null, 960, s * sideH, 320, sideH);
        }
        if (shouldDrawOverlay) {
          const overlaySample = sampleFromSeiTimelineAtTime(overlayTimeline, master.currentTime, segDuration);
          drawDriveOverlayOnCanvas(ctx, { x: 0, y: 0, w: 960, h: 720 }, overlaySample);
        }
        const segProgress = segDuration > 0 ? Math.max(0, Math.min(1, master.currentTime / segDuration)) : 0;
        const totalProgress = ((i + segProgress) / segments.length) * 100;
        setExportProgress(totalProgress, `${Math.round(totalProgress)}%`);
      };
      const scheduleNextFrame = () => {
        if (!running) {
          return;
        }
        if (canUseFrameCallback) {
          frameCallbackId = master.requestVideoFrameCallback(() => {
            if (!running) {
              return;
            }
            renderFrame();
            scheduleNextFrame();
          });
          return;
        }
        nextTick += frameMs;
        const delay = Math.max(0, nextTick - performance.now());
        frameTimer = setTimeout(() => {
          if (!running) {
            return;
          }
          renderFrame();
          scheduleNextFrame();
        }, delay);
      };
      renderFrame();
      if (!canUseFrameCallback) {
        nextTick = performance.now() + frameMs;
      }
      scheduleNextFrame();

      await new Promise((resolve) => {
        const done = () => {
          running = false;
          if (frameTimer !== null) {
            clearTimeout(frameTimer);
            frameTimer = null;
          }
          if (frameCallbackId !== null && typeof master.cancelVideoFrameCallback === "function") {
            master.cancelVideoFrameCallback(frameCallbackId);
            frameCallbackId = null;
          }
          resolve();
        };
        const timeoutMs = (Number.isFinite(master.duration) && master.duration > 0 ? master.duration * 1000 : 70000) + 1000;
        const timer = setTimeout(() => {
          clearTimeout(timer);
          done();
        }, timeoutMs);
        master.addEventListener("ended", () => {
          clearTimeout(timer);
          done();
        }, { once: true });
      });

      Object.values(loaded).forEach((x) => {
        x.video.pause();
        URL.revokeObjectURL(x.src);
      });

      const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);
      logLine("info", `Exported segment ${i + 1}/${segments.length} in ${elapsed}s.`);
      const finishedPct = ((i + 1) / segments.length) * 100;
      setExportProgress(finishedPct, `${Math.round(finishedPct)}%`);
    }
  } finally {
    recorder.stop();
    await stopped;
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = prevText;
  }

  const blobType = mimeType || "video/webm";
  const out = new Blob(chunks, { type: blobType });
  const scopeStem = scope === "all"
    ? "teslacam-all-events"
    : sanitizeFileStem(active.eventDirPath || active.key || "teslacam-selected");
  const outName = `${scopeStem}-combined.${outExt}`;
  downloadBlob(out, outName);
  setExportProgress(100, "100%");
  els.stats.textContent = `Exported combined timeline: ${outName}`;
  logLine("info", `Browser combined export complete (${blobType}).`);
}

function configuredPreviewOrder() {
  const selected = [els.slot1Select.value, els.slot2Select.value, els.slot3Select.value];
  const unique = [];

  for (const cam of selected) {
    if (!unique.includes(cam) && cam !== state.focusCamera) {
      unique.push(cam);
    }
  }

  const fallback = ["left", "right", "back", "front"];
  for (const cam of fallback) {
    if (!unique.includes(cam) && cam !== state.focusCamera) {
      unique.push(cam);
    }
  }

  return unique.slice(0, 3);
}

function applyFocusLayout() {
  const previewPriority = configuredPreviewOrder();
  const orderMap = new Map(previewPriority.map((k, i) => [k, i + 1]));

  for (const tile of els.cameraTiles) {
    const camera = tile.dataset.camera;
    const isMain = camera === state.focusCamera;
    tile.classList.toggle("is-main", isMain);
    tile.dataset.order = isMain ? "0" : String(orderMap.get(camera) || 3);
  }
}

function renderEventList() {
  els.eventList.innerHTML = "";

  state.events.forEach((evt, index) => {
    const li = document.createElement("li");
    if (index === state.activeIndex) {
      li.classList.add("active");
    }

    const dt = evt.date ? evt.date.toLocaleString() : evt.key;
    const cameras = Object.entries(evt.clips)
      .filter(([, clip]) => Boolean(clip))
      .map(([name]) => name)
      .join(", ");

    li.innerHTML = `<strong>${dt}</strong><br><small>${cameras}</small>`;
    li.addEventListener("click", () => selectEvent(index));
    els.eventList.appendChild(li);
  });
}

async function playAll() {
  const loaded = getLoadedVideos();
  logLine("info", `Play requested for ${loaded.length} active video(s).`);
  state.mediaSyncing = true;
  try {
    await Promise.allSettled(loaded.map((video) => video.play()));
  } finally {
    state.mediaSyncing = false;
  }
  els.playPauseBtn.textContent = "Pause";
}

function pauseAll() {
  logLine("info", "Pause requested.");
  state.mediaSyncing = true;
  try {
    for (const video of getLoadedVideos()) {
      video.pause();
    }
  } finally {
    state.mediaSyncing = false;
  }
  els.playPauseBtn.textContent = "Play";
}

function activeMainClip() {
  const evt = getActiveEvent();
  if (!evt) {
    return null;
  }
  return evt.clips[state.focusCamera] || evt.clips.front || evt.clips.left || evt.clips.right || evt.clips.back;
}

async function loadTelemetry() {
  const evt = getActiveEvent();
  const clip = activeMainClip();
  const jsonMeta = evt && evt.eventJson ? evt.eventJson : null;

  if (!clip || clip.mode !== "native" || !isTauriNativeMode()) {
    if (jsonMeta && Number.isFinite(jsonMeta.est_lat) && Number.isFinite(jsonMeta.est_lon)) {
      const loc = [jsonMeta.city, jsonMeta.street].filter(Boolean).join(", ") || "unknown location";
      const ts = jsonMeta.timestamp || "unknown";
      els.telemetry.textContent = `Telemetry (event.json)\n` +
        `timestamp: ${ts}\n` +
        `lat=${jsonMeta.est_lat.toFixed(6)} lon=${jsonMeta.est_lon.toFixed(6)}\n` +
        `location: ${loc}`;
      logLine("info", "Telemetry loaded from event.json.");
      return;
    }

    els.telemetry.textContent = "Telemetry: available in Tauri native mode.";
    logLine("debug", "Telemetry skipped (native mode not available and no event.json GPS).");
    return;
  }

  try {
    logLine("info", `Reading telemetry from ${clip.path}`);
    const meta = await invokeNative("read_clip_metadata", { clipPath: clip.path });
    if (meta.gps) {
      const gps = `lat=${meta.gps.latitude.toFixed(6)} lon=${meta.gps.longitude.toFixed(6)} alt=${meta.gps.altitude_meters ?? "n/a"}`;
      const ct = meta.creation_time || "unknown";
      els.telemetry.textContent = `Telemetry\ncreation_time: ${ct}\n${gps}`;
      logLine("info", "Telemetry loaded from clip metadata.");
      return;
    }

    if (jsonMeta && Number.isFinite(jsonMeta.est_lat) && Number.isFinite(jsonMeta.est_lon)) {
      const loc = [jsonMeta.city, jsonMeta.street].filter(Boolean).join(", ") || "unknown location";
      const ts = jsonMeta.timestamp || meta.creation_time || "unknown";
      els.telemetry.textContent = `Telemetry (event.json fallback)\n` +
        `timestamp: ${ts}\n` +
        `lat=${jsonMeta.est_lat.toFixed(6)} lon=${jsonMeta.est_lon.toFixed(6)}\n` +
        `location: ${loc}`;
      logLine("info", "Telemetry fallback used from event.json.");
      return;
    }

    els.telemetry.textContent = "Telemetry\nGPS not found";
    logLine("warn", "No GPS found in clip metadata or event.json.");
  } catch (error) {
    if (jsonMeta && Number.isFinite(jsonMeta.est_lat) && Number.isFinite(jsonMeta.est_lon)) {
      const loc = [jsonMeta.city, jsonMeta.street].filter(Boolean).join(", ") || "unknown location";
      const ts = jsonMeta.timestamp || "unknown";
      els.telemetry.textContent = `Telemetry (event.json fallback)\n` +
        `timestamp: ${ts}\n` +
        `lat=${jsonMeta.est_lat.toFixed(6)} lon=${jsonMeta.est_lon.toFixed(6)}\n` +
        `location: ${loc}`;
      logLine("warn", `Telemetry ffprobe failed, using event.json: ${String(error)}`);
      return;
    }

    els.telemetry.textContent = `Telemetry error: ${String(error)}`;
    logLine("error", `Telemetry failed: ${String(error)}`);
  }
}

async function loadMapForEvent(forceRouteRefresh = false) {
  const evt = getActiveEvent();
  const token = ++state.mapLoadToken;

  if (!evt) {
    els.mapStatus.textContent = "No event selected";
    clearMapCanvas("Load an event to view GPS data.");
    setMapPointsMessage("No GPS points yet.");
    state.mapPoints = [];
    state.mapRoutePoints = [];
    return;
  }

  const hasEventJsonGps = Boolean(
    evt.eventJson && Number.isFinite(evt.eventJson.est_lat) && Number.isFinite(evt.eventJson.est_lon),
  );

  if ((!isTauriNativeMode() || evt.source !== "native") && !hasEventJsonGps) {
    try {
      const seiPoints = await extractSeiGpsPointsForEvent(evt, state.activeIndex);
      if (token !== state.mapLoadToken) {
        return;
      }
      if (seiPoints.length >= 2) {
        const master = getMasterVideo();
        renderMap(seiPoints, master ? master.currentTime : 0, getEventDuration());
        els.mapStatus.textContent = `SEI GPS route (${seiPoints.length} points)`;
        logLine("info", `Map loaded from SEI GPS (${seiPoints.length} points).`);
        return;
      }
    } catch (err) {
      logLine("warn", `SEI GPS decode failed: ${String(err)}.`);
    }

    els.mapStatus.textContent = "No GPS found";
    clearMapCanvas("No GPS available for this event.");
    setMapPointsMessage("No GPS points found in imported clips/event.json/SEI.");
    state.mapPoints = [];
    state.mapRoutePoints = [];
    logLine("debug", "Map skipped (no native metadata, event.json GPS, or SEI GPS).");
    return;
  }

  if ((!isTauriNativeMode() || evt.source !== "native") && hasEventJsonGps) {
    try {
      const seiPoints = await extractSeiGpsPointsForEvent(evt, state.activeIndex);
      if (token !== state.mapLoadToken) {
        return;
      }
      if (seiPoints.length >= 2) {
        const master = getMasterVideo();
        renderMap(seiPoints, master ? master.currentTime : 0, getEventDuration());
        const routePoints = getEventJsonRoutePoints();
        els.mapStatus.textContent = `SEI GPS route (${seiPoints.length} points) + event markers (${routePoints.length})`;
        logLine("info", `Map loaded from SEI GPS (${seiPoints.length} points).`);
        return;
      }
    } catch (err) {
      logLine("warn", `SEI GPS decode failed: ${String(err)}. Using event.json route.`);
    }

    const routePoints = getEventJsonRoutePoints();
    if (routePoints.length >= 2) {
      await renderEventJsonRoute(routePoints, state.activeIndex, forceRouteRefresh);
      els.mapStatus.textContent = `Route from event.json (${routePoints.length} points)`;
      logLine("info", "Map loaded as combined event.json route.");
    } else {
      const fallbackPoint = [{
        camera: "event_json",
        latitude: evt.eventJson.est_lat,
        longitude: evt.eventJson.est_lon,
        creationTime: evt.eventJson.timestamp || null,
      }];
      renderMap(fallbackPoint, 0, getEventDuration());
      els.mapStatus.textContent = "GPS from event.json";
      logLine("info", "Map loaded from event.json in browser mode.");
    }
    return;
  }

  const clipEntries = Object.entries(evt.clips)
    .filter(([, clip]) => Boolean(clip && clip.mode === "native" && clip.path))
    .map(([camera, clip]) => ({ camera, path: clip.path }));

  if (!clipEntries.length) {
    els.mapStatus.textContent = "No clips in this event";
    clearMapCanvas("No clip files available for mapping.");
    setMapPointsMessage("No GPS points yet.");
    state.mapPoints = [];
    state.mapRoutePoints = [];
    return;
  }

  els.mapStatus.textContent = "Loading GPS data...";
  clearMapCanvas("Loading GPS data...");
  logLine("info", `Loading GPS metadata from ${clipEntries.length} clip(s).`);

  const points = [];
  await Promise.allSettled(
    clipEntries.map(async ({ camera, path }) => {
      const meta = await invokeNative("read_clip_metadata", { clipPath: path });
      if (meta && meta.gps) {
        points.push({
          camera,
          latitude: meta.gps.latitude,
          longitude: meta.gps.longitude,
          creationTime: meta.creation_time || null,
        });
      }
    }),
  );

  if (token !== state.mapLoadToken) {
    return;
  }

  points.sort((a, b) => String(a.creationTime || "").localeCompare(String(b.creationTime || "")));
  const master = getMasterVideo();
  renderMap(points, master ? master.currentTime : 0, getEventDuration());
  state.mapRoutePoints = [];
  if (!points.length && evt.eventJson && Number.isFinite(evt.eventJson.est_lat) && Number.isFinite(evt.eventJson.est_lon)) {
    const routePoints = getEventJsonRoutePoints();
    if (routePoints.length >= 2) {
      await renderEventJsonRoute(routePoints, state.activeIndex, forceRouteRefresh);
      els.mapStatus.textContent = `Route from event.json (${routePoints.length} points)`;
      logLine("info", "Map fallback used combined event.json route.");
    } else {
      const fallbackPoint = [{
        camera: "event_json",
        latitude: evt.eventJson.est_lat,
        longitude: evt.eventJson.est_lon,
        creationTime: evt.eventJson.timestamp || null,
      }];
      renderMap(fallbackPoint, 0, getEventDuration());
      els.mapStatus.textContent = "GPS from event.json";
      logLine("info", "Map fallback used event.json coordinates.");
    }
    return;
  }
  els.mapStatus.textContent = points.length
    ? `GPS points: ${points.length}`
    : "No GPS found in clip metadata";
  logLine("info", `Map updated with ${points.length} GPS point(s).`);
}

function selectEvent(index) {
  state.activeIndex = index;
  const evt = getActiveEvent();

  if (!evt) {
    return;
  }

  pauseAll();

  setVideoClip(els.videos.front, evt.clips.front);
  setVideoClip(els.videos.back, evt.clips.back);
  setVideoClip(els.videos.left, evt.clips.left);
  setVideoClip(els.videos.right, evt.clips.right);

  const loaded = getLoadedCameraKeys();
  if (!loaded.includes(state.focusCamera)) {
    state.focusCamera = loaded.includes("front") ? "front" : (loaded[0] || "front");
  }
  applyFocusLayout();

  const label = evt.date ? evt.date.toLocaleString() : evt.key;
  els.eventMeta.textContent = `Event: ${label}`;
  logLine("info", `Selected event ${index + 1}/${state.events.length}: ${label}`);

  renderEventList();
  updateButtons();
  updateSeekUi();
  refreshEventWindow();
  void loadSeiTimelineForActiveEvent();
  loadTelemetry();
  loadMapForEvent(true);
}

function bindVideoEvents() {
  for (const video of Object.values(els.videos)) {
    video.addEventListener("timeupdate", () => {
      syncCurrentTime(video);
      const master = getMasterVideo();
      if (master && video !== master && !state.syncing) {
        return;
      }
      schedulePlaybackUiUpdate(false);
    });

    video.addEventListener("seeking", () => {
      syncCurrentTime(video);
      schedulePlaybackUiUpdate(true);
    });

    video.addEventListener("loadedmetadata", () => {
      logLine("debug", `Loaded metadata (${video.id}): duration=${Number(video.duration).toFixed(3)}s src=${video.currentSrc || video.src}`);
      schedulePlaybackUiUpdate(true);
      refreshEventWindow();
    });

    video.addEventListener("error", () => {
      const err = video.error;
      const details = err ? `code=${err.code} message=${err.message || "n/a"}` : "unknown error";
      logLine("error", `Video load failed (${video.id}): ${details} src=${video.currentSrc || video.src}`);
    });

    video.addEventListener("ended", () => {
      const allEnded = getLoadedVideos().every((v) => v.ended);
      if (allEnded) {
        pauseAll();
      }
    });

    // Keep all camera streams in sync when user uses native video controls/keyboard.
    video.addEventListener("pause", () => {
      if (state.syncing || state.mediaSyncing) {
        return;
      }
      const othersPlaying = getLoadedVideos().some((v) => v !== video && !v.paused && !v.ended);
      if (othersPlaying) {
        pauseAll();
      }
    });

    video.addEventListener("play", () => {
      if (state.syncing || state.mediaSyncing) {
        return;
      }
      void playAll();
    });
  }
}

async function scanNativePath() {
  if (!isTauriNativeMode()) {
    els.stats.textContent = "Tauri native mode is not active. Use folder picker instead.";
    return;
  }

  const rootPath = (els.folderPath.value || "").trim();
  if (!rootPath) {
    els.stats.textContent = "Enter a TeslaCam folder path first.";
    logLine("warn", "Scan aborted: empty path.");
    return;
  }

  try {
    logLine("info", `Scanning TeslaCam path: ${rootPath}`);
    const events = await invokeNative("scan_teslacam", { rootPath });
    state.events = buildEventsFromNative(events);
    state.activeIndex = -1;

    els.stats.textContent = `Scanned ${state.events.length} events from ${rootPath}`;
    logLine("info", `Scan complete: ${state.events.length} event(s).`);

    if (state.events.length) {
      selectEvent(0);
    } else {
      els.eventMeta.textContent = "No events found in selected folder.";
      renderEventList();
      updateButtons();
      updateSeekUi();
      loadMapForEvent();
    }
  } catch (error) {
    els.stats.textContent = `Scan failed: ${String(error)}`;
    logLine("error", `Scan failed: ${String(error)}`);
  }
}

async function handleLoadFolderClick(event) {
  if (!isTauriNativeMode()) {
    return;
  }

  // WebView folder input support is inconsistent; route to native scan path flow.
  event.preventDefault();

  let rootPath = (els.folderPath.value || "").trim();
  if (!rootPath) {
    const entered = window.prompt("Enter TeslaCam folder path", "C:\\\\TeslaCam");
    if (!entered) {
      logLine("warn", "Native load canceled: no path provided.");
      return;
    }
    rootPath = entered.trim();
    els.folderPath.value = rootPath;
  }

  logLine("info", `Load button using native path scan: ${rootPath}`);
  await scanNativePath();
}

async function exportCurrentEvent() {
  const evt = getActiveEvent();
  if (!evt) {
    return;
  }

  const exportScope = (els.exportScope && els.exportScope.value) || "selected";

  if (!isTauriNativeMode()) {
    await exportWebCombinedTimeline(exportScope);
    return;
  }

  if (exportScope === "all") {
    els.stats.textContent = "All-events export is currently available in browser mode.";
    logLine("warn", "Native all-events export is not implemented yet.");
    setExportProgress(0, "Idle");
    return;
  }

  const outputPath = (els.exportPath.value || "").trim();
  if (!outputPath) {
    els.stats.textContent = "Set an output file path for export.";
    logLine("warn", "Export aborted: missing output path.");
    return;
  }

  const request = {
    outputPath,
    mainCamera: state.focusCamera,
    clips: {
      front: evt.clips.front && evt.clips.front.mode === "native" ? evt.clips.front.path : null,
      back: evt.clips.back && evt.clips.back.mode === "native" ? evt.clips.back.path : null,
      left: evt.clips.left && evt.clips.left.mode === "native" ? evt.clips.left.path : null,
      right: evt.clips.right && evt.clips.right.mode === "native" ? evt.clips.right.path : null,
    },
    telemetryPngFrames: buildNativeTelemetryPngFramesForExport(getEventDuration()),
    overlayDurationSec: getEventDuration(),
  };

  try {
    els.stats.textContent = "Exporting MP4...";
    setExportProgress(5, "5%");
    logLine("info", `Export started: ${outputPath}`);
    setExportProgress(10, "Encoding... (live ffmpeg output in terminal)");
    const result = await invokeNative("export_event_mp4", { request });
    setExportProgress(100, "100%");
    els.stats.textContent = `Export complete: ${result.output_path}`;
    logLine("info", `Export complete: ${result.output_path}`);
  } catch (error) {
    setExportProgress(0, "Idle");
    els.stats.textContent = `Export failed: ${String(error)}`;
    logLine("error", `Export failed: ${String(error)}`);
  }
}

async function browseExportPath() {
  if (!isTauriNativeMode()) {
    return;
  }
  try {
    const currentPath = (els.exportPath.value || "").trim();
    const selected = await invokeNative("pick_export_path", {
      request: { currentPath: currentPath || null },
    });
    if (selected) {
      els.exportPath.value = selected;
      logLine("info", `Export path selected: ${selected}`);
    }
  } catch (error) {
    logLine("error", `Export path picker failed: ${String(error)}`);
  }
}

function setup() {
  const storedTheme = readThemeSettings();
  applyTheme(storedTheme);
  syncThemeInputs(storedTheme);

  bindVideoEvents();
  setExportProgress(0, "Idle");
  applyFocusLayout();
  if (hasLeaflet) {
    ensureLeafletMap();
  }
  logLine("system", `App initialized. Mode=${isTauriNativeMode() ? "tauri-native" : "browser"}`);
  if (isTauriNativeMode() && !state.ffmpegLogUnlisten) {
    listenNativeEvent("ffmpeg-log", (payload) => {
      const line = String(payload || "").trim();
      if (!line) {
        return;
      }
      logLine("debug", `[ffmpeg] ${line}`);
    })
      .then((unlisten) => {
        state.ffmpegLogUnlisten = unlisten;
        logLine("debug", "Live FFmpeg terminal output enabled.");
      })
      .catch((err) => {
        logLine("warn", `FFmpeg log stream unavailable: ${String(err)}`);
      });
  }

  const slotSelects = [els.slot1Select, els.slot2Select, els.slot3Select];
  for (const [idx, select] of slotSelects.entries()) {
    select.addEventListener("change", () => {
      state.previewSlots[idx] = select.value;
      applyFocusLayout();
      refreshEventWindow();
      logLine("info", `Small slot ${idx + 1} set to ${select.value}.`);
    });
  }

  els.scanPathBtn.addEventListener("click", scanNativePath);
  els.exportBrowseBtn.addEventListener("click", browseExportPath);
  els.exportBtn.addEventListener("click", exportCurrentEvent);
  els.loadFolderBtn.addEventListener("click", handleLoadFolderClick);
  els.snapRoadsToggle.addEventListener("change", () => {
    if (state.mapRoutePoints.length) {
      void renderEventJsonRoute(state.mapRoutePoints, state.mapRouteCurrentIndex, true).catch((err) => {
        logLine("warn", `Snap re-render failed: ${String(err)}. Reverting to raw route.`);
        els.snapRoadsToggle.checked = false;
        void renderEventJsonRoute(state.mapRoutePoints, state.mapRouteCurrentIndex, true);
      });
    }
  });
  els.osrmEndpoint.addEventListener("change", () => {
    state.routeSnapCache.clear();
    if (state.mapRoutePoints.length) {
      void renderEventJsonRoute(state.mapRoutePoints, state.mapRouteCurrentIndex);
    }
  });
  els.themeApplyBtn.addEventListener("click", () => {
    const theme = currentThemeFromInputs();
    applyTheme(theme);
    writeThemeSettings(theme);
    logLine("info", `Theme applied: ${theme.primary}`);
  });
  els.themeResetBtn.addEventListener("click", () => {
    applyTheme(THEME_DEFAULTS);
    syncThemeInputs(THEME_DEFAULTS);
    writeThemeSettings(THEME_DEFAULTS);
    logLine("info", "Theme reset to defaults.");
  });
  els.clearLogsBtn.addEventListener("click", () => {
    els.terminalOutput.textContent = "[system] Terminal cleared.";
    state.logCount = 0;
  });
  if (els.mapPointsPanel) {
    els.mapPointsPanel.addEventListener("toggle", () => {
      const ctx = state.mapPointLabelsContext;
      if (!ctx) {
        return;
      }
      if (els.mapPointsPanel.open) {
        refreshMapPointsList();
      } else {
        els.mapPoints.textContent = `${ctx.points.length} point(s). Expand to view details.`;
      }
    });
  }

  for (const tile of els.cameraTiles) {
    tile.addEventListener("click", () => {
      const camera = tile.dataset.camera;
      if (!camera || !els.videos[camera] || !els.videos[camera].src) {
        return;
      }
      state.focusCamera = camera;
      applyFocusLayout();
      refreshEventWindow();
      loadTelemetry();
    });
  }

  els.mapCanvas.addEventListener("click", (event) => {
    if (!state.mapRouteHitPoints.length) {
      return;
    }
    const rect = els.mapCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hitRadius = 14;
    let best = null;
    let bestDist = Infinity;
    for (const p of state.mapRouteHitPoints) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (best && bestDist <= hitRadius && Number.isInteger(best.eventIndex)) {
      logLine("info", `Map click -> event ${best.eventIndex + 1}`);
      selectEvent(best.eventIndex);
    }
  });

  window.addEventListener("resize", () => {
    if (state.leaflet.map && els.leafletMap.style.display !== "none") {
      state.leaflet.map.invalidateSize();
    }
    if (state.mapRoutePoints.length) {
      void renderEventJsonRoute(state.mapRoutePoints, state.mapRouteCurrentIndex);
    } else if (state.mapPoints.length) {
      updateMapMarkerForPlayback();
    } else {
      clearMapCanvas("Load an event to view GPS data.");
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") {
      return;
    }
    const tag = String(event.target && event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) {
      return;
    }
    event.preventDefault();
    const master = getMasterVideo();
    if (!master) {
      return;
    }
    if (master.paused) {
      void playAll();
    } else {
      pauseAll();
    }
  });

  els.folderInput.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    logLine("info", `Folder import selected with ${files.length} file(s).`);
    const baseEvents = buildEventsFromFiles(files);
    Promise.resolve(enrichWebEventsWithEventJson(baseEvents, files)).then((events) => {
      state.events = sortEventsByDate(events);
      state.activeIndex = -1;

      const eventJsonCount = events.filter((e) => Boolean(e.eventJson)).length;
      els.stats.textContent = `Loaded ${files.length} files, found ${state.events.length} events (${eventJsonCount} with event.json).`;

      for (const video of Object.values(els.videos)) {
        clearVideo(video);
      }

      if (state.events.length) {
        selectEvent(0);
      } else {
        els.eventMeta.textContent = "No events found in selected folder.";
        renderEventList();
        updateButtons();
        updateSeekUi();
        els.telemetry.textContent = "Telemetry: not loaded";
        loadMapForEvent();
      }
    });
  });

  els.playPauseBtn.addEventListener("click", async () => {
    const master = getMasterVideo();
    if (!master) {
      return;
    }

    if (master.paused) {
      await playAll();
    } else {
      pauseAll();
    }
  });

  els.prevBtn.addEventListener("click", () => {
    if (state.activeIndex > 0) {
      selectEvent(state.activeIndex - 1);
    }
  });

  els.nextBtn.addEventListener("click", () => {
    if (state.activeIndex < state.events.length - 1) {
      selectEvent(state.activeIndex + 1);
    }
  });

  els.speedSelect.addEventListener("change", () => {
    const speed = parseFloat(els.speedSelect.value);
    setPlaybackRate(Number.isFinite(speed) ? speed : 1);
  });

  els.seek.addEventListener("input", () => {
    const t = parseFloat(els.seek.value);
    if (!Number.isFinite(t)) {
      return;
    }

    for (const video of getLoadedVideos()) {
      video.currentTime = t;
    }
    updateSeekUi();
  });

  if (!isTauriNativeMode()) {
    els.scanPathBtn.disabled = true;
    els.scanPathBtn.title = "Available inside Tauri app";
    els.exportPath.disabled = true;
    els.exportBrowseBtn.disabled = true;
    els.exportBrowseBtn.title = "Available inside Tauri app";
    els.exportPath.placeholder = "Browser mode: downloads file automatically";
    logLine("debug", "Native scan disabled in browser mode; export uses file download.");
  }

  window.addEventListener("error", (event) => {
    const where = event && event.filename ? ` @ ${event.filename}:${event.lineno || 0}:${event.colno || 0}` : "";
    logLine("error", `Unhandled error: ${event.message || "unknown"}${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logLine("error", `Unhandled promise rejection: ${String(event.reason)}`);
  });

  clearMapCanvas("Load an event to view GPS data.");
  setMapPointsMessage("No GPS points yet.");
  setPlaybackRate(1);
  updateDriveOverlay();
  updateButtons();
}

setup();




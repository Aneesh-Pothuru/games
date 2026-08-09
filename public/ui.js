/**
 * DOM helpers, avatars, and the device-facing bits: wake lock, haptics, audio.
 */

// ------------------------------------------------------------------- dom ----

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

// --------------------------------------------------------------- announce ---

const politeRegion = () => document.getElementById('live-polite');
const alertRegion = () => document.getElementById('live-alert');

/** Assertive interrupts the screen reader — reserve it for "act now". */
export function announce(message, assertive = false) {
  const region = assertive ? alertRegion() : politeRegion();
  if (!region) return;
  region.textContent = '';
  // A same-frame swap is coalesced away by some screen readers.
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

// --------------------------------------------------------------- avatars ----

/** FNV-1a. Seeded from the stable player id, so renaming keeps your face. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const PALETTES = [
  ['#5ba8ff', '#0e2c52', '#bfe0ff'], ['#ff7a45', '#4a1b08', '#ffd9c6'],
  ['#2fd3a0', '#06342a', '#c4f5e6'], ['#f2e14d', '#3d3606', '#fbf6c8'],
  ['#e48fd6', '#3d1038', '#fadcf5'], ['#45d6e8', '#06343b', '#c9f3f9'],
  ['#a9b4ff', '#1b2050', '#dfe3ff'], ['#ffb13d', '#452b02', '#ffe7c2'],
  ['#7be06b', '#153a0e', '#dcf7d6'], ['#ff8fa0', '#4a121e', '#ffd9df'],
  ['#c9a6ff', '#2b1552', '#ebddff'], ['#e8e4da', '#2a2924', '#ffffff'],
];

/** Shape is the primary channel: the set stays separable in pure grayscale. */
const SILHOUETTES = [
  'M32 4a28 28 0 1 1 0 56 28 28 0 0 1 0-56Z',
  'M14 4h36a10 10 0 0 1 10 10v36a10 10 0 0 1-10 10H14A10 10 0 0 1 4 50V14A10 10 0 0 1 14 4Z',
  'M32 3 58 17.5v29L32 61 6 46.5v-29Z',
  'M32 3l25 8v22c0 15-11 25-25 31C18 58 7 48 7 33V11Z',
  'M32 3c15 0 26 11 26 25 0 17-16 27-26 36C22 55 6 45 6 28 6 14 17 3 32 3Z',
  'M22 4h20l16 16v20L42 60H22L6 40V20Z',
  'M32 2 62 32 32 62 2 32Z',
  'M32 3c14 0 24 10 24 24v25a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5V27C8 13 18 3 32 3Z',
];

const MARKS = [
  '<circle cx="32" cy="42" r="7"/>',
  '<path d="M22 44h20"/>',
  '<path d="M24 46l8-9 8 9Z"/>',
  '<path d="M32 34v14M25 41h14"/>',
  '<rect x="24" y="36" width="16" height="9" rx="2"/>',
  '<path d="M23 38q9 12 18 0"/>',
  '<path d="M32 33l3.4 7 7.6.9-5.6 5.2 1.6 7.5L32 49.9 24.9 53.6l1.6-7.5-5.6-5.2 7.6-.9Z"/>',
  '<path d="M25 35v12M32 32v15M39 35v12"/>',
  '<circle cx="26" cy="42" r="3.4"/><circle cx="38" cy="42" r="3.4"/>',
  '<path d="M22 36h20v10H22z" opacity=".55"/><path d="M22 41h20"/>',
];

const EYES = [
  [25, 39, 4.2], [24, 38, 3.4], [26, 40, 5], [25, 37, 3.8], [23, 39, 4.6], [26, 38, 3],
];

function traitsOf(id) {
  const s = hash32(id);
  return {
    palette: s % PALETTES.length,
    silhouette: (s >>> 4) % SILHOUETTES.length,
    mark: (s >>> 8) % MARKS.length,
    eyes: (s >>> 12) % EYES.length,
    band: (s >>> 16) % 4,
    tilt: (s >>> 20) % 4,
  };
}

/**
 * Raw hashing gives 12x8 palette/shape pairs, which collides in roughly a
 * third of 10-player lobbies. Sorting the ids first and linear-probing to
 * uniqueness makes every client derive identical avatars with no server
 * coordination, and guarantees distinctness up to 12 players.
 */
export function assignAvatars(ids) {
  const usedPalettes = new Set();
  const usedShapes = new Set();
  const out = {};
  for (const id of [...ids].sort()) {
    const t = traitsOf(id);
    let p = t.palette;
    for (let i = 0; usedPalettes.has(p) && i < PALETTES.length; i++) p = (p + 1) % PALETTES.length;
    usedPalettes.add(p);
    let sh = t.silhouette;
    for (let i = 0; usedShapes.has(sh) && i < SILHOUETTES.length && usedShapes.size < SILHOUETTES.length; i++) {
      sh = (sh + 1) % SILHOUETTES.length;
    }
    usedShapes.add(sh);
    out[id] = { ...t, palette: p, silhouette: sh };
  }
  return out;
}

export function avatarSvg(name, traits) {
  const [ink, ground, hi] = PALETTES[traits.palette];
  const [ex, ey, er] = EYES[traits.eyes];
  const rot = (traits.tilt - 1.5) * 4;
  const bandY = 50 + traits.band * 2.5;
  return `<svg viewBox="0 0 64 64" role="img" aria-label="${escapeAttr(name)}"><rect width="64" height="64" fill="${ground}"/><g transform="rotate(${rot} 32 32)"><path d="${SILHOUETTES[traits.silhouette]}" fill="${ink}"/><path d="${SILHOUETTES[traits.silhouette]}" fill="none" stroke="${hi}" stroke-width="1.6" opacity=".5"/><g fill="${ground}" stroke="${ground}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="${ex}" cy="${ey}" r="${er}" stroke="none"/><circle cx="${64 - ex}" cy="${ey}" r="${er}" stroke="none"/>${MARKS[traits.mark]}</g>${traits.band ? `<path d="M8 ${bandY}h48" stroke="${hi}" stroke-width="2.4" opacity=".55" stroke-linecap="round"/>` : ''}</g></svg>`;
}

export function escapeAttr(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ------------------------------------------------------------- wake lock ----

let wakeLock = null;
let wantWakeLock = false;
let noSleepVideo = null;

export async function keepAwake(on) {
  wantWakeLock = on;
  if (!on) {
    try {
      await wakeLock?.release();
    } catch {
      /* already released */
    }
    wakeLock = null;
    stopNoSleepFallback();
    return false;
  }
  return acquireWakeLock();
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return startNoSleepFallback();
  if (document.visibilityState !== 'visible') return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    stopNoSleepFallback();
    return true;
  } catch {
    // NotAllowedError is routine: low battery, power saver, doc not active.
    return startNoSleepFallback();
  }
}

/** Pre-16.4 iOS and denied locks: a muted looping video keeps the screen on. */
function startNoSleepFallback() {
  if (noSleepVideo) return true;
  try {
    const video = el('video', { muted: true, playsinline: true, loop: true });
    video.muted = true;
    video.setAttribute('style', 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none');
    video.src =
      'data:video/mp4;base64,AAAAIGZ0eXBtcDQyAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0OCByMjYwMSBhMGNkN2QzIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbAAAAAFljb250AAAAAA==';
    document.body.append(video);
    void video.play().catch(() => {});
    noSleepVideo = video;
    return true;
  } catch {
    return false;
  }
}

function stopNoSleepFallback() {
  noSleepVideo?.remove();
  noSleepVideo = null;
}

// The OS releases the lock whenever the tab hides, so always re-acquire.
document.addEventListener('visibilitychange', () => {
  if (wantWakeLock && wakeLock === null && document.visibilityState === 'visible') acquireWakeLock();
});

// --------------------------------------------------------------- feedback ---

export const prefs = {
  sound: false, // eight phones chiming out of sync is a disaster
  haptics: true,
};

try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('parlour:prefs') ?? '{}'));
} catch {
  /* defaults are fine */
}

export function savePrefs() {
  try {
    localStorage.setItem('parlour:prefs', JSON.stringify(prefs));
  } catch {
    /* nothing to do */
  }
}

const HAPTIC_PATTERNS = { turn: [40, 70, 40], confirm: 22, reject: [60, 40, 60], reveal: 12 };

/** iOS Safari has no Vibration API, so this is a bonus channel, never load-bearing. */
export function buzz(kind = 'confirm') {
  if (!prefs.haptics || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(HAPTIC_PATTERNS[kind] ?? 22);
  } catch {
    /* nothing to do */
  }
}

let audioCtx = null;

/** Must run inside a real user gesture: the context starts suspended on iOS. */
export function unlockAudio() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const source = audioCtx.createBufferSource();
      source.buffer = audioCtx.createBuffer(1, 1, 22050);
      source.connect(audioCtx.destination);
      source.start(0);
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* audio is optional */
  }
}

export function tone(frequency = 660, ms = 160) {
  if (!prefs.sound || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000 + 0.02);
  } catch {
    /* audio is optional */
  }
}

// iOS re-suspends aggressively; re-resume whenever we come back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') audioCtx?.resume().catch(() => {});
});

// ------------------------------------------------------------- keyboard -----

/** Lift the bottom action bar above the iOS keyboard. */
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(inset)}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

// ---------------------------------------------------------------- toast -----

let toastTimer = 0;

export function toast(message, tone = '') {
  document.querySelector('.toast')?.remove();
  const node = el('div', { class: `toast ${tone}`, role: 'status' }, [el('div', { text: message })]);
  document.body.append(node);
  announce(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4000);
}

export function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const burst = el('div', { class: 'burst', 'aria-hidden': 'true' });
  for (let i = 0; i < 24; i++) {
    const span = el('span', {}, [el('i')]);
    // Deterministic-ish spread without needing a randomness source.
    const angle = (i / 24) * Math.PI * 2;
    span.style.setProperty('--x', `${Math.cos(angle) * 46}vw`);
    span.style.setProperty('--y0', `${-8 - Math.abs(Math.sin(angle)) * 24}vh`);
    span.style.setProperty('--r', `${(i % 2 ? 1 : -1) * (360 + i * 20)}deg`);
    span.style.animationDelay = `${(i % 8) * 22}ms`;
    burst.append(span);
  }
  document.body.append(burst);
  setTimeout(() => burst.remove(), 1600);
}

// ---------------------------------------------------------------- timer -----

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

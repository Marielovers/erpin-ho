import './style.css';
import { createLive2D } from 'live2d-web';
import {
  MOTION_AREAS, PERSISTENT_PARAMETER_IDS, increaseLevel,
  isRisingPositive, newGameState, stagedParameterValues,
  PET_ENDING_SECONDS, addPettingTime, disqualifyHappyEnding, canStrokeHead,
} from './game-rules.js';
import { createSpring, advanceSpring } from './spring-return.js';
import { createHitSoundPlayer } from './hit-sounds.js';
import { createReactionVoicePlayer } from './reaction-voices.js';

// Runtime dependencies are loaded from local Vite/npm assets only.
// npm run dev downloads the official Cubism Core once, before Vite starts.
const assetUrl = (path) => new URL(path, new URL(import.meta.env.BASE_URL, document.baseURI)).href;
const CORE_URL = assetUrl('vendor/live2dcubismcore.min.js');
const MODEL_URL = assetUrl('model/에르핀.model3.json');
const hitSounds = createHitSoundPlayer(assetUrl, typeof Audio === 'function' ? Audio : null);
const reactionVoices = createReactionVoicePlayer(assetUrl); // exclusive voice channel; no dialogue backlog
const STORAGE_KEY = 'erpin-live2d-interactive-v1'; // preserve earlier click history
const SENSITIVITY_PIXELS = 180;
const MOVE_THRESHOLD = 9;
const CLICK_PRIORITY = MOTION_AREAS;
const DRAG_PRIORITY = ['breasttouch', 'skirtopen', 'touch'];
const DRAG_PARAMETERS = {
  touch: [
    { id: 'headX', axis: 'x', sign: 1 },
    { id: 'headY', axis: 'y', sign: -1 },
  ],
  skirtopen: [{ id: 'skirtopen', axis: 'y', sign: -1 }],
  breasttouch: [
    { id: 'boobX1', axis: 'x', sign: 1 },
    { id: 'boobY1', axis: 'y', sign: -1 },
  ],
};
const DRAG_IDS = ['headX', 'headY', 'skirtopen', 'boobX1', 'boobY1'];
const PHYSICS_OUTPUT_IDS = new Set(['headX', 'headY', 'boobX1', 'boobY1']);
const ALL_GAME_IDS = [...new Set([...DRAG_IDS, ...PERSISTENT_PARAMETER_IDS, 'eyeopen', 'smile'])];
const $ = (id) => document.getElementById(id);
const host = $('live2dHost');
const statusEl = $('status');
$('stage').style.setProperty('--game-background', `url("${assetUrl('assets/background.png')}")`);
const splash = $('splash');
const endingVeil = $('happyEnding');
const startButton = $('startButton');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Speech uses an exclusive channel: missed lines are dropped, not queued.
let started = false;
function modelFit() {
  return { scale: window.innerWidth <= 700 ? 0.9 : 0.6, offsetX: 0, offsetY: -0.4, units: 'stage' };
}
let model;
let active = null;
const returning = new Map();
// Persistent facial/game values are applied AFTER animation and physics every frame.
const stateDrivers = new Map();
// These two LV flags use live2d-web's own persistent per-frame override.
// Unlike a callback driver, setParameter is re-applied by the Cubism backend
// every frame after motion, physics and expressions.
const DIRECT_LV_PARAMETER_IDS = new Set(['eyelight', 'pupil']);
const directLvPins = new Set();
const GAME_CODE_VERSION = '2026-11-08-eyeopen-lv-ramp';
let lastSpringAt = null;
let limits = Object.create(null);
let tearParameterId = 'tears'; // previous .moc3 uses 'tears'; edited models may use 'tear'
let endingPoseDrivers = [];
// touch.motion3.json was registered but never actually played in the old build.
// Hold its eye-close pose during real head strokes, then restore the face on release.
let petFaceMode = 'off';
const petFaceDrivers = [];
const ENDING_POSE_IDS = ['eyeopen', 'smile'];
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
catch (error) { console.warn('게임 기록 복원 실패', error); }
let state = newGameState(saved && typeof saved === 'object' ? saved : {});

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (error) { console.warn('게임 기록 저장 실패', error); }
}
function notice(message, error = false) {
  if (error) {
    console.error('[Live2D]', message);
    statusEl.textContent = message;
    statusEl.hidden = false;
  } else {
    console.debug('[Live2D]', message);
    statusEl.hidden = true;
  }
}
function advanceFrame(now) {
  if (lastSpringAt !== null) advanceReturns((now - lastSpringAt) / 1000);
  lastSpringAt = now;
  requestAnimationFrame(advanceFrame);
}
function setBounded(id, value) {
  const range = limits[id];
  if (!range) return;
  model.setParameter(id, clamp(value, range.minimum, range.maximum));
}

// Both values remain pinned at zero every animation frame after the ending.
// The after-motion driver wins over expression/motion changes; it does not
// touch the spring-driven head/body physics parameters.
function keepHappyPose() {
  if (!model || endingPoseDrivers.length) return;
  for (const id of ENDING_POSE_IDS) {
    if (!limits[id]) continue;
    setBounded(id, 0);
    endingPoseDrivers.push(model.addParameterDriver(id, {
      phase: 'after-motion', getValue: () => 0,
    }));
  }
}
function clearPetFaceDrivers() {
  for (const dispose of petFaceDrivers.splice(0)) dispose();
  petFaceMode = 'off';
}
function beginPetMotion() {
  if (!model || !canStrokeHead(state)) return;
  petFaceMode = 'petting';
  if (!state.endingReached && petFaceDrivers.length === 0) {
    for (const id of ENDING_POSE_IDS) {
      if (!limits[id]) continue;
      // 'after-motion' wins over motion/physics and guarantees closed eyes
      // while the head is being stroked, even during motion fade-in.
      petFaceDrivers.push(model.addParameterDriver(id, {
        phase: 'after-motion',
        getValue: () => petFaceMode === 'petting' ? 0 : limits[id].defaultValue,
      }));
    }
  }
  // Motion is intentionally triggered ONCE at the beginning of each stroke.
  // Even if the motion JSON is looping, the after-motion driver restores
  // the default face between strokes. A later hit motion interrupts it.
  void model.playMotion('touch', 0, {
    priority: 'force', fadeInMs: 120, fadeOutMs: 200,
  }).catch(error => {
    console.error('touch.motion3.json 재생 실패:', error);
    notice(`touch 모션 오류: ${error?.message || String(error)}`, true);
  });
}
function endPetMotion() {
  if (state.endingReached) {
    clearPetFaceDrivers(); // Permanent ending pose is managed separately.
  } else if (petFaceDrivers.length) {
    // The SDK has no public stopMotion method; the touch file has Loop=true.
    // Restore normal face even if its loop has not been interrupted yet.
    petFaceMode = 'resting';
  }
}
function showHappyEnding({ playVoice = false } = {}) {
  endingVeil.hidden = false;
  keepHappyPose();
  if (playVoice) reactionVoices.queueJoy();
  else reactionVoices.lockEnding();
}
function finishHappyEnding() {
  if (!state.endingReached) return;
  clearPetFaceDrivers();
  showHappyEnding({ playVoice: true });
  save();
}
// Game state is not a one-time write: expressions and motion/physics may
// modify values every frame. Use persistent direct setParameter overrides
// for eyelight/pupil; other parameters retain their existing drivers.
function applyGameParameters() {
  if (!model) return;
  const values = stagedParameterValues(state);
  if (state.cheekHits > 0 && limits.cheekcolor) {
    values.cheekcolor = limits.cheekcolor.defaultValue + state.cheekHits * 0.1;
  }
  if (state.breastLeftHits > 0 && limits.breastcolorleft) {
    values.breastcolorleft = limits.breastcolorleft.defaultValue + state.breastLeftHits * 0.1;
  }
  if (state.breastRightHits > 0 && limits.breastcolorright) {
    values.breastcolorright = limits.breastcolorright.defaultValue + state.breastRightHits * 0.1;
  }
  const target = new Map();
  for (const [logicalId, rawValue] of Object.entries(values)) {
    const id = logicalId === 'tears' ? tearParameterId : logicalId;
    const range = limits[id];
    if (range) target.set(id, clamp(rawValue, range.minimum, range.maximum));
  }
  // Clear any obsolete driver before pinning the LV flags. Driver cleanup
  // calls clearParameter(), so doing this afterward would erase a new pin.
  for (const [id, old] of stateDrivers) {
    if (DIRECT_LV_PARAMETER_IDS.has(id) || !target.has(id)) {
      old.dispose();
      stateDrivers.delete(id);
      if (!target.has(id)) model.clearParameter(id);
      continue;
    }
    old.value = target.get(id);
    model.setParameter(id, old.value);
  }
  for (const id of [...directLvPins]) {
    if (!target.has(id)) {
      model.clearParameter(id);
      directLvPins.delete(id);
    }
  }
  for (const [id, value] of target) {
    if (DIRECT_LV_PARAMETER_IDS.has(id)) {
      // Persistent manual override: the backend reapplies this after physics
      // every frame, so a motion/expression cannot undo LV1/LV20.
      model.setParameter(id, value);
      directLvPins.add(id);
      continue;
    }
    if (stateDrivers.has(id)) continue;
    const entry = { value, dispose: null };
    model.setParameter(id, value);
    entry.dispose = model.addParameterDriver(id, {
      phase: 'after-motion', getValue: () => entry.value,
    });
    stateDrivers.set(id, entry);
  }
  if (state.endingReached) keepHappyPose();
}
function progress(source) {
  if (state.endingReached) return; // no level/impact events after the happy ending
  increaseLevel(state, source);
  applyGameParameters();
  save();
  reactionVoices.queue(state.lv); // choose voice based on the new LV; play 0.5 seconds later
  const detail = source === 'facehit' ? ' · blood=1'
    : source === 'breasthitleft' ? ' · 왼쪽 색상 +0.1'
    : source === 'breasthitright' ? ' · 오른쪽 색상 +0.1'
    : source === 'bellyhit' ? ` · bellyhit ${state.bellyHitCount}회` : '';
  notice(`${source} · LV ${state.lv}${detail} · 행복 엔딩 불가`);
}

// Cubism Core must exist on our host. Never silently load it from a CDN.
async function assertLocalCore() {
  const response = await fetch(CORE_URL, { cache: 'no-store' });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || type.includes('text/html')) {
    throw new Error('로컬 Cubism Core가 없습니다. npm run dev를 다시 실행해 주세요.\n' +
      '설치가 실패한 경우 npm run setup:core로 오류를 확인하세요.');
  }
  const head = (await response.text()).slice(0, 200);
  if (/<!doctype html|<html/i.test(head)) throw new Error('Core 경로가 HTML을 반환했습니다.');
}
// During dragging, setParameter() pins the requested value. Once released,
// let Cubism compute physics normally. After physics we read its *current*
// output and smooth the visible parameter toward it. This matters because
// headX/headY/boobX1/boobY1 are PHYSICS OUTPUTS in this model: driving their
// default value before physics is simply overwritten by the solver.
function stopReturn(id) {
  const motion = returning.get(id);
  if (!motion) return;
  returning.delete(id);
  motion.dispose?.();
  model?.clearParameter(id);
}
function advanceReturns(_dtSeconds) {
  for (const [id, motion] of returning) {
    // A driver only finishes after several consecutive frames close to the
    // live physics result, not just close to the hard-coded default.
    if (motion.settledFrames >= 4) stopReturn(id);
  }
}
function beginReturn(id, currentValue) {
  if (!model || !limits[id]) return;
  stopReturn(id);
  const limit = limits[id];
  const value = Number.isFinite(currentValue) ? currentValue : model.getParameter(id);
  const spring = createSpring(clamp(value, limit.minimum, limit.maximum),
    limit.defaultValue, limit.maximum - limit.minimum);
  const motion = { spring, dispose: null, settledFrames: 0, lastAt: null };
  model.clearParameter(id); // no manual override should mask physics now
  motion.dispose = model.addParameterDriver(id, {
    phase: 'after-motion',
    getValue: () => {
      // Called by live2d-web AFTER Cubism's physics. Read the unconstrained
      // real output, then blend visually toward it without disabling physics.
      const calculated = PHYSICS_OUTPUT_IDS.has(id) ? model.getParameter(id) : limit.defaultValue;
      spring.target = Number.isFinite(calculated)
        ? clamp(calculated, limit.minimum, limit.maximum)
        : limit.defaultValue;
      const now = performance.now();
      const dt = motion.lastAt === null ? 1 / 60 : clamp((now - motion.lastAt) / 1000, 1 / 120, 1 / 30);
      motion.lastAt = now;
      const finished = advanceSpring(spring, dt);
      motion.settledFrames = finished ? motion.settledFrames + 1 : 0;
      return clamp(spring.value, limit.minimum, limit.maximum);
    },
  });
  returning.set(id, motion);
}
function releaseDragParameters(dragged = null, current = null, immediate = false) {
  if (!model) return;
  const ids = dragged ? DRAG_PARAMETERS[dragged].map((p) => p.id) : DRAG_IDS;
  for (const id of ids) {
    const position = current?.[id] ?? model.getParameter(id);
    if (immediate) {
      stopReturn(id);
      const range = limits[id];
      if (range) model.setParameter(id, range.defaultValue);
      model.clearParameter(id);
    } else beginReturn(id, position);
  }
}

// Pure DOM overlay: no CDN, external animation images, or WebGL allocations.
const effects = $('effects');
function addEffectClass(name, x, y, options = {}) {
  const rect = host.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // Limit the number of DOM particles during rapid repeated taps.
  if (effects.childElementCount >= 48) effects.firstElementChild?.remove();
  const node = document.createElement('span');
  node.className = 'effect ' + name;
  node.style.left = `${clamp(x - rect.left, 0, rect.width)}px`;
  node.style.top = `${clamp(y - rect.top, 0, rect.height)}px`;
  for (const [key, value] of Object.entries(options)) node.style.setProperty(key, value);
  effects.appendChild(node);
  node.addEventListener('animationend', () => node.remove(), {once:true});
}
// Light feedback: hit=two warm rings and two tiny sparks; touch=one cool ring.
function spawnRipple(x, y, heavy = false, continuous = false) {
  const count = heavy ? 2 : 1;
  for (let i = 0; i < count; i++) {
    addEffectClass(heavy ? 'ripple-heavy' : 'ripple-light', x, y, {
      '--delay': `${i * 75}ms`,
      '--scale': String(heavy ? 3.4 + i * 1.25 : continuous ? 2.2 : 2.9),
    });
  }
  if (heavy) {
    for (let i = 0; i < 2; i++) {
      const angle = Math.random() * Math.PI * 2;
      addEffectClass('impact-spark', x, y, {
        '--vx': `${Math.cos(angle) * 26}px`,
        '--vy': `${Math.sin(angle) * 26}px`,
        '--delay': `${i * 35}ms`,
      });
    }
  }
}
// Larger hearts float upward slowly; keep the count low so strokes feel gentle.
function spawnHearts(x, y, count = 2) {
  for (let i = 0; i < count; i++) {
    addEffectClass('stroke-heart', x + (Math.random() - .5) * 38, y, {
      '--vx': `${(Math.random() - .5) * 68}px`,
      '--vy': `${-48 - Math.random() * 42}px`,
      '--delay': `${Math.random() * 140}ms`,
      '--size': `${25 + Math.random() * 13}px`,
      '--duration': `${1800 + Math.random() * 600}ms`,
    });
  }
}
// Time must be earned by active head movement, not by holding still.
// Capping the sample gap avoids granting 30 seconds after a stalled tab
// resumes or after one isolated mouse movement.
function registerPettingMove(event) {
  if (!active || active.dragArea !== 'touch' || !active.moved || !canStrokeHead(state)) return;
  const now = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
  const delta = Math.hypot(event.clientX - active.petLastX, event.clientY - active.petLastY);
  const elapsed = Math.max(0, now - active.petLastAt);
  active.petLastAt = now;
  active.petLastX = event.clientX;
  active.petLastY = event.clientY;
  if (delta < 1.25 || state.endingReached || state.endingDisqualified) return;
  const earned = Math.min(200, elapsed) / 1000;
  const before = state.petSeconds;
  const completed = addPettingTime(state, earned);
  if (completed) {
    // Remove the temporary pet-face drivers BEFORE creating the permanent
    // ending drivers. They both target eyeopen/smile; reverse ordering can
    // dispose the new ending pose through the SDK's per-ID registrations.
    finishHappyEnding();
    applyGameParameters(); // shy reaches and stays at 1
  } else if (state.petSeconds !== before) {
    // Move shy smoothly from 0 -> 1 over the 30 seconds of real strokes.
    applyGameParameters();
    if (now - active.petLastSaveAt >= 650) {
      active.petLastSaveAt = now;
      save();
    }
  }
}
function onMove(event) {
  if (!active || event.pointerId !== active.id) return;
  if (active.dragArea === 'touch' && !canStrokeHead(state)) return;
  const dx = event.clientX - active.x;
  const dy = event.clientY - active.y;
  if (Math.hypot(dx, dy) > MOVE_THRESHOLD && !active.moved) {
    active.moved = true;
    if (active.dragArea && active.dragArea !== 'touch') {
      // Even a drag that never crosses skirtopen=0 forfeits the ending.
      disqualifyHappyEnding(state);
      save();
    }
    if (active.dragArea === 'breasttouch') progress('breasttouch');
    if (active.dragArea === 'touch') {
      beginPetMotion();
      spawnHearts(event.clientX, event.clientY, 3);
    }
  }
  if (!active.moved || !active.dragArea) return;
  registerPettingMove(event);
  if (Math.hypot(event.clientX - active.fxX, event.clientY - active.fxY) >= 26 &&
      (event.timeStamp || performance.now()) - active.fxTime >= 170) {
    if (active.dragArea === 'touch') spawnHearts(event.clientX, event.clientY, 2);
    else spawnRipple(event.clientX, event.clientY, false, true);
    active.fxX = event.clientX; active.fxY = event.clientY;
    active.fxTime = event.timeStamp || performance.now();
  }
  for (const { id, axis, sign } of DRAG_PARAMETERS[active.dragArea]) {
    const range = limits[id];
    if (!range) continue;
    const displacement = ((axis === 'x' ? dx : dy) * sign / SENSITIVITY_PIXELS) * (range.maximum - range.minimum);
    const value = clamp(active.initial[id] + displacement, range.minimum, range.maximum);
    setBounded(id, value);
    active.current[id] = value;
    if (id === 'skirtopen') {
      const positive = value > 0;
      // Edge-trigger: a single crossing at 0 (not every mousemove/frame).
      if (isRisingPositive(active.skirtWasPositive ? 1 : 0, value)) progress('skirtopen');
      active.skirtWasPositive = positive;
    }
  }
  // During drag, parameter updates stay inside the model—no in-game dashboard.
}
async function playClickMotion(area) {
  if (state.endingReached) return;
  clearPetFaceDrivers(); // Free eye/smile for the new hit motion.
  // Count once for each accepted click/animation trigger, not per animation frame.
  // A failed local asset load is reported to the user, rather than hidden.
  const playing = model.playMotion(area, 0, { priority: 'force', fadeInMs: 100, fadeOutMs: 200 });
  // Audio is started in the same user gesture as the requested hit motion.
  // Skirt / breast drag and touch do not play these five impact sounds.
  hitSounds.play(area);
  progress(area);
  try {
    const result = await playing;
    if (result?.status === 'skipped') console.warn('모션이 시작되지 않았습니다:', area);
  } catch (error) {
    console.error('모션 재생 실패:', area, error);
    notice(`${area} 모션 오류: ${error?.message || String(error)}`, true);
  }
}
function onEnd(event, cancelled = false) {
  if (!active || event.pointerId !== active.id) return;
  if (!cancelled) onMove(event);
  const { clickArea, dragArea, moved, current } = active;
  active = null;
  if (dragArea && moved) {
    releaseDragParameters(dragArea, current); // spring-fed physics return
    if (dragArea === 'touch') {
      endPetMotion();
      save(); // preserve cumulative petting seconds
    }
  }
  if (!cancelled && dragArea === 'touch' && moved && !state.endingReached && canStrokeHead(state)) reactionVoices.queuePet();
  if (!cancelled && !moved && clickArea && !state.endingReached) {
    spawnRipple(event.clientX, event.clientY, true);
    void playClickMotion(clickArea);
  } else if (dragArea && moved) {
    notice(`${dragArea} 드래그 종료 · 감쇠 스프링/물리 연산으로 자연 복귀 · LV ${state.lv}`);
  }
  if (host.hasPointerCapture?.(event.pointerId)) {
    try { host.releasePointerCapture(event.pointerId); } catch { /* released already */ }
  }
}
function registerPointerEvents() {
  host.addEventListener('pointerdown', (event) => {
    if (active || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const hits = model.hitTest(event.clientX, event.clientY);
    // One non-head interaction permanently disables head strokes AND the
    // 30-second ending. After a successful ending, only head strokes remain.
    const clickArea = state.endingReached ? null :
      CLICK_PRIORITY.find((name) => hits.includes(name)) || null;
    const dragArea = state.endingReached ?
      (hits.includes('touch') ? 'touch' : null) :
      DRAG_PRIORITY.find((name) => hits.includes(name) &&
        (name !== 'touch' || canStrokeHead(state))) || null;
    if (!clickArea && !dragArea) {
      notice(!canStrokeHead(state) && hits.includes('touch')
        ? '다른 상호작용 이후에는 머리 쓰다듬기가 잠깁니다'
        : state.endingReached ? '엔딩 이후 머리 쓰다듬기만 가능합니다' : '등록된 Hit Area 밖입니다');
      return;
    }
    // Any first contact with another interactive region prevents the secret
    // ending, even if the user releases before a drag threshold/LV increase.
    // Pure head strokes remain valid (head touch can overlap generic meshes).
    if (!state.endingReached && (dragArea === 'breasttouch' || dragArea === 'skirtopen' || (clickArea && dragArea !== 'touch'))) {
      if (disqualifyHappyEnding(state)) save();
    }
    reactionVoices.unlock(); // must be called synchronously in the user's gesture on mobile
    const initial = Object.fromEntries(DRAG_IDS.map((id) => {
      const settling = returning.get(id);
      return [id, settling ? settling.spring.value : model.getParameter(id)];
    }));
    if (dragArea) for (const {id} of DRAG_PARAMETERS[dragArea]) stopReturn(id);
    active = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      clickArea, dragArea, moved: false, initial,
      skirtWasPositive: initial.skirtopen > 0,
      current: { ...initial }, fxX: event.clientX, fxY: event.clientY,
      fxTime: event.timeStamp || performance.now(),
      petLastAt: Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now(),
      petLastX: event.clientX, petLastY: event.clientY,
      petLastSaveAt: Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now(),
    };
    host.setPointerCapture(event.pointerId);
    // Hit sparkle is shown only when the tap is confirmed (pointerup).
    if (dragArea) spawnRipple(event.clientX, event.clientY);
    notice(`${clickArea || dragArea} 선택`);
  });
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', (event) => onEnd(event));
  host.addEventListener('pointercancel', (event) => onEnd(event, true));
  host.addEventListener('lostpointercapture', (event) => {
    if (active?.id === event.pointerId) {
      const previous = active; active = null;
      if (previous.dragArea && previous.moved) releaseDragParameters(previous.dragArea, previous.current);
      if (previous.dragArea === 'touch') { endPetMotion(); save(); }
    }
  });
  window.addEventListener('blur', () => {
    if (active) {
      const previous = active; active = null;
      if (previous.dragArea && previous.moved) releaseDragParameters(previous.dragArea, previous.current);
      if (previous.dragArea === 'touch') { endPetMotion(); save(); }
    }
  });
}
async function start() {
  try {
    reactionVoices.preload(); // local WAV files, no external CDN
    await assertLocalCore();
    model = await createLive2D({
      container: host, src: MODEL_URL, coreUrl: CORE_URL, fit: modelFit(),
      followPointer: false, idleMotion: false,
    });
    const info = model.getModelInfo();
    const missingAreas = [...CLICK_PRIORITY, ...DRAG_PRIORITY].filter((name) => !info.hitAreas.includes(name));
    if (missingAreas.length) throw new Error('등록되지 않은 Hit Area: ' + missingAreas.join(', '));
    const missingMotions = [...CLICK_PRIORITY, 'touch'].filter((name) => (info.motions[name] || 0) < 1);
    if (missingMotions.length) throw new Error('등록되지 않은 모션: ' + missingMotions.join(', '));
    const meta = new Map((info.parameters || []).map((p) => [p.id, p]));
    tearParameterId = meta.has('tear') ? 'tear' : 'tears';
    const missingParams = ALL_GAME_IDS.filter((id) => {
      const range = meta.get(id === 'tears' ? tearParameterId : id);
      // ojum exists only in the user's newer model. Keep older bundled models usable.
      if (id === 'ojum' && !range) return false;
      return !range || ![range.minimum, range.maximum, range.defaultValue].every(Number.isFinite) || range.maximum <= range.minimum;
    });
    if (missingParams.length) throw new Error('모델에 파라미터가 없습니다: ' + missingParams.join(', '));
    limits = Object.fromEntries(ALL_GAME_IDS.filter((id) => meta.has(id === 'tears' ? tearParameterId : id))
      .map((id) => [id, meta.get(id === 'tears' ? tearParameterId : id)]));
    if (!limits.ojum) console.warn('현재 번들 모델에는 ojum 파라미터가 없을 수 있습니다. 최신 모델의 .moc3를 넣어 주세요.');
    limits[tearParameterId] = meta.get(tearParameterId);
    releaseDragParameters(null, null, true);
    applyGameParameters(); // restore all persistent state, including LV eye pins
    console.info(`[에르핀] 실행 코드 ${GAME_CODE_VERSION}. LV 눈 파라미터 확인: __erpinCheckLv()`);
    registerPointerEvents();
    if (state.endingReached) showHappyEnding(); // restore veil, never replay the ending voice
    save();
    requestAnimationFrame(advanceFrame);
    splash.hidden = true;
    statusEl.hidden = true;
    started = true;
  } catch (error) {
    console.error('[에르핀 LV Live2D]', error);
    notice('실행 실패: ' + (error?.message || String(error)), true);
    startButton.disabled = false;
    startButton.textContent = '다시 시작';
  }
}
// Optional console diagnostics. This does not add any on-screen UI.
// In F12 console run: __erpinDebug()
window.__erpinDebug = () => ({
  lv: state.lv,
  endingDisqualified: state.endingDisqualified,
  endingReached: state.endingReached,
  petSeconds: state.petSeconds,
  shy: model?.getParameter('shy'),
  headStrokingAllowed: canStrokeHead(state),
  eyelight: model?.getParameter('eyelight'),
  pupil: model?.getParameter('pupil'),
  eyeopen: model?.getParameter('eyeopen'),
  expectedEyeopen: stagedParameterValues(state).eyeopen ?? limits.eyeopen?.defaultValue ?? null,
  returningParameters: [...returning.keys()],
  activeDrag: active?.dragArea ?? null,
  petFaceMode,
});
startButton.addEventListener('click', () => {
  if (started || startButton.disabled) return;
  reactionVoices.unlock();
  startButton.disabled = true;
  startButton.textContent = '시작하는 중…';
  statusEl.hidden = true;
  void start();
});
window.addEventListener('resize', () => {
  if (model) model.setFit(modelFit());
});

// No on-screen UI. F12 console: __erpinCheckLv()
// If actual===expected but appearance is unchanged, inspect the *new* moc3
// keyforms / drawable bindings rather than changing LV thresholds again.
window.__erpinCheckLv = () => {
  const stages = stagedParameterValues(state);
  const report = ['eyelight', 'pupil'].map(id => {
    const r = limits[id];
    const actual = model && r ? model.getParameter(id) : null;
    const expected = stages[id] ?? (r ? r.defaultValue : null);
    return {
      codeVersion: GAME_CODE_VERSION,
      parameter: id,
      lv: state.lv,
      expected,
      actual,
      registered: Boolean(r),
      minimum: r?.minimum ?? null,
      maximum: r?.maximum ?? null,
      defaultValue: r?.defaultValue ?? null,
      persistentOverride: directLvPins.has(id),
      matches: actual !== null && expected !== null ? Math.abs(actual - expected) < 0.001 : false,
    };
  });
  console.table(report);
  return report;
};

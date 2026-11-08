// Pure, independently testable game progression rules.
// Frame updates must never call increaseLevel(): a positive skirtopen is
// counted only on the non-positive -> positive edge of an active drag.
export const MOTION_AREAS = Object.freeze([
  'cheekhit', 'facehit', 'breasthitleft', 'breasthitright', 'bellyhit',
]);

export const TEAR_PARAMETER_CANDIDATES = Object.freeze(['tear', 'tears']);
export const PET_ENDING_SECONDS = 30;

export const PERSISTENT_PARAMETER_IDS = Object.freeze([
  'blood', 'cheekcolor', 'breastcolorleft', 'breastcolorright',
  'shy', 'eyelight', 'mouth1', 'mouth2', 'mouth3', 'mouth4', 'brow', 'pupil', 'sad', 'tears', 'dust', 'ojum',
]);

const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function newGameState(saved = {}) {
  const state = {
    clicks: safeCount(saved.clicks),
    lv: safeCount(saved.lv),
    skirtEvents: safeCount(saved.skirtEvents),
    breastTouchEvents: safeCount(saved.breastTouchEvents),
    cheekHits: safeCount(saved.cheekHits),
    breastLeftHits: safeCount(saved.breastLeftHits),
    breastRightHits: safeCount(saved.breastRightHits),
    faceHitOnce: saved.faceHitOnce === true,
    bellyHitCount: safeCount(saved.bellyHitCount) || (saved.bellyHitOnce === true ? 1 : 0),
    touchLocked: saved.touchLocked === true,
    petSeconds: Math.min(PET_ENDING_SECONDS,
      Number.isFinite(saved.petSeconds) ? Math.max(0, saved.petSeconds) : 0),
    // One non-head interaction locks all future head strokes.
    endingDisqualified: saved.endingDisqualified === true,
    endingReached: saved.endingReached === true,
  };
  if (state.lv > 0) state.touchLocked = true;
  // Older saves may predate endingDisqualified; any prior valid action voids it.
  if (state.touchLocked || state.lv > 0 || state.clicks > 0 ||
      state.skirtEvents > 0 || state.breastTouchEvents > 0 ||
      state.cheekHits > 0 || state.breastLeftHits > 0 || state.breastRightHits > 0 ||
      state.faceHitOnce || state.bellyHitCount > 0) state.endingDisqualified = true;
  if (state.endingDisqualified) {
    state.endingReached = false;
    state.touchLocked = true;
  }
  if (state.endingReached) state.petSeconds = PET_ENDING_SECONDS;
  return state;
}

export function increaseLevel(state, source) {
  if (source !== 'skirtopen' && source !== 'breasttouch' && !MOTION_AREAS.includes(source)) {
    throw new TypeError('알 수 없는 LV 이벤트: ' + source);
  }
  state.lv++;
  state.touchLocked = true;
  state.endingDisqualified = true;
  if (source === 'skirtopen') state.skirtEvents++;
  else if (source === 'breasttouch') state.breastTouchEvents++;
  else {
    state.clicks++;
    if (source === 'facehit') state.faceHitOnce = true;
    if (source === 'cheekhit') state.cheekHits++;
    if (source === 'bellyhit') state.bellyHitCount++;
    if (source === 'breasthitleft') state.breastLeftHits++;
    if (source === 'breasthitright') state.breastRightHits++;
  }
  return state;
}

// Even a skirt/breast drag that does not increase LV permanently blocks ending.
export function disqualifyHappyEnding(state) {
  if (state.endingReached) return false;
  const changed = !state.endingDisqualified;
  state.endingDisqualified = true;
  state.touchLocked = true;
  return changed;
}

// Once another interaction occurred, head strokes are blocked forever.
// Petting remains available after a successful ending.
export function canStrokeHead(state) {
  return state.endingReached || !state.endingDisqualified;
}

// The controller passes only seconds actually spent moving over the head.
export function addPettingTime(state, seconds) {
  if (state.endingDisqualified || state.endingReached ||
      !Number.isFinite(seconds) || seconds <= 0) return false;
  state.petSeconds = Math.min(PET_ENDING_SECONDS, state.petSeconds + seconds);
  if (state.petSeconds < PET_ENDING_SECONDS - 1e-6) return false;
  state.petSeconds = PET_ENDING_SECONDS;
  state.endingReached = true;
  return true;
}

export function isRisingPositive(previous, current) {
  return previous <= 0 && current > 0;
}

export function levelStage(lv) {
  return lv >= 30 ? 30 : lv >= 20 ? 20 : lv >= 10 ? 10 : lv >= 1 ? 1 : 0;
}

// Values are cumulative unless the later threshold explicitly overrides one.
export function stagedParameterValues(state) {
  const values = {};
  // Independent hidden progression: active petting accumulates toward shy=1.
  // Preserve progress if the player later voids the ending.
  if (state.petSeconds > 0 || state.endingReached) {
    values.shy = state.endingReached ? 1 : Number((state.petSeconds / PET_ENDING_SECONDS).toFixed(6));
  }
  if (state.lv >= 1) Object.assign(values, {
    mouth1: 0, mouth2: 1, brow: 1,
  });
  if (state.lv >= 10) Object.assign(values, {
    mouth2: 0, mouth3: 1, brow: 0, tears: 1,
  });
  // Eye-open resting value: LV10 = 1.00, LV11 = 0.95, ...
  // LV20+ = 0.50.  Below LV10, the model controls eyeopen normally.
  // Head petting and the happy ending are exclusive of LV events, so their
  // eyeopen=0 pose remains untouched by this stage-based resting driver.
  if (state.lv >= 10) {
    values.eyeopen = Number((1 - (Math.min(state.lv, 20) - 10) * 0.05).toFixed(3));
  }
  if (state.lv >= 20) Object.assign(values, {
    mouth2: 0, mouth3: 1, brow: -1,
  });
  if (state.lv >= 30) Object.assign(values, {
    // At LV 30 sad starts at 0.1, then grows by 0.1 every new LV.
    // Runtime clamps against the model's actual parameter maximum.
    sad: Number(((state.lv - 29) * 0.1).toFixed(5)), mouth3: 0, mouth4: 1,
  });
  // Independent permanent LV thresholds; later facial-expression stages
  // must never switch these two parameters off.
  if (state.lv >= 1) values.eyelight = 0;
  if (state.lv >= 20) values.pupil = 0;
  if (state.faceHitOnce) values.blood = 1;
  if (state.bellyHitCount >= 1) values.dust = 1;
  if (state.bellyHitCount >= 5) values.ojum = 1;
  return values;
}

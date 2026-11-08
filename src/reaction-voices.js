// Reaction voices are exclusive and DROP new speech while another line is
// playing or waiting for its 500 ms delay. Impact SFX are entirely separate.
// The happy-ending voice preempts all speech and permanently locks the channel.
export const REACTION_VOICE_DELAY_MS = 500;
export const REACTION_VOICE_VOLUME = 0.5;
export const PET_VOICE_FILE = 'voices/Voice_Erpin_Touch2_Skin3.wav';
export const JOY_VOICE_FILE = 'voices/Voice_Erpin_Joy3.wav';
export const VOICE_FILES = Object.freeze({
  hit: Object.freeze([1, 2, 3, 4, 5].map(i => `voices/Voice_Erpin_Hit${i}.wav`)),
  sorrow: Object.freeze([2, 3, 4, 5].map(i => `voices/Voice_Erpin_Sorrow${i}.wav`)),
});

export function voiceGroupForLevel(level) {
  return level >= 20 ? 'sorrow' : 'hit';
}
export function randomVoiceForLevel(level, random = Math.random) {
  const files = VOICE_FILES[voiceGroupForLevel(level)];
  const n = Number(random());
  return files[Math.min(files.length - 1,
    Math.max(0, Math.floor((Number.isFinite(n) ? n : 0) * files.length)))];
}

export function createReactionVoicePlayer(resolveUrl, options = {}) {
  const AudioCtor = options.AudioCtor ?? globalThis.Audio ?? null;
  const AudioContextCtor = options.AudioContextCtor ?? globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
  const fetchFn = options.fetchFn ?? globalThis.fetch?.bind(globalThis);
  const setTimer = options.setTimeoutFn ?? globalThis.setTimeout?.bind(globalThis);
  const clearTimer = options.clearTimeoutFn ?? globalThis.clearTimeout?.bind(globalThis);
  const random = options.random ?? Math.random;
  const paths = [...VOICE_FILES.hit, ...VOICE_FILES.sorrow, PET_VOICE_FILE, JOY_VOICE_FILE];
  const bytes = new Map();
  const decoded = new Map();
  let context = null;
  let active = null; // Reserves the speech channel from scheduling through ended.
  let endingLocked = false;

  function preload() {
    if (typeof fetchFn !== 'function') return;
    for (const path of paths) {
      if (bytes.has(path)) continue;
      const promise = Promise.resolve().then(() => fetchFn(resolveUrl(path)))
        .then(response => {
          if (!response.ok) throw Error(`음성 파일 요청 실패: ${path} (${response.status})`);
          return response.arrayBuffer();
        });
      bytes.set(path, promise);
      promise.catch(error => console.warn('음성 파일 미리 읽기 실패:', path, error));
    }
  }

  // Call synchronously from a pointer/touch gesture on mobile.
  function unlock() {
    if (typeof AudioContextCtor !== 'function') return;
    try {
      if (!context) context = new AudioContextCtor();
      if (context.state !== 'running' && typeof context.resume === 'function') {
        context.resume()?.catch?.(error => console.warn('음성 재생 활성화 실패:', error));
      }
    } catch (error) {
      context = null;
      console.warn('Web Audio를 사용할 수 없어 HTML Audio로 전환합니다:', error);
    }
  }

  function decode(path) {
    if (!decoded.has(path)) {
      if (!bytes.has(path)) preload();
      const data = bytes.get(path);
      if (!data || !context) return Promise.reject(Error('음성 디코딩 불가'));
      decoded.set(path, data.then(buffer => context.decodeAudioData(buffer.slice(0))));
    }
    return decoded.get(path);
  }

  function complete(item) {
    if (active !== item) return; // A cancelled async decode must not release a new voice.
    try { item.source?.disconnect?.(); item.gain?.disconnect?.(); } catch {}
    active = null;
    // No pump and no backlog: ignored voices are intentionally lost.
  }

  function playHtml(item) {
    if (active !== item) return;
    if (typeof AudioCtor !== 'function') { complete(item); return; }
    try {
      const audio = new AudioCtor(resolveUrl(item.path));
      item.audio = audio;
      audio.volume = REACTION_VOICE_VOLUME;
      audio.preload = 'auto';
      const done = () => complete(item);
      audio.addEventListener?.('ended', done, { once: true });
      audio.addEventListener?.('error', done, { once: true });
      const result = audio.play();
      result?.catch?.(error => {
        console.warn('음성 재생이 거부되었습니다:', item.path, error);
        complete(item);
      });
    } catch (error) {
      console.warn('음성 재생 실패:', item.path, error);
      complete(item);
    }
  }

  async function playCurrent(item) {
    if (active !== item) return;
    if (!context || typeof fetchFn !== 'function') { playHtml(item); return; }
    try {
      const buffer = await decode(item.path);
      if (active !== item) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = REACTION_VOICE_VOLUME;
      source.connect(gain);
      gain.connect(context.destination);
      item.source = source;
      item.gain = gain;
      source.onended = () => complete(item);
      source.start(0);
    } catch (error) {
      if (active !== item) return;
      console.warn('Web Audio 음성 오류, HTML Audio로 재시도:', item.path, error);
      playHtml(item);
    }
  }

  function reserve(path, delayMs) {
    // Reserve immediately, not 500 ms later. This prevents multiple clicks
    // in the delay window from building a chain of stale dialogue.
    if (endingLocked || active) return null;
    const item = { path, timer: null, source: null, gain: null, audio: null };
    active = item;
    if (delayMs > 0) {
      if (typeof setTimer !== 'function') { active = null; return null; }
      item.timer = setTimer(() => {
        item.timer = null;
        if (active === item) void playCurrent(item);
      }, delayMs);
    } else {
      void playCurrent(item);
    }
    return path;
  }

  function queue(level) {
    if (endingLocked || active) return null;
    return reserve(randomVoiceForLevel(level, random), REACTION_VOICE_DELAY_MS);
  }

  function queuePet() {
    return reserve(PET_VOICE_FILE, 0);
  }

  function stopAll() {
    const previous = active;
    active = null;
    if (!previous) return;
    if (previous.timer !== null) clearTimer?.(previous.timer);
    try {
      if (previous.source) {
        previous.source.onended = null;
        previous.source.stop(0);
        previous.source.disconnect();
      }
    } catch {}
    try { previous.gain?.disconnect?.(); } catch {}
    try {
      previous.audio?.pause?.();
      if (previous.audio) previous.audio.currentTime = 0;
    } catch {}
  }

  // Called when reloading an already-finished game: preserve silent ending.
  function lockEnding() {
    stopAll();
    endingLocked = true;
  }

  // The happy ending always wins, even over an already-playing spoken line.
  // Nothing else can ever be spoken after it, including after Joy finishes.
  function queueJoy() {
    if (endingLocked) return null;
    stopAll();
    const result = reserve(JOY_VOICE_FILE, 0);
    endingLocked = true;
    return result;
  }

  return { preload, unlock, queue, queuePet, queueJoy, stopAll, lockEnding };
}

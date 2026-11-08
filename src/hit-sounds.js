// The user's five uploaded impact sounds, bundled as local Vite public assets.
// No external CDN or audio network service is used.
export const HIT_SOUND_FILES = Object.freeze({
  cheekhit: 'sfx/cheekhit.wav',
  facehit: 'sfx/facehit.wav',
  breasthitleft: 'sfx/breasthitleft.wav',
  breasthitright: 'sfx/breasthitright.wav',
  bellyhit: 'sfx/bellyhit.wav',
});

export const HIT_SOUND_VOLUME = 0.5;
const POOL_SIZE = 4;

/** Make short overlapping one-shot sounds while keeping volume at 50%.
 * AudioCtor is injected for tests; in the browser use the built-in HTMLAudioElement.
 */
export function createHitSoundPlayer(resolveUrl, AudioCtor = null) {
  if (typeof AudioCtor !== 'function') {
    return { play: () => false };
  }
  const banks = new Map();
  for (const [area, path] of Object.entries(HIT_SOUND_FILES)) {
    const url = resolveUrl(path);
    const clips = Array.from({ length: POOL_SIZE }, () => {
      const audio = new AudioCtor(url);
      audio.preload = 'auto';
      audio.volume = HIT_SOUND_VOLUME;
      return audio;
    });
    banks.set(area, { clips, next: 0 });
  }

  return {
    play(area) {
      const bank = banks.get(area);
      if (!bank) return false;
      const clip = bank.clips[bank.next];
      bank.next = (bank.next + 1) % bank.clips.length;
      try {
        // Starting directly inside the trusted click handler unlocks playback
        // on desktop and mobile; resetting allows rapid repeated taps.
        clip.pause();
        clip.currentTime = 0;
        clip.volume = HIT_SOUND_VOLUME;
        const playing = clip.play();
        if (playing && typeof playing.catch === 'function') {
          playing.catch((error) => console.warn('타격 효과음 재생 실패:', area, error));
        }
      } catch (error) {
        console.warn('타격 효과음 처리 실패:', area, error);
        return false;
      }
      return true;
    },
  };
}

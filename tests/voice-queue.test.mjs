import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReactionVoicePlayer, PET_VOICE_FILE, JOY_VOICE_FILE,
  REACTION_VOICE_DELAY_MS, REACTION_VOICE_VOLUME,
} from '../src/reaction-voices.js';

function clock() {
  let ms = 0, nextId = 0;
  const tasks = new Map();
  return {
    now: () => ms,
    setTimeoutFn: (fn, delay) => {
      const id = ++nextId;
      tasks.set(id, {at: ms + delay, fn});
      return id;
    },
    clearTimeoutFn: id => tasks.delete(id),
    tick: delta => {
      const target = ms + delta;
      for (;;) {
        const next = [...tasks.entries()].filter(([, x]) => x.at <= target)
          .sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
        if (!next) break;
        ms = next[1].at;
        tasks.delete(next[0]);
        next[1].fn();
      }
      ms = target;
    },
  };
}

class MockAudio {
  static instances = [];
  static playing = 0;
  static maxPlaying = 0;
  constructor(src) {
    this.src = src;
    this.listeners = new Map();
    this.isPlaying = false;
    MockAudio.instances.push(this);
  }
  addEventListener(event, fn) { this.listeners.set(event, fn); }
  play() {
    this.isPlaying = true;
    MockAudio.playing++;
    MockAudio.maxPlaying = Math.max(MockAudio.maxPlaying, MockAudio.playing);
    return Promise.resolve();
  }
  end() {
    if (this.isPlaying) { this.isPlaying = false; MockAudio.playing--; }
    this.listeners.get('ended')?.();
  }
  pause() {
    if (this.isPlaying) { this.isPlaying = false; MockAudio.playing--; }
  }
}
const resetAudio = () => {
  MockAudio.instances=[];MockAudio.playing=0;MockAudio.maxPlaying=0;
};
const player = t => createReactionVoicePlayer(path=>path,{
  AudioCtor:MockAudio,AudioContextCtor:null,fetchFn:null,...t,random:()=>0,
});

test('500ms wait reserves voice slot: clicks during wait and playing are discarded',()=>{
  resetAudio();
  const t=clock(),p=player(t);
  assert.equal(REACTION_VOICE_DELAY_MS,500);
  assert.match(p.queue(1),/Hit1/);
  assert.equal(p.queue(20),null);
  assert.equal(p.queuePet(),null);
  t.tick(499);
  assert.equal(MockAudio.instances.length,0);
  t.tick(1);
  assert.equal(MockAudio.instances.length,1);
  assert.match(MockAudio.instances[0].src,/Hit1/);
  assert.equal(MockAudio.instances[0].volume,REACTION_VOICE_VOLUME);
  assert.equal(p.queue(20),null);
  assert.equal(p.queuePet(),null);
  MockAudio.instances[0].end();
  t.tick(2000);
  assert.equal(MockAudio.instances.length,1,'ignored lines must never replay later');
  assert.match(p.queue(20),/Sorrow2/);
  t.tick(500);
  assert.equal(MockAudio.instances.length,2);
  assert.match(MockAudio.instances[1].src,/Sorrow2/);
  assert.equal(MockAudio.maxPlaying,1);
});

test('head stroke line is dropped if another dialogue is playing',()=>{
  resetAudio();
  const t=clock(),p=player(t);
  assert.equal(p.queuePet(),PET_VOICE_FILE);
  assert.equal(MockAudio.instances.length,1);
  assert.equal(p.queue(1),null);
  assert.equal(p.queuePet(),null);
  MockAudio.instances[0].end();
  t.tick(1000);
  assert.equal(MockAudio.instances.length,1);
  assert.equal(p.queuePet(),PET_VOICE_FILE);
  assert.equal(MockAudio.instances.length,2);
});

test('stopAll cancels a waiting voice so no stale line starts',()=>{
  resetAudio();
  const t=clock(),p=player(t);
  p.queue(1);p.stopAll();
  t.tick(600);
  assert.equal(MockAudio.instances.length,0);
  assert.equal(p.queuePet(),PET_VOICE_FILE);
  assert.equal(MockAudio.instances.length,1);
});

test('ending interrupts an active voice, clears delay, and permanently silences all others',()=>{
  resetAudio();
  const t=clock(),p=player(t);
  p.queuePet();
  assert.equal(MockAudio.playing,1);
  assert.equal(p.queueJoy(),JOY_VOICE_FILE);
  assert.equal(MockAudio.instances.length,2);
  assert.equal(MockAudio.playing,1);
  assert.equal(MockAudio.maxPlaying,1);
  assert.equal(MockAudio.instances[1].src,JOY_VOICE_FILE);
  assert.equal(MockAudio.instances[1].volume,.5);
  assert.equal(p.queueJoy(),null,'ending must not replay twice');
  assert.equal(p.queuePet(),null);
  assert.equal(p.queue(20),null);
  MockAudio.instances[1].end();
  assert.equal(p.queuePet(),null,'ending stays locked after joy finishes');
  assert.equal(p.queue(1),null);
});

test('ending cancels reserved 500ms hit voice and plays only Joy',()=>{
  resetAudio();
  const t=clock(),p=player(t);
  p.queue(1);
  t.tick(150);
  p.queueJoy();
  t.tick(1000);
  assert.equal(MockAudio.instances.length,1);
  assert.equal(MockAudio.instances[0].src,JOY_VOICE_FILE);
});

test('restored ending can be permanently silent without replaying Joy',()=>{
  resetAudio();
  const t=clock(),p=player(t);
  p.queue(1);
  p.lockEnding();
  t.tick(2000);
  assert.equal(MockAudio.instances.length,0);
  assert.equal(p.queueJoy(),null);
  assert.equal(p.queuePet(),null);
  assert.equal(p.queue(20),null);
});

test('WebAudio: decoding is exclusive, and cancelled decoding never starts',async()=>{
  const t=clock(),started=[];
  let releaseDecode;
  class Context {
    state='running';destination={};
    decodeAudioData(){return new Promise(resolve=>{releaseDecode=()=>resolve({duration:0.7});});}
    createGain(){return {gain:{value:0},connect(){},disconnect(){}};}
    createBufferSource(){return {
      connect(){},disconnect(){},stop(){},start(){started.push(this);},onended:null,
    };}
  }
  const p=createReactionVoicePlayer(path=>path,{
    AudioCtor:MockAudio,AudioContextCtor:Context,
    fetchFn:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)}),...t,random:()=>0,
  });
  p.preload();p.unlock();
  p.queue(1);p.queue(20);
  t.tick(500);
  for(let i=0;i<50;i++) await Promise.resolve();
  assert.equal(started.length,0);
  assert.equal(p.queuePet(),null);
  p.queueJoy();
  for(let i=0;i<50;i++) await Promise.resolve();
  // Both decodes can share the mock resolver; cancellation must protect old one.
  releaseDecode?.();
  for(let i=0;i<50;i++) await Promise.resolve();
  assert.ok(started.length<=1);
  assert.equal(p.queue(1),null);
  p.stopAll();
});

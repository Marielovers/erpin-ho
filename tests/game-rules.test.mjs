import test from 'node:test';
import assert from 'node:assert/strict';
import {newGameState,increaseLevel,stagedParameterValues,addPettingTime,disqualifyHappyEnding,canStrokeHead,PET_ENDING_SECONDS} from '../src/game-rules.js';

test('bellyhit once enables dust, fifth enables ojum',()=>{
  const s=newGameState();
  for(let i=1;i<=5;i++){
    increaseLevel(s,'bellyhit');
    const p=stagedParameterValues(s);
    assert.equal(s.bellyHitCount,i);
    assert.equal(p.dust,1);
    assert.equal('ojum' in p,i>=5);
    if(i===5) assert.equal(p.ojum,1);
  }
});
test('other motions and drags cannot increment belly count',()=>{
  const s=newGameState();
  for(const name of ['facehit','breasthitleft','breasthitright','cheekhit','skirtopen','breasttouch']) increaseLevel(s,name);
  assert.equal(s.bellyHitCount,0);
  assert.equal('dust' in stagedParameterValues(s),false);
});
test('legacy bellyHitOnce migrates to conservative first-hit count',()=>{
  const s=newGameState({lv:9,bellyHitOnce:true});
  assert.equal(s.bellyHitCount,1);
  assert.equal(stagedParameterValues(s).dust,1);
  assert.equal('ojum' in stagedParameterValues(s),false);
});
test('LV stages stay active and head touch locks',()=>{
  const s=newGameState();
  for(let i=0;i<30;i++) increaseLevel(s,'bellyhit');
  const p=stagedParameterValues(s);
  assert.equal(p.tears,1);assert.equal(p.pupil,1);assert.equal(p.sad,0.1);assert.equal(s.touchLocked,true);
});


test('eyelight stays at 1 for every LV >= 1, while pupil starts at LV 20',()=>{
  for (const lv of [0,1,2,9,10,19,20,21,29,30,31,50]) {
    const p=stagedParameterValues(newGameState({lv}));
    assert.equal(p.eyelight,lv >= 1 ? 1 : undefined,`eyelight at LV ${lv}`);
    assert.equal(p.pupil,lv >= 20 ? 1 : undefined,`pupil at LV ${lv}`);
  }
});

test('eyelight and pupil survive progression and saved LV restoration',()=>{
  const s = newGameState();
  for(let i=0;i<35;i++) {
    increaseLevel(s,'cheekhit');
    const values=stagedParameterValues(s);
    assert.equal(values.eyelight,1);
    assert.equal(values.pupil,s.lv >= 20 ? 1 : undefined);
  }
  const restored=newGameState(JSON.parse(JSON.stringify(s)));
  assert.equal(stagedParameterValues(restored).eyelight,1);
  assert.equal(stagedParameterValues(restored).pupil,1);
});

test('30 seconds of real accumulated petting grants ending, with no idle time awarded by rules',()=>{
  const s=newGameState();
  assert.equal(addPettingTime(s,12.3),false);
  assert.equal(addPettingTime(s,17.6),false);
  assert.equal(addPettingTime(s,0.1),true);
  assert.equal(s.petSeconds,PET_ENDING_SECONDS);
  assert.equal(addPettingTime(s,1),false);
  assert.equal(s.endingReached,true);
  const restored=newGameState(JSON.parse(JSON.stringify(s)));
  assert.equal(restored.endingReached,true);
});

test('any non-petting interaction invalidates ending even when no LV was awarded',()=>{
  const s=newGameState();
  addPettingTime(s,29.99);
  disqualifyHappyEnding(s);
  assert.equal(addPettingTime(s,100),false);
  assert.equal(s.endingReached,false);
  assert.equal(s.petSeconds,29.99);
  assert.equal(newGameState({lv:1,endingReached:true}).endingReached,false);
});

test('LV stage rules remain intact while petting ending eligibility is separate',()=>{
  const s=newGameState();
  increaseLevel(s,'breasttouch');
  assert.equal(s.lv,1);
  assert.equal(s.endingDisqualified,true);
  assert.equal(stagedParameterValues(s).eyelight,1);
  assert.equal(addPettingTime(s,35),false);
});


test('every non-head interaction locks head strokes permanently, including restored saves',()=>{
  for(const source of ['cheekhit','facehit','breasthitleft','breasthitright','bellyhit','breasttouch','skirtopen']){
    const s=newGameState();
    assert.equal(canStrokeHead(s),true);
    increaseLevel(s,source);
    assert.equal(canStrokeHead(s),false,source);
    assert.equal(newGameState(JSON.parse(JSON.stringify(s))).touchLocked,true);
    assert.equal(canStrokeHead(newGameState(JSON.parse(JSON.stringify(s)))),false);
  }
  const s=newGameState();disqualifyHappyEnding(s);
  assert.equal(canStrokeHead(s),false);
  assert.equal(s.touchLocked,true);
});

test('shy increases linearly only through valid 30-second petting time, ending fixes it at 1',()=>{
  const s=newGameState();
  assert.equal(stagedParameterValues(s).shy,undefined);
  addPettingTime(s,7.5);
  assert.equal(stagedParameterValues(s).shy,0.25);
  addPettingTime(s,7.5);
  assert.equal(stagedParameterValues(s).shy,0.5);
  assert.equal(addPettingTime(s,15),true);
  assert.equal(stagedParameterValues(s).shy,1);
  assert.equal(canStrokeHead(s),true);
  const restored=newGameState(JSON.parse(JSON.stringify(s)));
  assert.equal(stagedParameterValues(restored).shy,1);
  assert.equal(restored.endingReached,true);
});

test('partial shy freezes if any other interaction occurs',()=>{
  const s=newGameState();addPettingTime(s,6);
  assert.equal(stagedParameterValues(s).shy,0.2);
  disqualifyHappyEnding(s);
  assert.equal(addPettingTime(s,25),false);
  assert.equal(stagedParameterValues(s).shy,0.2);
});


test('LV10 to LV20 gradually lowers resting eyeopen from 1 to 0.5', () => {
  const expected = new Map([[0, undefined], [1, undefined], [9, undefined], [10, 1], [11, 0.95], [15, 0.75], [19, 0.55], [20, 0.5], [21, 0.5], [30, 0.5], [50, 0.5]]);
  for (const [lv, eyeopen] of expected) {
    const state = newGameState({ lv });
    assert.equal(stagedParameterValues(state).eyeopen, eyeopen, `eyeopen at LV ${lv}`);
    if (lv >= 1) assert.equal(stagedParameterValues(state).eyelight, 1);
    if (lv >= 20) assert.equal(stagedParameterValues(state).pupil, 1);
  }
});

test('head-petting happiness at LV0 keeps eyeopen out of LV resting overrides', () => {
  const state = newGameState({ petSeconds: 30, endingReached: true });
  assert.equal(state.lv, 0);
  assert.equal(state.endingReached, true);
  assert.equal(stagedParameterValues(state).eyeopen, undefined);
  assert.equal(stagedParameterValues(state).shy, 1);
});

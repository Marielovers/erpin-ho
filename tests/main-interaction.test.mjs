import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import * as rules from '../src/game-rules.js';
import * as springs from '../src/spring-return.js';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
function createMock({hasOjum=true}={}) {
  const nodes=new Map(),store=new Map(),overrides=new Map(),drivers=new Map(), sounds=[], motions=[];
  const computed = new Map(), rendered = new Map();
  const make=(id)=>{
    if (!nodes.has(id)) {
      const listeners = new Map();
      const elem={id,hidden:id==='happyEnding',disabled:false,textContent:'',style:{setProperty(){}},addEventListener:(e,fn)=>listeners.set(e,fn),fire:(e,data)=>listeners.get(e)?.(data),
        setPointerCapture(){},hasPointerCapture(){return false;},releasePointerCapture(){},
        getBoundingClientRect:()=>({left:0,top:0,width:800,height:800}),
        appendChild(){}, get childElementCount(){return 0;},
      };
      nodes.set(id,elem);
    }
    return nodes.get(id);
  };
  class FakeAudio {
    constructor(src){this.src=src;this.volume=1;this.currentTime=0;}
    play(){sounds.push({src:this.src,volume:this.volume}); return Promise.resolve();}
    pause(){}
  }
  const params=[...new Set([...rules.PERSISTENT_PARAMETER_IDS,'eyeopen','smile','headX','headY','skirtopen','boobX1','boobY1'])]
    .filter(id=>hasOjum||id!=='ojum').map(id=>({id,minimum:['headX','headY','brow','boobX1','boobY1'].includes(id)?-1:0,maximum:id==='sad'?2:1,defaultValue:id==='eyeopen'?1:id==='smile'?.6:0}));
  const model={
    getModelInfo:()=>({hitAreas:[...rules.MOTION_AREAS,'skirtopen','touch','breasttouch'],motions:Object.fromEntries([...rules.MOTION_AREAS,'touch'].map(x=>[x,1])),parameters:params}),
    hitTest:(x)=>({100:['bellyhit'],200:['touch'],300:['breasttouch'],400:['skirtopen']})[x]||[],
    getParameter:id=>overrides.get(id)??computed.get(id)??0,
    setParameter:(id,v)=>overrides.set(id,v),clearParameter:id=>overrides.delete(id),
    addParameterDriver:(id,driver)=>{drivers.set(id,driver); return ()=>drivers.delete(id);},
    playMotion:(area,index,options)=>{motions.push({area,index,options}); return Promise.resolve({status:'finished'});},setFit:()=>{},
    frame:(physics={})=>{
      // Emulate live2d-web: motion/physics writes first, persistent manual
      // setParameter overrides next, and callback drivers write last.
      for(const [id,value] of Object.entries(physics)) computed.set(id,value);
      rendered.clear();
      for(const p of params) rendered.set(p.id,computed.get(p.id)??p.defaultValue);
      for(const [id,value] of overrides) rendered.set(id,value);
      for(const [id,driver] of [...drivers]) rendered.set(id,driver.getValue());
      return rendered;
    },
  };
  let main=fs.readFileSync(join(root,'src/main.js'),'utf8');
  main=main.replace(/^import '\.\/style\.css';\s*/,'')
    .replace(/^import \{ createLive2D \} from 'live2d-web';\s*/,'')
    .replace(/^import[\s\S]*?from '\.\/game-rules\.js';\s*/,'')
    .replace(/^import[\s\S]*?from '\.\/spring-return\.js';\s*/,'')
    .replace(/^import \{ createHitSoundPlayer \} from '\.\/hit-sounds\.js';\s*/,'')
    .replace(/^import \{ createReactionVoicePlayer \} from '\.\/reaction-voices\.js';\s*/,'')
    .replace('import.meta.env.BASE_URL',"'/'");
  const ctx={URL,document:{baseURI:'http://localhost:5173/',getElementById:make,createElement:()=>({style:{setProperty(){}},addEventListener(){},remove(){}})},
    window:{innerWidth:1100,addEventListener(){}},localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},
    createLive2D:async()=>model,
    fetch:async()=>({ok:true,headers:{get:()=> 'application/javascript'},text:async()=> 'const core={}',arrayBuffer:async()=>new ArrayBuffer(4)}),
    Audio:FakeAudio,requestAnimationFrame:()=>{},console,Math,performance:{now:()=>1},
    createHitSoundPlayer:()=>({play:(area)=>sounds.push({src:area,volume:.5})}),
    createReactionVoicePlayer:()=>({preload(){},unlock(){},queue(){},queuePet(){sounds.push({src:'voices/Voice_Erpin_Touch2_Skin3.wav',volume:.5})},queueJoy(){sounds.push({src:'voices/Voice_Erpin_Joy3.wav',volume:.5})},stopAll(){},lockEnding(){}}),
    ...rules,...springs};
  vm.runInNewContext(main,ctx);
  const start=async()=>{make('startButton').fire('click');await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
  const fire=(name,x,y,id=1,timeStamp=1)=>make('live2dHost').fire(name,{pointerId:id,clientX:x,clientY:y,pointerType:'mouse',button:0,timeStamp});
  return {start,fire,make,model,overrides,drivers,computed,rendered,sounds,motions,
    frame:(physics)=>model.frame(physics),
    advance:()=>vm.runInNewContext('advanceReturns(1/60)',ctx),
    state:()=>JSON.parse(store.get('erpin-live2d-interactive-v1')),
    debug:()=>ctx.window.__erpinDebug(),checkLv:()=>ctx.window.__erpinCheckLv()};
}
test('start screen hides only after click, bellyhits 1 and 5 drive dust and ojum',async()=>{
  const m=createMock();
  assert.equal(m.make('splash').hidden,false);
  await m.start();
  assert.equal(m.make('splash').hidden,true);
  for(let i=1;i<=5;i++){
    m.fire('pointerdown',100,50);m.fire('pointerup',100,50);
    assert.equal(m.state().bellyHitCount,i);
    assert.equal(m.overrides.get('dust'),1);
    assert.equal(m.overrides.has('ojum'),i>=5);
  }
});
test('head-stroking plays only on completed drag; preserves spring driver',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',200,100);m.fire('pointermove',250,75);m.fire('pointerup',250,75);
  assert.equal(m.sounds.filter(x=>x.src.endsWith('Voice_Erpin_Touch2_Skin3.wav')).length,1);
  assert.equal(m.sounds.find(x=>x.src.endsWith('Voice_Erpin_Touch2_Skin3.wav')).volume,.5);
  assert.equal(m.drivers.has('headX'),true); assert.equal(m.drivers.has('headY'),true);
});
test('older bundled model without ojum still runs',async()=>{
  const m=createMock({hasOjum:false}); await m.start();
  for(let i=0;i<5;i++){m.fire('pointerdown',100,50);m.fire('pointerup',100,50);}
  assert.equal(m.state().bellyHitCount,5);
  assert.equal(m.overrides.get('dust'),1);
  assert.equal(m.overrides.has('ojum'),false);
});

test('30 seconds of actual head drags triggers happiness once and locks only other interactions',async()=>{
  const m=createMock(); await m.start();
  let time=10;
  m.fire('pointerdown',200,100,1,time);
  for(let i=0;i<180;i++){
    time+=180;
    m.fire('pointermove',i%2 ? 250 : 270,95+(i%3)*5,1,time);
  }
  assert.equal(m.state().endingReached,true);
  assert.equal(m.state().endingDisqualified,false);
  assert.equal(m.make('happyEnding').hidden,false);
  assert.equal(m.overrides.get('eyeopen'),0);
  assert.equal(m.overrides.get('smile'),0);
  assert.equal(m.sounds.filter(s=>s.src.endsWith('Voice_Erpin_Joy3.wav')).length,1);
  // A hit after the ending is ignored.
  m.fire('pointerup',250,100,1,time+10);
  const before=m.state().lv;
  m.fire('pointerdown',100,100,2,time+200);
  m.fire('pointerup',100,100,2,time+220);
  assert.equal(m.state().lv,before);
  // Head petting remains available after the end, with physics return.
  m.fire('pointerdown',200,100,3,time+300);
  m.fire('pointermove',260,60,3,time+450);
  m.fire('pointerup',260,60,3,time+470);
  assert.equal(m.drivers.has('headX'),true);
  assert.equal(m.drivers.has('headY'),true);
});

test('first hit permanently disables head strokes while preserving LV progression',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',100,50);m.fire('pointerup',100,50);
  assert.equal(m.state().endingDisqualified,true);
  assert.equal(m.state().touchLocked,true);
  const motions = m.motions.length;
  m.fire('pointerdown',200,100,2,100);
  for(let i=0;i<200;i++)m.fire('pointermove',i%2?250:270,100,2,300+i*180);
  m.fire('pointerup',270,100,2,37_000);
  assert.equal(m.state().petSeconds,0);
  assert.equal(m.motions.length,motions,'touch motion must not run after a hit');
  assert.equal(m.drivers.has('headX'),false);
  assert.equal(m.drivers.has('headY'),false);
  assert.equal(m.sounds.some(s=>s.src.endsWith('Voice_Erpin_Touch2_Skin3.wav')),false);
  assert.equal(m.state().endingReached,false);
  assert.equal(m.make('happyEnding').hidden,true);
  assert.equal(m.state().lv,1);
});

test('breast drag returns X/Y through Cubism physics and blocks ending',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',300,100,1,10);
  m.fire('pointermove',360,60,1,100);
  m.fire('pointerup',360,60,1,130);
  assert.equal(m.state().lv,1);
  assert.equal(m.state().endingDisqualified,true);
  assert.equal(m.drivers.get('boobX1')?.phase,'after-motion');
  assert.equal(m.drivers.get('boobY1')?.phase,'after-motion');
  assert.equal(m.overrides.has('boobX1'),false);
  assert.equal(m.overrides.has('boobY1'),false);
});

test('skirt drag that does not cross zero still disqualifies the ending but does not change LV',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',400,100,1,10);
  m.fire('pointermove',400,170,1,100); // negative direction clamps at zero
  m.fire('pointerup',400,170,1,130);
  assert.equal(m.state().lv,0);
  assert.equal(m.state().endingDisqualified,true);
});

// These tests exercise driver values as the Live2D SDK updates frames. Earlier
// tests only checked rule calculations, which missed visible overrides.
test('LV1 eyelight persists on render frames; LV20 pupil persists during simulated motion',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',100,50);m.fire('pointerup',100,50);
  assert.equal(m.state().lv,1);
  for(let i=0;i<5;i++){
    m.frame({eyelight:0,pupil:0});
    assert.equal(m.rendered.get('eyelight'),1);
  }
  for(let i=1;i<20;i++){m.fire('pointerdown',100,50);m.fire('pointerup',100,50);}
  assert.equal(m.state().lv,20);
  for(let i=0;i<5;i++){
    m.frame({eyelight:0,pupil:0});
    assert.equal(m.rendered.get('eyelight'),1);
    assert.equal(m.rendered.get('pupil'),1);
  }
});

test('head drag release eases toward dynamic live physics X/Y, rather than snapping',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',200,100);m.fire('pointermove',275,45);m.fire('pointerup',275,45);
  assert.equal(m.drivers.get('headX')?.phase,'after-motion');
  assert.equal(m.drivers.get('headY')?.phase,'after-motion');
  const beginX=m.frame({headX:-0.2,headY:0.2}).get('headX');
  const beginY=m.rendered.get('headY');
  assert.ok(beginX>-.2,`X released suddenly: ${beginX}`);
  assert.ok(beginY>0,`Y released suddenly: ${beginY}`);
  for(let i=0;i<250;i++){m.frame({headX:-.2,headY:.2}); m.advance();}
  assert.ok(Math.abs(m.rendered.get('headX')+.2)<.025,`X should follow physics: ${m.rendered.get('headX')}`);
  assert.ok(Math.abs(m.rendered.get('headY')-.2)<.025,`Y should follow physics: ${m.rendered.get('headY')}`);
});

test('breast drag releases into independently simulated X/Y physics',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',300,100);m.fire('pointermove',370,40);m.fire('pointerup',370,40);
  const first=m.frame({boobX1:-.2,boobY1:-.15});
  assert.ok(first.get('boobX1')>-.2);
  assert.ok(first.get('boobY1')>-.15);
  for(let i=0;i<250;i++){m.frame({boobX1:-.2,boobY1:-.15}); m.advance();}
  assert.ok(Math.abs(m.rendered.get('boobX1')+.2)<.025);
  assert.ok(Math.abs(m.rendered.get('boobY1')+.15)<.025);
});

test('skirt release eases to default rather than retaining its last manual value',async()=>{
  const m=createMock();await m.start();
  m.fire('pointerdown',400,100);m.fire('pointermove',400,50);m.fire('pointerup',400,50);
  const first=m.frame({skirtopen:0.5}).get('skirtopen');
  assert.ok(first>0,`skirt instantly jumped to default: ${first}`);
  // skirtopen is not a physics output: no external 0.5 value keeps writing it.
  m.computed.delete('skirtopen');
  for(let i=0;i<250;i++){m.frame();m.advance();}
  assert.ok(Math.abs(m.rendered.get('skirtopen'))<.025);
});

test('even a non-head contact without LV event blocks the secret ending',async()=>{
  const m=createMock();await m.start();
  m.fire('pointerdown',400,100);m.fire('pointerup',400,100);
  assert.equal(m.state().lv,0);
  assert.equal(m.state().endingDisqualified,true);
  m.fire('pointerdown',200,100,2,10);
  for(let i=0;i<200;i++)m.fire('pointermove',i%2?250:270,100,2,300+i*180);
  m.fire('pointerup',270,100,2,37000);
  assert.equal(m.state().endingReached,false);
});


test('a real head drag starts touch.motion3.json once and closes eyeopen/smile while stroking', async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',200,100,1,10);
  assert.equal(m.motions.length,0,'a still pointer should not play touch motion');
  m.fire('pointermove',250,60,1,100);
  assert.deepEqual(m.motions.map(x=>x.area),['touch']);
  assert.equal(m.motions[0].options.priority,'force');
  m.fire('pointermove',275,50,1,150);
  assert.equal(m.motions.length,1,'do not restart touch on every movement');
  assert.equal(m.drivers.get('eyeopen')?.phase,'after-motion');
  assert.equal(m.drivers.get('smile')?.phase,'after-motion');
  m.frame({eyeopen:1,smile:1});
  assert.equal(m.rendered.get('eyeopen'),0);
  assert.equal(m.rendered.get('smile'),0);
  m.fire('pointerup',275,50,1,200);
  m.frame({eyeopen:0,smile:0});
  assert.equal(m.rendered.get('eyeopen'),1,'eyes should reopen to the model default despite a looping touch motion');
  assert.equal(m.rendered.get('smile'),.6,'smile should restore the model default');
  // Next hit interrupts looping touch motion and releases its face overrides.
  m.fire('pointerdown',100,50,2,300);
  m.fire('pointerup',100,50,2,350);
  assert.deepEqual(m.motions.map(x=>x.area),['touch','bellyhit']);
  assert.equal(m.drivers.has('eyeopen'),false);
  assert.equal(m.drivers.has('smile'),false);
});

test('ending pose stays at eyeopen=smile=0 even after petting ends',async()=>{
  const m=createMock();await m.start();
  let t=10;
  m.fire('pointerdown',200,100,1,t);
  for(let i=0;i<180;i++){
    t+=180;
    m.fire('pointermove',i%2?250:270,95+(i%3)*5,1,t);
  }
  assert.equal(m.state().endingReached,true);
  m.fire('pointerup',250,100,1,t+10);
  m.frame({eyeopen:1,smile:1});
  assert.equal(m.rendered.get('eyeopen'),0);
  assert.equal(m.rendered.get('smile'),0);
  assert.equal(m.sounds.filter(s=>s.src.endsWith('Voice_Erpin_Touch2_Skin3.wav')).length,0,'pet line must be silent when ending arrives');
  assert.equal(m.sounds.filter(s=>s.src.endsWith('Voice_Erpin_Joy3.wav')).length,1);
});


test('shy tracks actual stroking time and updates the per-frame expression driver smoothly',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',200,100,1,10);
  for(let i=1;i<=50;i++) {
    m.fire('pointermove',i%2?260:245,95,1,10+i*180);
    if(i%10===0) {
      m.frame({shy:0});
      const expected=m.debug().petSeconds/30;
      assert.ok(Math.abs(m.rendered.get('shy')-expected)<.000002,
        `shy should track ${expected} (got ${m.rendered.get('shy')})`);
    }
  }
  assert.ok(m.state().petSeconds>7 && m.state().petSeconds<11);
  assert.ok(m.drivers.has('shy'));
  m.fire('pointerup',245,95,1,9050);
  const saved=m.state().petSeconds;
  assert.ok(saved>7);
  assert.ok(saved<30);
  // Petting time and expression should retain progress between strokes.
  m.frame({shy:0});
  assert.ok(Math.abs(m.rendered.get('shy')-saved/30)<.000002);
});

test('30-second ending permanently keeps shy=1 across frames',async()=>{
  const m=createMock();await m.start();
  let time=10;
  m.fire('pointerdown',200,100,1,time);
  for(let i=0;i<180;i++) {
    time+=180;
    m.fire('pointermove',i%2?250:270,95+(i%3)*5,1,time);
  }
  assert.equal(m.state().endingReached,true);
  assert.equal(m.state().petSeconds,30);
  for(let i=0;i<4;i++) {
    m.frame({shy:0,eyeopen:1,smile:1});
    assert.equal(m.rendered.get('shy'),1);
    assert.equal(m.rendered.get('eyeopen'),0);
    assert.equal(m.rendered.get('smile'),0);
  }
});

test('even a non-LV skirt contact prevents further head motion and shy progression',async()=>{
  const m=createMock(); await m.start();
  m.fire('pointerdown',200,100,1,10);
  for(let i=1;i<=12;i++)m.fire('pointermove',i%2?260:245,95,1,10+i*180);
  m.fire('pointerup',245,95,1,2500);
  const time=m.state().petSeconds;
  const shy=m.frame({shy:0}).get('shy');
  m.fire('pointerdown',400,100,2,3000); // touching skirt is enough, regardless of LV
  m.fire('pointerup',400,100,2,3050);
  assert.equal(m.state().lv,0);
  assert.equal(m.state().endingDisqualified,true);
  m.fire('pointerdown',200,100,3,3200);
  for(let i=1;i<=160;i++)m.fire('pointermove',i%2?260:245,95,3,3200+i*180);
  m.fire('pointerup',245,95,3,34000);
  assert.equal(m.state().petSeconds,time,'stroke counter must freeze');
  assert.equal(m.frame({shy:0}).get('shy'),shy,'shy driver must freeze');
  assert.equal(m.state().endingReached,false);
});


test('LV eye flags use live2d-web persistent manual overrides, not lifecycle drivers', async()=>{
  const m=createMock(); await m.start();
  const diagnostic=m.debug();
  assert.equal(diagnostic.lv,0);
  m.fire('pointerdown',100,50);m.fire('pointerup',100,50);
  assert.equal(m.overrides.get('eyelight'),1);
  assert.equal(m.drivers.has('eyelight'),false);
  assert.equal(m.overrides.has('pupil'),false);
  for(let i=1;i<20;i++) {m.fire('pointerdown',100,50);m.fire('pointerup',100,50);}
  assert.equal(m.state().lv,20);
  assert.equal(m.overrides.get('eyelight'),1);
  assert.equal(m.overrides.get('pupil'),1);
  assert.equal(m.drivers.has('pupil'),false);
  for(let i=0;i<6;i++){
    m.frame({eyelight:0,pupil:0});
    assert.equal(m.rendered.get('eyelight'),1);
    assert.equal(m.rendered.get('pupil'),1);
  }
});


test('diagnostic distinguishes LV stage, model range and persistent pin state',async()=>{
  const m=createMock(); await m.start();
  assert.equal(m.checkLv().find(x=>x.parameter==='pupil').expected,0);
  for(let i=0;i<20;i++) {m.fire('pointerdown',100,50);m.fire('pointerup',100,50);}
  const report=m.checkLv();
  assert.equal(report[0].expected,1);
  assert.equal(report[1].expected,1);
  assert.equal(report[0].actual,1);
  assert.equal(report[1].actual,1);
  assert.equal(report[0].persistentOverride,true);
  assert.equal(report[1].persistentOverride,true);
  assert.ok(report.every(x=>x.matches));
});


test('LV10-20 eyeopen value survives model frame updates alongside existing LV eye flags', async()=>{
  const m=createMock(); await m.start();
  for(let i=1;i<=20;i++){
    m.fire('pointerdown',100,50);m.fire('pointerup',100,50);
    if([9,10,11,15,19,20].includes(i)){
      const expected=i<10?0:Number((1-(Math.min(i,20)-10)*.05).toFixed(3));
      m.frame({eyeopen:0,eyelight:0,pupil:0});
      assert.equal(m.rendered.get('eyeopen'),expected,`eyeopen at LV ${i}`);
      assert.equal(m.rendered.get('eyelight'),1,`eyelight at LV ${i}`);
      if(i>=20) assert.equal(m.rendered.get('pupil'),1,`pupil at LV ${i}`);
    }
  }
  // Same resting default remains when saved LV is restored.
  assert.equal(m.state().lv,20);
  m.frame({eyeopen:1});
  assert.equal(m.rendered.get('eyeopen'),0.5);
});

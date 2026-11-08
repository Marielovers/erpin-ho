import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('game screen has only title/start and no LV/reset dashboard',()=>{
 const html=readFileSync(resolve(root,'index.html'),'utf8');
 assert.match(html,/그저 30초 동안 에르핀을/);
 assert.match(html,/쓰다듬기만 하면 되는 게임/);
 assert.match(html,/id="startButton"/);
 assert.doesNotMatch(html,/id="reset"|id="level"|class="panel"/);
});
test('assets and GitHub workflow exist',()=>{
 for(const p of ['public/assets/background.png','public/voices/Voice_Erpin_Touch2_Skin3.wav','.github/workflows/deploy.yml','public/model/에르핀.model3.json']) assert.ok(existsSync(resolve(root,p)),p);
});

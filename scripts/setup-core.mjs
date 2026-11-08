// Executed automatically by npm's predev/prestart/prebuild hooks.
// The downloaded Cubism Core is saved locally; the browser never uses a CDN.
// IMPORTANT: Live2D Cubism Core is proprietary. Please review Live2D's license:
// https://www.live2d.com/ko/sdk/download/web/
import { mkdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const dest = resolve(dirname(fileURLToPath(import.meta.url)), '../public/vendor/live2dcubismcore.min.js');
const source = 'https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js';
const tmp = `${dest}.download`;
try {
  const info = await stat(dest);
  if (info.size > 10_000) {
    console.log('✓ Cubism Core가 설치되어 있습니다. (로컬 파일 사용)');
    process.exit(0);
  }
} catch { /* first start */ }
console.log('Cubism Core 파일이 없어 Live2D 공식 호스팅 서버에서 자동 설치합니다.');
console.log('라이선스: https://www.live2d.com/ko/sdk/download/web/');
try {
  const response = await fetch(source, { redirect: 'follow', signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`공식 다운로드 HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  const head = new TextDecoder().decode(bytes.slice(0, 400));
  if (bytes.byteLength < 10_000 || type.includes('text/html') || /<!doctype|<html/i.test(head)) {
    throw new Error('공식 URL에서 JavaScript 파일을 받지 못했습니다.');
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  console.log(`✓ Cubism Core 자동 설치 완료 (${bytes.length} bytes)`);
} catch (error) {
  try { await unlink(tmp); } catch { /* no temp file */ }
  console.error('Cubism Core 자동 설치 실패:', error.message);
  console.error('네트워크를 확인하고 npm run dev를 다시 실행하세요.');
  console.error('또는 공식 SDK에서 파일을 내려받아 다음 경로에 넣으세요:', dest);
  process.exitCode = 1;
}

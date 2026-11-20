import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DISPLAY_NAME,
  InstallerError,
  OFFICIAL_APP_EXE,
  buildStaging,
  compileNsi,
  renderNsi,
} from '../scripts/build-windows-installer.mjs';
import { sha512Base64 } from '../scripts/build-desktop-bundle.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/build-windows-installer.mjs', import.meta.url));

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'heluo-nsis-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakePayload(bytes = Buffer.from('fake-official-setup-exe')) {
  return { target: 'win-x64', version: '0.2.2-rc.5', url: 'https://example.test/setup.exe', sha512: sha512Base64(bytes), bytes };
}

test('renderNsi：品牌名、/S 静默装、快捷方式与探针 TODO 齐全', () => {
  const nsi = renderNsi({ officialExeName: 'dsh-setup.exe', withIcon: true });
  assert.match(nsi, new RegExp(`Name "${DISPLAY_NAME}"`));
  assert.match(nsi, /OutFile "HeluoForgeEnterprise-Setup\.exe"/);
  assert.match(nsi, /ExecWait '"\$INSTDIR\\dsh-setup\.exe" \/S' \$0/);
  assert.match(nsi, /CreateShortCut "\$SMPROGRAMS\\河洛 Forge 企业版\\河洛 Forge 企业版\.lnk" "\$LOCALAPPDATA\\Programs\\DSH\\DSH\.exe" "" "\$INSTDIR\\brand\\app-icon\.ico"/);
  assert.match(nsi, /TODO\(P2 探针\)/);
  assert.match(nsi, /RequestExecutionLevel user/);
  // NSIS 字符串中不允许出现双反斜杠路径（与 OFFICIAL_APP_EXE 的单反斜杠一致）。
  assert.doesNotMatch(nsi.replace(OFFICIAL_APP_EXE, ''), /\\\\/u);
});

test('renderNsi：无图标时回退注释与无图标快捷方式', () => {
  const nsi = renderNsi({ officialExeName: 'dsh-setup.exe', withIcon: false });
  assert.match(nsi, /; 无品牌图标时使用 NSIS 默认图标/);
  assert.doesNotMatch(nsi, /Icon "brand/);
  assert.match(nsi, /CreateShortCut "\$SMPROGRAMS\\河洛 Forge 企业版\\河洛 Forge 企业版\.lnk" "\$LOCALAPPDATA\\Programs\\DSH\\DSH\.exe"$/mu);
});

test('buildStaging：载荷、nsi、清单与探针记录', (t) => {
  const root = tempRoot(t);
  const payload = fakePayload();
  const { manifest } = buildStaging({ stagingDir: join(root, 'staging'), payload, now: () => new Date('2026-11-20T00:00:00Z') });
  assert.equal(manifest.schema, 'heluo-windows-installer/1');
  assert.equal(manifest.payload.version, '0.2.2-rc.5');
  assert.equal(manifest.payload.sha256.length, 64);
  assert.equal(manifest.iconEmbedded, false);
  assert.equal(manifest.probesPending.length, 3);
  assert.ok(existsSync(join(root, 'staging/payload/dsh-desktop-win-x64-0.2.2-rc.5.exe')));
  const nsi = readFileSync(join(root, 'staging/installer.nsi'), 'utf8');
  assert.match(nsi, /dsh-desktop-win-x64-0\.2\.2-rc\.5\.exe/);
});

test('compileNsi：makensis 缺失时返回 false 而非崩溃', { skip: false }, (t) => {
  const root = tempRoot(t);
  const nsiPath = join(root, 'x.nsi');
  writeFileSync(nsiPath, 'OutFile "x.exe"\nSection\nSectionEnd\n');
  const probe = spawnSync('makensis', ['-VERSION'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    assert.equal(compileNsi(nsiPath, root), false);
  } else {
    assert.equal(typeof compileNsi(nsiPath, root), 'boolean');
  }
});

test('CLI 端到端（offline）：退出 0 产出暂存；篡改退出 3', (t) => {
  const root = tempRoot(t);
  const payload = fakePayload();
  writeFileSync(join(root, 'setup.exe'), payload.bytes);
  const manifest = { target: 'win-x64', version: payload.version, url: payload.url, sha512: payload.sha512, file: 'setup.exe' };
  writeFileSync(join(root, 'offline.json'), JSON.stringify(manifest));

  const ok = spawnSync(
    process.execPath,
    [SCRIPT, '--offline-manifest', join(root, 'offline.json'), '--output', join(root, 'out')],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(root, 'out/staging/installer.nsi')));
  assert.ok(existsSync(join(root, 'out/staging/installer-manifest.json')));

  writeFileSync(join(root, 'setup.exe'), Buffer.from('tampered'));
  const bad = spawnSync(
    process.execPath,
    [SCRIPT, '--offline-manifest', join(root, 'offline.json'), '--output', join(root, 'out2')],
    { encoding: 'utf8' },
  );
  assert.equal(bad.status, 3);
  assert.ok(bad.stderr.includes('PAYLOAD_MISMATCH'));
});

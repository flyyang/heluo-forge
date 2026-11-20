import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BundleError,
  buildStaging,
  downloadAndVerify,
  renderInstallMd,
  resolveFeedPayload,
  sha512Base64,
  verifyLocalPayload,
  zipDir,
} from '../scripts/build-desktop-bundle.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/build-desktop-bundle.mjs', import.meta.url));

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'heluo-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakePayload(target, bytes = Buffer.from(`fake-dmg-${target}`)) {
  return { target, kind: 'dmg', version: '0.2.1-rc.3', url: `https://example.test/${target}.dmg`, sha512: sha512Base64(bytes), size: bytes.length, bytes };
}

test('sha512 校验：一致通过，篡改报 PAYLOAD_MISMATCH', () => {
  const payload = fakePayload('mac-arm64');
  assert.doesNotThrow(() => verifyLocalPayload(payload, payload.bytes));
  const tampered = { ...payload, bytes: Buffer.from('tampered') };
  assert.throws(() => verifyLocalPayload(tampered, tampered.bytes), (error) => error instanceof BundleError && error.code === 'PAYLOAD_MISMATCH');
});

test('downloadAndVerify：HTTP 失败与大小不符均拒绝', async () => {
  const fetchFail = async () => new Response('x', { status: 503 });
  const payload = fakePayload('mac-x64');
  await assert.rejects(() => downloadAndVerify(payload, fetchFail, 1000), (error) => error.code === 'FETCH_FAILED');

  const fetchOk = async () => new Response(Buffer.from('shorter-than-declared'));
  const wrongSize = { ...payload, bytes: undefined };
  await assert.rejects(
    () => downloadAndVerify(wrongSize, fetchOk, 1000),
    (error) => error.code === 'PAYLOAD_MISMATCH',
  );
});

test('resolveFeedPayload：feed 解析并解析出版本化 URL', async () => {
  const feedYaml = [
    'version: 0.2.1-rc.3',
    'files:',
    '  - url: DSH-0.2.1-rc.3-arm64.dmg',
    '    sha512: >-',
    `      ${sha512Base64(Buffer.from('x'))}`,
    '    size: 3',
    'releaseDate: \'2026-10-23T10:00:00.000Z\'',
    '',
  ].join('\n');
  const fetchImpl = async () => new Response(feedYaml, { status: 200 });
  const payload = await resolveFeedPayload({ origin: 'https://example.test', target: 'mac-arm64', fetchImpl, timeoutMs: 1000 });
  assert.equal(payload.version, '0.2.1-rc.3');
  assert.equal(payload.url, 'https://example.test/dsh-desk/feeds/mac-arm64/DSH-0.2.1-rc.3-arm64.dmg');
  await assert.rejects(
    () => resolveFeedPayload({ origin: 'https://example.test', target: 'nope', fetchImpl, timeoutMs: 1000 }),
    (error) => error.code === 'INVALID',
  );
});

test('renderInstallMd：品牌、Gatekeeper 占位与原样声明齐全', () => {
  const markdown = renderInstallMd({
    payloads: [{ target: 'mac-arm64', version: '0.2.1-rc.3', fileName: 'payload/dsh-desktop-mac-arm64-0.2.1-rc.3.dmg' }],
    generatedAt: '2026-11-20T00:00:00.000Z',
  });
  assert.match(markdown, /河洛 Forge 企业版/);
  assert.match(markdown, /Gatekeeper/);
  assert.match(markdown, /待 P3 实测/);
  assert.match(markdown, /原样/);
  assert.match(markdown, /异版本先卸载再安装/);
});

test('buildStaging + zipDir：暂存布局、摘要清单与 zip 产物', (t) => {
  const root = tempRoot(t);
  const payloads = [fakePayload('mac-arm64'), fakePayload('mac-x64')];
  const manifest = buildStaging({ stagingDir: join(root, 'staging'), payloads, now: () => new Date('2026-11-20T00:00:00Z') });
  assert.equal(manifest.schema, 'heluo-desktop-bundle/1');
  assert.equal(manifest.payloads.length, 2);
  assert.ok(existsSync(join(root, 'staging/payload/dsh-desktop-mac-arm64-0.2.1-rc.3.dmg')));
  const sums = readFileSync(join(root, 'staging/SHA256SUMS'), 'utf8');
  assert.match(sums, /payload\/dsh-desktop-mac-arm64-0\.2\.1-rc\.3\.dmg/);
  assert.match(sums, /INSTALL\.md/);
  const zip = zipDir(join(root, 'staging'), join(root, 'bundle.zip'));
  assert.ok(existsSync(zip));
  const listing = spawnSync('unzip', ['-l', zip], { encoding: 'utf8' });
  assert.match(listing.stdout, /desktop-payloads\.json/);
});

test('CLI 端到端（offline 清单）：退出 0 并产出 zip；篡改退出 3', (t) => {
  const root = tempRoot(t);
  const arm64 = fakePayload('mac-arm64');
  writeFileSync(join(root, 'arm64.dmg'), arm64.bytes);
  const manifest = [{ target: 'mac-arm64', version: arm64.version, url: arm64.url, sha512: arm64.sha512, file: 'arm64.dmg' }];
  writeFileSync(join(root, 'offline.json'), JSON.stringify(manifest));

  const ok = spawnSync(
    process.execPath,
    [SCRIPT, '--offline-manifest', join(root, 'offline.json'), '--output', join(root, 'out'), '--targets', 'mac-arm64'],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);

  writeFileSync(join(root, 'arm64.dmg'), Buffer.from('tampered'));
  const bad = spawnSync(
    process.execPath,
    [SCRIPT, '--offline-manifest', join(root, 'offline.json'), '--output', join(root, 'out2'), '--targets', 'mac-arm64'],
    { encoding: 'utf8' },
  );
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /PAYLOAD_MISMATCH/);
});

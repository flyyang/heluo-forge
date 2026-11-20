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

test('fetchWithRetry：404 后恢复则成功，持续 404 报 FETCH_FAILED', async () => {
  const { fetchWithRetry } = await import('../scripts/build-desktop-bundle.mjs');
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return calls >= 3 ? new Response('ok', { status: 200 }) : new Response('x', { status: 404 });
  };
  const recovered = await fetchWithRetry('https://example.test/a', 1000, { attempts: 3, backoffMs: 1, fetchImpl: flaky });
  assert.equal(recovered.status, 200);
  assert.equal(calls, 3);

  const dead = async () => new Response('x', { status: 404 });
  await assert.rejects(
    () => fetchWithRetry('https://example.test/b', 1000, { attempts: 2, backoffMs: 1, fetchImpl: dead }),
    (error) => error.code === 'FETCH_FAILED' && /CDN 复制空窗/.test(error.message),
  );
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

test('latest dmg 形态：latest 文件名、存证标记与 INSTALL 措辞', (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('fake-latest-dmg');
  const payload = {
    target: 'mac-arm64',
    kind: 'dmg',
    version: 'latest',
    url: 'https://example.test/desktop/dsh-latest-macos-arm64.dmg',
    sha512: sha512Base64(bytes),
    size: bytes.length,
    digestSource: 'self',
    versionUncertified: true,
    bytes,
  };
  const manifest = buildStaging({ stagingDir: join(root, 'staging'), payloads: [payload], now: () => new Date('2026-11-20T00:00:00Z') });
  const record = manifest.payloads[0];
  assert.equal(record.fileName, 'payload/dsh-desktop-mac-arm64-latest.dmg');
  assert.equal(record.digestSource, 'self');
  assert.equal(record.versionUncertified, true);
  const markdown = readFileSync(join(root, 'staging/INSTALL.md'), 'utf8');
  assert.match(markdown, /安装镜像/);
  assert.match(markdown, /版本待挂载核验/);
  assert.match(markdown, /仅有 zip 形态时解压后拖入/);
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

test('CLI 分包：双目标各自成包（按架构独立 zip 与 staging）', (t) => {
  const root = tempRoot(t);
  const arm64 = fakePayload('mac-arm64');
  const x64 = fakePayload('mac-x64');
  writeFileSync(join(root, 'arm64.dmg'), arm64.bytes);
  writeFileSync(join(root, 'x64.dmg'), x64.bytes);
  const manifest = [
    { target: 'mac-arm64', version: arm64.version, url: arm64.url, sha512: arm64.sha512, file: 'arm64.dmg' },
    { target: 'mac-x64', version: x64.version, url: x64.url, sha512: x64.sha512, file: 'x64.dmg' },
  ];
  writeFileSync(join(root, 'offline.json'), JSON.stringify(manifest));

  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--offline-manifest', join(root, 'offline.json'), '--output', join(root, 'out')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, 'out/mac-arm64/heluo-desktop-mac-arm64-0.2.1-rc.3.zip')));
  assert.ok(existsSync(join(root, 'out/mac-x64/heluo-desktop-mac-x64-0.2.1-rc.3.zip')));
  // 每个包只含本架构载荷：对侧 dmg 不在包内
  const arm64Zip = join(root, 'out/mac-arm64/heluo-desktop-mac-arm64-0.2.1-rc.3.zip');
  const listing = spawnSync('unzip', ['-l', arm64Zip], { encoding: 'utf8' });
  assert.match(listing.stdout, /dsh-desktop-mac-arm64-0\.2\.1-rc\.3\.dmg/);
  assert.doesNotMatch(listing.stdout, /mac-x64/);
});

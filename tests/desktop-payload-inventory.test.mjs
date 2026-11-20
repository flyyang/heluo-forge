import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  InventoryError,
  TARGETS,
  collectInventory,
  parseUpdaterFeed,
  renderReport,
  resolveBinaryUrl,
  versionState,
} from '../scripts/desktop-payload-inventory.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/desktop-payload-inventory.mjs', import.meta.url));
const REPO_ROOT = dirname(dirname(SCRIPT));

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Async spawn: a sync child would freeze this process's event loop and starve the loopback server. */
function runCli(args) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolvePromise) => {
    child.on('close', (code) => resolvePromise({ status: code, stdout, stderr }));
  });
}

const FEED_FIXTURE = `version: 0.2.1-rc.3
files:
  - url: DSH-0.2.1-rc.3-arm64.dmg
    sha512: AbCdEf1234567890+/==
    size: 104857600
releaseDate: '2026-10-23T10:00:00.000Z'
`;

test('parseUpdaterFeed 提取 electron-updater feed 字段', () => {
  const feed = parseUpdaterFeed(FEED_FIXTURE);
  assert.equal(feed.version, '0.2.1-rc.3');
  assert.equal(feed.url, 'DSH-0.2.1-rc.3-arm64.dmg');
  assert.equal(feed.sha512, 'AbCdEf1234567890+/==');
  assert.equal(feed.size, 104857600);
  assert.equal(feed.releaseDate, '2026-10-23T10:00:00.000Z');
});

test('parseUpdaterFeed 缺少关键字段时报 FEED_UNPARSEABLE', () => {
  assert.throws(() => parseUpdaterFeed('version: 1.0.0\n'), (error) => error instanceof InventoryError && error.code === 'FEED_UNPARSEABLE');
  assert.throws(() => parseUpdaterFeed('not yaml at all'), (error) => error.code === 'FEED_UNPARSEABLE');
});

test('resolveBinaryUrl 绝对地址原样保留、相对地址并入 feed 目录', () => {
  assert.equal(
    resolveBinaryUrl('https://example.test', 'dsh-desk/feeds/mac-arm64/nightly-mac.yml', 'https://cdn.test/a.dmg'),
    'https://cdn.test/a.dmg',
  );
  assert.equal(
    resolveBinaryUrl('https://example.test/', 'dsh-desk/feeds/mac-arm64/nightly-mac.yml', 'DSH-0.2.1-rc.3-arm64.dmg'),
    'https://example.test/dsh-desk/feeds/mac-arm64/DSH-0.2.1-rc.3-arm64.dmg',
  );
});

test('versionState 三态：一致 / 漂移 / 未知', () => {
  assert.equal(versionState('0.2.1-rc.3', '0.2.1-rc.3').state, 'match');
  assert.equal(versionState('0.2.1-rc.3', '0.2.1-rc.5').state, 'drift');
  assert.equal(versionState('0.2.1-rc.3', null).state, 'unknown');
});

function jsonResponse(body, status = 200) {
  return new Response(status === 404 ? 'not found' : body, { status });
}

test('collectInventory 汇总探测结果与告警', async () => {
  const fetchImpl = async (url, timeoutMs, init = {}) => {
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0);
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '123456' } });
    if (url.includes('mac-arm64') || url.includes('mac-x64')) return jsonResponse(FEED_FIXTURE);
    if (url.includes('win-x64')) return jsonResponse('', 404);
    throw new Error('unexpected url');
  };
  const { report } = await collectInventory({
    origin: 'https://example.test',
    dshVersion: '0.2.1-rc.3',
    fetchImpl,
    timeoutMs: 1000,
  });
  assert.equal(report.schema, 'heluo-desktop-inventory/1');
  assert.equal(report.targets.length, TARGETS.length);
  assert.equal(report.summary.feedsOk, 2);
  assert.ok(report.warnings.some((warning) => warning.includes('win-x64')));
  const arm64 = report.targets.find((entry) => entry.target === 'mac-arm64');
  assert.equal(arm64.versionState.state, 'match');
  assert.equal(arm64.latestBytes, 123456);
});

test('renderReport 渲染 Markdown 表与告警', async () => {
  const fetchImpl = async (url, _timeoutMs, init = {}) => {
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    return jsonResponse(FEED_FIXTURE.replace('0.2.1-rc.3', '0.2.1-rc.5'));
  };
  const { report } = await collectInventory({
    origin: 'https://example.test',
    dshVersion: '0.2.1-rc.3',
    fetchImpl,
    timeoutMs: 1000,
  });
  const markdown = renderReport(report);
  assert.match(markdown, /# 官方 DSH Desktop 载荷盘点报告/);
  assert.match(markdown, /mac-arm64 \| 0\.2\.1-rc\.5 \| drift/);
  assert.match(markdown, /版本与 \.dsh-version 锁定版漂移/);
});

test('CLI 端到端：loopback 源盘点成功并落盘报告', async (t) => {
  const root = tempRoot(t);
  const server = http.createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': '999' });
      response.end();
      return;
    }
    if (request.url?.startsWith('/dsh-desk/feeds/')) {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end(FEED_FIXTURE);
      return;
    }
    response.writeHead(404);
    response.end('nope');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => server.close());
  const { port } = server.address();

  const output = join(root, 'inventory');
  const result = await runCli(['--origin', `http://127.0.0.1:${port}`, '--output', output, '--timeout-ms', '5000']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(output, 'inventory.json'), 'utf8'));
  assert.equal(report.summary.feedsOk, 3);
  assert.match(readFileSync(join(output, 'INVENTORY.md'), 'utf8'), /mac-arm64/);
});

test('CLI 反向：全部 feed 失败退出 1，strict 漂移退出 3', async (t) => {
  const root = tempRoot(t);
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => server.close());
  const dead = `http://127.0.0.1:${server.address().port}`;

  const failed = await runCli(['--origin', dead, '--output', join(root, 'a'), '--timeout-ms', '3000']);
  assert.equal(failed.status, 1);

  const okServer = http.createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': '1' });
      response.end();
      return;
    }
    response.writeHead(200);
    response.end(FEED_FIXTURE.replace(/0\.2\.1-rc\.3/gu, '0.2.1-rc.9'));
  });
  await new Promise((resolvePromise) => okServer.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => okServer.close());
  const drifting = await runCli([
    '--origin', `http://127.0.0.1:${okServer.address().port}`,
    '--output', join(root, 'b'),
    '--timeout-ms', '3000',
    '--strict',
  ]);
  assert.equal(drifting.status, 3);
  assert.match(drifting.stderr, /--strict/);
});

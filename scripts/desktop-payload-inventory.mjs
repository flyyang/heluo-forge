/**
 * Official DSH Desktop payload inventory (plan CORP-DSH-PLAN-024 §4.1 P0.2).
 *
 * Evidence only, never redistributes: fetches the public electron-updater
 * feeds, records the version / URL / sha512 / size each target currently
 * serves, probes the fixed "latest" download URLs, and compares the served
 * version against the locked .dsh-version. No payload bytes are downloaded or
 * stored; the report is the deliverable (P0 redistribution decision input).
 *
 * Feed layout follows the upstream publishing docs: feeds live under
 * `dsh-desk/feeds/<target>/nightly[-mac].yml` with absolute binary URLs, and
 * the fixed latest installers under `desktop/dsh-latest-*.dmg|.exe`. Upstream
 * has no versioned archive — only these moving pointers — so the report is
 * the provenance record for「原样字节 + 摘要」(CORP-DSH-PLAN-024 §5).
 *
 * 用法：
 *   node scripts/desktop-payload-inventory.mjs [--origin URL] [--output DIR]
 *     [--dsh-version-file PATH] [--timeout-ms N] [--strict] [--json]
 *     [--repo-root DIR]
 *
 * 退出码：0 正常；1 FETCH_FAILED（全部 feed 探测失败）；2 INVALID（参数或
 * 输入文件问题）；3 STRICT_FAILED（--strict 下版本漂移或存在探测失败）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INVENTORY_SCHEMA = 'heluo-desktop-inventory/1';
export const TOOL_NAME = 'heluo-desktop-payload-inventory';

const DEFAULT_ORIGIN = 'https://download.deepseek.com';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Updater targets and their fixed latest installers (publishing README). */
export const TARGETS = [
  { target: 'mac-arm64', kind: 'dmg', feed: 'nightly-mac.yml', latest: 'dsh-latest-macos-arm64.dmg' },
  { target: 'mac-x64', kind: 'dmg', feed: 'nightly-mac.yml', latest: 'dsh-latest-macos-x64.dmg' },
  { target: 'win-x64', kind: 'exe', feed: 'nightly.yml', latest: 'dsh-latest-windows-x64.exe' },
];

export class InventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Minimal electron-updater feed parser. The feeds are flat YAML with an
 * optional `files:` list whose entries are indented (and bulleted), so every
 * field regex accepts leading indentation and an optional `- ` bullet; only
 * the fields the inventory needs are extracted.
 */
export function parseUpdaterFeed(text, source = 'feed') {
  const valuePattern = "^\\s*(?:-\\s*)?NAME:\\s*['\"]?([^'\"\\s]+)['\"]?\\s*$";
  const field = (name) => new RegExp(valuePattern.replace('NAME', name), 'mu');
  const version = field('version').exec(text);
  const url = field('url').exec(text) ?? field('path').exec(text);
  const sha512 = field('sha512').exec(text);
  const size = /^\s*(?:-\s*)?size:\s*(\d+)\s*$/mu.exec(text);
  const releaseDate = field('releaseDate').exec(text);
  if (!version || !url || !sha512) {
    throw new InventoryError(
      'FEED_UNPARSEABLE',
      `${source}: expected version/url/sha512 fields, found version=${Boolean(version)} url=${Boolean(url)} sha512=${Boolean(sha512)}`,
    );
  }
  return {
    version: version[1],
    url: url[1],
    sha512: sha512[1],
    size: size ? Number(size[1]) : null,
    releaseDate: releaseDate ? releaseDate[1].trim() : null,
  };
}

/** Resolve a feed url field (may be absolute or relative to the feed file). */
export function resolveBinaryUrl(origin, feedPath, url) {
  if (/^https?:\/\//iu.test(url)) return url;
  const base = dirname(feedPath);
  const joined = `${base}/${url.replace(/^\//u, '')}`;
  return `${origin.replace(/\/$/u, '')}/${joined.replace(/^\//u, '')}`;
}

export function versionState(locked, served) {
  if (!served) return { state: 'unknown', note: 'feed 未取得，无版本可比' };
  if (served === locked) return { state: 'match', note: '与锁定版一致' };
  return { state: 'drift', note: `上游当前提供 ${served}，锁定版为 ${locked}` };
}

function statusOf(ok, status) {
  if (!ok) return 'network-error';
  return status === 200 ? 'ok' : `http-${status}`;
}

/**
 * Probe every target against the public origin. `fetchImpl` is injectable so
 * tests can serve fixtures from a loopback listener without network access.
 */
export async function collectInventory({ origin, dshVersion, fetchImpl, timeoutMs, now = () => new Date() }) {
  const results = [];
  for (const spec of TARGETS) {
    const feedPath = `dsh-desk/feeds/${spec.target}/${spec.feed}`;
    const feedUrl = `${origin.replace(/\/$/u, '')}/${feedPath}`;
    const entry = {
      target: spec.target,
      kind: spec.kind,
      feedPath,
      feedStatus: null,
      feed: null,
      versionState: null,
      latestPath: `desktop/${spec.latest}`,
      latestStatus: null,
      latestBytes: null,
    };
    try {
      const response = await fetchImpl(feedUrl, timeoutMs);
      entry.feedStatus = statusOf(response.ok, response.status);
      if (response.ok) {
        const feed = parseUpdaterFeed(await response.text(), feedUrl);
        feed.url = resolveBinaryUrl(origin, feedPath, feed.url);
        entry.feed = feed;
        entry.versionState = versionState(dshVersion, feed.version);
      }
    } catch (error) {
      entry.feedStatus = 'network-error';
      entry.networkError = String(error.cause?.code ?? error.message ?? error);
    }
    try {
      const response = await fetchImpl(`${origin.replace(/\/$/u, '')}/${entry.latestPath}`, timeoutMs, { method: 'HEAD' });
      entry.latestStatus = statusOf(response.ok, response.status);
      const length = response.headers?.get?.('content-length');
      entry.latestBytes = length ? Number(length) : null;
    } catch {
      entry.latestStatus = 'network-error';
    }
    results.push(entry);
  }

  const feedsOk = results.filter((entry) => entry.feedStatus === 'ok');
  const drift = feedsOk
    .filter((entry) => entry.versionState?.state === 'drift')
    .map((entry) => entry.target);
  const warnings = [];
  for (const entry of results) {
    if (entry.feedStatus !== 'ok') warnings.push(`${entry.target}: feed 探测失败（${entry.feedStatus}）`);
    if (entry.latestStatus && entry.latestStatus !== 'ok') {
      warnings.push(`${entry.target}: latest 固定 URL 探测失败（${entry.latestStatus}）`);
    }
  }
  if (feedsOk.length > 0 && feedsOk.length < results.length) {
    warnings.push('部分 feed 探测失败，盘点为部分结论；重新运行或人工核验缺失目标');
  }
  if (drift.length > 0) warnings.push(`上游版本与 .dsh-version 锁定版漂移：${drift.join(', ')}`);

  return {
    report: {
      schema: INVENTORY_SCHEMA,
      tool: TOOL_NAME,
      generatedAt: now().toISOString(),
      origin,
      lockedDshVersion: dshVersion,
      targets: results,
      warnings,
      summary: { feedsOk: feedsOk.length, feedsTotal: results.length, drift },
    },
  };
}

export function renderReport(report) {
  const lines = [
    '# 官方 DSH Desktop 载荷盘点报告',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 探测源：${report.origin}`,
    `- 锁定版（.dsh-version）：${report.lockedDshVersion}`,
    `- feed 探测：${report.summary.feedsOk}/${report.summary.feedsTotal} 成功`,
    '',
    '| target | feed 版本 | 与锁定版 | sha512（base64，前 12 位） | 大小 | latest 固定 URL |',
    '|---|---|---|---|---|---|',
  ];
  for (const entry of report.targets) {
    const feedVersion = entry.feed?.version ?? '—';
    const state = entry.versionState?.state ?? 'unknown';
    const sha = entry.feed?.sha512?.slice(0, 12) ?? '—';
    const size = entry.feed?.size != null ? String(entry.feed.size) : '—';
    lines.push(`| ${entry.target} | ${feedVersion} | ${state} | ${sha} | ${size} | ${entry.latestStatus} |`);
  }
  lines.push('');
  if (report.warnings.length === 0) {
    lines.push('无告警：全部目标探测成功且版本与锁定版一致。');
  } else {
    lines.push('## 告警', '', ...report.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('');
  lines.push('> 本报告只读取公开 feed 与 HEAD 探测，不下载载荷字节；sha512 为上游 electron-updater 声明值（base64），作为「原样字节 + 摘要比对」的比对基准来源。');
  return `${lines.join('\n')}\n`;
}

function usage() {
  return [
    '用法: node scripts/desktop-payload-inventory.mjs [选项]',
    '  --origin <url>            下载源（默认 https://download.deepseek.com）',
    '  --output <dir>            报告输出目录（默认 dist/desktop-inventory）',
    '  --dsh-version-file <path> 锁定版文件（默认 .dsh-version）',
    '  --timeout-ms <n>          单请求超时（默认 15000）',
    '  --strict                  版本漂移或探测失败时退出非零',
    '  --json                    额外把 JSON 报告打到 stdout',
    '  --repo-root <dir>         仓库根（默认脚本上级目录）',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    origin: DEFAULT_ORIGIN,
    output: null,
    dshVersionFile: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    strict: false,
    json: false,
    repoRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new InventoryError('INVALID', `选项 ${arg} 缺少取值`);
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case '--origin': options.origin = next(); break;
      case '--output': options.output = next(); break;
      case '--dsh-version-file': options.dshVersionFile = next(); break;
      case '--timeout-ms': {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) throw new InventoryError('INVALID', '--timeout-ms 需为正整数');
        options.timeoutMs = value;
        break;
      }
      case '--strict': options.strict = true; break;
      case '--json': options.json = true; break;
      case '--repo-root': options.repoRoot = next(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new InventoryError('INVALID', `未知参数 ${arg}`);
    }
  }
  return options;
}

async function defaultFetch(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${usage()}\n${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const repoRoot = resolve(options.repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  const versionPath = resolve(repoRoot, options.dshVersionFile ?? '.dsh-version');
  let dshVersion;
  try {
    dshVersion = readFileSync(versionPath, 'utf8').trim();
  } catch (error) {
    process.stderr.write(`读取锁定版文件失败（${versionPath}）：${error.message}\n`);
    return 2;
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/u.test(dshVersion)) {
    process.stderr.write(`锁定版文件内容不是版本号：${dshVersion}\n`);
    return 2;
  }
  const outputDir = isAbsolute(options.output ?? '')
    ? options.output
    : join(repoRoot, options.output ?? 'dist/desktop-inventory');

  const { report } = await collectInventory({
    origin: options.origin,
    dshVersion,
    fetchImpl: defaultFetch,
    timeoutMs: options.timeoutMs,
  });
  mkdirSync(outputDir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(outputDir, 'inventory.json'), json);
  writeFileSync(join(outputDir, 'INVENTORY.md'), renderReport(report));
  if (options.json) process.stdout.write(json);
  process.stdout.write(`[heluo] 载荷盘点完成：${outputDir}/inventory.json（feed ${report.summary.feedsOk}/${report.summary.feedsTotal}）\n`);
  for (const warning of report.warnings) process.stdout.write(`[heluo] WARN ${warning}\n`);

  if (report.summary.feedsOk === 0) {
    process.stderr.write('[heluo] 全部 feed 探测失败，无可用证据\n');
    return 1;
  }
  if (options.strict && (report.summary.drift.length > 0 || report.warnings.length > 0)) {
    process.stderr.write('[heluo] --strict：存在版本漂移或探测失败\n');
    return 3;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}

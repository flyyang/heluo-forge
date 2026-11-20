/**
 * macOS desktop bundle builder (plan CORP-DSH-PLAN-024 §4.4 P3, neutral base).
 *
 * Assembles the neutral macOS delivery base: the official Desktop dmg for
 * every requested target is downloaded from its versioned feed URL, verified
 * byte-for-byte against the feed-declared sha512, and packed UNMODIFIED next
 * to a branded INSTALL.md and a digest manifest. Enterprise configuration is
 * never accepted here — the private injection stays on the packaging machine.
 *
 * The bundle embeds official payloads, so under the plan's redistribution
 * rule it must NOT be attached to any release until the P0 license ruling is
 * recorded; consumers keep it as a workflow artifact until then.
 *
 * 用法：
 *   node scripts/build-desktop-bundle.mjs [--targets mac-arm64,mac-x64]
 *     [--origin URL] [--output DIR] [--offline-manifest FILE] [--json]
 *     [--repo-root DIR]
 *
 * --offline-manifest 指向 JSON 数组（{target, version, sha512, url, file}），
 * 全部载荷从本地文件读取，供离线测试与内部镜像使用。
 *
 * 退出码：0 成功；2 INVALID（参数/输入）；3 PAYLOAD_MISMATCH（sha512 不符）；
 * 4 FETCH_FAILED（feed 或载荷下载失败）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGETS, parseUpdaterFeed, resolveBinaryUrl } from './desktop-payload-inventory.mjs';

export const BUNDLE_SCHEMA = 'heluo-desktop-bundle/1';
export const TOOL_NAME = 'heluo-build-desktop-bundle';

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

/** Fetch and parse one target's updater feed. */
export async function resolveFeedPayload({ origin, target, fetchImpl, timeoutMs }) {
  const spec = TARGETS.find((candidate) => candidate.target === target);
  if (!spec) throw new BundleError('INVALID', `未知目标 ${target}（可用：${TARGETS.map((t) => t.target).join(', ')}）`);
  const feedPath = `dsh-desk/feeds/${spec.target}/${spec.feed}`;
  const response = await fetchWithRetry(`${origin.replace(/\/$/u, '')}/${feedPath}`, timeoutMs, { fetchImpl });
  if (!response.ok) throw new BundleError('FETCH_FAILED', `${target}: feed HTTP ${response.status}`);
  const feed = parseUpdaterFeed(await response.text(), feedPath);
  return {
    target,
    kind: spec.kind,
    version: feed.version,
    url: resolveBinaryUrl(origin, feedPath, feed.url),
    sha512: feed.sha512,
    size: feed.size,
  };
}

/**
 * Fetch with retry: the official CDN has replication windows where a feed
 * already advertises a binary URL that some edges still answer with 404
 * (observed 2026-11-20 on GitHub runners and the maker machine alike).
 * Network errors, 404 and 5xx are retried with linear backoff.
 */
export async function fetchWithRetry(url, timeoutMs, { attempts = 3, backoffMs = 5_000, fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? (async (target, timeout) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(target, { signal: controller.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  });
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await doFetch(url, timeoutMs);
      if (response.ok || (response.status !== 404 && response.status < 500)) return response;
      lastStatus = response.status;
    } catch (error) {
      lastStatus = `network:${error.name}`;
    }
    if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs * attempt));
  }
  throw new BundleError('FETCH_FAILED', `${url}: 重试 ${attempts} 次后仍不可达（${lastStatus}；可能为 CDN 复制空窗或访问限制）`);
}

/** Download the payload bytes and verify them against the declared sha512. */
export async function downloadAndVerify(payload, fetchImpl, timeoutMs) {
  const response = await fetchWithRetry(payload.url, timeoutMs, { fetchImpl });
  if (!response.ok) throw new BundleError('FETCH_FAILED', `${payload.target}: payload HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha512Base64(bytes);
  if (digest !== payload.sha512) {
    throw new BundleError('PAYLOAD_MISMATCH', `${payload.target}: sha512 ${digest} 与 feed 声明不符`);
  }
  if (payload.size != null && bytes.length !== payload.size) {
    throw new BundleError('PAYLOAD_MISMATCH', `${payload.target}: 大小 ${bytes.length} 与 feed 声明 ${payload.size} 不符`);
  }
  return bytes;
}

export function verifyLocalPayload(payload, bytes) {
  const digest = sha512Base64(bytes);
  if (digest !== payload.sha512) {
    throw new BundleError('PAYLOAD_MISMATCH', `${payload.target}: 本地载荷 sha512 ${digest} 与声明不符`);
  }
  return bytes;
}

/** Branded first-launch guide; uncertain behaviors stay marked as probes. */
export function renderInstallMd({ payloads, generatedAt }) {
  const rows = payloads
    .map((payload) => `- \`${payload.fileName}\` — 官方 DSH Desktop ${payload.version}（${payload.target}），原样字节，SHA-256 见 SHA256SUMS`)
    .join('\n');
  return [
    '# 河洛 Forge 企业版 · macOS 成套包（中性基线）',
    '',
    `> 生成时间：${generatedAt}。本包为中性基线：官方载荷原样随包；企业插件与默认配置由制包机私版注入后交付。`,
    '',
    '## 包内清单',
    '',
    rows,
    '- `INSTALL.md` — 本说明',
    '- `desktop-payloads.json` — 官方载荷来源与摘要记录',
    '- `SHA256SUMS` — 全部文件摘要',
    '',
    '## 安装三步',
    '',
    '1. 双击挂载对应架构的 dmg，将应用拖入「应用程序」。Apple Silicon 选 arm64，Intel 选 x64。',
    '2. 首次打开如遇 Gatekeeper 提示，按 Apple 官方指引处理（右键 → 打开，或系统设置 → 隐私与安全性 → 仍要打开）。**外层材料未签名，首开实际表现待 P3 实测后回填图文。**',
    '3. 运行随包初始化脚本安装企业插件与默认配置（私版注入后提供）；插件挂载在应用内「设置 → 插件」确认。',
    '',
    '## 升级与回退',
    '',
    '沿用交付版本收敛语义：异版本先卸载再安装；用户数据（`~/.dsh` 工作区）不受外层升级影响。',
    '',
    '## 边界',
    '',
    '- 不重签名、不公证；官方载荷字节原样，可按 `desktop-payloads.json` 内的来源 URL 与摘要独立核对。',
    '- 本中性基线不含任何企业凭据或内网地址。',
    '',
  ].join('\n');
}

export function buildStaging({ stagingDir, payloads, now = () => new Date(), renderInstall = renderInstallMd }) {
  mkdirSync(join(stagingDir, 'payload'), { recursive: true });
  const records = [];
  for (const payload of payloads) {
    const fileName = `dsh-desktop-${payload.target}-${payload.version}.${payload.kind}`;
    const target = join(stagingDir, 'payload', fileName);
    writeFileSync(target, payload.bytes);
    records.push({
      target: payload.target,
      kind: payload.kind,
      version: payload.version,
      fileName: `payload/${fileName}`,
      bytes: payload.bytes.length,
      sha256: createHash('sha256').update(payload.bytes).digest('hex'),
      sourceUrl: payload.url,
      sourceSha512: payload.sha512,
    });
  }
  const generatedAt = now().toISOString();
  const manifest = {
    schema: BUNDLE_SCHEMA,
    tool: TOOL_NAME,
    generatedAt,
    payloads: records,
  };
  writeFileSync(join(stagingDir, 'desktop-payloads.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(stagingDir, 'INSTALL.md'),
    renderInstall({ payloads: records, generatedAt }),
  );
  const sums = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
      sums.push(`${digest}  ${full.slice(stagingDir.length + 1)}`);
    }
  };
  walk(stagingDir);
  writeFileSync(join(stagingDir, 'SHA256SUMS'), `${sums.sort().join('\n')}\n`);
  return manifest;
}

export function zipDir(stagingDir, outputFile) {
  execFileSync('zip', ['-r', '-X', '-q', outputFile, '.'], { cwd: stagingDir });
  return outputFile;
}

function usage() {
  return [
    '用法: node scripts/build-desktop-bundle.mjs [选项]',
    '  --targets <a,b>        目标（默认 mac-arm64,mac-x64；可用 mac-arm64/mac-x64/win-x64）',
    '  --origin <url>         下载源（默认 https://download.deepseek.com）',
    '  --output <dir>         输出目录（默认 dist/desktop-bundle）',
    '  --offline-manifest <f> 本地载荷清单 JSON（[{target,version,sha512,url,file}]）',
    '  --timeout-ms <n>       单请求超时（默认 120000）',
    '  --json                 打印 desktop-payloads.json 到 stdout',
    '  --repo-root <dir>      仓库根（默认脚本上级目录）',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    targets: 'mac-arm64,mac-x64',
    origin: 'https://download.deepseek.com',
    output: null,
    offlineManifest: null,
    timeoutMs: 120_000,
    json: false,
    repoRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new BundleError('INVALID', `选项 ${arg} 缺少取值`);
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case '--targets': options.targets = next(); break;
      case '--origin': options.origin = next(); break;
      case '--output': options.output = next(); break;
      case '--offline-manifest': options.offlineManifest = next(); break;
      case '--timeout-ms': {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) throw new BundleError('INVALID', '--timeout-ms 需为正整数');
        options.timeoutMs = value;
        break;
      }
      case '--json': options.json = true; break;
      case '--repo-root': options.repoRoot = next(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new BundleError('INVALID', `未知参数 ${arg}`);
    }
  }
  return options;
}

async function defaultFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
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
  const repoRoot = resolve(options.repoRoot ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'));
  const outputDir = isAbsolute(options.output ?? '') ? options.output : resolve(repoRoot, options.output ?? 'dist/desktop-bundle');
  const targetList = options.targets.split(',').map((value) => value.trim()).filter(Boolean);

  try {
    const payloads = [];
    if (options.offlineManifest) {
      const manifestPath = resolve(options.offlineManifest);
      const entries = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(entries)) throw new BundleError('INVALID', 'offline 清单必须是 JSON 数组');
      for (const entry of entries) {
        const filePath = resolve(dirnameOf(manifestPath), entry.file);
        if (!existsSync(filePath)) throw new BundleError('INVALID', `载荷文件不存在：${filePath}`);
        payloads.push({ ...entry, bytes: verifyLocalPayload(entry, readFileSync(filePath)) });
      }
    } else {
      for (const target of targetList) {
        const payload = await resolveFeedPayload({ origin: options.origin, target, fetchImpl: defaultFetch, timeoutMs: options.timeoutMs });
        process.stdout.write(`[heluo] ${target}: 下载 ${payload.version}（${payload.url}）\n`);
        payloads.push({ ...payload, bytes: await downloadAndVerify(payload, defaultFetch, options.timeoutMs) });
      }
    }
    const stagingDir = join(outputDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    const manifest = buildStaging({ stagingDir, payloads });
    const versions = [...new Set(manifest.payloads.map((payload) => payload.version))];
    const zipName = `heluo-desktop-${targetList.join('+')}-${versions.join('+')}.zip`;
    const zipPath = join(outputDir, zipName);
    zipDir(stagingDir, zipPath);
    if (options.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`[heluo] macOS 成套包完成：${zipPath}\n`);
    if (versions.length > 1) {
      process.stdout.write(`[heluo] WARN 多目标版本不一致：${versions.join(' / ')}（分发前需收敛或分别交付）\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof BundleError) {
      process.stderr.write(`[heluo] ${error.code}: ${error.message}\n`);
      return error.code === 'PAYLOAD_MISMATCH' ? 3 : error.code === 'FETCH_FAILED' ? 4 : 2;
    }
    throw error;
  }
}

function dirnameOf(path) {
  return resolve(path, '..');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}

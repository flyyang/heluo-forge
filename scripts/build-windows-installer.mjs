/**
 * Windows outer NSIS installer generator (plan CORP-DSH-PLAN-024 §4.3 P2, v0).
 *
 * Stages the official Desktop setup exe (downloaded from its versioned feed
 * URL and verified against the feed sha512), generates an outer NSIS script
 * branded「河洛 Forge 企业版」that silently runs the official installer and
 * then lays out the enterprise assets with branded shortcuts, and compiles it
 * when makensis is available (CI installs nsis; the packaging machine may
 * compile offline via `brew install makensis`).
 *
 * v0 boundaries, all marked as P2 probes in the plan and MUST be re-verified
 * on a real Windows host before any distribution: the official installer's
 * silent flag (/S), its default install location, and the shortcut target
 * path are conventions, not measured facts. The generated installer embeds
 * the official payload, so it stays a workflow artifact until the P0 license
 * ruling; it must not be attached to a release.
 *
 * 用法：
 *   node scripts/build-windows-installer.mjs [--origin URL] [--output DIR]
 *     [--icon FILE.ico] [--offline-manifest FILE] [--repo-root DIR] [--json]
 *
 * 退出码：0 成功（含 makensis 未安装时仅产出 .nsi 与暂存目录）；2 INVALID；
 * 3 PAYLOAD_MISMATCH；4 FETCH_FAILED；5 NSIS_COMPILE_FAILED。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BundleError, downloadAndVerify, resolveFeedPayload, verifyLocalPayload } from './build-desktop-bundle.mjs';

export const INSTALLER_SCHEMA = 'heluo-windows-installer/1';
export const TOOL_NAME = 'heluo-build-windows-installer';
export const OUTER_NAME = 'HeluoForgeEnterprise';
export const DISPLAY_NAME = '河洛 Forge 企业版';

/** P2 probe placeholder: the official per-user install path is unmeasured. */
export const OFFICIAL_APP_EXE = '$LOCALAPPDATA\\Programs\\DSH\\DSH.exe';

export class InstallerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Generate the outer NSIS script. Kept data-driven for tests. */
export function renderNsi({ displayName = DISPLAY_NAME, outerName = OUTER_NAME, officialExeName, withIcon }) {
  const iconLine = withIcon
    ? 'Icon "brand\\app-icon.ico"'
    : '; 无品牌图标时使用 NSIS 默认图标（P1 派生资产缺失回退）';
  const shortcutWithIcon = '  CreateShortCut "$SMPROGRAMS\\' + displayName + '\\' + displayName + '.lnk" "' + OFFICIAL_APP_EXE + '" "" "$INSTDIR\\brand\\app-icon.ico"';
  const shortcutPlain = '  CreateShortCut "$SMPROGRAMS\\' + displayName + '\\' + displayName + '.lnk" "' + OFFICIAL_APP_EXE + '"';
  return [
    '; 河洛 Forge 企业版外层安装器（自动生成，勿手改）',
    '; 计划 CORP-DSH-PLAN-024 §4.3 P2 v0：/S 静默参数、官方默认安装路径与',
    '; 快捷方式指向均为待实机核验的探针项（见 desktop-release 计划 §3 #5）。',
    '!include "MUI2.nsh"',
    'Name "' + displayName + '"',
    'OutFile "' + outerName + '-Setup.exe"',
    'InstallDir "$LOCALAPPDATA\\HeluoForgeEnterprise"',
    'RequestExecutionLevel user',
    iconLine,
    '',
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "SimpChinese"',
    '',
    'Section "安装"',
    '  SetOutPath "$INSTDIR"',
    '  File "payload\\' + officialExeName + '"',
    '  DetailPrint "静默安装官方 DSH Desktop（' + officialExeName + ' /S）…"',
    '  ExecWait \'"$INSTDIR\\' + officialExeName + '" /S\' $0',
    '  ${If} $0 != 0',
    '    DetailPrint "官方安装器退出码 $0；继续布置企业资产，请员工查看安装日志。"',
    '  ${EndIf}',
    '  ; 企业资产（私版注入后由制包机补齐 assets/ 目录；中性构建时为空壳说明）',
    '  SetOutPath "$INSTDIR\\enterprise"',
    '  File /nonfatal "assets\\*.*"',
    '  CreateDirectory "$SMPROGRAMS\\' + displayName + '"',
    withIcon ? shortcutWithIcon : shortcutPlain,
    '  CreateShortCut "$DESKTOP\\' + displayName + '.lnk" "' + OFFICIAL_APP_EXE + '"',
    '  ; TODO(P2 探针): 从注册表读取官方卸载键定位真实安装目录，替换上面的硬编码路径。',
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    'SectionEnd',
    '',
    'Section "Uninstall"',
    '  ; 只清理外层企业资产；官方应用走其自带卸载器，用户数据（~/.dsh）不动。',
    '  Delete "$SMPROGRAMS\\' + displayName + '\\' + displayName + '.lnk"',
    '  RMDir "$SMPROGRAMS\\' + displayName + '"',
    '  Delete "$DESKTOP\\' + displayName + '.lnk"',
    '  RMDir /r "$INSTDIR"',
    'SectionEnd',
    '',
  ].join('\n');
}

export function buildStaging({ stagingDir, payload, iconFile, now = () => new Date() }) {
  mkdirSync(join(stagingDir, 'payload'), { recursive: true });
  const officialExeName = `dsh-desktop-${payload.target}-${payload.version}.exe`;
  writeFileSync(join(stagingDir, 'payload', officialExeName), payload.bytes);
  let withIcon = false;
  if (iconFile && existsSync(iconFile)) {
    mkdirSync(join(stagingDir, 'brand'), { recursive: true });
    copyFileSync(iconFile, join(stagingDir, 'brand', 'app-icon.ico'));
    withIcon = true;
  }
  const nsi = renderNsi({ officialExeName, withIcon });
  writeFileSync(join(stagingDir, 'installer.nsi'), nsi);
  const manifest = {
    schema: INSTALLER_SCHEMA,
    tool: TOOL_NAME,
    generatedAt: now().toISOString(),
    payload: {
      target: payload.target,
      version: payload.version,
      fileName: `payload/${officialExeName}`,
      bytes: payload.bytes.length,
      sha256: createHash('sha256').update(payload.bytes).digest('hex'),
      sourceUrl: payload.url,
      sourceSha512: payload.sha512,
    },
    iconEmbedded: withIcon,
    probesPending: ['官方 /S 静默参数实测', '官方默认安装路径实测', '快捷方式指向注册表定位'],
  };
  writeFileSync(join(stagingDir, 'installer-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, nsiPath: join(stagingDir, 'installer.nsi') };
}

export function compileNsi(nsiPath, outputDir) {
  try {
    execFileSync('makensis', ['-INPUTCHARSET', 'UTF8', '-V2', nsiPath], { cwd: outputDir, stdio: 'pipe' });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new InstallerError('NSIS_COMPILE_FAILED', `makensis 编译失败：${String(error.stderr ?? error.message).slice(0, 400)}`);
  }
}

function usage() {
  return [
    '用法: node scripts/build-windows-installer.mjs [选项]',
    '  --origin <url>         下载源（默认 https://download.deepseek.com）',
    '  --output <dir>         输出目录（默认 dist/windows-installer）',
    '  --icon <file.ico>      品牌图标（建议 dist/brand-icons/app-icon.ico）',
    '  --offline-manifest <f> 本地载荷清单 JSON（{target,version,sha512,url,file}）',
    '  --timeout-ms <n>       单请求超时（默认 300000）',
    '  --json                 打印 installer-manifest.json 到 stdout',
    '  --repo-root <dir>      仓库根（默认脚本上级目录）',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    origin: 'https://download.deepseek.com',
    output: null,
    icon: null,
    offlineManifest: null,
    timeoutMs: 300_000,
    json: false,
    repoRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new InstallerError('INVALID', `选项 ${arg} 缺少取值`);
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case '--origin': options.origin = next(); break;
      case '--output': options.output = next(); break;
      case '--icon': options.icon = next(); break;
      case '--offline-manifest': options.offlineManifest = next(); break;
      case '--timeout-ms': {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) throw new InstallerError('INVALID', '--timeout-ms 需为正整数');
        options.timeoutMs = value;
        break;
      }
      case '--json': options.json = true; break;
      case '--repo-root': options.repoRoot = next(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new InstallerError('INVALID', `未知参数 ${arg}`);
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
  const repoRoot = resolve(options.repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  const outputDir = isAbsolute(options.output ?? '') ? options.output : resolve(repoRoot, options.output ?? 'dist/windows-installer');

  try {
    let payload;
    if (options.offlineManifest) {
      const manifestPath = resolve(options.offlineManifest);
      const entry = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const filePath = resolve(manifestPath, '..', entry.file);
      if (!existsSync(filePath)) throw new InstallerError('INVALID', `载荷文件不存在：${filePath}`);
      payload = { ...entry, bytes: verifyLocalPayload(entry, readFileSync(filePath)) };
    } else {
      payload = await resolveFeedPayload({ origin: options.origin, target: 'win-x64', fetchImpl: defaultFetch, timeoutMs: options.timeoutMs });
      process.stdout.write(`[heluo] win-x64: 下载 ${payload.version}（${payload.url}）\n`);
      payload = { ...payload, bytes: await downloadAndVerify(payload, defaultFetch, options.timeoutMs) };
    }
    const stagingDir = join(outputDir, 'staging');
    const { manifest, nsiPath } = buildStaging({
      stagingDir,
      payload,
      iconFile: options.icon ? resolve(options.icon) : null,
    });
    const compiled = compileNsi(nsiPath, stagingDir);
    if (options.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`[heluo] Windows 外层安装器暂存完成：${stagingDir}\n`);
    process.stdout.write(compiled ? '[heluo] makensis 编译完成：staging/HeluoForgeEnterprise-Setup.exe\n' : '[heluo] makensis 不可用，仅产出 installer.nsi 与暂存目录（CI 或制包机编译）\n');
    return 0;
  } catch (error) {
    if (error instanceof InstallerError || error instanceof BundleError) {
      process.stderr.write(`[heluo] ${error.code}: ${error.message}\n`);
      if (error.code === 'PAYLOAD_MISMATCH') return 3;
      if (error.code === 'FETCH_FAILED') return 4;
      if (error.code === 'NSIS_COMPILE_FAILED') return 5;
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}

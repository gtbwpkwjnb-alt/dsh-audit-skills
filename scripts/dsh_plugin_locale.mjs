#!/usr/bin/env node
/**
 * dsh_plugin_locale.mjs — DSH 插件页中文化落地器（skills-summarize-audit 本地适配）
 *
 * 背景：DSH 插件页文字由 @deepseek-ai/dsh-app-boot readPluginMeta() 读取
 *   <plugin_pkg>/locale/en.json（英语资源，定义同目录语言文件集合）
 *   取 meta.title / meta.description；缺失时回落到 package.json 的 name/description。
 * 该路径经包 specifier 解析，因此 package.json 的 exports 必须导出 "./locale/*"。
 *
 * 用法：
 *   node dsh_plugin_locale.mjs --check
 *   node dsh_plugin_locale.mjs --apply
 *   node dsh_plugin_locale.mjs --restore
 *   可选：--profile <profileDir>
 *
 * 幂等；每次覆盖写入前备份到 *.dsh-locale.bak。升级/重装插件后 locale 会丢失，
 * 重新执行 --apply 即可恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NL = String.fromCharCode(10);
const args = process.argv.slice(2);
const mode = args.includes('--restore') ? 'restore' : args.includes('--check') ? 'check' : 'apply';
const pi = args.indexOf('--profile');
const profile = pi >= 0 && args[pi + 1]
  ? args[pi + 1]
  : path.join(os.homedir(), '.dsh', 'profiles', 'desktop');

const catalog = JSON.parse(fs.readFileSync(new URL('../references/dsh-plugin-locale-catalog.json', import.meta.url), 'utf8'));

const BAK = '.dsh-locale.bak';
const rows = [];

function backup(file) {
  const b = file + BAK;
  if (!fs.existsSync(b)) fs.copyFileSync(file, b);
}
function writeJson(file, value) {
  if (fs.existsSync(file)) backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + NL);
}

for (const e of catalog.entries) {
  const dir = path.join(profile, 'node_modules', ...e.pkg.split('/'));
  const pkgFile = path.join(dir, 'package.json');
  const enFile = path.join(dir, 'locale', 'en.json');
  const zhFile = path.join(dir, 'locale', 'zh.json');
  if (!fs.existsSync(pkgFile)) { rows.push([e.pkg, 'MISSING', '包未安装']); continue; }

  if (mode === 'restore') {
    let n = 0;
    for (const f of [pkgFile, enFile, zhFile]) {
      if (fs.existsSync(f + BAK)) { fs.copyFileSync(f + BAK, f); fs.unlinkSync(f + BAK); n++; }
    }
    rows.push([e.pkg, n ? 'RESTORED' : 'NO_BACKUP', n + ' 个文件']); continue;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const hasExports = pkg.exports !== undefined && typeof pkg.exports === 'object' && pkg.exports !== null && !Array.isArray(pkg.exports);
  const exportsHasLocale = hasExports && Object.keys(pkg.exports).some((k) => k.startsWith('./locale'));
  const localeOk = fs.existsSync(enFile) && fs.existsSync(zhFile);
  const titleOk = localeOk && (() => { try { const j = JSON.parse(fs.readFileSync(zhFile, 'utf8')); return !!(j.meta && j.meta.title && j.meta.description); } catch { return false; } })();

  if (mode === 'check') {
    // 无 exports 映射时按路径解析即可用；有 exports 时必须导出 ./locale/*
    const resolvable = localeOk && (!hasExports || exportsHasLocale);
    rows.push([e.pkg, resolvable ? 'OK' : 'TODO',
      'locale=' + (localeOk ? 'yes' : 'no') + ' exports=' + (exportsHasLocale ? 'yes' : (hasExports ? 'no' : 'n/a'))]);
    continue;
  }

  // apply
  writeJson(enFile, { meta: e.en });
  writeJson(zhFile, { meta: e.zh });
  let exportNote = 'n/a';
  if (hasExports && !exportsHasLocale) {
    backup(pkgFile);
    pkg.exports['./locale/*'] = './locale/*';
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + NL);
    exportNote = 'added ./locale/*';
  } else if (hasExports) {
    exportNote = 'already exported';
  } else {
    exportNote = 'no exports map';
  }
  rows.push([e.pkg, 'APPLIED', exportNote + (titleOk ? ' (覆盖已有)' : '')]);
}

const w = Math.max(...rows.map((r) => r[0].length)) + 2;
console.log('mode=' + mode + '  profile=' + profile);
for (const [a, b, c] of rows) console.log('  ' + a.padEnd(w) + b.padEnd(11) + c);

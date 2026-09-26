#!/usr/bin/env node
/**
 * dsh_market_search.mjs — DSH 插件市场按需搜索与对比推荐
 * （skills-summarize-audit 本地 DSH 适配）
 *
 * 只做发现与对比，不安装。所有事实字段附来源与日期；不可得为 null。
 *
 * 用法：
 *   node dsh_market_search.mjs --need 记忆 --need 搜索
 *   node dsh_market_search.mjs --need "语音转写" --runtime 0.1.7-rc.2 --limit 8
 *   node dsh_market_search.mjs --need 记忆 --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const needs = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--need') needs.push(argv[i + 1]);
const runtime = flag('--runtime', '0.1.7-rc.2');
const limit = Number(flag('--limit', '10'));
const asJson = argv.includes('--json');
const profile = flag('--profile', path.join(os.homedir(), '.dsh', 'profiles', 'desktop'));
if (needs.length === 0) { console.log('用法: --need <关键词> [--need ...] [--runtime x] [--limit n] [--json]'); process.exit(2); }

// 已装插件
const installed = new Set();
try {
  const pj = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  for (const k of Object.keys(pj.dependencies || {})) installed.add(k);
} catch {}

let semver = null;
try { semver = createRequire(path.join(profile, 'node_modules') + '/').call(null, 'semver'); } catch {}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) return null;
  return r.json();
}
function compatOf(manifest) {
  const peers = Object.entries(manifest.peerDependencies || {}).filter(([k]) => k.startsWith('@deepseek-ai/dsh'));
  const declared = (manifest.dsh && manifest.dsh.compatibility) || null;
  if (declared && declared.dshReleases && declared.dshReleases[runtime]) return '兼容(声明)';
  if (peers.length === 0) return '无 DSH peer';
  if (!semver) return 'peer待核验: ' + peers.map(([k, v]) => k.replace('@deepseek-ai/', '') + '@' + v).join(', ').slice(0, 90);
  const bad = peers.filter(([, range]) => { try { return !semver.satisfies(runtime, range); } catch { return true; } });
  return bad.length === 0 ? '兼容(peer)' : '不兼容: ' + bad.map(([k]) => k.replace('@deepseek-ai/', '')).join(',');
}

const out = [];
for (const need of needs) {
  const res = await getJson('https://registry.npmjs.org/-/v1/search?size=25&text=' + encodeURIComponent(need + ' dsh deepseek harness'));
  const seen = new Set();
  const rows = [];
  for (const o of (res && res.objects) || []) {
    const name = o.package.name;
    if (seen.has(name)) continue;
    seen.add(name);
    const blob = name + ' ' + (o.package.description || '');
    if (!/dsh|harness|deepseek/i.test(blob)) continue;
    const pack = await getJson('https://registry.npmjs.org/' + name.replace('/', '%2f'));
    if (!pack) continue;
    const latest = pack['dist-tags'].latest;
    const m = pack.versions[latest] || {};
    if (!(m.dsh && m.dsh.bundle)) continue;            // 必须是真 DSH bundle
    rows.push({
      name, version: latest,
      published: (pack.time[latest] || '').slice(0, 10),
      license: m.license || null,
      repo: String((m.repository && m.repository.url) || '').replace(/^git\+/, '').replace(/\.git$/, '') || null,
      installed: installed.has(name),
      enabled: (() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8')).dsh.profile.bundles.includes(name); } catch { return false; } })(),
      compat: compatOf(m),
      keyless: /keyless|no api key|免 key|免key|无需 ?key|free/i.test(m.description || '') ? '免key/免费' : null,
      desc: String(m.description || '').slice(0, 110),
    });
  }
  out.push({ need, rows });
}

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log('DSH 市场按需对比  runtime=' + runtime + '  profile=' + profile + NL);
for (const g of out) {
  console.log('## 需求: ' + g.need + (g.rows.length ? '' : '   （未找到真 DSH bundle）'));
  if (!g.rows.length) { console.log(''); continue; }
  g.rows.sort((a, b) => (b.installed - a.installed) || b.published.localeCompare(a.published));
  for (const r of g.rows.slice(0, limit)) {
    console.log('  ' + (r.installed ? (r.enabled ? '[已装·启用] ' : '[已装·禁用] ') : '[未装]     ') + r.name + '@' + r.version);
    console.log('     发布 ' + r.published + ' | ' + (r.license || 'lic=null') + ' | ' + r.compat + (r.keyless ? ' | ' + r.keyless : ''));
    if (r.repo) console.log('     ' + r.repo);
    console.log('     ' + r.desc);
  }
  console.log('');
}
console.log('注：Stars/下载量不作为质量证据；许可与价格需分别核验；未实际安装或运行。');

#!/usr/bin/env node
/**
 * build-client-catalog.mjs — 把内置 catalog 的中文快照注入客户端半体
 *
 * 为什么需要：
 *   插件侧的 `displayName` / `localizedDescription` 是宿主 **2.9+** 才有的字段（2.8.0 的 index.js 里
 *   `displayName` 只出现在技能行）。也就是说，只要运行中的 DSH 还是旧宿主，列表就**物理上拿不到**
 *   插件的中文名与中文说明 —— 而「让英语不好的用户看懂插件」正是本插件的主功能，用户会以为功能没生效。
 *   客户端半体是静态脚本、热更新，所以把内置 catalog 的中文快照内联进来，旧宿主下也能显示。
 *
 * 只内联**仓库里的内置 catalog**（`references/dsh-plugin-locale-catalog.json`）：
 *   - 它是仓库数据，内联不泄漏任何本机信息；
 *   - 用户覆盖层（LLM 生成/手工补录）**不内联** —— 那是本机状态，不能进已发布的客户端。
 *
 * 用法：
 *   node scripts/build-client-catalog.mjs          # 注入/更新 client.js 里的快照块
 *   node scripts/build-client-catalog.mjs --check  # 只校验是否与 catalog 一致（回归闸门用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CATALOG = path.join(REPO, 'references', 'dsh-plugin-locale-catalog.json')
const CLIENT = path.join(REPO, 'client.js')
const START = '/* @catalog-snapshot:start（由 scripts/build-client-catalog.mjs 生成，勿手改） */'
const END = '/* @catalog-snapshot:end */'

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
const map = {}
for (const entry of Array.isArray(catalog.entries) ? catalog.entries : []) {
  if (!entry || typeof entry.pkg !== 'string' || entry.pkg === '') continue
  const zh = entry.zh
  if (!zh || typeof zh.title !== 'string') continue
  map[entry.pkg] = [zh.title, typeof zh.description === 'string' ? zh.description : '']
}

/* 紧凑形态：pkg -> [中文名（含原包名的（）形态）, 中文说明]；按包名排序保证幂等 */
const keys = Object.keys(map).sort()
const body = keys.map((k) => '      ' + JSON.stringify(k) + ': ' + JSON.stringify(map[k]) + ',').join('\n')
const block = [
  START,
  '    /* 内置 catalog 的中文快照（8 条以内、约 1KB）：旧宿主（<2.9）不发 displayName/localizedDescription，',
  '       而客户端半体是热更新的，所以用这份仓库数据兜底，让列表在旧宿主下也能直接显示优化结果。',
  '       只含仓库内置条目；用户覆盖层（LLM 生成）不在其中，缺失时如实说明而不是编造。 */',
  '    var CATALOG_ZH = {',
  body,
  '    };',
  END,
].join('\n')

const src = fs.readFileSync(CLIENT, 'utf8')
const i = src.indexOf(START)
const j = src.indexOf(END)
if (i < 0 || j < 0 || j < i) {
  console.error('FAIL 找不到快照标记，请先在 client.js 里放入 START/END 两个标记')
  process.exit(1)
}
const next = src.slice(0, i) + block + src.slice(j + END.length)
const changed = next !== src

if (process.argv.includes('--check')) {
  if (changed) {
    console.error('FAIL 客户端里的 catalog 快照与 references/dsh-plugin-locale-catalog.json 不一致（漂移）')
    console.error('     修复：node scripts/build-client-catalog.mjs')
    process.exit(1)
  }
  console.log('PASS catalog 快照与内置 catalog 一致（' + keys.length + ' 条）')
  process.exit(0)
}

if (changed) {
  fs.writeFileSync(CLIENT, next)
  console.log('OK 已注入 ' + keys.length + ' 条中文快照到 client.js')
} else {
  console.log('OK 快照已是最新（' + keys.length + ' 条）')
}

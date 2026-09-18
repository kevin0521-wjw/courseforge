/**
 * importer 测试夹具：在 Node 里把 web/js/importer.js 真跑起来。
 *
 * 为什么需要它：
 *   CMap 源选择这一层出过两次误诊 —— 只测 pdf.js（等于绕过 importer），
 *   就测不出「首选源取不到时会不会换下一个源」。
 *   而浏览器自动化在本机会挂死（agent-browser 已知问题），
 *   于是用 vm + 极简 DOM stub 顶替宿主环境：
 *   跑的是【真实的 importer.js 源码】，只是把 window/document 换成可控的假货，
 *   并且能通过替换源码里的 CMAP_SOURCES 来模拟各种源组合（含取不到的源）。
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEB = join(ROOT, 'web');
export const CMAPS = join(WEB, 'cmaps');
export const IMPORTER = join(WEB, 'js', 'importer.js');
/** 一个保证不存在的 CMap 目录，用来模拟「这个源取不到」 */
export const MISSING_CMAPS = join(ROOT, '_nonexistent-cmaps') + '/';

/** pdfjs-dist 是可选依赖：没装时返回 null，调用方据此跳过测试 */
export function loadPdfJs() {
  try { return require('pdfjs-dist/legacy/build/pdf.js'); } catch { return null; }
}

/**
 * 浏览器等价 CMap 取源工厂。
 *
 * 为什么要自己写：pdf.js 自带的 NodeCMapReaderFactory 只认本地路径，
 * 给它 https 的 cMapUrl 会直接失败 —— 那样「镜像源兜底」永远测不出来，
 * 而浏览器里的 DOMCMapReaderFactory 是能 fetch https 的。
 * 这里两种都支持：http(s) 走 fetch，其余按文件路径读（正斜杠/反斜杠都认）。
 */
export function makeSmartCMapFactory(PDFJS) {
  return class SmartCMapFactory {
    constructor({ baseUrl, isCompressed }) {
      this.baseUrl = baseUrl;
      this.isCompressed = isCompressed;
    }
    async fetch({ name }) {
      if (!this.baseUrl) throw new Error('The CMap "baseUrl" parameter must be specified');
      const p = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '');
      let bytes;
      if (/^https?:\/\//.test(p)) {
        const res = await fetch(p);
        if (!res.ok) throw new Error('CMap HTTP ' + res.status + ' @ ' + p);
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        bytes = new Uint8Array(readFileSync(p));
      }
      return {
        cMapData: bytes,
        compressionType: this.isCompressed
          ? PDFJS.CMapCompressionType.BINARY
          : PDFJS.CMapCompressionType.NONE
      };
    }
  };
}

// ==================== 极简 DOM stub ====================

function makeEl(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    files: null,
    hidden: false,
    disabled: false,
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    removeEventListener() {},
    click() {},
    getAttribute() { return null; },
    setAttribute() {},
    closest() { return null; },
    querySelectorAll() { return []; },
    getContext() { return {}; },
    appendChild() {},
    remove() {}
  };
}

/** 测试也能直接拿到 DOM 桩：OCR 归一化等纯逻辑测试复用同一套最小环境 */
export function makeDom() {
  const els = {};
  const statusHistory = [];
  const getEl = (id) => (els[id] = els[id] || makeEl(id));

  // 记录状态变化历史 —— 出错时能看清 runPdf 究竟走到了哪一步
  const statusEl = getEl('importStatus');
  let last = null;
  Object.defineProperty(statusEl, 'textContent', {
    get() { return last; },
    set(v) { if (v !== last) { last = v; if (v) statusHistory.push(v); } }
  });

  const documentStub = {
    readyState: 'complete',
    baseURI: 'http://127.0.0.1:5199/',
    getElementById: (id) => getEl(id),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (tag) => makeEl('<' + tag + '>'),
    head: { appendChild() {} }
  };
  return { els, getEl, documentStub, statusHistory };
}

// ==================== 运行 ====================

/** 把源码里的 CMAP_SOURCES 数组整体替换掉（模拟不同源组合）。返回 null 表示没匹配上。 */
export function patchCMapSources(sourceCode, sources) {
  const list = sources.map((s) => JSON.stringify(s)).join(', ');
  const re = /var CMAP_SOURCES = \[[\s\S]*?\];/;
  if (!re.test(sourceCode)) return null;
  return sourceCode.replace(re, 'var CMAP_SOURCES = [' + list + '];');
}

/**
 * 跑一次完整的「喂 PDF → 解析」流程。
 * @param {object} opts
 * @param {string} [opts.desktopCmapBase] 模拟桌面端 preload 注入的 CourseForgeDesktop.cmapBase
 *        （不传 = 网页版环境，没有 CourseForgeDesktop）
 * @returns {{summary:string, status:string, history:string[], win:object}}
 */
export async function runImporter({ pdfPath, pdfjsLib, sourceCode, timeoutMs = 60_000, desktopCmapBase }) {
  const src = sourceCode || readFileSync(IMPORTER, 'utf8');
  const env = makeDom();

  const win = {
    document: env.documentStub,
    location: { protocol: 'http:', href: 'http://127.0.0.1:5199/' },
    navigator: {},
    addEventListener() {},
    pdfjsLib // 直接注入，跳过 CDN 脚本加载
  };
  if (desktopCmapBase) {
    // 模拟桌面端 preload 注入的桥（importer.js 只读 cmapBase 这一个字段）
    win.CourseForgeDesktop = { isDesktop: true, cmapBase: desktopCmapBase };
  }
  win.window = win;
  win.self = win;

  const ctx = vm.createContext({
    window: win,
    self: win,
    document: env.documentStub,
    navigator: {},
    location: win.location,
    console, setTimeout, clearTimeout, Promise, File, Blob, URL, fetch, Response
  });

  for (const f of ['core.js', 'parser.js', 'pdf-layout.js']) {
    vm.runInContext(readFileSync(join(WEB, 'js', f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext(src, ctx, { filename: 'importer.js' });

  if (!win.CourseImporter) throw new Error('importer.js 没有挂到 window.CourseImporter');
  win.CourseImporter.mount({
    getSettings: () => ({ totalWeeks: 16 }),
    apply() {},
    toast() {}
  });

  const fp = env.getEl('importPdf');
  const change = (fp._handlers.change || [])[0];
  if (!change) throw new Error('未绑定 #importPdf 的 change 事件');

  const bytes = readFileSync(pdfPath);
  fp.files = [new File([new Uint8Array(bytes)], 'timetable.pdf')];
  change({ target: fp });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const done = env.getEl('importSummary').textContent;
    const st = env.getEl('importStatus').textContent || '';
    if (done) break;
    if (/失败|读不出/.test(st)) break;
  }

  return {
    summary: env.getEl('importSummary').textContent,
    status: env.getEl('importStatus').textContent || '',
    history: env.statusHistory,
    win
  };
}

/**
 * PDF 提取层测试 —— 守护「中文 PDF 能不能解出文字」这一层。
 *
 * 为什么单独测这一层：
 * 之前只测了「解析器」，而解析器的测试夹具是用 Python 从 PDF 内容流里
 * 抽出来的坐标片段 —— 那等于**绕过了 pdf.js 这一层**。结果线上真实失败
 * 的原因是 pdf.js 一个字符都没解出来（缺 cMapUrl），而全部测试照样通过。
 * Bug 恰好长在那个没人测的缝隙里。本文件把缝隙补上。
 *
 * 核心事实：Type0 + CMap 编码（如 UniGB-UCS2-H）的中文 PDF，
 * pdf.js 必须拿到 cMapUrl 指向的 .bcmap 才能解码；缺了会返回 0 个 item。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB = join(ROOT, 'web');
const CMAPS = join(WEB, 'cmaps');
const FIXTURE = join(HERE, 'fixtures', 'cjk-cmap.pdf');

// 夹具里写了这 6 段文字；全部必须能提取出来
const EXPECTED = ['星期一', '星期二', '高等数学', '学术英语', '张琴', '顾海悦'];

// pdfjs-dist 是可选依赖：缺了就跳过（CI 里没装时不应误报失败）
let pdfjs = null;
try {
  pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
} catch {
  pdfjs = null;
}

const skip = pdfjs ? false : '未安装 pdfjs-dist（可选依赖），跳过 PDF 提取层测试';

/** 用给定选项提取第 1 页的全部文字 */
async function extract(pdfPath, opts) {
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, ...opts }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join('');
  const nonEmpty = tc.items.filter((i) => i.str && i.str.trim()).length;
  await doc.destroy();
  return { text, itemCount: tc.items.length, nonEmpty };
}

// ==================== 夹具本身 ====================

test('夹具：合成中文 PDF 存在且非空', () => {
  assert.ok(existsSync(FIXTURE), `缺少夹具 ${FIXTURE}；用 tools/make-cjk-pdf-fixture.py 生成`);
  assert.ok(readFileSync(FIXTURE).length > 500, '夹具文件过小，可能生成失败');
});

// ==================== 根因守护 ====================

test(
  '根因：不给 cMapUrl 时 pdf.js 解不出任何中文（这正是线上「未提取到文字」的原因）',
  { skip },
  async () => {
    const r = await extract(FIXTURE, {});
    // 注意：不是乱码而是彻底空白 —— 0 个 item。
    // 若哪天 pdf.js 改成默认内置 CMap，这条断言会失败，
    // 那时说明可以移除 cMapUrl 依赖，属于「有意为之」的变更，不是回归。
    assert.equal(
      r.itemCount,
      0,
      `不带 cMapUrl 本应解不出文字（实测 ${r.itemCount} 个 item、${r.text.length} 字符）。` +
        '若此项失败，说明 pdf.js 行为变了，请复核 importer.js 是否需要继续传 cMapUrl。'
    );
    assert.equal(r.text.replace(/\s/g, ''), '');
  }
);

test('修复：带上 cMapUrl 后，夹具里的中文字全部正确提取', { skip }, async () => {
  const r = await extract(FIXTURE, { cMapUrl: CMAPS + '/', cMapPacked: true });
  for (const word of EXPECTED) {
    assert.ok(
      r.text.includes(word),
      `应提取到「${word}」，实际提取内容：${JSON.stringify(r.text)}`
    );
  }
  assert.equal(r.nonEmpty, EXPECTED.length, '非空 item 数应等于写入的文字段数');
});

test('修复：cMapUrl 指向 web/cmaps/（随包发布的本地目录）即可，无需外部网络', { skip }, async () => {
  // 用相对路径形式（生产代码里的 CMAP_BASE 就是 'cmaps/'）
  const r = await extract(FIXTURE, { cMapUrl: join(WEB, 'cmaps') + '/', cMapPacked: true });
  assert.ok(r.text.includes('高等数学'), '本地 cmaps 目录必须能独立完成解码');
});

// ==================== 交付物守护：cmaps 目录必须随包发布 ====================

test('交付：web/cmaps/ 存在且包含中文 PDF 必需的 CMap 文件', () => {
  assert.ok(existsSync(CMAPS), '缺少 web/cmaps/ —— 中文 PDF 会全部解析失败');
  const files = readdirSync(CMAPS).filter((f) => f.endsWith('.bcmap'));
  assert.ok(files.length > 100, `cmaps 文件过少（${files.length} 个），疑似复制不完整`);

  // 这几个是中文 PDF 的常客：编码 CMap + CID→Unicode 映射
  for (const need of ['UniGB-UCS2-H.bcmap', 'UniGB-UTF16-H.bcmap', 'Adobe-GB1-UCS2.bcmap']) {
    assert.ok(files.includes(need), `缺少关键 CMap：${need}`);
  }
  // 探针文件必须在（importer.js 用它判断本地目录可用性）
  assert.ok(
    files.includes('UniGB-UCS2-H.bcmap'),
    'importer.js 的 CMAP_PROBE 依赖 UniGB-UCS2-H.bcmap'
  );
});

// ==================== 源码守护：生产代码必须真的传这两个选项 ====================

test('源码：runPdf 必须向 getDocument 传 cMapUrl 与 cMapPacked', () => {
  const src = readFileSync(join(WEB, 'js', 'importer.js'), 'utf8');

  const call = /getDocument\(\{([\s\S]*?)\}\)\.promise/.exec(src);
  assert.ok(call, '未找到 getDocument 调用，源码结构可能已变化');

  const opts = call[1];
  assert.ok(
    /cMapUrl\s*:/.test(opts),
    'getDocument 必须传 cMapUrl —— 否则中文 PDF 一个字符都读不出来'
  );
  assert.ok(
    /cMapPacked\s*:\s*true/.test(opts),
    'getDocument 必须传 cMapPacked: true（.bcmap 是压缩格式）'
  );

  // 探针与回退逻辑必须存在，否则「部署时漏传 cmaps/」会静默失效
  assert.ok(/resolveCMapBase/.test(src), '应保留 CMap 目录探测/回退逻辑');
  assert.ok(/CMAP_CDN/.test(src), '应保留 CDN 回退地址');
});

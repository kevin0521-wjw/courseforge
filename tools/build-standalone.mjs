/**
 * 单文件打包：把 web/ 的 CSS/JS 内联进一个 HTML，输出 dist/CourseForge-standalone.html
 * 用途：分享给他人、双击即用、无服务器环境
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');
const OUT = join(ROOT, 'dist', 'CourseForge-standalone.html');

const html = await readFile(join(WEB, 'index.html'), 'utf-8');
const css = await readFile(join(WEB, 'css', 'style.css'), 'utf-8');
const scripts = ['core.js', 'storage.js', 'render.js', 'parser.js', 'importer.js', 'app.js'];
let out = html.replace(
  /<link rel="stylesheet" href="css\/style.css">/,
  '<style>\n' + css + '\n</style>'
);

for (const name of scripts) {
  const code = await readFile(join(WEB, 'js', name), 'utf-8');
  if (code.includes('</script>')) {
    console.error(`错误：${name} 中包含 "</script>"，无法安全内联`);
    process.exit(1);
  }
  const tag = new RegExp(`<script src="js/${name.replace('.', '\\.')}"></script>`);
  if (!tag.test(out)) {
    console.error(`错误：index.html 中找不到脚本引用 js/${name}`);
    process.exit(1);
  }
  out = out.replace(tag, '<script>\n' + code + '\n</script>');
}

if (/<link rel="stylesheet"|<script src=/.test(out)) {
  console.error('错误：仍有未内联的外部资源引用');
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out, 'utf-8');
console.log(`打包完成: ${OUT}（${(out.length / 1024).toFixed(1)} KB）`);

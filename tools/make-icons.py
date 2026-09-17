#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 web/icon.svg 生成各平台需要的位图图标。

为什么需要这个脚本
------------------
`web/icon.svg` 只管得了现代桌面浏览器。有两个地方明确不吃 SVG：

1. **iOS / iPadOS 的 apple-touch-icon** —— Safari「添加到主屏幕」只认 PNG，
   挂 SVG 拿不到图标（网页能装，图标是空白或页面截图）。这是之前真实存在的缺陷。
2. **Electron 打包用的 .ico** —— Windows 的 exe 资源、任务栏、安装向导都要 .ico，
   且要求至少 256×256；缺了就只能顶着 Electron 默认图标。

所以「位图是派生产物，源只有一个」：唯一真源仍然是 `web/icon.svg`。
本脚本用手写的极简 SVG 解析器读出线性渐变的色标和所有 `<rect>`（含圆角 rx），
统一在 4 倍分辨率上绘制、最后 LANCZOS 缩小 —— 直接按目标尺寸绘制的话，
16px 那种小图上的圆角会糊成一团。

用法::

    python tools/make-icons.py           # 生成全部产物
    python tools/make-icons.py --check   # 只比对不写盘（产物是否与 SVG 同步）

产物清单与「谁在用」的对应关系，见下面 TARGETS。产物本身要入库（CI 不装 Pillow），
由 tests/icons.test.mjs 做存在性/尺寸/引用一致性校验。
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:  # pragma: no cover
    # 本仓库其余 Python 工具只用标准库（PDF 夹具是手写字节），图标是唯一例外。
    # 产物已经入库，所以**CI 不需要 Pillow** —— 只有想重新生成图标的人才要装。
    sys.stderr.write(
        '需要 Pillow 才能生成图标（其余 Python 工具都是纯标准库）。\n'
        '  python -m pip install Pillow\n'
        '或者换一个已经装了 Pillow 的解释器来跑：\n'
        '  <python-with-pillow> tools/make-icons.py\n'
        '注意：图标产物已入库，日常开发/CI 无需本脚本。\n'
    )
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parent.parent
SVG_PATH = ROOT / 'web' / 'icon.svg'

# 超采样倍数：小尺寸图标的圆角全靠它才不糊
SS = 4
# 渐变母版的边长。渐变是线性的，放大缩小都还是同一个渐变，
# 所以只在低分辨率上算一次、之后一律 resize —— 省掉百万级的逐像素循环。
GRAD_N = 512
LUT_N = 1024

# ---- 产物定义 ----
# PNG：路径 → 边长
PNG_TARGETS = [
    ('web/icon-180.png', 180),   # apple-touch-icon（iOS 惯例 180×180）
    ('web/icon-192.png', 192),   # manifest any（Android 主屏）
    ('web/icon-512.png', 512),   # manifest any（启动画面/高分屏）
    ('web/icon-maskable-512.png', 512),  # manifest maskable，见下面 MASKABLE_ART_SCALE
]
ICO_TARGET = 'desktop/build/icon.ico'
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# 同步锁：只记「生成时 icon.svg 的哈希」。
# 存在的意义是堵一个静默分歧 —— 改了 icon.svg（比如换品牌色）却忘了重跑本脚本时，
# 浏览器标签页用新 SVG、PWA/桌面端还是旧 PNG，肉眼几乎发现不了。
# tests/icons.test.mjs 会比对它，且那条测试不需要 Pillow，所以在 CI 里也生效。
LOCK_TARGET = 'web/icons.lock.json'

# maskable 图标要留安全区：系统可能裁成圆形/水滴形，
# 只有中间 80% 直径的圆内是「保证可见」的。原图日历四角在圆形之外，
# 直接宣告 maskable 会被裁掉边角，所以把美术缩小到 0.72 居中，
# 底色仍是满幅渐变（maskable 要求背景铺满，不能有透明边）。
MASKABLE_ART_SCALE = 0.72

_ATTR = re.compile(r'([A-Za-z-]+)\s*=\s*"([^"]*)"')
_RECT = re.compile(r'<rect\b([^>]*?)/?>')
_STOP = re.compile(r'<stop\b([^>]*?)/?>')
_GRAD = re.compile(r'<linearGradient\b([^>]*?)>(.*?)</linearGradient>', re.S)
_URLREF = re.compile(r'url\(#([^)]+)\)')


def _attrs(chunk):
    return dict(_ATTR.findall(chunk))


def _rgb(text):
    """#rgb / #rrggbb → (r, g, b)。只支持十六进制，够用且不会静默出错。"""
    t = (text or '').strip()
    if not t.startswith('#'):
        raise ValueError('只支持 #rgb / #rrggbb 形式的颜色，遇到：%r' % t)
    h = t[1:]
    if len(h) == 3:
        h = ''.join(ch * 2 for ch in h)
    if len(h) != 6:
        raise ValueError('颜色位数不对：%r' % t)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _mix(c0, c1, t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return tuple(round(a + (b - a) * t) for a, b in zip(c0, c1))


class Icon(object):
    """把 icon.svg 里我们用到的子集解析成可绘制结构。"""

    def __init__(self, path):
        src = path.read_text('utf-8')

        vb = _attrs(re.search(r'<svg\b([^>]*)>', src).group(1)).get('viewBox', '')
        parts = [float(v) for v in vb.replace(',', ' ').split()]
        if len(parts) != 4:
            raise ValueError('icon.svg 必须有 viewBox="0 0 W H"')
        self.w, self.h = parts[2], parts[3]
        if self.w != self.h:
            raise ValueError('图标必须正方形（当前 %s×%s）' % (self.w, self.h))

        self.grads = {}
        for m in _GRAD.finditer(src):
            a = _attrs(m.group(1))
            stops = []
            for s in _STOP.finditer(m.group(2)):
                sa = _attrs(s.group(1))
                stops.append((float(sa.get('offset', 0)), _rgb(sa.get('stop-color', '#000'))))
            # 色标必须按 offset 排好序，否则线性插值区间会乱
            stops.sort(key=lambda kv: kv[0])
            if len(stops) < 2:
                raise ValueError('线性渐变 #%s 至少要有两个色标' % a.get('id'))
            self.grads[a.get('id')] = {
                'stops': stops,
                # SVG 默认 x1=0 y1=0 x2=1 y2=0（objectBoundingBox 单位）
                'x1': float(a.get('x1', 0)), 'y1': float(a.get('y1', 0)),
                'x2': float(a.get('x2', 1)), 'y2': float(a.get('y2', 0)),
            }

        self.rects = []
        for m in _RECT.finditer(src):
            a = _attrs(m.group(1))
            self.rects.append({
                'x': float(a.get('x', 0)), 'y': float(a.get('y', 0)),
                'w': float(a.get('width', 0)), 'h': float(a.get('height', 0)),
                'rx': float(a.get('rx', 0)),
                'fill': a.get('fill', '#000'),
            })
        if not self.rects:
            raise ValueError('icon.svg 里没解析出任何 <rect>，解析器可能跟不上格式变化了')

    # ---- 渐变 ----
    def _color_at(self, stops, t, lut):
        i = int(t * (LUT_N - 1) + 0.5)
        i = 0 if i < 0 else (LUT_N - 1 if i >= LUT_N else i)
        return lut[i]

    def gradient_master(self, gid):
        """把某个渐变渲染成 GRAD_N×GRAD_N 的母版（覆盖单位方框）。"""
        g = self.grads[gid]
        n = GRAD_N
        stops = g['stops']
        lut = [_mix_along(stops, i / (LUT_N - 1)) for i in range(LUT_N)]

        # t = ((p - a)·d) / |d|²  —— 展开成「行基准 + 列步长」，避免内层重复算点乘
        ax, ay = g['x1'] * n, g['y1'] * n
        bx, by = g['x2'] * n, g['y2'] * n
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        if den == 0:
            # 退化渐变（起点终点重合）：SVG 规定整个区域用最后一个色标
            return Image.new('RGB', (n, n), stops[-1][1])

        px = bytearray(n * n * 3)
        step = dx / den
        pos = 0
        for y in range(n):
            base = ((y - ay) * dy - ax * dx) / den
            for x in range(n):
                r, g_, b = self._color_at(stops, base + x * step, lut)
                px[pos] = r
                px[pos + 1] = g_
                px[pos + 2] = b
                pos += 3
        return Image.frombytes('RGB', (n, n), bytes(px))

    # ---- 绘制 ----
    def render(self, size, art_scale=1.0, full_bleed=False, master_cache=None):
        """渲染一张 size×size 的 RGBA 图。

        art_scale < 1 → 美术整体向中心缩小（maskable 安全区）。
        full_bleed=True → 跳过首个渐变矩形，改成整幅铺满的方形渐变
        （maskable 不允许透明边，圆角留白会露出透明像素）。
        """
        W = size * SS
        k = W / float(self.w)
        cx, cy = self.w / 2.0, self.h / 2.0
        canvas = Image.new('RGBA', (W, W), (0, 0, 0, 0))

        for idx, r in enumerate(self.rects):
            # 满幅底色（首层）不受 art_scale 影响：maskable 要求背景铺满整幅，
            # 跟着美术一起缩就会在四周露出透明边（曾真的这样错过一次）。
            s = 1.0 if (idx == 0 and full_bleed) else art_scale
            x0 = cx + (r['x'] - cx) * s
            y0 = cy + (r['y'] - cy) * s
            x1 = x0 + r['w'] * s
            y1 = y0 + r['h'] * s
            box = [x0 * k, y0 * k, x1 * k, y1 * k]
            radius = r['rx'] * s * k

            ref = _URLREF.search(r['fill'])
            if ref:
                gid = ref.group(1)
                if gid not in self.grads:
                    raise ValueError('fill 引用了不存在的渐变 #%s' % gid)
                master = (master_cache or {}).get(gid)
                if master is None:
                    master = self.gradient_master(gid)
                    if master_cache is not None:
                        master_cache[gid] = master
                tw = max(1, int(round(box[2] - box[0])))
                th = max(1, int(round(box[3] - box[1])))
                layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
                layer.paste(master.resize((tw, th), Image.BILINEAR).convert('RGBA'),
                            (int(round(box[0])), int(round(box[1]))))
            else:
                layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
                d = ImageDraw.Draw(layer)
                d.rectangle(box, fill=_rgb(r['fill']) + (255,))

            if idx == 0 and full_bleed:
                # 首层是底色：整幅铺满，且不做圆角
                canvas = layer
                continue

            # 圆角用「遮罩 + 合成」而不是 rounded_rectangle 直接画：
            # 渐变层是贴图，没法用 fill= 画圆角
            if radius > 0:
                mask = Image.new('L', (W, W), 0)
                ImageDraw.Draw(mask).rounded_rectangle(
                    box, radius=min(radius, min(box[2] - box[0], box[3] - box[1]) / 2.0), fill=255)
                # 逐像素取小 = 图层透明度 ∩ 圆角遮罩
                layer.putalpha(ImageChops.darker(layer.getchannel('A'), mask))

            canvas = Image.alpha_composite(canvas, layer)

        return canvas.resize((size, size), Image.LANCZOS)


def _mix_along(stops, t):
    if t <= stops[0][0]:
        return stops[0][1]
    if t >= stops[-1][0]:
        return stops[-1][1]
    for i in range(len(stops) - 1):
        o0, c0 = stops[i]
        o1, c1 = stops[i + 1]
        if o0 <= t <= o1:
            span = o1 - o0
            return _mix(c0, c1, 0.0 if span <= 0 else (t - o0) / span)
    return stops[-1][1]


def build(icon):
    """返回 {相对路径: PIL.Image}，不落盘。"""
    out = {}
    cache = {}
    for rel, size in PNG_TARGETS:
        scale = MASKABLE_ART_SCALE if 'maskable' in rel else 1.0
        out[rel] = icon.render(size, art_scale=scale, full_bleed=('maskable' in rel),
                               master_cache=cache)
    # ICO 用离线渲染好的 256 做母版；Pillow 会自己按 LANCZOS 缩到各档尺寸
    out[ICO_TARGET] = icon.render(256, master_cache=cache)
    return out


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    ap = argparse.ArgumentParser(description='从 web/icon.svg 生成 PNG / ICO 图标')
    ap.add_argument('--check', action='store_true',
                    help='只校验产物是否与 SVG 同步（像素比对，容忍 ±2 的编码差异），不写盘')
    args = ap.parse_args(argv)

    icon = Icon(SVG_PATH)
    images = build(icon)

    if args.check:
        return check(images) or check_lock()

    for rel, img in images.items():
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith('.ico'):
            img.save(path, format='ICO', sizes=[(s, s) for s in ICO_SIZES])
        else:
            img.save(path, format='PNG', optimize=True)
        print('  ✅ %-32s %s' % (rel, _describe(path, img)))

    if check(images) != 0:
        return 1  # 刚写盘就对不上，说明本脚本自身有 bug

    lock = ROOT / LOCK_TARGET
    lock.write_text(json.dumps({
        'source': SVG_PATH.relative_to(ROOT).as_posix(),
        'sha256': _sha256(SVG_PATH),
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('  ✅ %-32s 记录 icon.svg 的哈希' % LOCK_TARGET)

    print('\n源：%s（%d 个矩形）' % (SVG_PATH.relative_to(ROOT).as_posix(), len(icon.rects)))
    return 0


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _describe(path, img):
    if path.suffix == '.ico':
        with Image.open(path) as im:
            sizes = sorted(im.info.get('sizes', []))
        return 'ico %s (%d B)' % (','.join('%d' % s[0] for s in sizes), path.stat().st_size)
    return 'png %d×%d (%d B)' % (img.width, img.height, path.stat().st_size)


def check_lock():
    """比对 web/icons.lock.json 与当前 icon.svg 的哈希。

    这是「忘了重新生成」的唯一防线：改了 SVG 但没跑脚本时，位图还停在旧设计上，
    而浏览器标签页用的是新 SVG —— 两边不一致却没有任何报错。
    本函数不依赖 Pillow，所以 tests/icons.test.mjs 能原样搬过去在 CI 里跑。
    """
    lock = ROOT / LOCK_TARGET
    if not lock.exists():
        print('❌ %s 不存在（跑一次 `python tools/make-icons.py`）' % LOCK_TARGET)
        return 1
    recorded = json.loads(lock.read_text('utf-8')).get('sha256')
    actual = _sha256(SVG_PATH)
    if recorded != actual:
        print('❌ web/icon.svg 已改动，但图标产物没重新生成：')
        print('   锁里记的 sha256 = %s' % recorded)
        print('   当前 SVG 的 sha256 = %s' % actual)
        print('   → 跑一次 `python tools/make-icons.py`')
        return 1
    print('✅ 图标产物与 web/icon.svg 同步（sha256 %s…）' % actual[:12])
    return 0


def check(images):
    """比对期望图与磁盘产物。用像素比对而不是字节比对 ——
    不同 Pillow 版本压出来的 PNG 字节可能不同，字节比对会在别人机器上假红。"""
    bad = []
    for rel, expect in images.items():
        path = ROOT / rel
        if not path.exists():
            bad.append('%s 不存在（跑一次 `python tools/make-icons.py`）' % rel)
            continue
        if rel.endswith('.ico'):
            with Image.open(path) as im:
                sizes = sorted(s[0] for s in im.info.get('sizes', []))
            missing = [s for s in ICO_SIZES if s not in sizes]
            if missing:
                bad.append('%s 缺少尺寸：%s' % (rel, missing))
            elif max(sizes) < 256:
                bad.append('%s 最大尺寸只有 %d，electron-builder 要求 ≥256' % (rel, max(sizes)))
            continue
        with Image.open(path) as im:
            if (im.width, im.height) != (expect.width, expect.height):
                bad.append('%s 尺寸是 %d×%d，应为 %d×%d'
                           % (rel, im.width, im.height, expect.width, expect.height))
                continue
            diff = _max_pixel_diff(im.convert('RGBA'), expect)
            if diff > 2:
                bad.append('%s 与 icon.svg 不一致（最大像素差 %d）' % (rel, diff))
    if bad:
        print('❌ 图标产物对不上 web/icon.svg 的渲染结果：')
        for b in bad:
            print('   - ' + b)
        return 1
    print('✅ 位图渲染与 web/icon.svg 一致（%d 个文件）' % len(images))
    return 0


def _max_pixel_diff(a, b):
    return max(band[1] for band in ImageChops.difference(a, b).getextrema())


if __name__ == '__main__':
    sys.exit(main())

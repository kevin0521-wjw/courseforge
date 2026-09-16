#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「旋转绘制的中文课表 PDF」回归夹具（隐私安全、体积极小）。

==================== 为什么必须存在这个夹具 ====================
线上真实失败链条是两段，缺任何一段都复现不出来：

  ①类型：字体是 Type0 + CMap 编码（STSong-Light / UniGB-UCS2-H，未嵌入）。
    pdf.js 缺 cMapUrl 时【返回 0 个 item】—— 不是乱码，是彻底空白。
    → 由 tests/fixtures/cjk-cmap.pdf 守护。

  ②类型：内容流第一行是 `0 1 -1 0 595 0 cm`，即
    「在竖版页面里旋转 90° 绘制横版表格」。
    pdf.js 会把该矩阵烘焙进【每一个】item.transform，
    于是整页片段形如 [0,size,-size,0,e,f]（带旋转分量）。
    早期 normalizeItems「一见旋转就丢弃」→ 整页被清空 → 一门课都解析不出。
    → 由本夹具守护。

⚠️ 关键教训（第一版夹具就栽在这里）：
   本文件第一版只写了页级 `/Rotate 90`，**没有**那条 `cm`。
   实测 pdf.js 对页级 /Rotate【不改变文字坐标】——它只影响 viewport 渲染，
   拿到的 transform 仍是水平的 [size,0,0,size,x,y]。
   结果夹具「看起来很像」，却根本触发不了那段旋转过滤逻辑，
   测试照样全绿而线上照样失败。夹具不 representative，比没有夹具更糟。
   所以本脚本严格照抄真实 PDF 的几何：页 595×842 + /Rotate 90 +
   内容流首行 `0 1 -1 0 595 0 cm` + 字体 STSong-Light/UniGB-UCS2-H。

==================== 版面为何长这样 ====================
为了让「完整链路」（提取 → 版面还原 → 解析）真的跑出课程，
版面必须同时满足 pdf-layout.js 的几个硬性门槛，这里逐条对齐：

  · findDayColumns 要求表头行至少认出 4 个星期 → 本夹具用 4 个星期列（下限）
  · isTable 要求 列数 >= 3 且「含多格的视觉行」>= 2   → 5 列、17 个视觉行
  · findColumns 假设列宽等距                                → 列间距统一 130pt
    （真实 PDF 是 103.84pt 等距；间距不等会让 findColumns 推错列网格）
  · mergeSegments 的 secCol 需 >= 3 行「纯节次标记」        → 4 个节次行
  · 断格：格内行距 13pt（不触发 MERGE_GAP=22），
    跨格间距 21pt（在 [MIN_BREAK_GAP=13, MERGE_GAP=22) 之间）——
    刻意让「断格」只能靠内容形态判断触发，与真实课表的行为一致。

用法：
    python tools/make-rotated-timetable-fixture.py tests/fixtures/cjk-timetable-rotated.pdf
"""

import sys
from pathlib import Path

# ---- 页面与旋转 ----
PAGE_W, PAGE_H = 595.0, 842.0
ROTATE = 90

# ---- 横版绘制坐标（旋转前）。真实 PDF 首行就是这个矩阵 ----
# 变换关系：横版 (u, v) → 页面坐标 (595 - v, u)
# 因此横版坐标必须满足 u ∈ [0, 842]、v ∈ [0, 595]，否则文字会落到页面外被 pdf.js 丢弃。
CM_ROTATE = "0 1 -1 0 595 0 cm"

# 列起点（横版 x）：节次列 + 4 个星期列，间距统一 130
COL_SEC = 40.0
COL_DAY = {1: 170.0, 2: 300.0, 3: 430.0, 4: 560.0}

HEADER_Y = 521.0
# 4 个节次行的首行基线；行距 60
ROW_Y = [500.0, 440.0, 380.0, 320.0]
LINE_DY = 13.0  # 格内堆叠行距

HEADER = ["节次", "星期一", "星期二", "星期三", "星期四"]
SECTIONS = ["1-2", "3-4", "5-6", "7-8"]

# 字号（照抄真实 PDF：表头 12、课名/编号 9、详情 8）
SZ_HEADER = 12
SZ_NAME = 9
SZ_DETAIL = 8

# 每格 4 行堆叠，与真实 PDF 同形：
#   <课名> / <(课程编号)> / <(N-M节)周次/教师:X> / <课备注:/学分:N>
# 元组 = (课名, 课程编号, 详情行, 备注行)
CELLS = {
    (1, 1): ("程序设计基础", "(JBK0101001)", "(1-2节)1-16周/教师:张三/选", "课备注:/学分:3.0"),
    (1, 2): ("学术英语", "(GBK2300001)", "(1-2节)1-16周/教师:李四", "选课备注:/学分:2.0"),
    (1, 3): ("高等数学", "B(1)(GBK0101003)", "(1-2节)1-16周/教师:王五/选", "课备注:/学分:5.0"),
    (1, 4): ("体育(1)(GBK2800002)", "(GBK2800002)", "(1-2节)1-16周/教师:赵六/选", "课备注:男生羽毛球(基础)/学分:1.0"),
    (2, 1): ("信息与人工智能基础", "(GBK2300005)", "(3-4节)1-16周/教师:孙七/选", "课备注:/学分:2.0"),
    (2, 3): ("中国近现代史纲要", "(GBK2000004)", "(3-4节)1-16周/教师:周八", "选课备注:/学分:3.0"),
    (3, 2): ("大学英语(听说)", "(GBK0300001)", "(5-6节)1-16周/教师:吴九", "选课备注:/学分:2.0"),
    (3, 4): ("线性代数", "(GBK0102003)", "(5-6节)1-16周/教师:郑十/选", "课备注:/学分:4.0"),
    (4, 1): ("数据结构", "(GBK0104001)", "(7-8节)1-16周/教师:冯一/选", "课备注:/学分:4.0"),
    (4, 2): ("概率论与数理统计", "(GBK0102005)", "(7-8节)1-16周/教师:陈二", "选课备注:/学分:4.0"),
    (4, 3): ("计算机网络", "(GBK0105001)", "(7-8节)1-16周/教师:褚三/选", "课备注:/学分:3.0"),
    (4, 4): ("思想道德与法治", "(GBK0900001)", "(7-8节)1-16周/教师:卫四", "选课备注:/学分:3.0"),
}

# 供测试断言的期望值：(星期, 课名, 教师, 起始节, 结束节)
# 星期由所在列决定：COL_DAY 的键 1..4 对应 星期一..星期四，
# 因此 (行, 列) 里的「列」就是星期几 —— 下面按 CELLS 的键直接展开，避免手抄错。
# 注意课名是【解析后】的名称：「体育(1)(GBK2800002)」经过 stripCourseCode 应为「体育」，
# 「高等数学」+「B(1)(GBK0101003)」应拼回「高等数学 B」。
_COURSE_NAME = {
    (1, 1): "程序设计基础",
    (1, 2): "学术英语",
    (1, 3): "高等数学 B",
    (1, 4): "体育",
    (2, 1): "信息与人工智能基础",
    (2, 3): "中国近现代史纲要",
    (3, 2): "大学英语(听说)",
    (3, 4): "线性代数",
    (4, 1): "数据结构",
    (4, 2): "概率论与数理统计",
    (4, 3): "计算机网络",
    (4, 4): "思想道德与法治",
}
_TEACHER = {
    (1, 1): "张三", (1, 2): "李四", (1, 3): "王五", (1, 4): "赵六",
    (2, 1): "孙七", (2, 3): "周八",
    (3, 2): "吴九", (3, 4): "郑十",
    (4, 1): "冯一", (4, 2): "陈二", (4, 3): "褚三", (4, 4): "卫四",
}
EXPECTED = [
    (day, _COURSE_NAME[(row, day)], _TEACHER[(row, day)], row * 2 - 1, row * 2)
    for (row, day) in sorted(_COURSE_NAME)
]


def utf16be_hex(s: str) -> str:
    """UniGB-UCS2-H 与 UTF-16BE 在本夹具用到的字符上一致（与真实 PDF 的编码方式相同）"""
    return s.encode("utf-16-be").hex().upper()


def text_op(x: float, y: float, size: int, text: str) -> str:
    """一段独立的 BT/ET —— 坐标即绝对位置（BT 会重置文本矩阵）"""
    return "BT\n/F1 {} Tf\n{:.2f} {:.2f} Td\n<{}> Tj\nET".format(
        size, x, y, utf16be_hex(text)
    )


def build_content_stream() -> bytes:
    parts = [CM_ROTATE]  # ← 旋转的真相在这里，不是页级 /Rotate
    # 表头
    parts.append(text_op(COL_SEC, HEADER_Y, SZ_HEADER, HEADER[0]))
    for d in sorted(COL_DAY):
        parts.append(text_op(COL_DAY[d], HEADER_Y, SZ_HEADER, HEADER[d]))
    # 数据行
    for r, base_y in enumerate(ROW_Y):
        parts.append(text_op(COL_SEC, base_y, SZ_NAME, SECTIONS[r]))
        for d in sorted(COL_DAY):
            spec = CELLS.get((r + 1, d))
            if not spec:
                continue
            x = COL_DAY[d]
            for k, (txt, size) in enumerate(
                [
                    (spec[0], SZ_NAME),
                    (spec[1], SZ_NAME),
                    (spec[2], SZ_DETAIL),
                    (spec[3], SZ_DETAIL),
                ]
            ):
                parts.append(text_op(x, base_y - k * LINE_DY, size, txt))
    return ("\n".join(parts) + "\n").encode("latin-1")


def build_pdf() -> bytes:
    content = build_content_stream()

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        # 页级 /Rotate 90 与真实 PDF 一致。注意它本身不改变文字坐标，
        # 真正让坐标旋转的是内容流里的 cm —— 保留它是为了与真实文件同构。
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
        + "{:.0f} {:.0f}".format(PAGE_W, PAGE_H).encode()
        + b"] /Rotate "
        + str(ROTATE).encode()
        + b" /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
        b"/Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        # /W 是必须的，别删！
        # CJK 默认 /DW 1000（1em）没问题，但 ASCII 必须显式声明半角宽度。
        # 少了 /W 时 pdf.js 会把「(」「1」「-」也按 1em 算，
        # 实测「(1-2节)1-16周/教师:张三/选」被报成 152pt（19 字 × 8），
        # 真实 PDF 里同类字符串只有 93.7pt。字宽虚高会让 splitCells 算出负间距，
        # 把相邻的两列并成同一格 → 星期一到星期四全部串台。
        #
        # CID 区间怎么来的（踩过一次坑）：
        #   UniGB-UCS2-H 把 ASCII 映射到 Adobe-GB1 的 CID 1..95，
        #   换算关系是 CID = 码位 - 31（空格 U+0020 → 1，'J' U+004A → 43）。
        #   一开始写 /W [33 126 500]，只命中了 J/B/K 三个字母，
        #   数字与括号仍是全角宽 —— 相邻列照样并格。
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> "
        b"/FontDescriptor 7 0 R /DW 1000 /W [1 95 500] >>",
        b"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 "
        b"/FontBBox [0 -250 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 "
        b"/CapHeight 880 /StemV 93 >>",
    ]

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n"

    xref_pos = len(out)
    n = len(objects) + 1
    out += b"xref\n0 " + str(n).encode() + b"\n0000000000 65535 f \n"
    for off in offsets[1:]:
        out += "{:010d} 00000 n \n".format(off).encode()
    out += (
        b"trailer\n<< /Size " + str(n).encode() + b" /Root 1 0 R >>\n"
        b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF\n"
    )
    return bytes(out)


def main() -> int:
    dest = Path(
        sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/cjk-timetable-rotated.pdf"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    # newline="" 避免 Windows 文本模式把 LF 改写成 CRLF
    dest.write_bytes(build_pdf())
    print("已生成 {}（{} 字节）".format(dest, dest.stat().st_size))
    print("页 595x842 / Rotate {} / 内容流首行 {}".format(ROTATE, CM_ROTATE))
    print("期望解析出 {} 门课：".format(len(EXPECTED)))
    for day, name, teacher, s, e in EXPECTED:
        print("    星期{} {}-{}节  {}  {}".format(day, s, e, name, teacher))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

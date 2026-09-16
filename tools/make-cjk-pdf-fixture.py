#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成一个「CMap 编码中文 PDF」测试夹具。

为什么需要它：
用户真实课表含姓名学号，不适合入库；但这类 PDF 的关键特征是
【Type0 字体 + CMap 编码 + 非嵌入】——pdf.js 必须加载 .bcmap 才能解码。
本脚本手工构造一个具有完全相同特征的极小 PDF，用作回归夹具。

关键词：STSong-Light（Adobe 标准 CJK 字体，不嵌入）、UniGB-UCS2-H
（编码即 UTF-16BE）、CIDFontType0 + Adobe-GB1。

用法：
    python tools/make-cjk-pdf-fixture.py tests/fixtures/cjk-cmap.pdf
"""

import sys
from pathlib import Path


def utf16be_hex(s: str) -> str:
    """中文字符串 → PDF 里 <> 内的 UTF-16BE 十六进制（UniGB-UCS2-H 的编码形式）"""
    return s.encode("utf-16-be").hex().upper()


# (x, y, 文字) —— 故意排成「两列 + 两行」，顺带覆盖按坐标分列的情形
TEXTS = [
    (80.0, 760.0, "星期一"),
    (260.0, 760.0, "星期二"),
    (80.0, 730.0, "高等数学"),
    (260.0, 730.0, "学术英语"),
    (80.0, 700.0, "张琴"),
    (260.0, 700.0, "顾海悦"),
]

EXPECTED = [t[2] for t in TEXTS]


def build_content_stream() -> bytes:
    parts = []
    for x, y, text in TEXTS:
        parts.append(
            "BT\n/F1 12 Tf\n{:.1f} {:.1f} Td\n<{}> Tj\nET".format(x, y, utf16be_hex(text))
        )
    return ("\n".join(parts) + "\n").encode("latin-1")


def build_pdf() -> bytes:
    content = build_content_stream()

    objects = [
        # 1: Catalog
        b"<< /Type /Catalog /Pages 2 0 R >>",
        # 2: Pages
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        # 3: Page
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        # 4: Type0 字体 —— 关键：Encoding 用 CMap 名
        b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
        b"/Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
        # 5: 内容流
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        # 6: CIDFontType0 后代字体 —— 不嵌入，走标准 CJK 字体
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> "
        b"/FontDescriptor 7 0 R /DW 1000 >>",
        # 7: 字体描述符
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
    out += b"xref\n0 " + str(n).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += "{:010d} 00000 n \n".format(off).encode()

    out += (
        b"trailer\n<< /Size " + str(n).encode() + b" /Root 1 0 R >>\n"
        b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF\n"
    )
    return bytes(out)


def main() -> int:
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/cjk-cmap.pdf")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(build_pdf())
    print(f"已生成 {dest}（{dest.stat().st_size} 字节）")
    print("期望提取到的文字：" + " / ".join(EXPECTED))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

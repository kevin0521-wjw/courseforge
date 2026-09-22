#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 Capacitor 生成安卓启动图标源图（assets/icon-only.png，1024px）。

真源仍是 web/icon.svg（与 make-icons.py 同一原则）；这里只是把已入库的
web/icon-512.png LANCZOS 放大到 1024 —— 图标是几何图形 + 线性渐变，
放大不糊。产物供 `npx @capacitor/assets generate` 派生全套 mipmap。
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "icon-512.png"
OUT_DIR = ROOT / "assets"
OUT = OUT_DIR / "icon-only.png"

OUT_DIR.mkdir(exist_ok=True)
img = Image.open(SRC).convert("RGBA")
img = img.resize((1024, 1024), Image.LANCZOS)
img.save(OUT)
print("written:", OUT)

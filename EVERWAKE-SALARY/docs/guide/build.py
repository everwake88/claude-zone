#!/usr/bin/env python3
"""Builds the Everwake Salary guide.

guide.src.html is the page (styles, content, the player). This script embeds the
dashboard screenshots from shots/ into it and writes one self-contained file that
can be opened, sent or hosted as it is:

    python3 build.py                     ->  ../everwake-salary-guide.html
    python3 build.py --fragment PATH     also writes the page without <html>/<head>/<body>
                                         (for hosts that wrap the page themselves)
"""
import base64
import json
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
src = (here / "guide.src.html").read_text(encoding="utf-8")

shots = {"ar": {}, "en": {}}
for f in sorted((here / "shots").glob("*.webp")):
    lang, name = f.stem.split("-", 1)
    shots[lang][name] = "data:image/webp;base64," + base64.b64encode(f.read_bytes()).decode()

marker = "/*__SHOTS__*/{}"
assert marker in src, "guide.src.html lost its screenshots placeholder"
page = src.replace(marker, json.dumps(shots, separators=(",", ":")))
head, body = page.split("<!--/head-->", 1)

standalone = (
    '<!DOCTYPE html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + head + "</head>\n<body>\n" + body.strip() + "\n</body>\n</html>\n"
)
out = here.parent / "everwake-salary-guide.html"
out.write_text(standalone, encoding="utf-8")
print(f"{out.name}  {len(standalone.encode()) // 1024} KB")

if "--fragment" in sys.argv:
    frag = pathlib.Path(sys.argv[sys.argv.index("--fragment") + 1])
    frag.write_text(head + body, encoding="utf-8")
    print(f"{frag}  {frag.stat().st_size // 1024} KB")

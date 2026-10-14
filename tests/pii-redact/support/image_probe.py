#!/usr/bin/env python3
"""Image-container probe for the PII-redaction tests (R3, Fable M2). Independent of the engine.

Usage: image_probe.py <file>
Prints {"frames": [ocr text per frame], "soi_count": int, "jpeg_app": ["e0","e1",...], "png_chunks": [...],
        "metadata_text": "every textual metadata value (EXIF/XMP/PNG text/TIFF tags), joined"}
A redacted image must carry no secret in ANY frame, no EXIF thumbnail (second SOI) and no textual metadata.
"""
import io
import json
import os
import struct
import subprocess
import sys
import tempfile

from PIL import Image


def jpeg_info(b):
    apps, i = [], 2
    while i + 4 <= len(b) and b[i] == 0xFF:
        m = b[i + 1]
        if m in (0xD9, 0xDA):
            break
        ln = struct.unpack(">H", b[i + 2:i + 4])[0]
        if 0xE0 <= m <= 0xEF or m == 0xFE:
            apps.append(f"{m:02x}")
        i += 2 + ln
    return apps


def png_chunks(b):
    out, i = [], 8
    while i + 8 <= len(b):
        ln = struct.unpack(">I", b[i:i + 4])[0]
        out.append(b[i + 4:i + 8].decode("latin-1"))
        i += 12 + ln
    return out


def main():
    b = open(sys.argv[1], "rb").read()
    res = {"frames": [], "soi_count": b.count(b"\xff\xd8\xff"), "jpeg_app": [], "png_chunks": [], "metadata_text": ""}
    if b.startswith(b"\xff\xd8"):
        res["jpeg_app"] = jpeg_info(b)
    if b.startswith(b"\x89PNG"):
        res["png_chunks"] = png_chunks(b)
    meta = []
    try:
        im = Image.open(io.BytesIO(b))
        meta += [f"{k}={v}" for k, v in (im.info or {}).items() if isinstance(v, (str, bytes))]
        try:
            meta += [str(v) for v in im.getexif().values()]
        except Exception:
            pass
        for i in range(getattr(im, "n_frames", 1)):
            im.seek(i)
            with tempfile.TemporaryDirectory() as td:
                p = os.path.join(td, "f.png")
                im.convert("RGB").save(p)
                r = subprocess.run(["tesseract", p, "-", "--psm", "6"], capture_output=True, text=True)
                res["frames"].append(r.stdout)
            try:
                meta += [str(v) for v in getattr(im, "tag_v2", {}).values() if isinstance(v, (str, bytes))]
            except Exception:
                pass
    except Exception as e:
        res["error"] = type(e).__name__
    res["metadata_text"] = "\n".join(m.decode("latin-1") if isinstance(m, bytes) else m for m in meta)
    print(json.dumps(res))


if __name__ == "__main__":
    main()

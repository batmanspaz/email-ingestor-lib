#!/usr/bin/env python3
"""Pixel ground-truth probe for the PII-redaction tests (R2, Opus D3/C3/C4). Independent of the engine.

Usage: pixel_check.py <file> <pdf|image|xobject> <page> <x0,y0,x1,y1> <dpi>
  pdf:     rect is in PDF points on page <page>, rendered at <dpi>
  image:   rect is in pixels of the image file (page/dpi ignored)
  xobject: rect is in IMAGE SPACE (native pixels) of the largest image XObject on page <page> (R3, Fable C1: a page
           render cannot tell an overlay rectangle from removed pixels; the XObject itself can)
Prints {"mean": 0-255, "std": float, "ink": fraction of pixels darker than 128}.
A region whose digits were really removed is UNIFORM (low std, whatever the fill colour); a region that still shows
digit strokes has high std. OCR is not consulted - that is the point: OCR misreads are what this guards against.
"""
import io
import json
import sys

import fitz
from PIL import Image, ImageStat


def main():
    path, kind, page, rect, dpi = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
    x0, y0, x1, y1 = [float(v) for v in rect.split(",")]
    if kind == "pdf":
        doc = fitz.open(path)
        pg = doc[page]
        pix = pg.get_pixmap(dpi=dpi, clip=fitz.Rect(x0, y0, x1, y1), colorspace=fitz.csGRAY)
        im = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    elif kind == "xobject":
        doc = fitz.open(path)
        imgs = doc[page].get_images(full=True)
        if not imgs:
            print(json.dumps({"mean": 255.0, "std": 0.0, "ink": 0.0, "w": 0, "h": 0, "no_image": True}))
            return
        xref = max(imgs, key=lambda t: t[2] * t[3])[0]
        pix = fitz.Pixmap(doc, xref)
        if pix.alpha:
            pix = fitz.Pixmap(pix, 0)
        im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L").crop((int(x0), int(y0), int(x1), int(y1)))
    else:
        im = Image.open(path).convert("L").crop((int(x0), int(y0), int(x1), int(y1)))
    st = ImageStat.Stat(im)
    hist = im.histogram()
    ink = sum(hist[:128]) / max(1, sum(hist))
    print(json.dumps({"mean": st.mean[0], "std": st.stddev[0], "ink": ink, "w": im.width, "h": im.height}))


if __name__ == "__main__":
    main()

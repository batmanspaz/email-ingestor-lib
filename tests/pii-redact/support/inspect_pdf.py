#!/usr/bin/env python3
"""Independent leak inspector for the PII-redaction tests. Does NOT use the engine under test.

Usage: inspect_pdf.py <file.pdf> [--ocr]
Prints one JSON object: every extractable surface of the PDF as {name: [strings]}.
  text      page text layer (PyMuPDF), all pages
  raw       decoded page content streams (catches hidden-layer / white-on-white text)
  metadata  Info dictionary values
  xmp       XMP metadata packet
  widgets   AcroForm field values
  annots    annotation contents/info
  toc       bookmark titles
  embedded  embedded file names + decoded text content
  ocr       local tesseract OCR of each rendered page (only with --ocr)
  -- round 2 (red-team D1/D2/C3: an xref-based inspector reports ZERO leaks on a file whose bytes still hold them) --
  filebytes RAW file bytes (latin-1) + every `stream ... endstream` body zlib-inflated + decoded string operands.
            Catches superseded incremental revisions and orphan (unreferenced) objects.
  objects   every xref object's dictionary + its decoded stream (form XObjects, appearance streams, ObjStm members,
            JavaScript, XFA, custom Info keys, page labels, link URIs, file-attachment annotations, private keys)
  ocr_alt   SECOND OCR setup (only with --ocr-alt): 300 dpi grayscale, table lines removed, --psm 11, digits+dash
            whitelist pass. [Opus D3: one OCR engine/config is a single point of failure]
  meta      {revisions: count of %%EOF markers, xref_length, xref_length_gc: xref length after garbage=4,
             is_encrypted, spans: [[span text...] per page]}
Failure to open (corrupt/encrypted) is reported, not raised.
"""
import zlib
import json
import os
import subprocess
import sys
import tempfile

import re

import fitz


def decode_content_strings(raw: str) -> str:
    """Decode PDF string operands ((literal) and <hex>) so hex-encoded text in content streams is visible."""
    parts = []
    for m in re.finditer(r"<([0-9a-fA-F\s]+)>|\(((?:\\.|[^\\)])*)\)", raw):
        if m.group(1) is not None:
            h = re.sub(r"\s", "", m.group(1))
            if len(h) % 2:
                h += "0"
            try:
                parts.append(bytes.fromhex(h).decode("latin-1"))
            except ValueError:
                pass
        else:
            parts.append(m.group(2))
    return "".join(parts) + "\n" + " ".join(parts)


def textish(b: bytes) -> bool:
    """Decoded stream bodies that are pixel/font data are skipped (they cannot carry an SSN as characters and would
    blow the JSON up to tens of MB); anything mostly printable is scanned."""
    if not b:
        return False
    sample = b[:65536]
    printable = sum(1 for c in sample if 32 <= c < 127 or c in (9, 10, 13, 0))
    return printable / len(sample) >= 0.80


STREAM_RE = re.compile(rb"stream\r?\n(.*?)\r?\n?endstream", re.S)


def filebytes_surface(raw: bytes):
    # Raw bytes OUTSIDE stream bodies (dictionaries, strings, xref) + every stream body that is text-like, raw or
    # inflated. Binary stream bodies (images/fonts) are replaced by a placeholder.
    skeleton = STREAM_RE.sub(lambda m: m.group(0) if textish(m.group(1)) else b"stream\n<binary>\nendstream", raw)
    out = [skeleton.decode("latin-1")]
    for m in STREAM_RE.finditer(raw):
        body = m.group(1)
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
            try:
                decb = zlib.decompressobj(wbits).decompress(body)
            except Exception:
                continue
            if textish(decb):
                dec = decb.decode("latin-1")
                out.append(dec + "\n" + decode_content_strings(dec))
            break
    out.append(decode_content_strings(skeleton.decode("latin-1")))
    return out


def objects_surface(doc):
    out = []
    for x in range(1, doc.xref_length()):
        try:
            o = doc.xref_object(x, compressed=False)
            out.append(o + "\n" + decode_content_strings(o))
        except Exception:
            continue
        try:
            if doc.xref_is_stream(x):
                stb = doc.xref_stream(x) or b""
                if textish(stb):
                    st = stb.decode("latin-1")
                    out.append(st + "\n" + decode_content_strings(st))
        except Exception:
            pass
    try:
        t = doc.pdf_trailer(compressed=False)
        out.append(t + "\n" + decode_content_strings(t))
    except Exception:
        pass
    return out


def ocr_alt(doc):
    """Second, deliberately different OCR configuration."""
    texts = []
    for pg in doc:
        with tempfile.TemporaryDirectory() as td:
            png = os.path.join(td, "p.png")
            pix = pg.get_pixmap(dpi=300, colorspace=fitz.csGRAY)
            try:
                from PIL import Image, ImageFilter
                im = Image.frombytes("L", (pix.width, pix.height), pix.samples)
                # crude line removal: a min-filter thins thin box rules less than glyph strokes, then threshold
                im = im.filter(ImageFilter.MaxFilter(3)).point(lambda v: 255 if v > 160 else 0)
                im.save(png)
            except Exception:
                pix.save(png)
            parts = []
            for args in (["--psm", "11"], ["--psm", "6", "-c", "tessedit_char_whitelist=0123456789-"]):
                r = subprocess.run(["tesseract", png, "-", *args], capture_output=True, text=True)
                parts.append(r.stdout)
            texts.append("\n".join(parts))
    return texts


def main():
    path = sys.argv[1]
    want_ocr = "--ocr" in sys.argv
    want_ocr_alt = "--ocr-alt" in sys.argv
    raw_bytes = open(path, "rb").read()
    out = {"ok": True, "encrypted": False, "error": None, "pages": 0, "surfaces": {}}
    try:
        doc = fitz.open(path)
    except Exception as e:  # corrupt
        out.update(ok=False, error=f"open_failed:{type(e).__name__}")
        print(json.dumps(out))
        return
    if getattr(doc, "is_repaired", False):
        out.update(ok=False, error="corrupt:repaired")
        print(json.dumps(out))
        return
    if doc.needs_pass:
        out.update(ok=False, encrypted=True, error="encrypted")
        print(json.dumps(out))
        return
    s = out["surfaces"]
    out["pages"] = doc.page_count
    s["filebytes"] = filebytes_surface(raw_bytes)
    meta = {"revisions": raw_bytes.count(b"%%EOF"), "xref_length": doc.xref_length(), "is_encrypted": bool(doc.is_encrypted) or b"/Encrypt" in raw_bytes}
    try:
        meta["xref_length_gc"] = fitz.open("pdf", doc.tobytes(garbage=4)).xref_length()
    except Exception:
        meta["xref_length_gc"] = None
    spans = []
    for pg in doc:
        ps = []
        for b in pg.get_text("dict").get("blocks", []):
            for ln in b.get("lines", []):
                for sp in ln.get("spans", []):
                    ps.append(sp.get("text", ""))
        spans.append(ps)
    meta["spans"] = spans
    out["meta"] = meta
    s["objects"] = objects_surface(doc)
    try:
        s["text"] = [pg.get_text("text") for pg in doc]
    except Exception as e:
        out.update(ok=False, error=f"corrupt:{type(e).__name__}")
        print(json.dumps(out))
        return
    raw = []
    for pg in doc:
        try:
            r = pg.read_contents().decode("latin-1", errors="replace")
            raw.append(r + "\n" + decode_content_strings(r))
        except Exception:
            raw.append("")
    s["raw"] = raw
    s["metadata"] = [str(v) for v in (doc.metadata or {}).values() if v]
    try:
        s["xmp"] = [doc.get_xml_metadata() or ""]
    except Exception:
        s["xmp"] = []
    widgets, annots = [], []
    for pg in doc:
        for w in pg.widgets() or []:
            widgets.append(str(w.field_value or ""))
            widgets.append(str(w.field_name or ""))
        for a in pg.annots() or []:
            info = a.info or {}
            annots.append(str(info.get("content", "")))
            annots.append(str(info.get("title", "")))
            annots.append(str(info.get("subject", "")))
    s["widgets"] = widgets
    s["annots"] = annots
    s["toc"] = [str(t[1]) for t in doc.get_toc()]
    emb = []
    try:
        for name in doc.embfile_names():
            emb.append(name)
            emb.append(doc.embfile_get(name).decode("utf-8", errors="replace"))
    except Exception:
        pass
    s["embedded"] = emb
    if want_ocr:
        texts = []
        for pg in doc:
            with tempfile.TemporaryDirectory() as td:
                png = os.path.join(td, "p.png")
                pg.get_pixmap(dpi=220).save(png)
                r = subprocess.run(["tesseract", png, "-", "--psm", "6"], capture_output=True, text=True)
                texts.append(r.stdout)
        s["ocr"] = texts
    if want_ocr_alt:
        s["ocr_alt"] = ocr_alt(doc)
    print(json.dumps(out))


if __name__ == "__main__":
    main()

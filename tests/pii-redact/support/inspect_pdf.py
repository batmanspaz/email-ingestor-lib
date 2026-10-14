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
Failure to open (corrupt/encrypted) is reported, not raised.
"""
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


def main():
    path = sys.argv[1]
    want_ocr = "--ocr" in sys.argv
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
    print(json.dumps(out))


if __name__ == "__main__":
    main()

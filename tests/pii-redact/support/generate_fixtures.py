#!/usr/bin/env python3
"""Builds SYNTHETIC PII-redaction fixtures with PyMuPDF. No real data, ever.

Usage: generate_fixtures.py <outDir>
Writes the fixture files plus <outDir>/manifest.json describing, per fixture, which synthetic
secrets it contains (keys of values.json 'secrets') and which negative controls it carries.
This script is part of the P0 test harness (GREEN by design): the RED tests need it to work so
they fail on the engine, never on the fixtures.
"""
import json
import os
import sys
import zipfile

import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
V = json.load(open(os.path.join(HERE, "values.json")))
S = {k: v["text"] for k, v in V["secrets"].items()}
N = V["negatives"]

FULL_SECRETS = ["ssn1", "ssn2", "itin", "routing", "account", "dob", "pin", "agi", "dl"]


def body_lines():
    return [
        "Form 1040 - U.S. Individual Income Tax Return (SYNTHETIC TEST DOCUMENT)",
        f"Taxpayer: JANE Q TESTER    SSN: {S['ssn1']}",
        f"Spouse: JOHN TESTER    SSN: {S['ssn2']}",
        f"Dependent (ITIN): {S['itin']}",
        f"Date of birth: {S['dob']}",
        f"Routing number: {S['routing']}    Account number: {S['account']}",
        f"Self-select PIN: {S['pin']}    Prior year AGI: ${S['agi']}",
        f"Driver license no: {S['dl']} (CA)",
        f"{N['invoice']['label']} {N['invoice']['text']} is not an SSN",
        f"{N['phone']['label']} {N['phone']['text']}    {N['ein']['label']} {N['ein']['text']}",
        f"{N['amount']['label']} {N['amount']['text']}    {N['filing_date']['label']} {N['filing_date']['text']}",
        f"{N['current_agi']['label']} {N['current_agi']['text']}",
    ]


def write_lines(page, lines, y0=72, color=(0, 0, 0)):
    y = y0
    for line in lines:
        page.insert_text((54, y), line, fontsize=10, fontname="helv", color=color)
        y += 16
    return y


def neg_keys():
    return list(N.keys())


def make_text_layer(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, body_lines())
    doc.new_page()
    write_lines(doc[1], ["Page 2: continuation", f"Taxpayer SSN again: {S['ssn1']}"])
    doc.save(path)


def image_only_from(text_pdf_path, out_path, pages=None):
    src = fitz.open(text_pdf_path)
    doc = fitz.open()
    for i, pg in enumerate(src):
        if pages is not None and i not in pages:
            continue
        pix = pg.get_pixmap(dpi=200)
        np = doc.new_page(width=pg.rect.width, height=pg.rect.height)
        np.insert_image(np.rect, stream=pix.tobytes("png"))
    doc.save(out_path, deflate=True, garbage=3)


def make_mixed(out, text_pdf):
    src = fitz.open(text_pdf)
    doc = fitz.open()
    doc.insert_pdf(src, from_page=0, to_page=0)
    pix = src[1].get_pixmap(dpi=200)
    np = doc.new_page(width=src[1].rect.width, height=src[1].rect.height)
    np.insert_image(np.rect, stream=pix.tobytes("png"))
    doc.save(out, deflate=True, garbage=3)


def make_acroform(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, ["Synthetic e-file authorization form"])
    w = fitz.Widget()
    w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    w.field_name = "taxpayer_ssn"
    w.field_value = S["ssn1"]
    w.rect = fitz.Rect(54, 100, 260, 120)
    p.add_widget(w)
    doc.save(path)


def make_metadata(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, ["Synthetic document whose body has no private number"])
    doc.set_metadata({
        "title": f"Return for SSN {S['ssn1']}",
        "author": "Synthetic Preparer",
        "subject": f"Taxpayer {S['ssn2']}",
        "keywords": f"dob {S['dob']}",
    })
    doc.set_xml_metadata(
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        f'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        f'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description>SSN {S["ssn1"]}</dc:description>'
        "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
    doc.save(path)


def make_embedded(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, ["Synthetic PDF with an embedded worksheet"])
    doc.embfile_add("worksheet.txt", f"Worksheet SSN {S['ssn1']}\n".encode())
    doc.save(path)


def make_annots_toc(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, ["Synthetic PDF with annotations and a bookmark"])
    p.add_text_annot((72, 200), f"Note: SSN {S['ssn1']}")
    p.add_freetext_annot(fitz.Rect(54, 220, 360, 250), f"Spouse SSN {S['ssn2']}", fontsize=10)
    doc.set_toc([[1, f"Taxpayer {S['ssn1']}", 1]])
    doc.save(path)


def make_hidden_ocg(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, ["Synthetic PDF with text in a hidden layer"])
    ocg = doc.add_ocg("hidden-layer", on=False)
    p.insert_text((54, 300), f"Hidden SSN {S['ssn1']}", fontsize=10, fontname="helv", oc=ocg)
    doc.save(path)


def make_white_on_white(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, ["Synthetic PDF with white text"])
    p.insert_text((54, 300), f"Invisible SSN {S['ssn1']}", fontsize=10, fontname="helv", color=(1, 1, 1))
    doc.save(path)


def make_footer_every_page(path, pages=5):
    doc = fitz.open()
    for i in range(pages):
        p = doc.new_page()
        write_lines(p, [f"Synthetic page {i + 1} of {pages}"])
        p.insert_text((54, 800), f"Taxpayer SSN {S['ssn1']}    page {i + 1}", fontsize=8, fontname="helv")
    doc.save(path)


def make_split_spans(path):
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((54, 100), "SSN: 123-45-", fontsize=10, fontname="helv")
    w = fitz.get_text_length("SSN: 123-45-", fontname="helv", fontsize=10)
    p.insert_text((54 + w, 100), "6789", fontsize=10, fontname="helv")
    doc.save(path)


def make_unicode_dashes(path):
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((54, 100), "SSN 123 45 6789", fontsize=10, fontname="helv")
    p.insert_text((54, 120), "SSN 987–65–4320", fontsize=10, fontname="helv")
    doc.save(path)


def make_clean(path):
    doc = fitz.open()
    p = doc.new_page()
    write_lines(p, [
        "Synthetic clean document - no private numbers",
        f"{N['invoice']['label']} {N['invoice']['text']}",
        f"{N['phone']['label']} {N['phone']['text']}   {N['ein']['label']} {N['ein']['text']}",
        f"{N['amount']['label']} {N['amount']['text']}   {N['filing_date']['label']} {N['filing_date']['text']}",
    ])
    doc.save(path)


def make_encrypted(src, path):
    doc = fitz.open(src)
    doc.save(path, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner-pw", user_pw="user-pw")


def make_corrupt(src, path):
    data = open(src, "rb").read()
    cut = int(len(data) * 0.55)
    open(path, "wb").write(data[:cut] + b"\x00garbage\x00" * 8)


def docx_bytes(paragraphs):
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    paras = "".join(f"<w:p><w:r><w:t xml:space=\"preserve\">{t}</w:t></w:r></w:p>" for t in paragraphs)
    doc = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{paras}</w:body></w:document>")
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    P = lambda n: os.path.join(out, n)

    make_text_layer(P("text_layer.pdf"))
    image_only_from(P("text_layer.pdf"), P("image_only.pdf"))
    make_mixed(P("mixed.pdf"), P("text_layer.pdf"))
    make_acroform(P("acroform.pdf"))
    make_metadata(P("metadata.pdf"))
    make_embedded(P("embedded.pdf"))
    make_annots_toc(P("annots_toc.pdf"))
    make_hidden_ocg(P("hidden_ocg.pdf"))
    make_white_on_white(P("white_on_white.pdf"))
    make_footer_every_page(P("footer_every_page.pdf"))
    make_split_spans(P("split_spans.pdf"))
    make_unicode_dashes(P("unicode_dashes.pdf"))
    make_clean(P("clean.pdf"))
    make_encrypted(P("text_layer.pdf"), P("encrypted.pdf"))
    make_corrupt(P("text_layer.pdf"), P("corrupt.pdf"))

    txt = "\n".join(body_lines()) + "\n"
    open(P("notes.txt"), "w").write(txt)
    open(P("sheet.csv"), "w").write(f"name,ssn,routing\nJane Tester,{S['ssn1']},{S['routing']}\n")
    open(P("page.html"), "w").write(f"<html><body><p>Taxpayer SSN: {S['ssn1']}</p><p>Date of birth: {S['dob']}</p></body></html>\n")
    open(P("return.docx"), "wb").write(docx_bytes(body_lines()))
    with zipfile.ZipFile(P("bundle.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.write(P("text_layer.pdf"), "text_layer.pdf")
        z.write(P("notes.txt"), "notes.txt")
        z.write(P("clean.pdf"), "clean.pdf")
    with zipfile.ZipFile(P("bundle_with_bad_member.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.write(P("text_layer.pdf"), "text_layer.pdf")
        z.write(P("corrupt.pdf"), "corrupt.pdf")

    # kinds: what surfaces hold secrets (used by the leak inspector sanity tests)
    manifest = {
        "text_layer.pdf": {"secrets": FULL_SECRETS, "negatives": neg_keys(), "surfaces": ["text"], "pages": 2},
        "image_only.pdf": {"secrets": FULL_SECRETS, "negatives": neg_keys(), "surfaces": ["ocr"], "pages": 2},
        "mixed.pdf": {"secrets": ["ssn1", "ssn2", "itin", "routing", "account", "dob", "pin", "agi", "dl"], "negatives": neg_keys(), "surfaces": ["text", "ocr"], "pages": 2},
        "acroform.pdf": {"secrets": ["ssn1"], "negatives": [], "surfaces": ["widgets"], "pages": 1},
        "metadata.pdf": {"secrets": ["ssn1", "ssn2", "dob"], "negatives": [], "surfaces": ["metadata", "xmp"], "pages": 1},
        "embedded.pdf": {"secrets": ["ssn1"], "negatives": [], "surfaces": ["embedded"], "pages": 1},
        "annots_toc.pdf": {"secrets": ["ssn1", "ssn2"], "negatives": [], "surfaces": ["annots", "toc"], "pages": 1},
        "hidden_ocg.pdf": {"secrets": ["ssn1"], "negatives": [], "surfaces": ["raw"], "pages": 1},
        "white_on_white.pdf": {"secrets": ["ssn1"], "negatives": [], "surfaces": ["text"], "pages": 1},
        "footer_every_page.pdf": {"secrets": ["ssn1"], "negatives": [], "surfaces": ["text"], "pages": 5},
        "split_spans.pdf": {"secrets": ["ssn1"], "negatives": [], "surfaces": ["text"], "pages": 1},
        "unicode_dashes.pdf": {"secrets": ["ssn1", "ssn2"], "negatives": [], "surfaces": ["text"], "pages": 1},
        "clean.pdf": {"secrets": [], "negatives": ["invoice", "phone", "ein", "amount", "filing_date"], "surfaces": [], "pages": 1},
        "encrypted.pdf": {"secrets": FULL_SECRETS, "negatives": [], "surfaces": [], "pages": 2, "expect": "held:encrypted"},
        "corrupt.pdf": {"secrets": [], "negatives": [], "surfaces": [], "pages": 0, "expect": "held:corrupt"},
        "notes.txt": {"secrets": FULL_SECRETS, "negatives": neg_keys(), "kind": "text"},
        "sheet.csv": {"secrets": ["ssn1", "routing"], "negatives": [], "kind": "text"},
        "page.html": {"secrets": ["ssn1", "dob"], "negatives": [], "kind": "text"},
        "return.docx": {"secrets": FULL_SECRETS, "negatives": neg_keys(), "kind": "docx"},
        "bundle.zip": {"secrets": FULL_SECRETS, "negatives": neg_keys(), "kind": "zip"},
        "bundle_with_bad_member.zip": {"secrets": FULL_SECRETS, "negatives": [], "kind": "zip", "expect": "held:corrupt_member"},
    }
    json.dump(manifest, open(P("manifest.json"), "w"), indent=2)
    print(json.dumps({"ok": True, "dir": out, "files": sorted(manifest)}))


if __name__ == "__main__":
    main()

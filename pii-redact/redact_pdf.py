#!/usr/bin/env python3
"""PDF redaction engine CLI (PyMuPDF). PHASE 0 STUB — exits 2 with a JSON error until Phase 1.

Contract (see ~/claude/shared/plans/2026-10-15-intake-pii-redaction-P0-spec.md):
  redact_pdf.py --in <file.pdf> --out <redacted.pdf> --report <report.json> [--mode shadow|enforce] [--ocr tesseract]
  stdout: one JSON object {"outcome":"clean|redacted|detected|held","reason":null|"encrypted|corrupt|ocr_unavailable|verify_failed|engine_error",
                           "counts":{"ssn":0,"bank":0,"dob":0,"pin":0,"id":0}}
  exit 0 = outcome reached; exit 2 = engine error. NEVER prints a matched value.
"""
import json
import sys

if __name__ == "__main__":
    print(json.dumps({"outcome": "held", "reason": "engine_error", "error": "not_implemented_p0"}))
    sys.exit(2)

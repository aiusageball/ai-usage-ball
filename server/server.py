import os
import re
import ssl
import json
import time
import random
import asyncio
import subprocess
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

# Overridable only for local dev/testing (e.g. running two instances on one
# machine to simulate two teammates for Team View — see docs/team-view-test.md).
# Never overridden in the shipped app.
SERVER_PORT = int(os.environ.get("AIPULSE_PORT", "8000"))


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

    # Real-data pollers: Claude usage via Anthropic OAuth (direct, no CodexBar);
    # Codex/Antigravity still via CodexBar CLI for now.
    # All three providers now read real data natively (no CodexBar dependency).
    claude_task = asyncio.create_task(poll_claude_oauth())
    codex_task = asyncio.create_task(poll_codex_oauth())
    antigravity_task = asyncio.create_task(poll_antigravity_local())
    tick_task = asyncio.create_task(background_ticker())
    team_task = asyncio.create_task(browse_team_peers())
    try:
        yield
    finally:
        claude_task.cancel()
        codex_task.cancel()
        antigravity_task.cancel()
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
        "rate_limit_pct": 0.0,
        "rate_limit_pct_secondary": 0.0,
        "status": "NORMAL",
        "status_secondary": "NORMAL",
        "reset_time": "",
        "reset_time_secondary": "",
        "resetsAt": "",
        "resetsAt_secondary": "",
        "logs": []
    },
    "claude": {
        "provider": "Claude",
        "loaded": False,      # 第一次拿到真实数据后置 True(供前端开场动效判断)
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
        "logs": []
    },
    "codex": {
        "provider": "Codex",
        "loaded": False,      # 第一次拿到真实数据后置 True(供前端开场动效判断)
        "rate_limit_pct": 0.0,
        "rate_limit_pct_secondary": 0.0,
        "status": "NORMAL",
        "status_secondary": "NORMAL",
        "reset_time": "",
        "reset_time_secondary": "",
        "resetsAt": "",
        "resetsAt_secondary": "",
        "reset_credits": None,
        "logs": []
    }
}

def safe_pct(value) -> float:
    """Coerce a usedPercent value to float, treating None/invalid as 0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0

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
        co["resetsAt"] = ""
    if _iso_in_past(co.get("resetsAt_secondary", "")):
        co["rate_limit_pct_secondary"] = 0.0
        co["status_secondary"] = "NORMAL"
        co["resetsAt_secondary"] = ""

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
_CLAUDE_WEB_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")

def _get_claude_sessionkey():
    """从浏览器(Chrome/Safari/Firefox/Edge/Brave)读 claude.ai 的 sessionKey,带缓存。"""
    global _cached_claude_sessionkey
    if _cached_claude_sessionkey:
        return _cached_claude_sessionkey
    try:
        import browser_cookie3
    except ImportError:
        return None
    for loader in (browser_cookie3.chrome, browser_cookie3.safari,
                   browser_cookie3.firefox, browser_cookie3.edge, browser_cookie3.brave):
        try:
            for c in loader(domain_name="claude.ai"):
                if c.name == "sessionKey" and str(c.value).startswith("sk-ant"):
                    _cached_claude_sessionkey = c.value
                    return c.value
        except Exception:
            continue
    return None

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

def _read_oauth_token():
    """读现成的 Claude OAuth access_token(**只读,绝不刷新**)。同时看两处:
    ~/.claude/.credentials.json 文件 和 macOS 钥匙串 —— 新版 Claude Code 把凭据
    存进钥匙串、不再更新那个文件,所以只读文件会拿到过期 token。这里取两者中未过期
    且最新的那个。绝不碰 refresh_token(和 CLI 抢一次性轮换会触发服务端吊销整条链)。"""
    now = time.time()
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

    if not best:
        return None
    # 优先返回未过期的;都过期也返回最新那个(让 API 自己判 401,不在这儿武断丢弃)
    return best[0]

def fetch_claude_usage_resilient():
    """Claude 用量多源:优先浏览器 cookie(永不失效),失败退到现成 OAuth token
    (只读不刷新,避免和 CLI 抢轮换)。返回 (usage_dict 或 None, 来源字符串)。"""
    u = fetch_claude_usage_via_cookie()
    if u:
        return u, "cookie"
    tok = _read_oauth_token()
    if tok:
        try:
            return fetch_claude_usage(tok), "oauth"
        except Exception:
            pass
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

async def poll_claude_oauth():
    """Claude 用量轮询:cookie 为主源(对标 CodexBar,永不失效),OAuth token 只读兜底。
    不再自己刷新 OAuth token —— 那会和 Claude CLI 抢一次性轮换的 refresh_token、触发服务端
    把整条链吊销(之前 token 反复失效就是这么来的)。刷新交还给 CLI;cookie 不受影响。
    失败重试用短间隔(而不是跟成功一样的 60s)—— 冷启动时第一次读经常因为浏览器/
    钥匙串还没就绪而失败,如果失败也等 60s,首次显示真实数据就要接近一分钟。只在
    最初几次失败时快速重试;如果是真的长期拿不到(没登录 claude.ai),连续失败
    次数超过 CLAUDE_FAST_RETRY_MAX 后退回 60s 节奏,避免一直高频重试。"""
    global _claude_last_ok
    print("Starting Claude usage polling (cookie-first, OAuth fallback)...")
    fail_count = 0
    while True:
        try:
            usage, source = await asyncio.to_thread(fetch_claude_usage_resilient)
            if not usage:
                # cookie + OAuth 都拿不到(浏览器没登录 claude.ai 且 token 也失效)。
                # 置 needsLogin,前端 Claude 球据此显示"登录 claude.ai"的可点提示,
                # 而不是干等一个永远不来的数字。只有连续多次失败才置(避免冷启动
                # 时浏览器/钥匙串还没就绪就误报),给用户一个明确的可操作出口。
                if _claude_last_ok and time.time() - _claude_last_ok > CLAUDE_STALE_AFTER_SEC:
                    state["claude"]["stale"] = True
                if fail_count >= 2:
                    state["claude"]["needsLogin"] = True
                _log_claude("⚠ 取不到用量 — 请在浏览器登录 claude.ai", dedup=True)
                fail_count += 1
                await asyncio.sleep(5.0 if fail_count <= CLAUDE_FAST_RETRY_MAX else 60.0)
                continue

            fh = usage.get("five_hour") or {}
            sd = usage.get("seven_day") or {}
            fh_util = safe_pct(fh.get("utilization", 0))
            sd_util = safe_pct(sd.get("utilization", 0))

            # Primary ring = 5-hour session window; secondary = 7-day weekly.
            state["claude"]["rate_limit_pct"] = fh_util
            state["claude"]["resetsAt"] = fh.get("resets_at", "") or ""
            state["claude"]["status"] = "EXHAUSTED" if fh_util >= 100 else "NORMAL"
            state["claude"]["rate_limit_pct_secondary"] = sd_util
            state["claude"]["resetsAt_secondary"] = sd.get("resets_at", "") or ""
            state["claude"]["status_secondary"] = "EXHAUSTED" if sd_util >= 100 else "NORMAL"

            _claude_last_ok = time.time()
            fail_count = 0
            state["claude"]["loaded"] = True
            state["claude"]["stale"] = False
            state["claude"]["needsLogin"] = False
            state["claude"]["tokenExpired"] = False
            state["claude"]["updatedAt"] = datetime.now(timezone.utc).isoformat()
            _log_claude(f"Claude({source}): session {fh_util:.0f}% used, weekly {sd_util:.0f}% used",
                        dedup=True)
            await asyncio.sleep(60.0)  # usage changes slowly; once a minute is plenty
        except Exception as e:
            print(f"Error polling Claude usage: {e}")
            fail_count += 1
            await asyncio.sleep(5.0 if fail_count <= CLAUDE_FAST_RETRY_MAX else 60.0)

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
    print("Starting Codex usage polling (chatgpt.com backend)...")
    while True:
        try:
            token, acct = await asyncio.to_thread(get_codex_auth)
            if not token:
                print("Codex auth.json token not found. Skipping.")
            else:
                usage = await asyncio.to_thread(fetch_codex_usage, token, acct)
                rl = usage.get("rate_limit") or {}
                pri = rl.get("primary_window") or {}
                sec = rl.get("secondary_window") or {}
                pri_used = safe_pct(pri.get("used_percent", 0))
                sec_used = safe_pct(sec.get("used_percent", 0))
                reset_at = pri.get("reset_at")
                reset_at_secondary = sec.get("reset_at")
                # "限额重置券"剩余张数(撞限额时可立刻重置额度)
                reset_credits = (usage.get("rate_limit_reset_credits") or {}).get("available_count")

                state["codex"]["loaded"] = True
                state["codex"]["rate_limit_pct"] = pri_used
                state["codex"]["rate_limit_pct_secondary"] = sec_used
                state["codex"]["reset_credits"] = reset_credits
                state["codex"]["resetsAt"] = (
                    datetime.fromtimestamp(reset_at, tz=timezone.utc).isoformat()
                    if reset_at else ""
                )
                state["codex"]["resetsAt_secondary"] = (
                    datetime.fromtimestamp(reset_at_secondary, tz=timezone.utc).isoformat()
                    if reset_at_secondary else ""
                )
                state["codex"]["status"] = "EXHAUSTED" if pri_used >= 100 else "NORMAL"
                state["codex"]["status_secondary"] = "EXHAUSTED" if sec_used >= 100 else "NORMAL"

                timestamp = time.strftime("%H:%M:%S")
                plan = usage.get("plan_type", "")
                msg = f"ChatGPT/Codex: 5h {pri_used:.0f}% used, weekly {sec_used:.0f}% used (plan: {plan})"
                if not state["codex"]["logs"] or state["codex"]["logs"][0]["msg"] != msg:
                    state["codex"]["logs"].insert(0, {"time": timestamp, "msg": msg, "tokens": 0})
                    state["codex"]["logs"] = state["codex"]["logs"][:30]
            await asyncio.sleep(60.0)  # once a minute is plenty
            continue
        except urllib.error.HTTPError as e:
            print(f"Codex usage HTTP {e.code} {e.reason}")
            await asyncio.sleep(120.0 if e.code == 429 else 60.0)
            continue
        except Exception as e:
            print(f"Error polling Codex usage: {e}")
        await asyncio.sleep(60.0)

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

def _ag_worst(models, keyword):
    """Lowest remainingFraction (+ its resetTime) among models whose label contains keyword."""
    best = None
    for m in models:
        if keyword in (m.get("label") or "").lower():
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

async def poll_antigravity_local():
    """失败重试用短间隔而不是跟成功一样的 20s —— 冷启动时第一次探测常因为
    language_server 的 ps/端口列表还没就绪而落空,如果失败也等 20s,首次
    显示真实数据就要接近 20 秒(实测正是如此)。"""
    print("Starting Antigravity usage polling (local language server)...")
    fail_count = 0
    while True:
        ok = False
        try:
            status = await asyncio.to_thread(fetch_antigravity_status)
            if not status:
                # Antigravity not running / not reachable → mark offline.
                state["antigravity"]["available"] = False
                state["antigravity"]["status"] = "OFFLINE"
                state["antigravity"]["status_secondary"] = "OFFLINE"
            else:
                ok = True
                us = status.get("userStatus") or {}
                models = ((us.get("cascadeModelConfigData") or {}).get("clientModelConfigs")) or []
                gemini = _ag_worst(models, "gemini")
                claude = _ag_worst(models, "claude")
                state["antigravity"]["available"] = True
                state["antigravity"]["loaded"] = True

                # Third orb: primary ring = "GEMINI REMAINING" (secondary fields),
                # secondary ring = "CLAUDE REMAINING" (primary fields). See App.jsx.
                if gemini:
                    g_used = max(0.0, (1.0 - float(gemini[0])) * 100.0)
                    state["antigravity"]["rate_limit_pct_secondary"] = g_used
                    state["antigravity"]["resetsAt_secondary"] = _ag_iso(gemini[1])
                    state["antigravity"]["status_secondary"] = "EXHAUSTED" if g_used >= 100 else "NORMAL"
                if claude:
                    c_used = max(0.0, (1.0 - float(claude[0])) * 100.0)
                    state["antigravity"]["rate_limit_pct"] = c_used
                    state["antigravity"]["resetsAt"] = _ag_iso(claude[1])
                    state["antigravity"]["status"] = "EXHAUSTED" if c_used >= 100 else "NORMAL"

                plan = ((us.get("planStatus") or {}).get("planInfo") or {}).get("planName", "")
                timestamp = time.strftime("%H:%M:%S")
                gpart = f"Gemini {100 - state['antigravity']['rate_limit_pct_secondary']:.0f}%" if gemini else ""
                cpart = f"Claude {100 - state['antigravity']['rate_limit_pct']:.0f}%" if claude else ""
                msg = f"Antigravity ({plan}): {gpart} {cpart} remaining".strip()
                if not state["antigravity"]["logs"] or state["antigravity"]["logs"][0]["msg"] != msg:
                    state["antigravity"]["logs"].insert(0, {"time": timestamp, "msg": msg, "tokens": 0})
                    state["antigravity"]["logs"] = state["antigravity"]["logs"][:30]
        except Exception as e:
            print(f"Error polling Antigravity: {e}")
            state["antigravity"]["available"] = False
        fail_count = 0 if ok else fail_count + 1
        await asyncio.sleep(20.0 if (ok or fail_count > ANTIGRAVITY_FAST_RETRY_MAX) else 3.0)

# ── Team View: LAN-only peer discovery (opt-in, no cloud) ──
# Lets 2-3 teammates on the same local network see each other's remaining %
# during a pairing session. Fully separate from the Watch's zeroconf service
# (_aipulse._tcp.local.) — its own service type, so multiple teammates
# broadcasting at once don't collide with each other or with Watch discovery.
TEAM_SERVICE_TYPE = "_aipulseteam._tcp.local."
TEAM_CRITICAL_PCT = 10.0  # matches the orb UI's isCritical threshold (App.jsx)

team_settings = {"enabled": False, "display_name": "", "instance_id": ""}
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
    antigravity_remaining = _remaining(state["antigravity"]["rate_limit_pct_secondary"])

    return {
        "display_name": team_settings["display_name"] or "Teammate",
        "instance_id": team_settings["instance_id"],
        "providers": {
            "claude": {"remaining_pct": claude_remaining, "critical": claude_remaining < TEAM_CRITICAL_PCT},
            "codex": {"remaining_pct": codex_remaining, "critical": codex_remaining < TEAM_CRITICAL_PCT},
            "antigravity": {"remaining_pct": antigravity_remaining, "critical": antigravity_remaining < TEAM_CRITICAL_PCT},
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
    """Tracks other AI Usage Ball instances broadcasting on the LAN.
    Callbacks run on zeroconf's own thread; the dict they mutate is only
    ever read/written under the GIL, which is enough for this best-effort
    discovery cache (no correctness-critical ordering needed)."""

    def add_service(self, zc, type_, name):
        info = zc.get_service_info(type_, name, timeout=2000)
        if info and info.addresses:
            host = socket.inet_ntoa(info.addresses[0])
            _team_discovered[name] = {"host": host, "port": info.port, "last_seen": time.time()}

    def update_service(self, zc, type_, name):
        self.add_service(zc, type_, name)

    def remove_service(self, zc, type_, name):
        _team_discovered.pop(name, None)


def _fetch_team_status_sync(host: str, port: int):
    req = urllib.request.Request(f"http://{host}:{port}/api/team-status")
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read().decode())


async def browse_team_peers():
    """Discover other AI Usage Ball instances on the LAN (mDNS) and poll each
    discovered/pinned/manually-added peer's /api/team-status every few
    seconds. Never blocks startup — _team_zc was already set up (or left
    None) by lifespan()'s own hard-timeout-guarded init before this task
    even starts."""
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
        for name, d in list(_team_discovered.items()):
            targets[name] = (d["host"], d["port"])
        for iid, p in list(_team_pinned.items()):
            key = f"pinned:{iid}"
            if key not in targets:
                targets[key] = (p["host"], p["port"])

        for host, port in set(targets.values()):
            try:
                payload = await asyncio.wait_for(
                    asyncio.to_thread(_fetch_team_status_sync, host, port), timeout=3.0
                )
                iid = payload.get("instance_id")
                if not iid or iid == team_settings.get("instance_id"):
                    continue  # never show yourself in your own team list
                _team_peers_cache[iid] = {
                    "instance_id": iid,
                    "display_name": payload.get("display_name", "Teammate"),
                    "host": host,
                    "port": port,
                    "online": True,
                    "providers": payload.get("providers", {}),
                    "updated_at": payload.get("updated_at", ""),
                }
            except Exception:
                # Keep last-known values, just flip online off — graceful
                # degradation, not an error. Only touches peers we've already
                # successfully fetched from before.
                for cached in _team_peers_cache.values():
                    if cached["host"] == host and cached["port"] == port:
                        cached["online"] = False
                        break


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
async def set_team_settings(body: TeamSettingsBody):
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
def get_team_peers():
    return {"peers": list(_team_peers_cache.values())}


@app.post("/api/team-peers/manual")
async def add_team_peer_manual(body: TeamManualPeerBody):
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
    }
    return _team_peers_cache[iid]


@app.post("/api/team-pins")
def set_team_pins(body: TeamPinsBody):
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

    # Parse "bytes=start-end" and reply with 206 Partial Content. macOS WKWebView
    # requires this to play <video>; a plain 200 makes the orb stay blank.
    try:
        _unit, rng = range_header.split("=")
        start_s, end_s = rng.split("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
    except Exception:
        start, end = 0, file_size - 1

    start = max(0, start)
    end = min(end, file_size - 1)
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

@app.get("/api/stats")
def get_stats():
    return state

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
        while True:
            # Check client disconnection
            if await request.is_disconnected():
                break

            # State is mutated by background_ticker; here we only broadcast it.
            yield f"data: {json.dumps(state)}\n\n"
            await asyncio.sleep(1.0)  # Tick every 1 second

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    # timeout_graceful_shutdown: 被关闭时最多等 5 秒就强制退出,避免长连接(SSE)
    # 把进程卡在"半关闭"状态变成僵尸(监听口已关、却还吊着旧连接推冻结数据)。
    uvicorn.run(app, host="0.0.0.0", port=SERVER_PORT, timeout_graceful_shutdown=5)

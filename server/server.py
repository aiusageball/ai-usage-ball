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
from zeroconf import ServiceInfo, Zeroconf
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, Response


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
        
    try:
        info = ServiceInfo(
            "_aipulse._tcp.local.",
            "AIPulse Server._aipulse._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=8000,
            properties={'desc': 'AI Pulse Local Server'},
            server="aipulseserver.local.",
        )
        zeroconf_instance = Zeroconf()
        zeroconf_instance.register_service(info)
        print(f"ZeroConf broadcasting AIPulse Server on {ip}:8000")
    except Exception as e:
        print(f"Failed to start ZeroConf: {e}")

    # Real-data pollers: Claude usage via Anthropic OAuth (direct, no CodexBar);
    # Codex/Antigravity still via CodexBar CLI for now.
    # All three providers now read real data natively (no CodexBar dependency).
    claude_task = asyncio.create_task(poll_claude_oauth())
    codex_task = asyncio.create_task(poll_codex_oauth())
    antigravity_task = asyncio.create_task(poll_antigravity_local())
    tick_task = asyncio.create_task(background_ticker())
    try:
        yield
    finally:
        claude_task.cancel()
        codex_task.cancel()
        antigravity_task.cancel()
        tick_task.cancel()
        if zeroconf_instance:
            if info:
                zeroconf_instance.unregister_service(info)
            zeroconf_instance.close()


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
        "input_tokens": 0,
        "output_tokens": 0,
        "requests": 0,
        "cost": 0.0,
        "rate_limit_pct": 0.0,
        "rate_limit_pct_secondary": 0.0,
        "status": "NORMAL",
        "status_secondary": "NORMAL",
        "reset_time": "",
        "reset_time_secondary": "",
        "resetsAt": "",
        "resetsAt_secondary": "",
        "ai_credits": 780,
        "extraRateWindows": [],
        "logs": []
    },
    "claude": {
        "provider": "Claude",
        "input_tokens": 0,
        "output_tokens": 0,
        "requests": 0,
        "cost": 0.0,
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
        "logs": []
    },
    "codex": {
        "provider": "Codex",
        "input_tokens": 0,
        "output_tokens": 0,
        "requests": 0,
        "cost": 0.0,
        "rate_limit_pct": 0.0,
        "status": "NORMAL",
        "reset_time": "",
        "resetsAt": "",
        "reset_credits": None,
        "logs": []
    }
}

# Cost configurations per 1M tokens
COST_RATES = {
    "antigravity": {"input": 0.075, "output": 0.30},  # Gemini 1.5 Flash rates
    "claude": {"input": 3.00, "output": 15.00},       # Claude 3.5 Sonnet rates
    "codex": {"input": 2.50, "output": 10.00}         # OpenAI GPT-4o Codex rates
}

# All machine-specific paths are overridable via environment variables so the
# app is not hard-wired to one user's home directory.
LOG_FILE = os.environ.get("AIPULSE_LOG_FILE", "")
last_processed_line = 0

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

def estimate_tokens(text: str) -> int:
    """Simple robust heuristic: 4 characters = 1 token"""
    if not text:
        return 0
    return max(1, len(text) // 4)

def update_antigravity_metrics():
    global last_processed_line
    if not os.path.exists(LOG_FILE):
        return

    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()

        # If the file shrank, it was rotated or truncated — reset the cursor so
        # we don't get permanently stuck never reading new content again.
        if len(lines) < last_processed_line:
            last_processed_line = 0

        if len(lines) <= last_processed_line:
            return

        new_lines = lines[last_processed_line:]
        last_processed_line = len(lines)

        for line in new_lines:
            try:
                data = json.loads(line.strip())
                step_type = data.get("type", "")
                source = data.get("source", "")
                content = data.get("content", "")
                tool_calls = data.get("tool_calls", [])

                inp_tokens = 0
                out_tokens = 0
                log_msg = ""

                # 1. User Input
                if step_type == "USER_INPUT":
                    inp_tokens = estimate_tokens(content)
                    state["antigravity"]["requests"] += 1
                    log_msg = f"User: {content[:80]}..."
                
                # 2. Model Response (Actual Output)
                elif step_type == "PLANNER_RESPONSE":
                    out_tokens = estimate_tokens(content)
                    if tool_calls:
                        out_tokens += estimate_tokens(str(tool_calls))
                        log_msg = f"Agent tool call: {[tc.get('name') for tc in tool_calls]}"
                    else:
                        log_msg = f"Agent response: {content[:80]}..."
                
                # 3. Tool results or system actions (Inputs to the model for next step)
                else:
                    inp_tokens = estimate_tokens(content)
                    if step_type not in ["CONVERSATION_HISTORY", "SYSTEM"]:
                        log_msg = f"Tool output [{step_type}]: {content[:60]}..."

                # Update metrics
                state["antigravity"]["input_tokens"] += inp_tokens
                state["antigravity"]["output_tokens"] += out_tokens
                
                # Update Costs
                state["antigravity"]["cost"] = (
                    (state["antigravity"]["input_tokens"] / 1000000.0 * COST_RATES["antigravity"]["input"]) +
                    (state["antigravity"]["output_tokens"] / 1000000.0 * COST_RATES["antigravity"]["output"])
                )

                if log_msg:
                    timestamp = time.strftime("%H:%M:%S")
                    state["antigravity"]["logs"].insert(0, {
                        "time": timestamp,
                        "msg": log_msg,
                        "tokens": inp_tokens + out_tokens
                    })
                    state["antigravity"]["logs"] = state["antigravity"]["logs"][:30] # Keep last 30 logs

            except Exception as e:
                print(f"Error parsing line: {e}")

    except Exception as e:
        print(f"Error reading log file: {e}")

# Background CodexBar CLI Polling Task
CODEXBAR_CLI = os.environ.get(
    "AIPULSE_CODEXBAR_CLI",
    "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
)

def format_iso_timestamp(iso_str: str) -> str:
    if not iso_str:
        return ""
    try:
        iso_str_clean = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso_str_clean)
        # Local timezone offset in hours, defaults to UTC+10 (AEST). Override with AIPULSE_TZ_OFFSET.
        tz_offset = float(os.environ.get("AIPULSE_TZ_OFFSET", "10"))
        local_tz = timezone(timedelta(hours=tz_offset))
        dt_local = dt.astimezone(local_tz)
        return dt_local.strftime("%b %d at %-I:%M %p")
    except Exception as e:
        print(f"Error formatting timestamp {iso_str}: {e}")
        return iso_str

# ── Claude: real usage straight from Anthropic's OAuth endpoint ──
# Reuses the Claude Code OAuth token already on this machine (no CodexBar, no
# browser cookies). Approach mirrors the open-source CodexBar (MIT, steipete).
CLAUDE_CREDS_FILE = os.path.expanduser("~/.claude/.credentials.json")
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"

def _find_access_token(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in ("accesstoken", "access_token") and isinstance(v, str):
                return v
            found = _find_access_token(v)
            if found:
                return found
    return None

def _find_expires_at(obj):
    """Walk the credential JSON to find 'expiresAt' (epoch ms)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "expiresAt" and isinstance(v, (int, float)):
                return v
            found = _find_expires_at(v)
            if found is not None:
                return found
    return None

_cached_cookie_token = None
_cached_cookie_expiry = None

def get_claude_token_with_expiry():
    """Read the Claude Code OAuth access token + expiresAt from the credentials
    file AND the macOS Keychain, and return whichever is still valid (preferring
    the freshest). Returns (token, expires_epoch_s) or (None, None)."""
    global _cached_cookie_token, _cached_cookie_expiry

    def _parse_raw(raw):
        """Parse a raw JSON string into (token, expires_epoch_s) or (None, None)."""
        if not raw:
            return None, None
        try:
            obj = json.loads(raw)
            token = _find_access_token(obj)
            expires_ms = _find_expires_at(obj)
            expires_s = (expires_ms / 1000.0) if expires_ms and expires_ms > 1e12 else (expires_ms or None)
            return token, expires_s
        except Exception:
            if raw.startswith("sk-ant"):
                return raw, None
            return None, None

    candidates = []
    now = time.time()

    # Source 1: credentials file
    if os.path.exists(CLAUDE_CREDS_FILE):
        try:
            with open(CLAUDE_CREDS_FILE) as f:
                token, exp = _parse_raw(f.read())
            if token:
                candidates.append((token, exp))
        except Exception:
            pass

    # Source 2: macOS Keychain
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).decode().strip()
        token, exp = _parse_raw(raw)
        if token:
            candidates.append((token, exp))
    except Exception:
        pass



    # Prefer the candidate that is NOT expired. Among valid ones, pick the
    # one that expires latest (freshest). If all are expired, return the one
    # that expired most recently (least stale).
    def sort_key(pair):
        _, exp = pair
        if exp is None:
            return (0, 0)           # unknown expiry: treat as maybe-valid, low priority
        valid = 1 if exp > now else 0
        return (valid, exp)

    candidates.sort(key=sort_key, reverse=True)
    best_candidate = candidates[0] if candidates else (None, None)

    # Source 3: Browser Cookies (Zero-login fallback)
    # If we have no valid candidate from CLI/Keychain (meaning we have none, or the best one is expired)
    # then fallback to extracting the cookie directly from the user's browser, matching CodexBar behavior.
    best_exp = best_candidate[1]
    is_valid = best_exp is not None and best_exp > now
    
    if not is_valid:
        # Check our in-memory cache first to avoid spamming the user with macOS Keychain prompts
        if _cached_cookie_token and _cached_cookie_expiry and _cached_cookie_expiry > now:
            return _cached_cookie_token, _cached_cookie_expiry

        print("CLI/Keychain tokens expired or missing. Falling back to browser cookies...")
        cookie_found = False
        
        # 1. Try rookiepy (fastest, Rust-based)
        try:
            import rookiepy
            for browser_func in [rookiepy.chrome, rookiepy.safari, rookiepy.edge, rookiepy.brave]:
                try:
                    cookies = browser_func(["claude.ai"])
                    for c in cookies:
                        if c.get("name") == "sessionKey" and c.get("value", "").startswith("sk-ant"):
                            print(f"✅ Found sessionKey via rookiepy")
                            exp = c.get("expires", c.get("expires_on"))
                            if not exp:
                                exp = now + (30 * 86400)
                            _cached_cookie_token = c["value"]
                            _cached_cookie_expiry = exp
                            return c["value"], exp
                except Exception:
                    continue
        except ImportError:
            pass
            
        # 2. Try browser_cookie3 (pure python)
        if not cookie_found:
            try:
                import browser_cookie3
                # We try browsers individually because Safari might throw "Operation not permitted"
                # without Full Disk Access, and we don't want that to crash the Chrome extraction.
                for loader in [browser_cookie3.chrome, browser_cookie3.safari, browser_cookie3.edge, browser_cookie3.firefox]:
                    try:
                        cj = loader(domain_name="claude.ai")
                        for c in cj:
                            if c.name == "sessionKey" and c.value.startswith("sk-ant"):
                                print(f"✅ Found sessionKey via browser_cookie3 ({loader.__name__})")
                                exp = c.expires if c.expires else now + (30 * 86400)
                                _cached_cookie_token = c.value
                                _cached_cookie_expiry = exp
                                return c.value, exp
                    except Exception as e:
                        continue
            except ImportError:
                print("Neither rookiepy nor browser_cookie3 installed.")
            except Exception as e:
                print(f"browser_cookie3 fallback failed: {e}")

    return best_candidate

# Keep the old name as an alias for backwards compatibility.
def get_claude_token():
    token, _ = get_claude_token_with_expiry()
    return token

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

def fetch_claude_usage_via_cookie():
    """用 sessionKey 调 claude.ai usage API,返回与 OAuth usage 同构的 dict
    (含 five_hour / seven_day),失败返回 None。"""
    sk = _get_claude_sessionkey()
    if not sk:
        return None
    def _get(url):
        req = urllib.request.Request(url, headers={
            "Cookie": f"sessionKey={sk}", "User-Agent": _CLAUDE_WEB_UA,
            "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    try:
        orgs = _get("https://claude.ai/api/organizations")
        oid = orgs[0]["uuid"] if isinstance(orgs, list) and orgs else None
        if not oid:
            return None
        return _get(f"https://claude.ai/api/organizations/{oid}/usage")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            global _cached_claude_sessionkey
            _cached_claude_sessionkey = None   # cookie 失效 → 下次重新从浏览器读
        return None
    except Exception:
        return None

def _read_file_access_token():
    """只读 ~/.claude/.credentials.json 里现成的 access_token(不刷新)。OAuth 兜底用。"""
    try:
        o = (json.load(open(CLAUDE_CREDS_FILE)).get("claudeAiOauth") or {})
        return o.get("accessToken")
    except Exception:
        return None

def fetch_claude_usage_resilient():
    """Claude 用量多源:优先浏览器 cookie(永不失效),失败退到现成 OAuth token
    (只读不刷新,避免和 CLI 抢轮换)。返回 (usage_dict 或 None, 来源字符串)。"""
    u = fetch_claude_usage_via_cookie()
    if u:
        return u, "cookie"
    tok = _read_file_access_token()
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

# Claude Code 的公开 OAuth client_id + 刷新端点(实测 api.anthropic.com 可用,
# console.anthropic.com 被 Cloudflare 挡 403)。
CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
CLAUDE_OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"

def refresh_claude_token_file():
    """用 ~/.claude/.credentials.json 里的 refresh_token 换一套新 token、写回文件,
    返回新的 access_token(失败返回 None)。

    这让 AI Pulse 自己刷新、不再寄生于 Claude CLI —— 你一段时间不用 CLI,token 也不
    会馊掉(以前正是这样反复过期)。只动这个文件,**不碰 Keychain**(那里还存着十几个
    MCP 插件的 OAuth token,误写会全抹掉)。AI Pulse 取 token 时本就优先读文件。"""
    try:
        with open(CLAUDE_CREDS_FILE) as f:
            cred = json.load(f)
    except Exception:
        return None
    oauth = cred.get("claudeAiOauth") or {}
    rt = oauth.get("refreshToken")
    if not rt:
        return None
    try:
        body = json.dumps({
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": CLAUDE_OAUTH_CLIENT_ID,
        }).encode()
        req = urllib.request.Request(
            CLAUDE_OAUTH_TOKEN_URL, data=body,
            headers={"Content-Type": "application/json"})
        new = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
    except Exception as e:
        print(f"Claude token refresh failed: {e}")
        return None
    at = new.get("access_token")
    if not at:
        return None
    oauth["accessToken"] = at
    oauth["refreshToken"] = new.get("refresh_token", rt)   # refresh token 会轮换,存回新的
    ein = new.get("expires_in")
    if ein:
        oauth["expiresAt"] = int((time.time() + ein) * 1000)
    cred["claudeAiOauth"] = oauth
    try:
        tmp = CLAUDE_CREDS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cred, f, indent=2)
        os.replace(tmp, CLAUDE_CREDS_FILE)   # 原子替换,避免写一半损坏
        os.chmod(CLAUDE_CREDS_FILE, 0o600)
    except Exception as e:
        print(f"Claude token write-back failed: {e}")
        return None
    print("✅ Claude OAuth token auto-refreshed.")
    return at

def maybe_refresh_claude_token():
    """文件 token 已过期 / 5 分钟内将过期 → 主动刷新。

    放在 poll 每轮开头调用,确保后端优先用「官方 refresh_token 刷出来的新鲜 token」,
    而不是依赖浏览器登录的 cookie 回退(那个一旦你没在浏览器登录 claude.ai 就失效)。"""
    try:
        with open(CLAUDE_CREDS_FILE) as f:
            exp = (json.load(f).get("claudeAiOauth") or {}).get("expiresAt")
    except Exception:
        return
    if exp and time.time() > (exp / 1000 - 300):
        refresh_claude_token_file()

# Track whether we already logged the "token expired" message so we don't spam.
_claude_expired_logged = False
# 上次自动刷新的时间戳,用来给 401 自动刷新节流(避免刷出来仍被拒时狂刷端点)。
_claude_last_refresh = 0.0

async def poll_claude_oauth():
    """Claude 用量轮询:cookie 为主源(对标 CodexBar,永不失效),OAuth token 只读兜底。
    不再自己刷新 OAuth token —— 那会和 Claude CLI 抢一次性轮换的 refresh_token、触发服务端
    把整条链吊销(之前 token 反复失效就是这么来的)。刷新交还给 CLI;cookie 不受影响。"""
    global _claude_last_ok
    print("Starting Claude usage polling (cookie-first, OAuth fallback)...")
    while True:
        try:
            usage, source = await asyncio.to_thread(fetch_claude_usage_resilient)
            if not usage:
                # cookie + OAuth 都拿不到(浏览器没登录 claude.ai 且 token 也失效)
                if _claude_last_ok and time.time() - _claude_last_ok > CLAUDE_STALE_AFTER_SEC:
                    state["claude"]["stale"] = True
                _log_claude("⚠ 取不到用量 — 请在浏览器登录 claude.ai", dedup=True)
                await asyncio.sleep(60.0)
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
            state["claude"]["stale"] = False
            state["claude"]["tokenExpired"] = False
            state["claude"]["updatedAt"] = datetime.now(timezone.utc).isoformat()
            _log_claude(f"Claude({source}): session {fh_util:.0f}% used, weekly {sd_util:.0f}% used",
                        dedup=True)
            await asyncio.sleep(60.0)  # usage changes slowly; once a minute is plenty
        except Exception as e:
            print(f"Error polling Claude usage: {e}")
            await asyncio.sleep(60.0)

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
                pri_used = safe_pct(pri.get("used_percent", 0))
                reset_at = pri.get("reset_at")
                # "限额重置券"剩余张数(撞限额时可立刻重置额度)
                reset_credits = (usage.get("rate_limit_reset_credits") or {}).get("available_count")

                state["codex"]["rate_limit_pct"] = pri_used
                state["codex"]["reset_credits"] = reset_credits
                state["codex"]["resetsAt"] = (
                    datetime.fromtimestamp(reset_at, tz=timezone.utc).isoformat()
                    if reset_at else ""
                )
                state["codex"]["status"] = "EXHAUSTED" if pri_used >= 100 else "NORMAL"

                timestamp = time.strftime("%H:%M:%S")
                plan = usage.get("plan_type", "")
                msg = f"ChatGPT/Codex: {pri_used:.0f}% used (plan: {plan})"
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
        out = subprocess.run(
            ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-p", str(pid)],
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

async def poll_antigravity_local():
    print("Starting Antigravity usage polling (local language server)...")
    while True:
        try:
            status = await asyncio.to_thread(fetch_antigravity_status)
            if not status:
                # Antigravity not running / not reachable → mark offline.
                state["antigravity"]["available"] = False
                state["antigravity"]["status"] = "OFFLINE"
                state["antigravity"]["status_secondary"] = "OFFLINE"
            else:
                us = status.get("userStatus") or {}
                models = ((us.get("cascadeModelConfigData") or {}).get("clientModelConfigs")) or []
                gemini = _ag_worst(models, "gemini")
                claude = _ag_worst(models, "claude")
                state["antigravity"]["available"] = True

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
        await asyncio.sleep(20.0)

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
    update_antigravity_metrics()
    return state

async def background_ticker():
    """Single source of state mutation, runs once regardless of how many SSE
    clients are connected. Only refreshes REAL data — the Antigravity token
    estimate from the local log. Rate-limit %/reset for all providers come from
    the CodexBar polling task; no values are simulated."""
    while True:
        update_antigravity_metrics()
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
    uvicorn.run(app, host="0.0.0.0", port=8000, timeout_graceful_shutdown=5)

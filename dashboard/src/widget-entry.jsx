import { useState, useEffect, useRef, useId } from 'react';
import { getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { resolveBackendUrl } from './backend';
import { IS_APP_STORE, CUSTOM_LABELS_STORAGE_KEY, getCustomOrbLabels } from './config';
import { LANG_STORAGE_KEY, getInitialLang, useT } from './i18n';
import {
  formatCountdownHMS,
  formatClaudePrimaryCountdown,
  formatCodexPrimaryCountdown,
} from './utils/countdown';
import './Widget.css';

const WIDGET_DRAG_THRESHOLD = 6;
const WIDGET_CONTROLS = 'button, .widget-context-menu, .orb-login-hint, .orb-login-cta';

/* ── Orb configuration per type ── */
const buildOrbConfig = (orbLabels, t) => ({
  claude: {
    color: '#ff8c00',
    secondaryColor: '#facc15',
    glowColor: 'rgba(255, 85, 0, 0.4)',
    videoFilter: 'none',
    label: orbLabels.claude.title,
    primaryLabel: orbLabels.claude.primary,
    secondaryLabel: orbLabels.claude.secondary,
    hasWeeklySecondary: true,
    stackLabels: true,
    getData: (d) => ({
      percentage: (d.claude.rate_limit_pct_secondary >= 100 || d.claude.status_secondary === "EXHAUSTED") ? 0 : (100 - d.claude.rate_limit_pct),
      secondaryPercentage: 100 - d.claude.rate_limit_pct_secondary,
    }),
    getTimers: (d) => ({
      timer: formatClaudePrimaryCountdown(d.claude, t),
      secondaryTimer: formatCountdownHMS(d.claude.resetsAt_secondary, t.ready),
    }),
  },
  codex: {
    color: '#ef4444',
    secondaryColor: '#fb7185',
    glowColor: 'rgba(239, 68, 68, 0.4)',
    videoFilter: 'hue-rotate(320deg) saturate(2) brightness(1.2)',
    label: orbLabels.codex.title,
    primaryLabel: orbLabels.codex.primary,
    secondaryLabel: orbLabels.codex.secondary,
    hasWeeklySecondary: true,
    stackLabels: true,
    getData: (d) => ({
      percentage: (d.codex.rate_limit_pct_secondary >= 100 || d.codex.status_secondary === "EXHAUSTED") ? 0 : (100 - d.codex.rate_limit_pct),
      secondaryPercentage: 100 - d.codex.rate_limit_pct_secondary,
    }),
    getTimers: (d) => ({
      timer: formatCodexPrimaryCountdown(d.codex, t),
      secondaryTimer: formatCountdownHMS(d.codex.resetsAt_secondary, t.ready),
    }),
  },
  antigravity: {
    color: '#06b6d4',
    secondaryColor: '#fb923c',
    glowColor: 'rgba(6, 182, 212, 0.4)',
    videoFilter: 'hue-rotate(185deg) saturate(1.8) brightness(1.2)',
    label: orbLabels.antigravity.title,
    primaryLabel: orbLabels.antigravity.primary,
    secondaryLabel: orbLabels.antigravity.secondary,
    hasWeeklySecondary: false,
    stackLabels: true,
    getData: (d) => ({
      percentage: 100 - (d.antigravity?.rate_limit_pct_secondary ?? 0),
      secondaryPercentage: 100 - (d.antigravity?.rate_limit_pct ?? 0),
    }),
    getTimers: (d) => ({
      timer: formatCountdownHMS(d.antigravity.resetsAt_secondary, t.ready),
      secondaryTimer: formatCountdownHMS(d.antigravity.resetsAt, t.ready),
    }),
  },
  grok: {
    color: '#e2e8f0',
    secondaryColor: '#94a3b8',
    glowColor: 'rgba(226, 232, 240, 0.4)',
    videoFilter: 'grayscale(1) brightness(1.25) contrast(1.1)',
    label: orbLabels.grok.title,
    primaryLabel: orbLabels.grok.primary,
    secondaryLabel: orbLabels.grok.secondary,
    hasWeeklySecondary: false,
    getData: (d) => ({
      percentage: (d.grok?.status === "EXHAUSTED") ? 0 : (100 - (d.grok?.rate_limit_pct || 0)),
      secondaryLabel: d.grok?.plan ? (IS_APP_STORE ? orbLabels.grok.secondary : `${d.grok.plan.toUpperCase()} PLAN`) : orbLabels.grok.secondary,
    }),
    getTimers: (d) => ({
      timer: formatCountdownHMS(d.grok?.resetsAt, t.ready),
    }),
  },
});

/* ── DualRingOrb (self-contained copy for widget isolation) ── */
const DualRingOrb = ({ color, glowColor, timer, secondaryTimer, percentage, secondaryPercentage, secondaryColor, label, primaryLabel, secondaryLabel, hasWeeklySecondary = false, stackLabels = false, videoFilter, offline = false, appName = null, resetCredits = null, dataLoaded = true, backendUrl = null, needsLogin = false, onNeedsLogin = null, needsDiskAccess = false, onNeedsDiskAccess = null, needsSetup = false, onNeedsSetup = null, criticalPctThreshold = 20, criticalMinThreshold = 30, t = null }) => {
  const uid = useId().replace(/:/g, '');
  // Which "fix it" prompt replaces the countdown, if any. Disk access wins
  // over login: when macOS refuses to open Chrome's cookie DB, logging in
  // can't help, so telling the user to do it is actively wrong. (Mirrors
  // the main window's DualRingOrb in App.jsx.)
  const authFix = needsSetup
    ? { hint: t ? t.setupHint : 'SETUP', cls: 'orb-login-hint', cta: t ? t.setupCta : '⚙ CONFIGURE IN SETTINGS', on: onNeedsSetup, title: t ? t.setupTitle : 'Open Settings' }
    : (!IS_APP_STORE && needsDiskAccess)
      ? { hint: t ? t.grantAccessHint : 'GRANT ACCESS', cls: 'orb-login-hint long', cta: t ? t.grantAccessCta : '⚠ ALLOW FULL DISK ACCESS', on: onNeedsDiskAccess, title: t ? t.grantAccessTitle : 'Open System Settings › Privacy & Security › Full Disk Access' }
      : (!IS_APP_STORE && needsLogin)
        ? { hint: t ? t.signInHint : 'SIGN IN', cls: 'orb-login-hint', cta: t ? t.signInCta : '⚠ LOG IN TO CLAUDE.AI', on: onNeedsLogin, title: t ? t.signInTitle : 'Open claude.ai to sign in' }
        : null;
  const hasSecondary = secondaryPercentage !== undefined;

  const isWeeklySecondary = hasWeeklySecondary || secondaryLabel === "WEEKLY REMAINING";
  const rawPctSec = hasSecondary ? Math.max(0, Math.min(100, secondaryPercentage)) : 0;
  const isWeeklyExhausted = hasSecondary && isWeeklySecondary && rawPctSec <= 0;

  const radius = 65;
  const strokeW = 8;
  const circumference = 2 * Math.PI * radius;
  const validPct = isWeeklyExhausted ? 0 : Math.max(0, Math.min(100, percentage));

  const radiusSec = 47;
  const strokeWSec = 6;
  const circumferenceSec = 2 * Math.PI * radiusSec;
  const validPctSec = rawPctSec;

  // 弹出 widget 时如果还没拿到真实数据(percentage 默认按 100% 算),环先保持
  // "空"而不是显示成满环再猛地跳到真实值——跟主界面同一个道理(见 App.jsx)。
  // Offline = no trustworthy reading: keep rings empty rather than showing the last value as live.
  const ringPct = (dataLoaded && !offline && !isWeeklyExhausted) ? validPct : 0;
  const ringPctSec = (dataLoaded && !offline) ? validPctSec : 0;
  const strokeDashoffset = circumference - (circumference * ringPct) / 100;
  const strokeDashoffsetSec = circumferenceSec - (circumferenceSec * ringPctSec) / 100;

  const videoRef = useRef(null);
  const videoRetryRef = useRef(0);
  const loadedOnceRef = useRef(false);

  const isTimerCritical = (timerStr) => {
    if (!timerStr || timerStr === "00:00:00" || !timerStr.includes(':') || timerStr.includes('d:')) return false;
    const parts = timerStr.split(':');
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (Number.isNaN(h) || Number.isNaN(m)) return false;
      return h * 60 + m < criticalMinThreshold;
    }
    return false;
  };

  const pctThresh = criticalPctThreshold;
  const isCritical = validPct < pctThresh || (hasSecondary && validPctSec < pctThresh) || isTimerCritical(timer) || (hasSecondary && isTimerCritical(secondaryTimer));
  const isCriticalRef = useRef(isCritical);
  isCriticalRef.current = isCritical;

  // Liquid animation (native playback + demand-driven easing timer)
  const lastReloadRef = useRef(0);
  const baseSpeedRef = useRef(0.8 + Math.random() * 0.4);
  const hoveringRef = useRef(false);
  const lingerTimerRef = useRef(null);
  const burstTimerRef = useRef(null);
  const easeTimerRef = useRef(null);
  const targetSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);
  const currentSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);

  const applyPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    const spd = currentSpeedRef.current;
    if (spd > 0.05) {
      // WebKit ignores/garbles extreme rates; the natural range here is 0.8-1.2.
      try { v.playbackRate = Math.max(0.25, Math.min(2, spd)); } catch (e) {}
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    } else if (!v.paused) {
      try { v.pause(); } catch (e) {}
    }
  };

  const ensureEaseLoop = () => {
    if (easeTimerRef.current) return;
    const vid = videoRef.current;
    if (vid && (vid.error || vid.readyState === 0) && Date.now() - lastReloadRef.current > 15000) {
      lastReloadRef.current = Date.now();
      try { vid.load(); } catch (e) {}
    }
    easeTimerRef.current = setInterval(() => {
      currentSpeedRef.current += (targetSpeedRef.current - currentSpeedRef.current) * 0.08;
      if (targetSpeedRef.current === 0 && currentSpeedRef.current <= 0.01) {
        currentSpeedRef.current = 0;
        applyPlayback();
        clearInterval(easeTimerRef.current);
        easeTimerRef.current = null;
        return;
      }
      applyPlayback();
    }, 80);
  };

  const refreshTarget = () => {
    const next =
      (hoveringRef.current || isCriticalRef.current || burstTimerRef.current) ? baseSpeedRef.current : 0;
    targetSpeedRef.current = next;
    if (next > 0 || currentSpeedRef.current > 0.01) {
      ensureEaseLoop();
    }
  };
  // Flow the liquid for `ms` (default 30s), then settle back to resting state.
  const startFlowBurst = (ms = 30000) => {
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => {
      burstTimerRef.current = null;
      refreshTarget();
    }, ms);
    targetSpeedRef.current = baseSpeedRef.current;
    ensureEaseLoop();
  };
  const handleEnter = () => {
    hoveringRef.current = true;
    if (lingerTimerRef.current) { clearTimeout(lingerTimerRef.current); lingerTimerRef.current = null; }
    refreshTarget();
  };
  const handleLeave = () => {
    hoveringRef.current = false;
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    lingerTimerRef.current = setTimeout(() => {
      lingerTimerRef.current = null;
      refreshTarget();
    }, 20000);
  };

  useEffect(() => { refreshTarget(); }, [isCritical]);
  // On pop-out (mount), flow the liquid for 30 seconds, then settle.
  useEffect(() => { startFlowBurst(30000); }, []);

  // WKWebView withholds native mouseenter/mousemove/mouseleave from inactive
  // windows (widgets are alwaysOnBottom + focus:false, so they're always
  // "inactive" — this is deliberate WebKit policy, not a missing config; see
  // lib.rs's spawn_widget_hover_poller). The Rust side polls the OS-global
  // cursor position instead and emits these once the cursor has sat over the
  // widget for 2s, so hovering still visibly starts the liquid flowing.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromises = [
      win.listen('hover-dwell-start', () => handleEnter()),
      win.listen('hover-dwell-end', () => handleLeave()),
    ];
    return () => { unlistenPromises.forEach(p => p.then(fn => fn())); };
  }, []);

  // ── Ambient random pulse: occasionally the orb flows by itself ──
  const ambientTimerRef = useRef(null);
  useEffect(() => {
    const scheduleNext = () => {
      // Wait 20-40 minutes before the next random pulse
      const delay = (20 + Math.random() * 20) * 60 * 1000;
      ambientTimerRef.current = setTimeout(() => {
        // Flow for 8-15 seconds, then settle
        startFlowBurst((8 + Math.random() * 7) * 1000);
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => { if (ambientTimerRef.current) clearTimeout(ambientTimerRef.current); };
  }, []);

  useEffect(() => () => {
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    if (easeTimerRef.current) { clearInterval(easeTimerRef.current); easeTimerRef.current = null; }
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      try { v.currentTime = Math.random() * (v.duration || 10); } catch (e) {}
    }
    currentSpeedRef.current = isCriticalRef.current ? baseSpeedRef.current : 0;
    if (targetSpeedRef.current > 0 || currentSpeedRef.current > 0.01) {
      ensureEaseLoop();
    }
  }, []);

  const isExhausted = validPct <= 0 || isWeeklyExhausted;

  return (
    <div className="orb-wrapper" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className={`orb-glass-breather ${offline || authFix ? 'offline-state' : isExhausted ? 'exhausted-state' : isCritical ? 'critical-state' : ''}`}>
        <div
          className="orb-glass"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onClick={() => startFlowBurst(30000)}
          style={{ cursor: 'pointer' }}
        >
        <div className="orb-inner-shadow"></div>

        <div className="video-liquid-container">
          <div className="video-hover-wrapper">
            <video
              ref={videoRef}
              className="video-blob"
              src={backendUrl ? `${backendUrl}/liquid-loop.mp4?v=3` : undefined}
              preload="auto"
              loop
              muted
              playsInline
              onLoadedMetadata={() => {
                try {
                  const v = videoRef.current;
                  if (v && v.duration) v.currentTime = Math.random() * (v.duration - 0.1);
                } catch (e) {}
              }}
              onLoadedData={() => {
                loadedOnceRef.current = true;
                videoRetryRef.current = 0;
                if (targetSpeedRef.current > 0 || currentSpeedRef.current > 0.01) {
                  applyPlayback();
                  ensureEaseLoop();
                }
              }}
              onError={() => {
                // Two different situations share this handler:
                //  - Cold start: the bundled PyInstaller backend unpacks slowly,
                //    so the video endpoint can 404 for a while (~2min of retries).
                //  - Mid-session: the backend restarted (or the media stack
                //    dropped the element) after it had already loaded once.
                // The old code bailed out entirely once loadedOnce was set, so
                // the second case left the orb permanently frozen with no way to
                // recover short of closing and re-opening the widget. Retry in
                // both cases; the counter resets on every successful load.
                if (videoRetryRef.current >= 40) return;
                videoRetryRef.current += 1;
                setTimeout(() => {
                  try { videoRef.current && videoRef.current.load(); } catch (e) {}
                }, 3000);
              }}
              style={{
                transform: `scale(${Math.max(0.01, ((isWeeklyExhausted || offline) ? 0 : validPct) / 100)})`,
                transformOrigin: 'center center',
                opacity: Math.min(1, ((isWeeklyExhausted || offline) ? 0 : validPct) / 8),
                filter: videoFilter
              }}
            />
          </div>
        </div>

        <svg className="orb-rings-svg" viewBox="0 0 200 200">
          <defs>
            <filter id={`glow-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            {hasSecondary && (
              <filter id={`glow-sec-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            )}
          </defs>
          <circle cx="100" cy="100" r={radius} stroke={color} opacity="0.15" strokeWidth={strokeW} fill="none" />
          <circle
            cx="100" cy="100" r={radius}
            stroke={color} strokeWidth={strokeW} fill="none"
            opacity="0.9" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
            transform="rotate(-90 100 100)"
            filter={`url(#glow-${uid})`}
          />
          {hasSecondary ? (
            <>
              <circle cx="100" cy="100" r={radiusSec} stroke={secondaryColor} opacity="0.1" strokeWidth={strokeWSec} fill="none" />
              <circle
                cx="100" cy="100" r={radiusSec}
                stroke={secondaryColor} strokeWidth={strokeWSec} fill="none"
                opacity="0.5" strokeLinecap="round"
                strokeDasharray={circumferenceSec} strokeDashoffset={strokeDashoffsetSec}
                transform="rotate(-90 100 100)"
                filter={`url(#glow-sec-${uid})`}
              />
            </>
          ) : (
            <circle cx="100" cy="100" r="45" stroke={color} opacity="0.08" strokeWidth="10" fill="none" />
          )}
        </svg>

        <div className="orb-timer-wrapper">
          {authFix ? (
            <span
              className={`orb-timer ${authFix.cls}`}
              onClick={(e) => { e.stopPropagation(); if (authFix.on) authFix.on(); }}
              style={{ cursor: authFix.on ? 'pointer' : 'default' }}
              title={authFix.title}
            >{authFix.hint}</span>
          ) : (
            <span className="orb-timer" style={{ textShadow: `0 0 12px ${color}` }}>{offline ? "--:--:--" : isWeeklyExhausted && (timer === (t ? t.readyToGo : "READY TO GO") || timer === (t ? t.ready : "READY")) ? (t ? t.waitReset : "WAIT RESET") : timer}</span>
          )}
          {authFix || offline ? null : secondaryTimer ? (
            <span className="orb-timer-secondary" style={{ color: secondaryColor || '#fb923c', textShadow: `0 0 8px ${secondaryColor || '#fb923c'}` }}>{secondaryTimer}</span>
          ) : null}
        </div>

        <div className="orb-specular"></div>
        </div>
      </div>

      <div className="orb-ground-glow" style={{ background: glowColor }}></div>

      <div className="orb-label-container">
        <h3 className="orb-title">{label}</h3>
        {authFix ? (
          <p
            className="orb-subtitle orb-offline orb-login-cta"
            onClick={(e) => { e.stopPropagation(); if (authFix.on) authFix.on(); }}
            style={{ cursor: authFix.on ? 'pointer' : 'default' }}
            title={authFix.title}
          >{authFix.cta}</p>
        ) : offline ? (
          <p className="orb-subtitle orb-offline">{t ? t.offlineOpenApp(appName) : (appName ? `OFFLINE · OPEN ${appName.toUpperCase()}` : 'OFFLINE')}</p>
        ) : hasSecondary ? (
          <div className="orb-usage-lines" style={{ flexDirection: stackLabels ? 'column' : 'row', gap: stackLabels ? '4px' : '8px' }}>
            <p className="orb-subtitle"><span className="orb-indicator-dot" style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />{primaryLabel || "PRIMARY"} {validPct.toFixed(0)}%</p>
            <p className="orb-subtitle"><span className="orb-indicator-dot" style={{ backgroundColor: secondaryColor, boxShadow: `0 0 6px ${secondaryColor}` }} />{secondaryLabel || "SECONDARY"} {validPctSec.toFixed(0)}%</p>
            {resetCredits != null && <p className="orb-subtitle orb-reset-credits">{t ? t.resetsLeft(resetCredits) : `↺ ${resetCredits} ${resetCredits === 1 ? 'RESET' : 'RESETS'} LEFT`}</p>}
          </div>
        ) : (
          <>
            <p className="orb-subtitle">{primaryLabel ? `${primaryLabel} ${validPct.toFixed(0)}%` : `${validPct.toFixed(0)}% REMAINING`}</p>
            {/* Single-ring orbs (Grok) still show their plan line, without a fake second ring. */}
            {secondaryLabel && <p className="orb-subtitle orb-plan-label">{secondaryLabel}</p>}
            {resetCredits != null && <p className="orb-subtitle orb-reset-credits">{t ? t.resetsLeft(resetCredits) : `↺ ${resetCredits} ${resetCredits === 1 ? 'RESET' : 'RESETS'} LEFT`}</p>}
          </>
        )}
      </div>
    </div>
  );
};

// Desktop app each orb opens (matches open_provider_app in src-tauri/src/lib.rs).
const APP_NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok Bot' };

const readStoredNumber = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    const n = Number(parsed);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
};

/* ── Widget App ── */
function WidgetApp() {
  // Read which orb to display from URL params
  const params = new URLSearchParams(window.location.search);
  const orbType = params.get('orb') || 'claude';

  const [lang, setLang] = useState(getInitialLang);
  const [alertThreshold, setAlertThreshold] = useState(() => readStoredNumber('aipulse_alertThreshold', 20));
  const [alertTimerMin, setAlertTimerMin] = useState(() => readStoredNumber('aipulse_alertTimerMin', 30));
  const [labelVersion, setLabelVersion] = useState(0);

  const t = useT(lang);
  const orbLabels = getCustomOrbLabels(IS_APP_STORE, lang);
  const configs = buildOrbConfig(orbLabels, t);
  const config = configs[orbType] || configs.claude;

  // Keep refs in sync so timer interval uses updated language/labels immediately.
  const configRef = useRef(config);
  configRef.current = config;

  // Reload appearance/alert/language settings when changed in the main window.
  useEffect(() => {
    const syncFromStorage = () => {
      setLang(getInitialLang());
      setAlertThreshold(readStoredNumber('aipulse_alertThreshold', 20));
      setAlertTimerMin(readStoredNumber('aipulse_alertTimerMin', 30));
      setLabelVersion((v) => v + 1);
    };
    const onStorage = (e) => {
      if (
        !e.key ||
        e.key === LANG_STORAGE_KEY ||
        e.key === CUSTOM_LABELS_STORAGE_KEY ||
        e.key === 'aipulse_alertThreshold' ||
        e.key === 'aipulse_alertTimerMin'
      ) {
        syncFromStorage();
      }
    };
    window.addEventListener('storage', onStorage);
    const win = getCurrentWindow();
    const unlistenPromise = win.listen('settings-changed', syncFromStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const [data, setData] = useState({
    antigravity: { loaded: false, rate_limit_pct: 0, rate_limit_pct_secondary: 0, resetsAt: '', resetsAt_secondary: '' },
    claude: { loaded: false, rate_limit_pct: 0, rate_limit_pct_secondary: 0, resetsAt: '', resetsAt_secondary: '' },
    codex: { loaded: false, rate_limit_pct: 0, rate_limit_pct_secondary: 0, resetsAt: '', resetsAt_secondary: '', primary_window_started: false },
    grok: { loaded: false, rate_limit_pct: 0, resetsAt: '', status: 'NORMAL' },
  });
  const [timers, setTimers] = useState({ timer: '00:00:00', secondaryTimer: '00:00:00' });
  const [backendUrl, setBackendUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    resolveBackendUrl().then((url) => {
      if (!cancelled) setBackendUrl(url);
    });
    return () => { cancelled = true; };
  }, []);

  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // SSE connection
  useEffect(() => {
    if (!backendUrl) return undefined;
    let es = null;
    let retryTimer = null;
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      es = new EventSource(`${backendUrl}/api/stream`);
      es.onmessage = (e) => {
        try { setData(JSON.parse(e.data)); } catch (err) {}
      };
      es.onerror = () => {
        es.close();
        if (!cancelled) {
          retryTimer = setTimeout(connect, 3000);
        }
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (es) es.close();
    };
  }, [backendUrl]);

  // Timer tick (also re-runs immediately on lang/labelVersion update)
  useEffect(() => {
    setTimers(configRef.current.getTimers(dataRef.current));
    const id = setInterval(() => {
      setTimers(configRef.current.getTimers(dataRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, [orbType, lang, labelVersion]);

  const orbData = config.getData(data);

  // ── Update-ready badge (direct distribution only) ──
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    if (IS_APP_STORE) return undefined;
    const win = getCurrentWindow();
    const p = win.listen('update-ready', () => setUpdateReady(true));
    return () => { p.then(fn => fn()).catch(() => {}); };
  }, []);

  const restartForUpdate = async (e) => {
    e.stopPropagation();
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {}
  };

  // ── Right-click context menu state ──
  const [menu, setMenu] = useState(null);
  useEffect(() => {
    const close = () => setMenu(null);
    const onKeyDown = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const dragRef = useRef(null);

  const handlePointerDown = (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    dragRef.current = null;
    if (e.target.closest(WIDGET_CONTROLS)) return;
    if (menu) { setMenu(null); return; }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      x: e.screenX,
      y: e.screenY,
      moved: false,
      origin: null,
      frame: null,
    };
  };

  const moveWidget = (drag) => {
    if (!drag.origin || drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      if (dragRef.current !== drag) return;
      const x = drag.origin.x + drag.x - drag.startX;
      const y = drag.origin.y + drag.y - drag.startY;
      drag.win.setPosition(new LogicalPosition(x, y)).catch(() => {});
    });
  };

  const handlePointerMove = (e) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== e.pointerId || !(e.buttons & 1)) return;
    drag.x = e.screenX;
    drag.y = e.screenY;
    if (drag.moved) {
      moveWidget(drag);
      return;
    }
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < WIDGET_DRAG_THRESHOLD) return;

    // Leave clicks to WebKit. Only take control once the pointer has moved
    // far enough with the button held, and measure from the original press.
    drag.moved = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.win = getCurrentWindow();
    Promise.all([drag.win.outerPosition(), drag.win.scaleFactor()])
      .then(([position, scale]) => {
        if (dragRef.current !== drag) return;
        drag.origin = position.toLogical(scale);
        moveWidget(drag);
      }).catch(() => {});
  };

  const handlePointerUp = (e) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== e.pointerId) return;
    drag.pointerId = null;
    if (!drag.moved) return;
    drag.x = e.screenX;
    drag.y = e.screenY;
    moveWidget(drag);
  };

  const suppressDragClick = (e) => {
    if (e.detail === 0 || !dragRef.current?.moved) return;
    e.stopPropagation();
  };

  // Double-click the orb → launch this provider's desktop app in direct mode,
  // or bring back the main dashboard in App Store sandboxed mode.
  const openProviderApp = (e) => {
    if (dragRef.current?.moved || e.target.closest(WIDGET_CONTROLS)) return;
    if (IS_APP_STORE) {
      reopenMain();
      return;
    }
    invoke('open_provider_app', { provider: orbType }).catch(() => {});
  };

  // Bring the (possibly hidden) main dashboard back — available from the
  // right-click menu. (Double-click used to do this; it now opens the app.)
  const reopenMain = async () => {
    try {
      const main = await WebviewWindow.getByLabel('main');
      if (main) { await main.show(); await main.setFocus(); }
    } catch (e) {}
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    // Keep the menu fully inside the small widget window (the OS clips anything
    // past the window bounds), nudging it in when right-clicking near an edge.
    const menuW = 170;
    const menuH = 84;
    const x = Math.max(6, Math.min(e.clientX, window.innerWidth - menuW - 6));
    const y = Math.max(6, Math.min(e.clientY, window.innerHeight - menuH - 6));
    setMenu({ x, y });
  };

  const closeWidget = (e) => {
    e.stopPropagation();
    getCurrentWindow().close().catch(() => {});
  };

  const orbState = data[orbType];

  return (
    <div
      className="widget-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { dragRef.current = null; }}
      onClickCapture={suppressDragClick}
      onDoubleClick={openProviderApp}
      onContextMenu={handleContextMenu}
    >
      <DualRingOrb
        color={config.color}
        secondaryColor={config.secondaryColor}
        glowColor={config.glowColor}
        videoFilter={config.videoFilter}
        timer={timers.timer}
        secondaryTimer={timers.secondaryTimer}
        percentage={orbData.percentage}
        secondaryPercentage={orbData.secondaryPercentage}
        label={config.label}
        primaryLabel={config.primaryLabel}
        secondaryLabel={orbData.secondaryLabel ?? config.secondaryLabel}
        hasWeeklySecondary={!!config.hasWeeklySecondary}
        stackLabels={config.stackLabels}
        connected={true}
        dataLoaded={!!orbState?.loaded}
        resetCredits={orbType === 'codex' && data.codex ? data.codex.reset_credits : null}
        offline={!!orbState && orbState.available === false && !orbState.needsSetup}
        appName={IS_APP_STORE ? config.label : APP_NAMES[orbType]}
        needsLogin={!IS_APP_STORE && orbType === 'claude' && !!data.claude && !!data.claude.needsLogin && (!data.claude.loaded || !!data.claude.stale)}
        onNeedsLogin={() => openUrl('https://claude.ai').catch(() => {})}
        needsDiskAccess={!IS_APP_STORE && orbType === 'claude' && !!data.claude && !!data.claude.needsDiskAccess && (!data.claude.loaded || !!data.claude.stale)}
        onNeedsDiskAccess={() => invoke('open_full_disk_access_settings').catch(() => {})}
        needsSetup={!!orbState?.needsSetup}
        onNeedsSetup={reopenMain}
        criticalPctThreshold={alertThreshold}
        criticalMinThreshold={alertTimerMin}
        t={t}
        backendUrl={backendUrl}
      />

      {!IS_APP_STORE && updateReady && (
        <button
          className="widget-update-badge"
          onClick={restartForUpdate}
          title={t.widgetRestartUpdate}
        />
      )}

      {menu && (
        <div
          className="widget-context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button onClick={reopenMain}>{t.widgetOpenDashboard}</button>
          {!IS_APP_STORE && updateReady && <button onClick={restartForUpdate}>{t.widgetRestartUpdate}</button>}
          <button className="danger" onClick={closeWidget}>{t.widgetClose}</button>
        </div>
      )}
    </div>
  );
}

/* ── Mount ── */
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('widget-root')).render(<WidgetApp />);

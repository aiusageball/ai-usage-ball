import React, { useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import './Widget.css';

/* ── Shared helpers (duplicated from App.jsx to keep widget self-contained) ── */

const formatCountdownHMS = (resetsAtIso) => {
  if (!resetsAtIso) return "READY";
  try {
    const resetDate = new Date(resetsAtIso);
    const now = new Date();
    const diffMs = resetDate - now;
    if (diffMs <= 0) return "READY";
    const totalSecs = Math.floor(diffMs / 1000);
    const secs = String(totalSecs % 60).padStart(2, '0');
    const totalMins = Math.floor(totalSecs / 60);
    const mins = String(totalMins % 60).padStart(2, '0');
    const totalHours = Math.floor(totalMins / 60);
    if (totalHours > 72) {
      const days = Math.floor(totalHours / 24);
      const remHours = totalHours % 24;
      return `${days}d:${String(remHours).padStart(2, '0')}:${mins}`;
    }
    return `${String(totalHours).padStart(2, '0')}:${mins}:${secs}`;
  } catch (e) {
    return "READY";
  }
};

/* ── Orb configuration per type ── */
const ORB_CONFIG = {
  claude: {
    color: '#ff8c00',
    secondaryColor: '#facc15',
    glowColor: 'rgba(255, 85, 0, 0.4)',
    videoFilter: 'none',
    label: 'CLAUDE',
    primaryLabel: 'CLAUDE REMAINING',
    secondaryLabel: 'WEEKLY REMAINING',
    stackLabels: true,
    getData: (d) => ({
      percentage: 100 - d.claude.rate_limit_pct,
      secondaryPercentage: 100 - d.claude.rate_limit_pct_secondary,
    }),
    getTimers: (d) => ({
      timer: formatCountdownHMS(d.claude.resetsAt),
      secondaryTimer: formatCountdownHMS(d.claude.resetsAt_secondary),
    }),
  },
  codex: {
    color: '#ef4444',
    glowColor: 'rgba(239, 68, 68, 0.4)',
    videoFilter: 'hue-rotate(320deg) saturate(2) brightness(1.2)',
    label: 'CODEX',
    primaryLabel: 'CODEX REMAINING',
    stackLabels: false,
    getData: (d) => ({
      percentage: 100 - d.codex.rate_limit_pct,
    }),
    getTimers: (d) => ({
      timer: formatCountdownHMS(d.codex.resetsAt),
    }),
  },
  antigravity: {
    color: '#06b6d4',
    secondaryColor: '#fb923c',
    glowColor: 'rgba(6, 182, 212, 0.4)',
    videoFilter: 'hue-rotate(185deg) saturate(1.8) brightness(1.2)',
    label: 'ANTIGRAVITY',
    primaryLabel: 'GEMINI REMAINING',
    secondaryLabel: 'CLAUDE REMAINING',
    stackLabels: true,
    getData: (d) => ({
      percentage: 100 - d.antigravity.rate_limit_pct_secondary,
      secondaryPercentage: 100 - d.antigravity.rate_limit_pct,
    }),
    getTimers: (d) => ({
      timer: formatCountdownHMS(d.antigravity.resetsAt_secondary),
      secondaryTimer: formatCountdownHMS(d.antigravity.resetsAt),
    }),
  },
};

/* ── DualRingOrb (self-contained copy for widget isolation) ── */
const DualRingOrb = ({ color, glowColor, timer, secondaryTimer, percentage, secondaryPercentage, secondaryColor, label, primaryLabel, secondaryLabel, stackLabels = false, videoFilter, offline = false, resetCredits = null, dataLoaded = true }) => {
  const radius = 65;
  const circumference = 2 * Math.PI * radius;
  const validPct = Math.max(0, Math.min(100, percentage));

  const hasSecondary = secondaryPercentage !== undefined;
  const radiusSec = 47;
  const circumferenceSec = 2 * Math.PI * radiusSec;
  const validPctSec = hasSecondary ? Math.max(0, Math.min(100, secondaryPercentage)) : 0;

  // 弹出 widget 时如果还没拿到真实数据(percentage 默认按 100% 算),环先保持
  // "空"而不是显示成满环再猛地跳到真实值——跟主界面同一个道理(见 App.jsx)。
  const ringPct = dataLoaded ? validPct : 0;
  const ringPctSec = dataLoaded ? validPctSec : 0;
  const strokeDashoffset = circumference - (circumference * ringPct) / 100;
  const strokeDashoffsetSec = circumferenceSec - (circumferenceSec * ringPctSec) / 100;

  const videoRef = useRef(null);
  const videoRetryRef = useRef(0);
  const loadedOnceRef = useRef(false);

  const isTimerCritical = (t) => {
    if (!t || t === "00:00:00" || !t.includes(':')) return false;
    const parts = t.split(':');
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      return h === 0 && m < 30;
    }
    return false;
  };

  const isCritical = validPct < 10 || (hasSecondary && validPctSec < 10) || isTimerCritical(timer) || (hasSecondary && isTimerCritical(secondaryTimer));
  const isCriticalRef = useRef(isCritical);
  isCriticalRef.current = isCritical;

  const rotationRef = useRef(Math.floor(Math.random() * 360));

  // Liquid animation state (native playback — see the effect further down)
  const lastReloadRef = useRef(0);
  const baseSpeedRef = useRef(0.8 + Math.random() * 0.4);
  const hoveringRef = useRef(false);
  const lingerTimerRef = useRef(null);
  const burstTimerRef = useRef(null);
  const targetSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);
  const currentSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);

  const refreshTarget = () => {
    targetSpeedRef.current =
      (hoveringRef.current || isCriticalRef.current || burstTimerRef.current) ? baseSpeedRef.current : 0;
  };
  // Flow the liquid for `ms` (default 30s), then settle back to resting state.
  const startFlowBurst = (ms = 30000) => {
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => {
      burstTimerRef.current = null;
      refreshTarget();
    }, ms);
    targetSpeedRef.current = baseSpeedRef.current;
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
  }, []);

  // ── Liquid animation: NATIVE playback, not per-frame seeking ──
  // This used to advance `currentTime` by hand on every requestAnimationFrame
  // tick, on the belief that WKWebView blocks video.play() without a user
  // gesture. That belief was wrong — measured on a real widget, a muted
  // play() resolves and advances the video normally. The old approach was
  // also why the liquid kept mysteriously freezing: it pinned the animation
  // to the JS event loop (~100 seeks/sec/widget), and WebKit freely throttles
  // or suspends rAF for windows that are permanently inactive and
  // alwaysOnBottom — exactly what a desktop widget is. When that happened the
  // countdown (a setInterval) kept ticking while the liquid sat frozen.
  //
  // Native playback runs in the media pipeline instead, so no amount of JS
  // throttling can stall it — and it costs a fraction of the CPU. The asset is
  // already a baked 478-frame boomerang, so plain forward `loop` playback
  // gives the same visual with no reverse seeking (see the black-frame note in
  // App.jsx: reverse seeks flash the whole orb black in WKWebView).
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

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      try { v.currentTime = Math.random() * (v.duration || 10); } catch (e) {}
    }
    currentSpeedRef.current = isCriticalRef.current ? baseSpeedRef.current : 0;

    // Only eases the speed toward its target — the video keeps playing on its
    // own between ticks, so even if this timer gets throttled the liquid still
    // flows (it just ramps in more coarsely). 80ms ≈ 12 ticks/sec vs the old
    // ~100 seeks/sec.
    const id = setInterval(() => {
      currentSpeedRef.current += (targetSpeedRef.current - currentSpeedRef.current) * 0.08;
      applyPlayback();

      // Watchdog: if the element lost its data (backend restart, media stack
      // eviction after a long session) reload it, otherwise the orb would sit
      // frozen forever with no way back.
      const vid = videoRef.current;
      if (vid && (vid.error || vid.readyState === 0) && Date.now() - lastReloadRef.current > 15000) {
        lastReloadRef.current = Date.now();
        try { vid.load(); } catch (e) {}
      }
    }, 80);
    return () => clearInterval(id);
  }, []);

  const isExhausted = validPct <= 0;

  return (
    <div className="orb-wrapper" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className={`orb-glass-breather ${offline ? 'offline-state' : isExhausted ? 'exhausted-state' : isCritical ? 'critical-state' : ''}`}>
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
              src="http://127.0.0.1:8000/liquid-loop.mp4?v=3"
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
              onLoadedData={() => { loadedOnceRef.current = true; videoRetryRef.current = 0; }}
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
                transform: `scale(${Math.max(0.01, validPct / 100)})`,
                transformOrigin: 'center center',
                opacity: Math.min(1, validPct / 8),
                filter: videoFilter
              }}
            />
          </div>
        </div>

        <svg className="orb-rings-svg" viewBox="0 0 200 200">
          <defs>
            <filter id={`glow-${label.replace(/\s+/g, '-')}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            {hasSecondary && (
              <filter id={`glow-sec-${label.replace(/\s+/g, '-')}`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            )}
          </defs>
          <circle cx="100" cy="100" r={radius} stroke={color} opacity="0.15" strokeWidth="8" fill="none" />
          <circle
            cx="100" cy="100" r={radius}
            stroke={color} strokeWidth="8" fill="none"
            opacity="0.9" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
            transform="rotate(-90 100 100)"
            filter={`url(#glow-${label.replace(/\s+/g, '-')})`}
          />
          {hasSecondary ? (
            <>
              <circle cx="100" cy="100" r={radiusSec} stroke={secondaryColor} opacity="0.1" strokeWidth="6" fill="none" />
              <circle
                cx="100" cy="100" r={radiusSec}
                stroke={secondaryColor} strokeWidth="6" fill="none"
                opacity="0.5" strokeLinecap="round"
                strokeDasharray={circumferenceSec} strokeDashoffset={strokeDashoffsetSec}
                transform="rotate(-90 100 100)"
                filter={`url(#glow-sec-${label.replace(/\s+/g, '-')})`}
              />
            </>
          ) : (
            <circle cx="100" cy="100" r="45" stroke={color} opacity="0.08" strokeWidth="10" fill="none" />
          )}
        </svg>

        <div className="orb-timer-wrapper">
          <span className="orb-timer" style={{ textShadow: `0 0 12px ${color}` }}>{timer}</span>
          {secondaryTimer ? (
            <span className="orb-timer-secondary" style={{ color: '#fb923c', textShadow: '0 0 8px #fb923c' }}>{secondaryTimer}</span>
          ) : resetCredits != null ? (
            <span className="orb-timer-secondary" style={{ color: '#fb923c', textShadow: '0 0 8px #fb923c' }}>↺ {resetCredits} LEFT</span>
          ) : null}
        </div>

        <div className="orb-specular"></div>
        </div>
      </div>

      <div className="orb-ground-glow" style={{ background: glowColor }}></div>

      <div className="orb-label-container">
        <h3 className="orb-title">{label}</h3>
        {offline ? (
          <p className="orb-subtitle orb-offline">OFFLINE · OPEN ANTIGRAVITY</p>
        ) : hasSecondary ? (
          <div style={{ display: 'flex', flexDirection: stackLabels ? 'column' : 'row', justifyContent: 'center', alignItems: 'center', gap: stackLabels ? '4px' : '8px' }}>
            <p className="orb-subtitle">{primaryLabel || "PRIMARY"} {validPct.toFixed(0)}%</p>
            <p className="orb-subtitle">{secondaryLabel || "SECONDARY"} {validPctSec.toFixed(0)}%</p>
          </div>
        ) : (
          <p className="orb-subtitle">{primaryLabel ? `${primaryLabel} ${validPct.toFixed(0)}%` : `${validPct.toFixed(0)}% REMAINING`}</p>
        )}
      </div>
    </div>
  );
};

/* ── Widget App ── */
function WidgetApp() {
  // Read which orb to display from URL params
  const params = new URLSearchParams(window.location.search);
  const orbType = params.get('orb') || 'claude';
  const config = ORB_CONFIG[orbType] || ORB_CONFIG.claude;

  const [data, setData] = useState({
    antigravity: { loaded: false, rate_limit_pct: 0, rate_limit_pct_secondary: 0, resetsAt: '', resetsAt_secondary: '' },
    claude: { loaded: false, rate_limit_pct: 0, rate_limit_pct_secondary: 0, resetsAt: '', resetsAt_secondary: '' },
    codex: { loaded: false, rate_limit_pct: 0, resetsAt: '' },
  });
  const [timers, setTimers] = useState({ timer: '00:00:00', secondaryTimer: '00:00:00' });

  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // SSE connection
  useEffect(() => {
    let es = null;
    const connect = () => {
      es = new EventSource('http://127.0.0.1:8000/api/stream');
      es.onmessage = (e) => {
        try { setData(JSON.parse(e.data)); } catch (err) {}
      };
      es.onerror = () => {
        es.close();
        setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { if (es) es.close(); };
  }, []);

  // Timer tick
  useEffect(() => {
    const id = setInterval(() => {
      const t = config.getTimers(dataRef.current);
      setTimers(t);
    }, 1000);
    return () => clearInterval(id);
  }, [config]);

  const orbData = config.getData(data);

  // ── Update-ready badge ──
  // Most people barely reopen the main window once a widget is pinned to
  // their desktop, so a Settings-only "restart to update" notice can go
  // unseen for a long-running session. The main window broadcasts
  // 'update-ready' (see App.jsx) once a downloaded update is waiting for a
  // restart; every open widget picks it up independently.
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    const p = win.listen('update-ready', () => setUpdateReady(true));
    return () => { p.then(fn => fn()); };
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
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  // Drag the window manually (no data-tauri-drag-region → no native
  // double-click "zoom to center"). startDragging only moves on actual drag.
  const handleMouseDown = (e) => {
    if (e.button !== 0) return;      // left button only
    if (e.detail >= 2) return;       // second click of a double-click: skip drag
    if (menu) { setMenu(null); return; }
    getCurrentWindow().startDragging().catch(() => {});
  };

  // Double-click the orb → launch this provider's desktop app
  // (Claude.app / Codex.app / Antigravity.app).
  const openProviderApp = () => {
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

  return (
    <div
      className="widget-container"
      onMouseDown={handleMouseDown}
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
        secondaryLabel={config.secondaryLabel}
        stackLabels={config.stackLabels}
        connected={true}
        dataLoaded={!!data[orbType].loaded}
        resetCredits={orbType === 'codex' && data.codex ? data.codex.reset_credits : null}
        offline={orbType === 'antigravity' && data.antigravity && data.antigravity.available === false}
      />

      {updateReady && (
        <button
          className="widget-update-badge"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={restartForUpdate}
          title="Update ready — click to restart"
        />
      )}

      {menu && (
        <div
          className="widget-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={reopenMain}>⤢ Open dashboard</button>
          {updateReady && <button onClick={restartForUpdate}>↻ Restart to update</button>}
          <button className="danger" onClick={closeWidget}>✕ Close widget</button>
        </div>
      )}
    </div>
  );
}

/* ── Mount ── */
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('widget-root')).render(<WidgetApp />);

import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import './App.css';

const TRIAL_DAYS = 30;
// Lemon Squeezy checkout 链接 + 产品/变体 ID(验证 license 归属)。
// 双价:试用期内带折扣码 A$5.99,到期原价 A$9.99。
// ⚠️ 折扣码还没建,CHECKOUT_TRIAL 暂时同原价;建好减$4折扣码后改成带 ?checkout[discount_code]=CODE。
const LS_BUY = 'https://aiusageball.lemonsqueezy.com/checkout/buy/746df40e-c7a7-4fda-9481-d98cfdf39e8e';
const CHECKOUT_TRIAL = LS_BUY; // TODO: 折扣码建好后 → `${LS_BUY}?checkout[discount_code]=CODE`
const CHECKOUT_FULL  = LS_BUY;
const LS_PRODUCT_IDS = [1185289, 1853633]; // product_id / variant_id —— 验证 license 确属本产品

// Tauri v2 WebviewWindow API for creating widget windows
let WebviewWindow = null;
try {
  // Dynamic import to avoid crashes when running in plain browser (dev)
  import('@tauri-apps/api/webviewWindow').then(m => { WebviewWindow = m.WebviewWindow; });
} catch (e) {}

// Custom hook for persistent state
function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = value => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue, setValue];
}

const launchWidget = async (orbName) => {
  if (!WebviewWindow) return;
  const label = `widget-${orbName}`;
  // 点一下 = toggle(没开就弹出、开着就收回),且第一次点就生效。
  // 不再用 getByLabel 判断是否已存在 —— 已关闭的窗口会残留引用,导致
  // "第一次点收了个不存在的、要点两次才弹出"。改用"创建"做权威判断:
  // widget 已关闭 → label 已释放 → 创建成功并弹出;
  // widget 还开着 → 创建报 label 重复 → 在下面的错误回调里关掉它(收回)。
  // Default position: a vertical column on the right side of the screen
  // (Claude on top, Codex, then Antigravity) — matches the user's preferred
  // layout, sitting just left of the macOS desktop widgets in the corner.
  const widgetW = 240;
  const rightInset = 166;   // gap from window's right edge to the screen edge
  const topMargin = 30;     // y of the first (Claude) widget
  const vSpacing = 232;     // vertical gap between stacked widgets
  const screenW = window.screen.availWidth || window.screen.width || 3440;
  const idx = Math.max(0, ['claude', 'codex', 'antigravity'].indexOf(orbName));
  const x = Math.max(0, screenW - widgetW - rightInset);
  const y = topMargin + idx * vSpacing;

  // Create new transparent widget window
  const ww = new WebviewWindow(label, {
    url: `widget.html?orb=${orbName}`,
    width: widgetW,
    height: 300,
    decorations: false,
    transparent: true,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,   // 关键:widget 弹出不抢焦点,主界面保持激活 → 能连续点每个球一次到位
    center: false,
    x,
    y,
  });
  ww.once('tauri://error', async () => {
    // 创建失败 = label 已存在(widget 还开着) → 关掉它(toggle 的"收回")
    try { const ex = await WebviewWindow.getByLabel(label); if (ex) await ex.close(); } catch (e) {}
  });
};

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

    const hours = String(totalHours).padStart(2, '0');
    return `${hours}:${mins}:${secs}`;
  } catch (e) {
    return "READY";
  }
};

const SettingsModal = ({
  onClose,
  dataSource, setDataSource,
  alertThreshold, setAlertThreshold,
  alertTimerMin, setAlertTimerMin,
  launchAtLogin, setLaunchAtLogin,
  showInDock, setShowInDock,
  theme, setTheme,
  licensed, daysLeft, onActivate, checkoutUrl
}) => {
  const [activeTab, setActiveTab] = useState('account');

  const tabs = [
    { id: 'account', label: 'ACCOUNT', icon: '👤' },
    { id: 'datasource', label: 'DATA SOURCE', icon: '🔗' },
    { id: 'alerts', label: 'ALERTS', icon: '🔔' },
    { id: 'appearance', label: 'APPEARANCE', icon: '🎨' },
    { id: 'general', label: 'GENERAL', icon: '⚙️' },
  ];

  return (
    <div className="settings-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-modal-content">
        <div className="settings-header">
          <h2>SETTINGS</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        {/* Tab Navigation */}
        <div className="settings-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="settings-body" style={{ paddingBottom: '40px' }}>

          {/* ── Account Tab ── */}
          {activeTab === 'account' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">Current Plan</h3>
                {licensed ? (
                  <>
                    <div className="plan-badge pro-active" style={{ background: 'rgba(0, 255, 170, 0.1)', color: '#00ffaa', borderColor: 'rgba(0, 255, 170, 0.3)' }}>PRO · UNLOCKED</div>
                    <p className="section-desc">Thanks for your support — all features unlocked.</p>
                  </>
                ) : (
                  <>
                    <div className="plan-badge">FREE TRIAL</div>
                    <p className="section-desc">{daysLeft != null ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in your free trial.` : 'Free trial.'}</p>
                  </>
                )}
              </div>

              {!licensed ? (
                <>
                  <div className="setting-section">
                    <h3 className="section-title">Unlock forever — trial price</h3>
                    <button
                      className="upgrade-card pro"
                      style={{ textAlign: 'left', width: '100%' }}
                      onClick={() => openUrl(checkoutUrl)}
                    >
                      <span className="plan-name">⚡ AI Usage Ball Pro</span>
                      <span className="plan-price"><s style={{ opacity: 0.45, fontWeight: 'normal', marginRight: '6px' }}>A$9.99</s>A$5.99<small> one-time</small></span>
                      <span className="plan-feat" style={{ display: 'block', opacity: 0.8, fontSize: '11px', marginTop: '6px' }}>Desktop orbs · Apple Watch · Custom alerts · Themes</span>
                      <div style={{ marginTop: '12px', padding: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', textAlign: 'center', fontSize: '11px', fontWeight: 'bold' }}>
                        Lock in A$5.99 before trial ends ↗
                      </div>
                    </button>
                  </div>

                  <div className="setting-section">
                    <div className="section-divider"><span>or activate</span></div>
                    <h3 className="section-title" style={{ marginTop: '16px' }}>Have a license key?</h3>
                    <div className="license-input-group" style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        placeholder="Paste your license key"
                        style={{ flex: 1, minWidth: '200px', padding: '10px 12px', borderRadius: '6px', border: '1px solid #333', background: '#111', color: '#fff', fontFamily: 'monospace' }}
                        id="settingsLicenseKey"
                      />
                      <button
                        className="theme-btn"
                        style={{ padding: '0 20px', background: '#333', color: '#fff', whiteSpace: 'nowrap' }}
                        onClick={async (e) => {
                          const btn = e.currentTarget;
                          btn.innerHTML = 'Verifying...';
                          btn.style.opacity = '0.7';
                          const ok = await onActivate(document.getElementById('settingsLicenseKey').value);
                          if (!ok) { btn.innerHTML = 'Activate'; btn.style.opacity = '1'; alert('Invalid license key'); }
                        }}
                      >
                        Activate
                      </button>
                    </div>
                    <p className="section-desc" style={{ marginTop: '8px', fontSize: '12px' }}>The key emailed to you after purchase.</p>
                  </div>
                </>
              ) : (
                <div className="setting-section">
                  <div style={{ padding: '20px', background: 'rgba(0, 255, 170, 0.05)', border: '1px solid rgba(0, 255, 170, 0.2)', borderRadius: '12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎉</div>
                    <h3 style={{ margin: '0 0 8px 0', color: '#fff' }}>Thank you for your support!</h3>
                    <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: '13px' }}>All features unlocked. Your Apple Watch companion is ready to sync.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Data Source Tab ── */}
          {activeTab === 'datasource' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">Data Collection Method</h3>
                <p className="section-desc">Choose how AI Pulse reads your usage data</p>

                <div className="radio-group">
                  <label className={`radio-option ${dataSource === 'codexbar' ? 'selected' : ''}`}>
                    <input type="radio" name="datasource" value="codexbar" checked={dataSource === 'codexbar'} onChange={(e) => setDataSource(e.target.value)} />
                    <div className="radio-content">
                      <span className="radio-title">🍪 CodexBar / Cookie Mode</span>
                      <span className="radio-desc">Automatically reads usage from browser cookies (default, no setup needed)</span>
                    </div>
                  </label>

                  <label className={`radio-option ${dataSource === 'apikey' ? 'selected' : ''}`}>
                    <input type="radio" name="datasource" value="apikey" checked={dataSource === 'apikey'} onChange={(e) => setDataSource(e.target.value)} />
                    <div className="radio-content">
                      <span className="radio-title">🔑 API Key Mode</span>
                      <span className="radio-desc">Enter your provider API keys for direct access</span>
                    </div>
                  </label>
                </div>
              </div>

              {dataSource === 'apikey' && (
                <div className="setting-section">
                  <h3 className="section-title">API Keys</h3>
                  <div className="setting-group">
                    <label>Anthropic API Key</label>
                    <input type="password" placeholder="sk-ant-..." className="ando-input" />
                  </div>
                  <div className="setting-group">
                    <label>OpenAI API Key</label>
                    <input type="password" placeholder="sk-..." className="ando-input" />
                  </div>
                  <div className="setting-group">
                    <label>Google AI API Key</label>
                    <input type="password" placeholder="AIza..." className="ando-input" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Alerts Tab ── */}
          {activeTab === 'alerts' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">Usage Alerts</h3>
                <div className="setting-group">
                  <label>Alert when remaining quota below</label>
                  <div className="slider-row">
                    <input type="range" min="5" max="50" value={alertThreshold} onChange={(e) => setAlertThreshold(e.target.value)} className="ando-slider" />
                    <span className="slider-value">{alertThreshold}%</span>
                  </div>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">Timer Alerts</h3>
                <div className="setting-group">
                  <label>Alert when reset timer under</label>
                  <div className="slider-row">
                    <input type="range" min="5" max="120" step="5" value={alertTimerMin} onChange={(e) => setAlertTimerMin(e.target.value)} className="ando-slider" />
                    <span className="slider-value">{alertTimerMin} min</span>
                  </div>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">Notification Style</h3>
                <div className="checkbox-group">
                  <label className="checkbox-option">
                    <input type="checkbox" defaultChecked />
                    <span>macOS system notifications</span>
                  </label>
                  <label className="checkbox-option">
                    <input type="checkbox" defaultChecked />
                    <span>Menu bar icon color change</span>
                  </label>
                  <label className="checkbox-option">
                    <input type="checkbox" />
                    <span>Sound alert</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* ── Appearance Tab ── */}
          {activeTab === 'appearance' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">Theme</h3>
                <div className="theme-options">
                  <button className={`theme-btn ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>
                    <span className="theme-preview dark-preview"></span>
                    <span>Dark</span>
                  </button>
                  <button className={`theme-btn ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>
                    <span className="theme-preview light-preview"></span>
                    <span>Light</span>
                  </button>
                  <button className={`theme-btn ${theme === 'auto' ? 'active' : ''}`} onClick={() => setTheme('auto')}>
                    <span className="theme-preview auto-preview"></span>
                    <span>System</span>
                  </button>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">Orb Style</h3>
                <p className="section-desc">Customize the liquid animation appearance</p>
                <div className="setting-group">
                  <label>Animation Speed</label>
                  <div className="slider-row">
                    <input type="range" min="0" max="200" defaultValue="100" className="ando-slider" />
                    <span className="slider-value">100%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── General Tab ── */}
          {activeTab === 'general' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">Startup</h3>
                <div className="checkbox-group">
                  <label className="checkbox-option">
                    <input type="checkbox" checked={launchAtLogin} onChange={(e) => setLaunchAtLogin(e.target.checked)} />
                    <span>Launch AI Pulse at login</span>
                  </label>
                  <label className="checkbox-option">
                    <input type="checkbox" checked={showInDock} onChange={(e) => setShowInDock(e.target.checked)} />
                    <span>Show in Dock</span>
                  </label>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">Data</h3>
                <div className="setting-group">
                  <label>Refresh Interval</label>
                  <select className="ando-input" defaultValue="5">
                    <option value="1">Every 1 second</option>
                    <option value="5">Every 5 seconds</option>
                    <option value="15">Every 15 seconds</option>
                    <option value="30">Every 30 seconds</option>
                  </select>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">About</h3>
                <p className="section-desc">AI Pulse v0.1.0</p>
                <p className="section-desc" style={{ opacity: 0.5 }}>Built with Tauri + React</p>
              </div>

              <div className="settings-footer">
                <button className="ando-btn danger" onClick={onClose}>Reset All Settings</button>
                <button className="ando-btn" onClick={onClose}>SAVE</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const DualRingOrb = ({ color, glowColor, timer, secondaryTimer, percentage, secondaryPercentage, secondaryColor, label, primaryLabel, secondaryLabel, stackLabels = false, videoFilter, connected, onPopOut, offline = false, ambientPulse = false, resetCredits = null }) => {
  const radius = 65;
  const circumference = 2 * Math.PI * radius;
  const validPct = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (circumference * validPct) / 100;

  const hasSecondary = secondaryPercentage !== undefined;
  const radiusSec = 47;
  const circumferenceSec = 2 * Math.PI * radiusSec;
  const validPctSec = hasSecondary ? Math.max(0, Math.min(100, secondaryPercentage)) : 0;
  const strokeDashoffsetSec = circumferenceSec - (circumferenceSec * validPctSec) / 100;

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

  // Liquid animation: manual seek-driven playback.
  // WKWebView (Tauri production) blocks video.play() without a click gesture,
  // so we never call play(). Instead, we keep the video paused and manually
  // advance currentTime on each rAF tick. This is autoplay-policy-immune.
  const rAFRef = useRef(null);
  const lastTimeRef = useRef(null);
  const baseSpeedRef = useRef(0.8 + Math.random() * 0.4);
  const hoveringRef = useRef(false);
  const lingerTimerRef = useRef(null);
  const burstTimerRef = useRef(null);
  const ambientPulseRef = useRef(ambientPulse);
  const targetSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);
  const currentSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);

  // Keep ambientPulseRef in sync with the prop.
  useEffect(() => { ambientPulseRef.current = ambientPulse; refreshTarget(); }, [ambientPulse]);

  const refreshTarget = () => {
    targetSpeedRef.current =
      (hoveringRef.current || isCriticalRef.current || ambientPulseRef.current || burstTimerRef.current)
        ? baseSpeedRef.current : 0;
  };
  // Force the liquid to flow for `ms` (default 30s), then settle back to its
  // resting state. Used as feedback when popping out / retracting a widget.
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
    // Cancel any pending stop timer — mouse came back.
    if (lingerTimerRef.current) { clearTimeout(lingerTimerRef.current); lingerTimerRef.current = null; }
    refreshTarget();
  };
  const handleLeave = () => {
    hoveringRef.current = false;
    // Keep the liquid flowing for 20 seconds after the mouse leaves,
    // then let it ease to a stop.
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    lingerTimerRef.current = setTimeout(() => {
      lingerTimerRef.current = null;
      refreshTarget();
    }, 20000);
  };

  // Keep the target in sync when the critical state flips on a data update.
  useEffect(() => { refreshTarget(); }, [isCritical]);

  // Cleanup linger/burst timers on unmount.
  useEffect(() => () => {
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      try {
        // Seek to a random frame so the paused orb shows liquid, not black.
        v.currentTime = Math.random() * (v.duration || 10);
        currentSpeedRef.current = isCriticalRef.current ? baseSpeedRef.current : 0;
      } catch (e) {}
    }

    const loop = (timestamp) => {
      const vid = videoRef.current;
      // Gate on duration (available once metadata loads, readyState>=1) rather
      // than readyState>=2: WKWebView often parks an unplayed <video> at
      // readyState 1 and never buffers full frames, which froze the liquid.
      // Seeking currentTime itself drives WKWebView to render that frame.
      if (vid && !isNaN(vid.duration) && vid.duration > 0) {
        const dt = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 0;
        lastTimeRef.current = timestamp;

        // Ease playback speed toward the target (inertia for a fluid feel).
        currentSpeedRef.current +=
          (targetSpeedRef.current - currentSpeedRef.current) * 0.05;
        const spd = currentSpeedRef.current;

        if (spd > 0.01) {
          // Boomerang:正放到末帧反弹倒放,倒放到首帧再反弹正放。240 帧素材靠这个
          // 实现"正放+倒放"循环,延长流动时长且不增加帧数;端点反弹不停留 → 峰值/谷值
          // 各只出现一次,没有重复帧顿挫(这正是之前烤成 480 帧视频的毛病所在)。
          // 视频本身已经是"正放+倒放"(478 帧 boomerang),这里只需正向播放循环。
          // 关键:永不反向 seek —— WKWebView 反向跳 currentTime 那一帧会整球闪黑。
          // 首尾无缝(峰值/谷值各只一帧),正向 wrap 不跳。
          const advance = dt * spd;
          let newTime = vid.currentTime + advance;
          const dur = vid.duration;
          if (newTime >= dur) newTime -= dur;
          try { vid.currentTime = newTime; } catch (e) {}
        }
      } else {
        lastTimeRef.current = timestamp;
      }
      rAFRef.current = requestAnimationFrame(loop);
    };
    rAFRef.current = requestAnimationFrame(loop);
    return () => { if (rAFRef.current) cancelAnimationFrame(rAFRef.current); };
  }, []);

  const isExhausted = validPct <= 0;

  return (
    <div className="orb-wrapper" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className={`orb-glass-breather ${offline ? 'offline-state' : isExhausted ? 'exhausted-state' : isCritical ? 'critical-state' : ''}`}>
        <div
          className="orb-glass"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onClick={onPopOut ? (() => { startFlowBurst(30000); onPopOut(); }) : undefined}
          style={onPopOut ? { cursor: 'pointer' } : undefined}
          title={onPopOut ? 'Pop out as desktop widget' : undefined}
        >
        {/* Inner shadow/depth */}
        <div className="orb-inner-shadow"></div>

        {/* 3D Video Liquid Simulation (frozen frame at rest, flows on hover) */}
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
                // 元数据就绪后 seek 一帧:让静止的球显示液体而不是黑,并打通 seek 通路。
                try {
                  const v = videoRef.current;
                  if (v && v.duration) v.currentTime = Math.random() * (v.duration - 0.1);
                } catch (e) {}
              }}
              onLoadedData={() => { loadedOnceRef.current = true; }}
              onError={() => {
                // Only retry a cold-start failure (backend not up yet). Once the
                // video has loaded, never call load() again — reloading wipes the
                // buffer and makes the orb blink.
                // ~20s window so a slow backend cold-start still recovers.
                if (loadedOnceRef.current || videoRetryRef.current >= 10) return;
                videoRetryRef.current += 1;
                setTimeout(() => {
                  try { videoRef.current && videoRef.current.load(); } catch (e) {}
                }, 2000);
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

        {/* SVG Rings */}
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
          
          {/* Track background */}
          <circle cx="100" cy="100" r={radius} stroke={color} opacity="0.55" strokeWidth="8" fill="none" />
          
          {/* Progress Ring */}
          <circle 
            cx="100" cy="100" r={radius} 
            stroke={color} 
            strokeWidth="8" 
            fill="none" 
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform="rotate(-90 100 100)"
            filter={`url(#glow-${label.replace(/\s+/g, '-')})`}
          />

          {/* Inner Rings */}
          <circle cx="100" cy="100" r="54" stroke={hasSecondary ? secondaryColor : color} opacity="0.3" strokeWidth="1" fill="none" />
          
          {hasSecondary ? (
            <>
              <circle cx="100" cy="100" r={radiusSec} stroke={secondaryColor} opacity="0.5" strokeWidth="6" fill="none" />
              <circle 
                cx="100" cy="100" r={radiusSec} 
                stroke={secondaryColor} 
                strokeWidth="6" 
                fill="none" 
                opacity="0.5"
                strokeLinecap="round"
                strokeDasharray={circumferenceSec}
                strokeDashoffset={strokeDashoffsetSec}
                transform="rotate(-90 100 100)"
                filter={`url(#glow-sec-${label.replace(/\s+/g, '-')})`}
              />
            </>
          ) : (
            <circle cx="100" cy="100" r="45" stroke={color} opacity="0.08" strokeWidth="10" fill="none" />
          )}
        </svg>

        {/* Digital Timer */}
        <div className="orb-timer-wrapper">
          <span className="orb-timer" style={{ textShadow: `0 0 12px ${color}` }}>{timer}</span>
          {secondaryTimer ? (
            <span className="orb-timer-secondary" style={{ color: '#fb923c', textShadow: '0 0 8px #fb923c' }}>{secondaryTimer}</span>
          ) : resetCredits != null ? (
            <span className="orb-timer-secondary" style={{ color: '#fb923c', textShadow: '0 0 8px #fb923c' }}>↺ {resetCredits} LEFT</span>
          ) : null}
        </div>

        {/* Front Glass Specular Highlight */}
        <div className="orb-specular"></div>
        </div>
      </div>

      {/* Ground Reflection Glow */}
      <div className="orb-ground-glow" style={{ background: glowColor }}></div>
      
      {/* Label */}
      <div className="orb-label-container">
        <div className="orb-title-row">
          <h3 className="orb-title">{label}</h3>
          {onPopOut && (
            <button className="orb-popout-btn" onClick={onPopOut} title="Pop out as desktop widget">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          )}
        </div>
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

function App() {
  const [data, setData] = useState({
    antigravity: {
      provider: "Antigravity",
      rate_limit_pct: 0.0,
      rate_limit_pct_secondary: 0.0,
      status: "NORMAL",
      status_secondary: "NORMAL",
      reset_time: "",
      reset_time_secondary: "",
      resetsAt: "",
      resetsAt_secondary: ""
    },
    claude: {
      provider: "Claude",
      rate_limit_pct: 0.0,
      rate_limit_pct_secondary: 0.0,
      status: "NORMAL",
      status_secondary: "NORMAL",
      reset_time: "",
      reset_time_secondary: "",
      resetsAt: "",
      resetsAt_secondary: ""
    },
    codex: {
      provider: "Codex",
      rate_limit_pct: 0.0,
      status: "NORMAL",
      reset_time: "",
      resetsAt: "",
      reset_credits: null
    }
  });

  // Persistent Settings State
  const [dataSource, setDataSource] = useLocalStorage('aipulse_dataSource', 'codexbar');
  const [alertThreshold, setAlertThreshold] = useLocalStorage('aipulse_alertThreshold', 20);
  const [alertTimerMin, setAlertTimerMin] = useLocalStorage('aipulse_alertTimerMin', 30);
  const [launchAtLogin, setLaunchAtLogin] = useLocalStorage('aipulse_launchAtLogin', true);
  const [showInDock, setShowInDock] = useLocalStorage('aipulse_showInDock', false);
  const [theme, setTheme] = useLocalStorage('aipulse_theme', 'dark');

  // ── Free trial / license (state lives in the macOS Keychain, see lib.rs) ──
  const [trialStart, setTrialStart] = useState(null);   // epoch seconds, or null until loaded
  const [licensed, setLicensed] = useState(false);
  const [trialLoaded, setTrialLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const lic = await invoke('secure_get', { key: 'license' });
        if (lic) { setLicensed(true); setTrialLoaded(true); return; }
        let start = await invoke('secure_get', { key: 'trial_start' });
        if (!start) {
          start = String(Math.floor(Date.now() / 1000));
          await invoke('secure_set', { key: 'trial_start', value: start });
        }
        setTrialStart(parseInt(start, 10));
      } catch (e) {
        // 非 Tauri 环境(纯浏览器 dev)读不到钥匙串 → 当作试用中,不锁
        console.warn('trial/license check failed:', e);
      } finally {
        setTrialLoaded(true);
      }
    })();
  }, []);

  // 激活:调 Lemon Squeezy activate 接口验证 key + 绑定本机 → 写钥匙串 → 永久解锁。
  // activate 是公开接口(不需 secret key);核对 product_id/variant_id 确保 key 确属本产品。
  const activateLicense = async (key) => {
    const k = (key || '').trim();
    if (!k) return false;
    try {
      const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/activate', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ license_key: k, instance_name: 'AI Usage Ball' }).toString(),
      });
      const data = await res.json();
      const meta = data && data.meta;
      const belongs = meta && (LS_PRODUCT_IDS.includes(meta.product_id) || LS_PRODUCT_IDS.includes(meta.variant_id));
      if (data && data.activated && belongs) {
        await invoke('secure_set', { key: 'license', value: k });
        if (data.instance && data.instance.id) {
          await invoke('secure_set', { key: 'license_instance', value: String(data.instance.id) });
        }
        setLicensed(true);
        return true;
      }
      return false;
    } catch (e) {
      console.warn('license activate failed:', e);
      return false;
    }
  };

  // 计算试用剩余天数 + 状态
  const daysLeft = trialStart != null
    ? Math.max(0, TRIAL_DAYS - Math.floor((Date.now() / 1000 - trialStart) / 86400))
    : null;
  const isLicensed = licensed;   // 唯一准绳:钥匙串里的 license(不再认 localStorage 的 plan)
  const isExpired = trialLoaded && !isLicensed && trialStart != null && daysLeft <= 0;

  const [connected, setConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [timers, setTimers] = useState({
    claude: "00:00:00",
    claude_secondary: "00:00:00",
    codex: "00:00:00",
    antigravity: "00:00:00",
    antigravity_claude: "00:00:00"
  });
  
  const [currentTime, setCurrentTime] = useState("");

  // ── Ambient random pulse: occasionally one orb flows by itself ──
  const orbNames = ['claude', 'codex', 'antigravity'];
  const [ambientOrb, setAmbientOrb] = useState(null);

  useEffect(() => {
    let pulseTimeout = null;
    let stopTimeout = null;
    let lastPick = null;

    const scheduleNext = () => {
      // Wait 20-40 minutes before the next random pulse
      const delay = (20 + Math.random() * 20) * 60 * 1000;
      pulseTimeout = setTimeout(() => {
        // Pick a random orb, but avoid repeating the same one twice in a row
        let candidates = orbNames.filter(n => n !== lastPick);
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        lastPick = pick;
        setAmbientOrb(pick);

        // Let it flow for 8-15 seconds, then stop
        const flowDuration = (8 + Math.random() * 7) * 1000;
        stopTimeout = setTimeout(() => {
          setAmbientOrb(null);
          scheduleNext();
        }, flowDuration);
      }, delay);
    };

    scheduleNext();
    return () => {
      if (pulseTimeout) clearTimeout(pulseTimeout);
      if (stopTimeout) clearTimeout(stopTimeout);
    };
  }, []);

  // Always points at the latest `data` so the countdown interval can read it
  // without being listed as an effect dependency (which would tear down and
  // recreate the 1s interval on every SSE message).
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    let eventSource = null;

    const connectSSE = () => {
      eventSource = new EventSource('http://127.0.0.1:8000/api/stream');

      eventSource.onopen = () => {
        setConnected(true);
        console.log("Connected to AI Pulse Stream");
      };

      eventSource.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          setData(parsed);
        } catch (e) {
          console.error("Error parsing event data", e);
        }
      };

      eventSource.onerror = (err) => {
        console.error("SSE connection error, retrying...", err);
        setConnected(false);
        eventSource.close();
        setTimeout(connectSSE, 3000);
      };
    };

    connectSSE();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const d = dataRef.current;
      setTimers({
        claude: formatCountdownHMS(d.claude.resetsAt),
        claude_secondary: formatCountdownHMS(d.claude.resetsAt_secondary),
        codex: formatCountdownHMS(d.codex.resetsAt),
        antigravity: formatCountdownHMS(d.antigravity.resetsAt_secondary),
        antigravity_claude: formatCountdownHMS(d.antigravity.resetsAt)
      });

      const date = new Date();
      let hours = date.getHours();
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      setCurrentTime(`${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}   ${hours}:${minutes} ${ampm}`);
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="pulse-desktop-environment">
      {/* ── Trial-ended lock screen ── */}
      {isExpired && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 6000, background: 'rgba(8,8,11,0.92)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center' }}>
          <div style={{ fontSize: '34px' }}>⏳</div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>Your free trial has ended</h2>
          <p style={{ margin: 0, color: 'rgba(255,255,255,0.6)', fontSize: '13px', maxWidth: '260px' }}>Unlock AI Usage Ball forever — a one-time A$9.99.</p>
          <button onClick={() => openUrl(CHECKOUT_FULL)} style={{ padding: '10px 24px', background: '#ff8c00', color: '#111', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}>Buy · A$9.99</button>
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <input id="licenseKeyExpired" placeholder="License key" style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #333', background: '#111', color: '#fff', fontFamily: 'monospace', fontSize: '12px', width: '180px' }} />
            <button onClick={async () => { const ok = await activateLicense(document.getElementById('licenseKeyExpired').value); if (!ok) alert('Invalid license key'); }} style={{ padding: '8px 14px', background: '#333', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>Activate</button>
          </div>
        </div>
      )}

      {/* 3. High-Fidelity Ando Dark Concrete Popover Window */}
      <div className="popover-window">
        {showSettings && <SettingsModal 
          onClose={() => setShowSettings(false)}
          dataSource={dataSource} setDataSource={setDataSource}
          alertThreshold={alertThreshold} setAlertThreshold={setAlertThreshold}
          alertTimerMin={alertTimerMin} setAlertTimerMin={setAlertTimerMin}
          launchAtLogin={launchAtLogin} setLaunchAtLogin={setLaunchAtLogin}
          showInDock={showInDock} setShowInDock={setShowInDock}
          theme={theme} setTheme={setTheme}
          licensed={isLicensed} daysLeft={daysLeft}
          onActivate={activateLicense}
          checkoutUrl={CHECKOUT_TRIAL}
        />}
        <div className="concrete-overlay"></div>

        {/* Popover Header */}
        <header className="popover-header-section" data-tauri-drag-region>
          <div className="popover-title-group" data-tauri-drag-region>
            <div className="fluid-pixel-container" data-tauri-drag-region>
              <div className="fluid-pixel" data-tauri-drag-region></div>
            </div>
            <span className="popover-title" data-tauri-drag-region>AI Usage Ball</span>
          </div>
          
          <div className="popover-status-badge">
            <span className={`status-led ${connected ? 'live' : 'offline'}`}></span>
            <span className="status-text">{connected ? 'LIVE_SYNC' : 'OFFLINE'}</span>
            {!isLicensed && daysLeft != null && (
              <span
                title="Free trial"
                style={{ fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.05em', color: daysLeft <= 3 ? '#ff5a5a' : 'rgba(255,255,255,0.55)', padding: '2px 6px', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px' }}
              >
                TRIAL · {daysLeft}d
              </span>
            )}
            <button className="settings-icon-btn" onClick={() => setShowSettings(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        </header>

        {/* The Volumetric Orbs Grid */}
        <main className="spheres-grid">
          
          {/* Orb 1: Anthropic (Amber-Orange + Inner Yellow for Weekly) */}
          <DualRingOrb 
            color="#ff8c00" 
            secondaryColor="#facc15" 
            glowColor="rgba(255, 85, 0, 0.4)" 
            videoFilter="none"
            timer={timers.claude} 
            secondaryTimer={timers.claude_secondary}
            percentage={100 - data.claude.rate_limit_pct} 
            secondaryPercentage={100 - data.claude.rate_limit_pct_secondary}
            label="CLAUDE" 
            primaryLabel="CLAUDE REMAINING"
            secondaryLabel="WEEKLY REMAINING"
            stackLabels={true}
            connected={connected}
            ambientPulse={ambientOrb === 'claude'}
            onPopOut={() => launchWidget('claude')}
          />

          {/* Orb 2: Codex (Red) */}
          <DualRingOrb 
            color="#ef4444" 
            glowColor="rgba(239, 68, 68, 0.4)" 
            videoFilter="hue-rotate(320deg) saturate(2) brightness(1.2)"
            timer={timers.codex} 
            percentage={100 - data.codex.rate_limit_pct} 
            label="CODEX" 
            primaryLabel="CODEX REMAINING"
            connected={connected}
            resetCredits={data.codex.reset_credits}
            ambientPulse={ambientOrb === 'codex'}
            onPopOut={() => launchWidget('codex')}
          />

          {/* Orb 3: Antigravity (Cyan-Blue + Orange) */}
          <DualRingOrb 
            color="#06b6d4" 
            secondaryColor="#fb923c"
            glowColor="rgba(6, 182, 212, 0.4)" 
            videoFilter="hue-rotate(185deg) saturate(1.8) brightness(1.2)"
            timer={timers.antigravity} 
            secondaryTimer={timers.antigravity_claude}
            percentage={100 - data.antigravity.rate_limit_pct_secondary} 
            secondaryPercentage={100 - data.antigravity.rate_limit_pct} 
            label="ANTIGRAVITY" 
            primaryLabel="GEMINI REMAINING"
            secondaryLabel="CLAUDE REMAINING"
            stackLabels={true}
            connected={connected}
            offline={data.antigravity.available === false}
            ambientPulse={ambientOrb === 'antigravity'}
            onPopOut={() => launchWidget('antigravity')}
          />

        </main>

        {/* Tactile Ando Concrete Bottom Border Accent */}
        <div className="popover-footer-accent">
          <span className="credits-readout">{currentTime}</span>
          <span className="branding-readout">AI Usage Ball</span>
        </div>
      </div>

      <svg style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} width="0" height="0">
        <defs>
          <filter id="concrete-noise">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch" result="noise" />
            <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.085 0" />
            <feComposite operator="in" in2="SourceGraphic" result="monoNoise" />
            <feBlend mode="multiply" in="SourceGraphic" in2="monoNoise" />
          </filter>
        </defs>
      </svg>
    </div>
  );
}

export default App;

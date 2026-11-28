import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { eggBeginDrag, eggConsumeClickSuppress } from './easterEgg';
import { resolveBackendUrl } from './backend';
import {
  IS_APP_STORE,
  APP_VERSION,
  CUSTOM_LABELS_STORAGE_KEY,
  getDefaultOrbLabels,
  getCustomOrbLabels,
} from './config';
import { LANG_STORAGE_KEY, getInitialLang, useT } from './i18n';
import {
  formatCountdownHMS,
  formatClaudePrimaryCountdown,
  formatCodexPrimaryCountdown,
} from './utils/countdown';
import './App.css';

const TRIAL_DAYS = 30;
// Lemon Squeezy checkout 链接 + 产品/变体 ID(验证 license 归属)。
// 双价:试用期内带折扣码 A$5.99,到期原价 A$9.99。
// ⚠️ 这些是 Lemon Squeezy 测试模式(Test mode)的值 —— 店铺审核通过、切到 Live mode、
// 产品 Copy to Live Mode 后,checkout 链接/两个 ID/折扣码都会变成全新的,到时候要整套换掉。
const LS_BUY = 'https://aiusageball.lemonsqueezy.com/checkout/buy/c152b748-ebf0-45fc-8525-0df9afd9bc85';
const CHECKOUT_TRIAL = `${LS_BUY}?checkout[discount_code]=TRIAL`; // 试用期内 A$5.99(TRIAL 折扣码)
const CHECKOUT_FULL  = LS_BUY;                                     // 到期原价 A$9.99
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
  // Measured from a live widget's actual getBoundingClientRect() (not a CSS
  // estimate this time): content tops out at 212px (Claude/Antigravity, two
  // label lines) / 198px (Codex, one line). 270 leaves ~29px clear on each
  // side — comfortably past the update badge's corner too (10-23px) — versus
  // the earlier 225 guess, which left only 13px and clipped the orb.
  const widgetH = 270;
  const rightInset = 166;   // gap from window's right edge to the screen edge
  const topMargin = 30;     // y of the first (Claude) widget
  // Must be > widgetH — otherwise adjacent widgets' rectangular hit-test areas
  // overlap, and whichever one is topmost silently steals clicks meant for
  // its neighbor (e.g. Codex, sandwiched in the middle, could swallow clicks
  // aimed at Claude/Antigravity in the overlap band).
  const vSpacing = 280;
  const scr = window.screen;
  const screenW = scr.availWidth || scr.width || 3440;
  const screenH = scr.availHeight || scr.height || 1080;
  // availLeft/availTop (WebKit) = work-area origin below the menu bar.
  const availLeft = Number.isFinite(scr.availLeft) ? scr.availLeft : 0;
  const availTop = Number.isFinite(scr.availTop) ? scr.availTop : 0;
  const idx = Math.max(0, ['claude', 'codex', 'antigravity', 'grok'].indexOf(orbName));
  // Short screens: wrap into another column to the left instead of stacking
  // past the bottom edge (4 × 280 needs ~1140pt; laptops have ~900-1000).
  const rowsPerCol = Math.max(1, Math.floor((screenH - topMargin - widgetH) / vSpacing) + 1);
  const col = Math.floor(idx / rowsPerCol);
  const row = idx % rowsPerCol;
  const colGap = 16;
  const x = Math.max(availLeft, availLeft + screenW - widgetW - rightInset - col * (widgetW + colGap));
  const y = Math.min(
    availTop + topMargin + row * vSpacing,
    Math.max(availTop, availTop + screenH - widgetH),
  );

  // Create new transparent widget window
  const ww = new WebviewWindow(label, {
    url: `widget.html?orb=${orbName}`,
    width: widgetW,
    height: widgetH,
    decorations: false,
    transparent: true,
    shadow: false,
    // Keep widgets behind regular app windows, like desktop widgets.
    alwaysOnTop: false,
    alwaysOnBottom: true,
    skipTaskbar: true,
    focus: false,   // 关键:widget 弹出不抢焦点,主界面保持激活 → 能连续点每个球一次到位
    // alwaysOnBottom + focus:false means the widget is essentially always an
    // "inactive" window in Cocoa's eyes. Without this, macOS swallows the
    // first click as a plain activate-click and never passes it to the
    // webview — hover/click on the liquid silently do nothing.
    acceptFirstMouse: true,
    center: false,
    x,
    y,
  });
  ww.once('tauri://created', async () => {
    // Apply the level again after native window creation. This also avoids a
    // stale floating level surviving while Tauri finishes creating the window.
    try {
      await ww.setAlwaysOnTop(false);
      await ww.setAlwaysOnBottom(true);
    } catch (e) {
      console.error('Failed to lower widget window level:', e);
    }
  });
  ww.once('tauri://error', async () => {
    // 创建失败 = label 已存在(widget 还开着) → 关掉它(toggle 的"收回")
    try { const ex = await WebviewWindow.getByLabel(label); if (ex) await ex.close(); } catch (e) {}
  });
};

const parseManualPeerAddress = (value) => {
  const input = value.trim();
  if (!input) return null;

  // Keep accepting a bare IP/hostname for older peers that still use 8000;
  // new dynamic-port peers can be entered as host:port (or [IPv6]:port).
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    if (end < 0) return null;
    const host = input.slice(1, end).trim();
    const suffix = input.slice(end + 1);
    const port = suffix ? Number(suffix.startsWith(':') ? suffix.slice(1) : NaN) : 8000;
    return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }

  const separator = input.lastIndexOf(':');
  if (separator > 0 && input.indexOf(':') === separator) {
    const host = input.slice(0, separator).trim();
    const port = Number(input.slice(separator + 1));
    return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }

  return { host: input, port: 8000 };
};

const SettingsModal = ({
  onClose,
  t,
  lang, setLang,
  backendUrl,
  dataMode, setDataMode,
  alertThreshold, setAlertThreshold,
  alertTimerMin, setAlertTimerMin,
  customTitles, setCustomTitles,
  autoUpdate, setAutoUpdate,
  teamSharingEnabled, setTeamSharingEnabled,
  teamDisplayName, setTeamDisplayName,
  updateState, updateInfo, updateProgress, onCheckForUpdates, onRestartNow,
  licensed, daysLeft, onActivate, checkoutUrl,
  onResetAll,
  initialTab = null,
}) => {
  const defaultTab = initialTab || (IS_APP_STORE ? 'datasource' : 'account');
  const [activeTab, setActiveTab] = useState(defaultTab);
  const [credForm, setCredForm] = useState({
    claude_token: '',
    claude_session_key: '',
    codex_token: '',
    codex_account_id: '',
    antigravity_port: '',
    antigravity_csrf: '',
    grok_manual_pct: '',
  });
  const [credFlags, setCredFlags] = useState({});
  const [saveStatus, setSaveStatus] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);
  const [activatingLicense, setActivatingLicense] = useState(false);

  useEffect(() => {
    if (!backendUrl) return;
    fetch(`${backendUrl}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        if (cfg.data_mode) setDataMode(cfg.data_mode);
        setCredFlags(cfg.configured || {});
        if (cfg.antigravity_port) {
          setCredForm((prev) => ({ ...prev, antigravity_port: String(cfg.antigravity_port) }));
        }
        if (cfg.grok_manual_pct != null) {
          setCredForm((prev) => ({ ...prev, grok_manual_pct: String(cfg.grok_manual_pct) }));
        }
      })
      .catch(() => {});
  }, [backendUrl]);

  const applyDataMode = async (mode) => {
    setDataMode(mode);
    setSaveStatus('');
    if (!backendUrl) return;
    try {
      await fetch(`${backendUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_mode: mode }),
      });
    } catch {
      // ignore transient error
    }
  };

  const handleSaveCredentials = async () => {
    if (!backendUrl) {
      setSaveStatus(t.credentialsSaveFailed);
      return;
    }
    setSavingCreds(true);
    setSaveStatus('');
    try {
      const payload = { data_mode: dataMode };
      if (credForm.claude_token.trim()) payload.claude_token = credForm.claude_token.trim();
      if (credForm.claude_session_key.trim()) payload.claude_session_key = credForm.claude_session_key.trim();
      if (credForm.codex_token.trim()) payload.codex_token = credForm.codex_token.trim();
      if (credForm.codex_account_id.trim()) payload.codex_account_id = credForm.codex_account_id.trim();
      if (credForm.antigravity_port !== '') {
        const portNum = parseInt(credForm.antigravity_port, 10);
        if (Number.isInteger(portNum) && portNum > 0) payload.antigravity_port = String(portNum);
      } else {
        payload.antigravity_port = '';
      }
      if (credForm.antigravity_csrf.trim()) payload.antigravity_csrf = credForm.antigravity_csrf.trim();
      if (credForm.grok_manual_pct !== '') {
        const pctNum = parseFloat(credForm.grok_manual_pct);
        if (Number.isFinite(pctNum)) payload.grok_manual_pct = String(Math.max(0, Math.min(100, pctNum)));
      } else {
        payload.grok_manual_pct = '';
      }

      const res = await fetch(`${backendUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('save failed');
      const updated = await res.json();
      setCredFlags(updated.configured || {});
      setCredForm((prev) => ({
        ...prev,
        claude_token: '',
        claude_session_key: '',
        codex_token: '',
        codex_account_id: '',
        antigravity_csrf: '',
      }));
      setSaveStatus(t.credentialsSaved);
    } catch {
      setSaveStatus(t.credentialsSaveFailed);
    } finally {
      setSavingCreds(false);
    }
  };

  const tabs = [
    ...(!IS_APP_STORE ? [{ id: 'account', label: t.tabAccount, icon: '👤' }] : []),
    { id: 'datasource', label: t.tabDatasource, icon: '🔗' },
    { id: 'alerts', label: t.tabAlerts, icon: '🔔' },
    { id: 'appearance', label: t.tabAppearance, icon: '🎨' },
    { id: 'general', label: t.tabGeneral, icon: '⚙️' },
  ];

  const defaultLabels = getDefaultOrbLabels(IS_APP_STORE, lang);

  return (
    <div className="settings-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-modal-content">
        <div className="settings-header">
          <h2>{t.settingsTitle}</h2>
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

          {/* ── Account Tab (Direct distribution only) ── */}
          {!IS_APP_STORE && activeTab === 'account' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">{t.currentPlan}</h3>
                {licensed ? (
                  <>
                    <div className="plan-badge pro-active" style={{ background: 'rgba(0, 255, 170, 0.1)', color: '#00ffaa', borderColor: 'rgba(0, 255, 170, 0.3)' }}>{t.proUnlocked}</div>
                    <p className="section-desc">{t.proUnlockedDesc}</p>
                  </>
                ) : (
                  <>
                    <div className="plan-badge">{t.freeTrialBadge}</div>
                    <p className="section-desc">{t.trialDaysLeftDesc(daysLeft)}</p>
                  </>
                )}
              </div>

              {!licensed ? (
                <>
                  <div className="setting-section">
                    <h3 className="section-title">{t.unlockForever}</h3>
                    <button
                      className="upgrade-card pro"
                      style={{ textAlign: 'left', width: '100%' }}
                      onClick={() => openUrl(checkoutUrl)}
                    >
                      <span className="plan-name">{t.proName}</span>
                      <span className="plan-price"><s style={{ opacity: 0.45, fontWeight: 'normal', marginRight: '6px' }}>A$9.99</s>A$5.99<small>{t.proOneTime}</small></span>
                      <span className="plan-feat" style={{ display: 'block', opacity: 0.8, fontSize: '11px', marginTop: '6px' }}>{t.proFeatures}</span>
                      <div style={{ marginTop: '12px', padding: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', textAlign: 'center', fontSize: '11px', fontWeight: 'bold' }}>
                        {t.lockInTrial}
                      </div>
                    </button>
                  </div>

                  <div className="setting-section">
                    <div className="section-divider"><span>{t.orActivate}</span></div>
                    <h3 className="section-title" style={{ marginTop: '16px' }}>{t.haveLicenseKey}</h3>
                    <div className="license-input-group" style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        placeholder={t.pasteLicenseKey}
                        style={{ flex: 1, minWidth: '200px', padding: '10px 12px', borderRadius: '6px', border: '1px solid #333', background: '#111', color: '#fff', fontFamily: 'monospace' }}
                        id="settingsLicenseKey"
                      />
                      <button
                        className="theme-btn"
                        disabled={activatingLicense}
                        style={{ padding: '0 20px', background: '#333', color: '#fff', whiteSpace: 'nowrap', opacity: activatingLicense ? 0.7 : 1 }}
                        onClick={async () => {
                          setActivatingLicense(true);
                          try {
                            const ok = await onActivate(document.getElementById('settingsLicenseKey').value);
                            if (!ok) alert(t.invalidLicense);
                          } finally {
                            setActivatingLicense(false);
                          }
                        }}
                      >
                        {activatingLicense ? t.verifyingBtn : t.activateBtn}
                      </button>
                    </div>
                    <p className="section-desc" style={{ marginTop: '8px', fontSize: '12px' }}>{t.licenseKeyHelp}</p>
                  </div>
                </>
              ) : (
                <div className="setting-section">
                  <div style={{ padding: '20px', background: 'rgba(0, 255, 170, 0.05)', border: '1px solid rgba(0, 255, 170, 0.2)', borderRadius: '12px', textAlign: 'center' }}>
                    <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎉</div>
                    <h3 style={{ margin: '0 0 8px 0', color: '#fff' }}>{t.thankYouTitle}</h3>
                    <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: '13px' }}>{t.thankYouWatchDesc}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Data Source Tab ── */}
          {activeTab === 'datasource' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">{t.dataCollectionMethod}</h3>
                <p className="section-desc">{t.dataCollectionDesc}</p>

                <div className="radio-group">
                  {!IS_APP_STORE && (
                    <label className={`radio-option ${dataMode === 'auto' ? 'selected' : ''}`}>
                      <input type="radio" name="datasource" value="auto" checked={dataMode === 'auto'} onChange={() => applyDataMode('auto')} />
                      <div className="radio-content">
                        <span className="radio-title">⚡ {t.modeAutoTitle}</span>
                        <span className="radio-desc">{t.modeAutoDesc}</span>
                      </div>
                    </label>
                  )}

                  <label className={`radio-option ${dataMode === 'demo' ? 'selected' : ''}`}>
                    <input type="radio" name="datasource" value="demo" checked={dataMode === 'demo'} onChange={() => applyDataMode('demo')} />
                    <div className="radio-content">
                      <span className="radio-title">✨ {t.modeDemoTitle}</span>
                      <span className="radio-desc">{t.modeDemoDesc}</span>
                    </div>
                  </label>

                  <label className={`radio-option ${dataMode === 'manual' ? 'selected' : ''}`}>
                    <input type="radio" name="datasource" value="manual" checked={dataMode === 'manual'} onChange={() => applyDataMode('manual')} />
                    <div className="radio-content">
                      <span className="radio-title">🔑 {t.modeManualTitle}</span>
                      <span className="radio-desc">{t.modeManualDesc}</span>
                    </div>
                  </label>
                </div>
              </div>

              {dataMode === 'manual' && (
                <div className="setting-section">
                  <h3 className="section-title">{t.manualCredentialsTitle}</h3>
                  <div className="setting-group">
                    <label>
                      {t.manualChannel1Token} {credFlags.claude_token ? `(${t.configuredTag})` : ''}
                    </label>
                    <input
                      type="password"
                      placeholder={credFlags.claude_token ? '••••••••' : 'sk-ant-oat01-...'}
                      className="ando-input"
                      value={credForm.claude_token}
                      onChange={(e) => setCredForm({ ...credForm, claude_token: e.target.value })}
                    />
                  </div>
                  <div className="setting-group">
                    <label>
                      {t.manualChannel1Session} {credFlags.claude_session_key ? `(${t.configuredTag})` : ''}
                    </label>
                    <input
                      type="password"
                      placeholder={credFlags.claude_session_key ? '••••••••' : 'sk-ant-sid01-...'}
                      className="ando-input"
                      value={credForm.claude_session_key}
                      onChange={(e) => setCredForm({ ...credForm, claude_session_key: e.target.value })}
                    />
                  </div>
                  <div className="setting-group">
                    <label>
                      {t.manualChannel2Token} {credFlags.codex_token ? `(${t.configuredTag})` : ''}
                    </label>
                    <input
                      type="password"
                      placeholder={credFlags.codex_token ? '••••••••' : 'eyJ...'}
                      className="ando-input"
                      value={credForm.codex_token}
                      onChange={(e) => setCredForm({ ...credForm, codex_token: e.target.value })}
                    />
                  </div>
                  <div className="setting-group">
                    <label>
                      {t.manualChannel2Account} {credFlags.codex_account_id ? `(${t.configuredTag})` : ''}
                    </label>
                    <input
                      type="text"
                      placeholder="acct_..."
                      className="ando-input"
                      value={credForm.codex_account_id}
                      onChange={(e) => setCredForm({ ...credForm, codex_account_id: e.target.value })}
                    />
                  </div>
                  <div className="setting-group">
                    <label>{t.manualChannel3Port}</label>
                    <input
                      type="number"
                      placeholder="e.g. 52341"
                      className="ando-input"
                      value={credForm.antigravity_port}
                      onChange={(e) => setCredForm({ ...credForm, antigravity_port: e.target.value })}
                    />
                  </div>
                  <div className="setting-group">
                    <label>
                      {t.manualChannel3Csrf} {credFlags.antigravity_csrf ? `(${t.configuredTag})` : ''}
                    </label>
                    <input
                      type="password"
                      placeholder={credFlags.antigravity_csrf ? '••••••••' : 'csrf token'}
                      className="ando-input"
                      value={credForm.antigravity_csrf}
                      onChange={(e) => setCredForm({ ...credForm, antigravity_csrf: e.target.value })}
                    />
                  </div>
                  <div className="setting-group">
                    <label>{t.manualChannel4Pct}</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      placeholder="0 - 100"
                      className="ando-input"
                      value={credForm.grok_manual_pct}
                      onChange={(e) => setCredForm({ ...credForm, grok_manual_pct: e.target.value })}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
                    <button className="ando-btn" disabled={savingCreds} onClick={handleSaveCredentials}>
                      {savingCreds ? t.savingCredentials : t.saveCredentials}
                    </button>
                    {saveStatus && <span className="section-desc" style={{ color: '#4ade80' }}>{saveStatus}</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Alerts Tab ── */}
          {activeTab === 'alerts' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">{t.usageAlerts}</h3>
                <div className="setting-group">
                  <label>{t.alertBelowLabel}</label>
                  <div className="slider-row">
                    <input type="range" min="5" max="50" value={alertThreshold} onChange={(e) => setAlertThreshold(Number(e.target.value))} className="ando-slider" />
                    <span className="slider-value">{alertThreshold}%</span>
                  </div>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">{t.timerAlerts}</h3>
                <div className="setting-group">
                  <label>{t.alertTimerLabel}</label>
                  <div className="slider-row">
                    <input type="range" min="5" max="120" step="5" value={alertTimerMin} onChange={(e) => setAlertTimerMin(Number(e.target.value))} className="ando-slider" />
                    <span className="slider-value">{alertTimerMin} {t.minutesUnit}</span>
                  </div>
                </div>
              </div>

              <p className="section-desc">{t.alertsActiveNote}</p>
            </div>
          )}

          {/* ── Appearance Tab ── */}
          {activeTab === 'appearance' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">{t.customOrbLabels}</h3>
                <p className="section-desc">{t.customOrbLabelsDesc}</p>

                <div className="setting-group">
                  <label>{t.orbLabelSlot1}</label>
                  <input
                    type="text"
                    maxLength={24}
                    className="ando-input"
                    placeholder={defaultLabels.claude.title}
                    value={customTitles.claude || ''}
                    onChange={(e) => setCustomTitles({ ...customTitles, claude: e.target.value })}
                  />
                </div>
                <div className="setting-group">
                  <label>{t.orbLabelSlot2}</label>
                  <input
                    type="text"
                    maxLength={24}
                    className="ando-input"
                    placeholder={defaultLabels.codex.title}
                    value={customTitles.codex || ''}
                    onChange={(e) => setCustomTitles({ ...customTitles, codex: e.target.value })}
                  />
                </div>
                <div className="setting-group">
                  <label>{t.orbLabelSlot3}</label>
                  <input
                    type="text"
                    maxLength={24}
                    className="ando-input"
                    placeholder={defaultLabels.antigravity.title}
                    value={customTitles.antigravity || ''}
                    onChange={(e) => setCustomTitles({ ...customTitles, antigravity: e.target.value })}
                  />
                </div>
                <div className="setting-group">
                  <label>{t.orbLabelSlot4}</label>
                  <input
                    type="text"
                    maxLength={24}
                    className="ando-input"
                    placeholder={defaultLabels.grok.title}
                    value={customTitles.grok || ''}
                    onChange={(e) => setCustomTitles({ ...customTitles, grok: e.target.value })}
                  />
                </div>
                <div style={{ marginTop: '6px' }}>
                  <button
                    className="ando-btn"
                    onClick={() => setCustomTitles({ claude: '', codex: '', antigravity: '', grok: '' })}
                  >
                    {t.resetDefaultLabels}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── General Tab ── */}
          {activeTab === 'general' && (
            <div className="settings-tab-content">
              <div className="setting-section">
                <h3 className="section-title">{t.languageTitle}</h3>
                <p className="section-desc">{t.languageDesc}</p>
                <div className="theme-options" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                  <button className={`theme-btn ${lang === 'zh' ? 'active' : ''}`} onClick={() => setLang('zh')}>
                    <span>{t.langZh}</span>
                  </button>
                  <button className={`theme-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>
                    <span>{t.langEn}</span>
                  </button>
                </div>
              </div>

              <div className="setting-section">
                <h3 className="section-title">{t.teamViewTitle}</h3>
                <div className="checkbox-group">
                  <label className="checkbox-option">
                    <input type="checkbox" checked={teamSharingEnabled} onChange={(e) => setTeamSharingEnabled(e.target.checked)} />
                    <span>{t.teamSharingLabel}</span>
                  </label>
                </div>
                <p className="section-desc" style={{ marginTop: '4px' }}>
                  {t.teamSharingDesc}
                </p>
                {teamSharingEnabled && (
                  <div className="setting-group" style={{ marginTop: '10px' }}>
                    <label>{t.teamYourNameLabel}</label>
                    <input
                      className="ando-input"
                      type="text"
                      maxLength={40}
                      value={teamDisplayName}
                      placeholder={t.teamYourNamePlaceholder}
                      onChange={(e) => setTeamDisplayName(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {!IS_APP_STORE && (
                <div className="setting-section">
                  <h3 className="section-title">{t.updatesTitle}</h3>
                  <div className="checkbox-group">
                    <label className="checkbox-option">
                      <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} />
                      <span>{t.autoUpdateLabel}</span>
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
                    <button
                      className="ando-btn"
                      disabled={updateState === 'checking' || updateState === 'downloading'}
                      onClick={() => onCheckForUpdates(true)}
                    >
                      {updateState === 'checking' ? t.checkingUpdates : updateState === 'downloading' ? t.downloadingUpdates : t.checkForUpdates}
                    </button>
                    {updateState === 'ready' && (
                      <button className="ando-btn" onClick={onRestartNow}>{t.restartNow}</button>
                    )}
                  </div>
                  <p className="section-desc" style={{ marginTop: '8px' }}>
                    {updateState === 'idle' && t.updateIdle}
                    {updateState === 'checking' && t.updateChecking}
                    {updateState === 'uptodate' && t.updateUpToDate}
                    {updateState === 'available' && updateInfo && t.updateAvailable(updateInfo.version)}
                    {updateState === 'downloading' && t.updateDownloading(updateProgress)}
                    {updateState === 'ready' && updateInfo && t.updateReady(updateInfo.version)}
                    {updateState === 'error' && t.updateError}
                  </p>
                </div>
              )}

              <div className="setting-section">
                <h3 className="section-title">{t.aboutTitle}</h3>
                <p className="section-desc">{t.aboutVersion(APP_VERSION)}</p>
                <p className="section-desc" style={{ opacity: 0.5 }}>{t.aboutBuiltWith}</p>
              </div>

              <div className="settings-footer">
                <button className="ando-btn danger" onClick={onResetAll}>{t.resetAllSettings}</button>
                <button className="ando-btn" onClick={onClose}>{t.doneBtn}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const DualRingOrb = ({ providerKey = null, color, glowColor, timer, secondaryTimer, percentage, secondaryPercentage, secondaryColor, label, primaryLabel, secondaryLabel, hasWeeklySecondary = false, stackLabels = false, videoFilter, onPopOut, offline = false, appName = null, ambientPulse = false, resetCredits = null, dataLoaded = true, introOrder = 0, needsLogin = false, onNeedsLogin = null, needsDiskAccess = false, onNeedsDiskAccess = null, needsSetup = false, onNeedsSetup = null, criticalPctThreshold = 20, criticalMinThreshold = 30, t = null, backendUrl = null }) => {
  // Which "fix it" prompt to show in place of the countdown, if any. Disk
  // access wins over login: when macOS refuses to open Chrome's cookie DB,
  // logging in can't help, so telling the user to do it is actively wrong.
  const authFix = needsSetup
    ? { hint: t ? t.setupHint : 'SETUP', cls: 'orb-login-hint', cta: t ? t.setupCta : '⚙ CONFIGURE IN SETTINGS', on: onNeedsSetup, title: t ? t.setupTitle : 'Open Settings › Data Source' }
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

  const videoRef = useRef(null);
  const videoRetryRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const orbGlassRef = useRef(null);   // 彩蛋:无绳弹弓需要球体的真实屏幕位置
  const uid = React.useId().replace(/:/g, '');

  const isTimerCritical = (timerStr) => {
    if (!timerStr || timerStr === "00:00:00" || !timerStr.includes(':')) return false;
    const parts = timerStr.split(':');
    if (parts.length === 3 && !parts[0].includes('d')) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        const totalMins = h * 60 + m;
        return totalMins < criticalMinThreshold;
      }
    }
    return false;
  };

  const isCritical = validPct < criticalPctThreshold || (hasSecondary && validPctSec < criticalPctThreshold) || isTimerCritical(timer) || (hasSecondary && isTimerCritical(secondaryTimer));
  const isCriticalRef = useRef(isCritical);
  isCriticalRef.current = isCritical;

  // Liquid animation: native playback + demand-driven easing timer (0% JS CPU when idle).
  const lastReloadRef = useRef(0);
  const baseSpeedRef = useRef(0.8 + Math.random() * 0.4);
  const hoveringRef = useRef(false);
  const lingerTimerRef = useRef(null);
  const burstTimerRef = useRef(null);
  const easeTimerRef = useRef(null);
  const ambientPulseRef = useRef(ambientPulse);
  const targetSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);
  const currentSpeedRef = useRef(isCritical ? baseSpeedRef.current : 0);

  const applyPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    const spd = currentSpeedRef.current;
    if (spd > 0.05) {
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
      (hoveringRef.current || isCriticalRef.current || ambientPulseRef.current || burstTimerRef.current)
        ? baseSpeedRef.current : 0;
    targetSpeedRef.current = next;
    if (next > 0 || currentSpeedRef.current > 0.01) {
      ensureEaseLoop();
    }
  };

  // Keep ambientPulseRef in sync with the prop.
  useEffect(() => { ambientPulseRef.current = ambientPulse; refreshTarget(); }, [ambientPulse]);

  // Force the liquid to flow for `ms` (default 30s), then settle back to its
  // resting state. Used as feedback when popping out / retracting a widget.
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

  // Cleanup linger/burst/ease timers on unmount.
  useEffect(() => () => {
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    if (easeTimerRef.current) { clearInterval(easeTimerRef.current); easeTimerRef.current = null; }
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      try {
        // Seek to a random frame so the paused orb shows liquid, not black.
        v.currentTime = Math.random() * (v.duration || 10);
      } catch (e) {}
    }
    currentSpeedRef.current = isCriticalRef.current ? baseSpeedRef.current : 0;
    if (targetSpeedRef.current > 0 || currentSpeedRef.current > 0.01) {
      ensureEaseLoop();
    }
  }, []);

  // 开场"灌满"动效:液体先自顾自从空到满涨一轮(和真实数据无关),看起来像是
  // 一边涨一边在读后台数据;涨满之后,如果真实数据已经到了就直接用真实值——
  // .video-blob 自带的 1.5s transition 会把它从"满"平滑收回到该有的高度;
  // 真实数据还没到就先满着等,数据一到同样靠那个 transition 自然收回去。
  // introOrder(0/1/2,从左到右)让三个球错开开始,一个接一个地涨,而不是
  // 同时一起涨——每个球自己涨满仍是 INTRO_MS,只是起涨时间依次延后。
  const [introDone, setIntroDone] = useState(false);
  const [introPct, setIntroPct] = useState(0);
  // 轮到这个球开始涨了没(按 introOrder 从左到右错开)。
  const [turnStarted, setTurnStarted] = useState(false);
  const introRafRef = useRef(null);
  const introStartRef = useRef(null);
  const INTRO_MS = 3000;
  const INTRO_STAGGER_MS = 550;
  const introDelay = introOrder * INTRO_STAGGER_MS;

  useEffect(() => {
    if (introDone) return;
    const step = (ts) => {
      if (introStartRef.current == null) introStartRef.current = ts;
      const localElapsed = ts - introStartRef.current - introDelay;
      if (localElapsed < 0) {
        // 还没轮到这个球起涨,继续等待,液体保持空。
        introRafRef.current = requestAnimationFrame(step);
        return;
      }
      setTurnStarted(true);
      const t = Math.min(1, localElapsed / INTRO_MS);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic:起势快、到顶渐缓
      setIntroPct(eased * 100);
      if (t < 1) {
        introRafRef.current = requestAnimationFrame(step);
      } else {
        setIntroDone(true);
      }
    };
    introRafRef.current = requestAnimationFrame(step);
    return () => { if (introRafRef.current) cancelAnimationFrame(introRafRef.current); };
  }, [introDone]);

  const liquidPct = (isWeeklyExhausted || (offline && introDone)) ? 0 : (!introDone ? introPct : (dataLoaded ? validPct : 100));
  // 倒计时文字(READY/真实时间)要等两件事都发生才露出来:轮到这个球的开场
  // 顺位、且真实数据已经到手。哪怕数据来得比顺位早,也照样按 introOrder 依次
  // 露出来,不会三个一起"啪"地弹出——避免中途先闪一下 READY 占位字样。
  const revealed = turnStarted && dataLoaded;
  // 光环在真实数据到手前保持"空"(而不是默认的 100% 满环)——默认状态
  // rate_limit_pct=0 会让 percentage 算成 100,环一开始就是满的;数据一到,
  // stroke-dashoffset 的 1s CSS transition 会让它从"满"猛地转一大圈扫到真实
  // 百分比,看起来像开场转了一圈。改成数据到手前就是空环,数据一到才从空转
  // 到真实值,方向和液体的"从空到满"一致,也不会有那种突兀的满环写扫。
  // Offline = no trustworthy reading: keep rings empty rather than showing the last value as live.
  const ringPct = (revealed && !offline && !isWeeklyExhausted) ? validPct : 0;
  const ringPctSec = (revealed && !offline) ? validPctSec : 0;
  const displayStrokeDashoffset = circumference - (circumference * ringPct) / 100;
  const displayStrokeDashoffsetSec = circumferenceSec - (circumferenceSec * ringPctSec) / 100;

  const isExhausted = validPct <= 0 || isWeeklyExhausted;

  return (
    <div className="orb-wrapper orb-intro-appear" style={{ animationDelay: `${introDelay}ms` }} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className={`orb-glass-breather ${offline || authFix ? 'offline-state' : isExhausted ? 'exhausted-state' : isCritical ? 'critical-state' : ''}`}>
        <div
          className="orb-glass"
          ref={orbGlassRef}
          data-provider={providerKey || (label ? label.toLowerCase() : undefined)}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onMouseDown={(e) => eggBeginDrag(e, orbGlassRef.current)}
          onClick={onPopOut ? (() => { if (eggConsumeClickSuppress()) return; startFlowBurst(30000); onPopOut(); }) : undefined}
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
              src={backendUrl ? `${backendUrl}/liquid-loop.mp4?v=3` : undefined}
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
              onLoadedData={() => {
                loadedOnceRef.current = true;
                videoRetryRef.current = 0;
                if (targetSpeedRef.current > 0 || currentSpeedRef.current > 0.01) {
                  applyPlayback();
                  ensureEaseLoop();
                }
              }}
              onError={() => {
                // Retry both cold-start failures and mid-session media evictions.
                if (videoRetryRef.current >= 40) return;
                videoRetryRef.current += 1;
                setTimeout(() => {
                  try { videoRef.current && videoRef.current.load(); } catch (e) {}
                }, 3000);
              }}
              style={{
                transform: `scale(${Math.max(0.01, liquidPct / 100)})`,
                transformOrigin: 'center center',
                opacity: Math.min(1, liquidPct / 8),
                filter: videoFilter
              }}
            />
          </div>
        </div>

        {/* SVG Rings */}
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
          
          {/* Track background (dimmed a lot more than the progress arc so
              "used" vs "remaining" actually reads at a glance) */}
          <circle cx="100" cy="100" r={radius} stroke={color} opacity="0.16" strokeWidth={strokeW} fill="none" />
          
          {/* Progress Ring */}
          <circle 
            cx="100" cy="100" r={radius} 
            stroke={color} 
            strokeWidth={strokeW} 
            fill="none" 
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={displayStrokeDashoffset}
            transform="rotate(-90 100 100)"
            filter={`url(#glow-${uid})`}
          />

          {/* Inner Rings */}
          <circle cx="100" cy="100" r={54} stroke={hasSecondary ? secondaryColor : color} opacity="0.3" strokeWidth="1" fill="none" />
          
          {hasSecondary ? (
            <>
              <circle cx="100" cy="100" r={radiusSec} stroke={secondaryColor} opacity="0.16" strokeWidth={strokeWSec} fill="none" />
              <circle
                cx="100" cy="100" r={radiusSec}
                stroke={secondaryColor}
                strokeWidth={strokeWSec}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={circumferenceSec}
                strokeDashoffset={displayStrokeDashoffsetSec}
                transform="rotate(-90 100 100)"
                filter={`url(#glow-sec-${uid})`}
              />
            </>
          ) : (
            <circle cx="100" cy="100" r="45" stroke={color} opacity="0.08" strokeWidth="10" fill="none" />
          )}
        </svg>

        {/* Digital Timer */}
        <div className="orb-timer-wrapper" style={{ opacity: (revealed || authFix) ? 1 : 0 }}>
          {authFix ? (
            <span
              className={`orb-timer ${authFix.cls}`}
              onClick={authFix.on || undefined}
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
            <button className="orb-popout-btn" onClick={onPopOut} title={t ? t.popOutTitle : "Pop out as desktop widget"}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          )}
        </div>
        {authFix ? (
          <p
            className="orb-subtitle orb-offline orb-login-cta"
            onClick={authFix.on || undefined}
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

function App() {
  const [data, setData] = useState({
    antigravity: {
      provider: "Antigravity",
      loaded: false,
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
      loaded: false,
      needsLogin: false,
      needsDiskAccess: false,
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
      loaded: false,
      rate_limit_pct: 0.0,
      rate_limit_pct_secondary: 0.0,
      status: "NORMAL",
      status_secondary: "NORMAL",
      reset_time: "",
      reset_time_secondary: "",
      resetsAt: "",
      resetsAt_secondary: "",
      primary_window_started: false,
      reset_credits: null
    },
    grok: {
      provider: "Grok",
      loaded: false,
      rate_limit_pct: 0.0,
      status: "NORMAL",
      resetsAt: "",
      plan: ""
    }
  });
  // Persistent Settings State
  const [lang, setLangState] = useState(getInitialLang);
  const t = useT(lang);
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  const setLang = (next) => {
    setLangState(next);
    try { window.localStorage.setItem(LANG_STORAGE_KEY, next); } catch {}
    emit('settings-changed', {}).catch(() => {});
  };

  const [dataMode, setDataMode] = useState(IS_APP_STORE ? 'demo' : 'auto');
  const [alertThreshold, setAlertThreshold] = useLocalStorage('aipulse_alertThreshold', 20);
  const [alertTimerMin, setAlertTimerMin] = useLocalStorage('aipulse_alertTimerMin', 30);
  const [customTitles, setCustomTitles] = useLocalStorage(CUSTOM_LABELS_STORAGE_KEY, {
    claude: '',
    codex: '',
    antigravity: '',
    grok: '',
  });
  const [autoUpdate, setAutoUpdate] = useLocalStorage('aipulse_autoUpdate', true);
  const [hasPoppedOutWidget, setHasPoppedOutWidget] = useLocalStorage('aipulse_hasPoppedOutWidget', false);
  const [settingsInitialTab, setSettingsInitialTab] = useState(null);

  useEffect(() => {
    emit('settings-changed', {}).catch(() => {});
  }, [alertThreshold, alertTimerMin, customTitles]);

  // ── Team View (LAN-only, opt-in) ──
  const [teamSharingEnabled, setTeamSharingEnabled] = useLocalStorage('aipulse_teamSharingEnabled', false);
  const [teamDisplayName, setTeamDisplayName] = useLocalStorage('aipulse_teamDisplayName', '');
  const [teamInstanceId, setTeamInstanceId] = useLocalStorage('aipulse_teamInstanceId', '');
  // [{instance_id, display_name, host, port}] — the user's pinned "2-3 teammates".
  const [pinnedPeers, setPinnedPeers] = useLocalStorage('aipulse_pinnedPeers', []);
  // Live data from the local backend's /api/team-peers (discovered + pinned + manual).
  const [teamPeersLive, setTeamPeersLive] = useState([]);
  const [showTeamAdd, setShowTeamAdd] = useState(false);
  const [teamManualHost, setTeamManualHost] = useState('');
  const [teamManualError, setTeamManualError] = useState('');
  const [showTeamNamePrompt, setShowTeamNamePrompt] = useState(false);
  const [teamNameDraft, setTeamNameDraft] = useState('');

  // The Tauri shell chooses a free local port before it starts the backend.
  // Resolve it once so every main-window request uses the same port.
  const [backendUrl, setBackendUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    resolveBackendUrl().then((url) => {
      if (!cancelled) setBackendUrl(url);
    });
    return () => { cancelled = true; };
  }, []);

  // Sync current data collection mode from local backend config.
  useEffect(() => {
    if (!backendUrl) return;
    fetch(`${backendUrl}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg && cfg.data_mode) setDataMode(cfg.data_mode);
      })
      .catch(() => {});
  }, [backendUrl]);

  // Generate a stable instance ID once — this is how a pinned teammate stays
  // pinned across their app restarts and IP changes (their IP isn't stable,
  // this ID is).
  useEffect(() => {
    if (!teamInstanceId) {
      setTeamInstanceId(Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => b.toString(16).padStart(2, '0')).join(''));
    }
  }, [teamInstanceId]);

  // Push sharing on/off + display name to the local backend whenever they change.
  useEffect(() => {
    if (!backendUrl || !teamInstanceId) return; // wait for backend + ID
    fetch(`${backendUrl}/api/team-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: teamSharingEnabled,
        display_name: teamDisplayName || 'Teammate',
        instance_id: teamInstanceId,
      }),
    }).catch(() => {});
  }, [backendUrl, teamSharingEnabled, teamDisplayName, teamInstanceId]);

  // Keep the backend's poller aware of who's pinned, so it keeps retrying a
  // teammate even after they fall out of mDNS range (different network, etc.).
  useEffect(() => {
    if (!backendUrl) return;
    fetch(`${backendUrl}/api/team-pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: pinnedPeers }),
    }).catch(() => {});
  }, [backendUrl, pinnedPeers]);

  // Poll for discovered/pinned/manual peers. Runs regardless of whether
  // sharing is on — you can watch teammates without broadcasting yourself.
  useEffect(() => {
    if (!backendUrl) return undefined;
    let cancelled = false;
    const poll = () => {
      fetch(`${backendUrl}/api/team-peers`)
        .then(r => r.json())
        .then(d => { if (!cancelled) setTeamPeersLive(d.peers || []); })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 6000);
    return () => { cancelled = true; clearInterval(id); };
  }, [backendUrl]);

  const pinTeamPeer = (peer) => {
    if (pinnedPeers.length >= 3) return;
    if (pinnedPeers.some(p => p.instance_id === peer.instance_id)) return;
    setPinnedPeers([...pinnedPeers, {
      instance_id: peer.instance_id, display_name: peer.display_name, host: peer.host, port: peer.port,
    }]);
    setShowTeamAdd(false);
  };

  const unpinTeamPeer = (instanceId) => {
    setPinnedPeers(pinnedPeers.filter(p => p.instance_id !== instanceId));
  };

  const addTeamPeerManual = () => {
    if (!backendUrl) return;
    const peer = parseManualPeerAddress(teamManualHost);
    if (!peer) {
      setTeamManualError(t.teamManualFormatErr);
      return;
    }
    setTeamManualError('');
    fetch(`${backendUrl}/api/team-peers/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(peer),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setTeamManualError(d.detail || t.teamConnectErr); return; }
        pinTeamPeer(d);
        setTeamManualHost('');
      })
      .catch(() => setTeamManualError(t.teamConnectErr));
  };

  // Clicking "Share" for the first time (no name set yet) shouldn't silently
  // start broadcasting as generic "Teammate" — ask for a name first. Turning
  // sharing back off never needs a prompt.
  const handleShareClick = () => {
    if (teamSharingEnabled) {
      setTeamSharingEnabled(false);
      return;
    }
    if (!teamDisplayName.trim()) {
      setTeamNameDraft(teamDisplayName);
      setShowTeamAdd(false);
      setShowTeamNamePrompt(true);
      return;
    }
    setTeamSharingEnabled(true);
  };

  const confirmTeamName = () => {
    const name = teamNameDraft.trim();
    if (!name) return;
    setTeamDisplayName(name);
    setTeamSharingEnabled(true);
    setShowTeamNamePrompt(false);
  };

  // ── Auto-update (Tauri updater plugin) ──
  // idle | checking | uptodate | available | downloading | ready | error
  const [updateState, setUpdateState] = useState('idle');
  const [updateInfo, setUpdateInfo] = useState(null);       // { version, notes }
  const [updateProgress, setUpdateProgress] = useState(0);
  const pendingUpdateRef = useRef(null);                    // holds the Update object between check() and install
  const autoUpdateRef = useRef(autoUpdate);
  useEffect(() => { autoUpdateRef.current = autoUpdate; }, [autoUpdate]);

  const installUpdate = async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    setUpdateState('downloading');
    setUpdateProgress(0);
    try {
      let total = 0, received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setUpdateProgress(total ? Math.min(100, Math.round((received / total) * 100)) : 0);
        } else if (event.event === 'Finished') {
          setUpdateProgress(100);
        }
      });
      setUpdateState('ready');
      // Widgets are the thing people actually look at day to day — most users
      // rarely reopen the main window, so a Settings-only "restart to update"
      // notice would go unseen for a long-running session. Broadcast to any
      // open widget windows so they can show a small badge instead.
      emit('update-ready', { version: pendingUpdateRef.current && pendingUpdateRef.current.version }).catch(() => {});
    } catch (e) {
      console.error('Update install failed:', e);
      setUpdateState('error');
    }
  };

  // manual=true → user clicked "Check for Updates" (always download if found);
  // manual=false → silent startup check (only auto-downloads if the setting is on).
  const checkForUpdates = async (manual = false) => {
    if (updateState === 'checking' || updateState === 'downloading') return;
    setUpdateState('checking');
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setUpdateState('uptodate');
        return;
      }
      pendingUpdateRef.current = update;
      setUpdateInfo({ version: update.version, notes: update.body });
      setUpdateState('available');
      if (manual || autoUpdateRef.current) {
        await installUpdate();
      }
    } catch (e) {
      console.error('Update check failed:', e);
      setUpdateState('error');
    }
  };

  const restartNow = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      console.error('Restart failed:', e);
    }
  };

  // Silent check shortly after launch — only acts (downloads) if autoUpdate is on;
  // otherwise it just surfaces "available" so the Settings panel can show it.
  // This app is meant to stay running for days at a time, not get relaunched
  // often, so a launch-only check could miss releases for a long time —
  // also re-check every 3 days for as long as the app stays open.
  // Disabled in App Store builds (updates are managed by the App Store).
  useEffect(() => {
    if (IS_APP_STORE) return undefined;
    const timer = setTimeout(() => { checkForUpdates(false); }, 4000);
    const RECHECK_MS = 3 * 24 * 60 * 60 * 1000;
    const id = setInterval(() => { checkForUpdates(false); }, RECHECK_MS);
    return () => { clearTimeout(timer); clearInterval(id); };
  }, []);

  // ── Free trial / license (state lives in the macOS Keychain, see lib.rs) ──
  const [trialStart, setTrialStart] = useState(null);   // epoch seconds, or null until loaded
  const [licensed, setLicensed] = useState(IS_APP_STORE);
  const [trialLoaded, setTrialLoaded] = useState(IS_APP_STORE);

  useEffect(() => {
    if (IS_APP_STORE) return;
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
    if (IS_APP_STORE) return true;
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
  const isLicensed = IS_APP_STORE || licensed;
  const isExpired = !IS_APP_STORE && trialLoaded && !isLicensed && trialStart != null && daysLeft <= 0;

  const resetAllSettings = () => {
    const defaultMode = IS_APP_STORE ? 'demo' : 'auto';
    setAlertThreshold(20);
    setAlertTimerMin(30);
    setCustomTitles({ claude: '', codex: '', antigravity: '', grok: '' });
    setTeamSharingEnabled(false);
    setTeamDisplayName('');
    setPinnedPeers([]);
    setAutoUpdate(true);
    setDataMode(defaultMode);
    if (backendUrl) {
      fetch(`${backendUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_mode: defaultMode }),
      }).catch(() => {});
    }
  };

  const [connected, setConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [timers, setTimers] = useState({
    claude: "00:00:00",
    claude_secondary: "00:00:00",
    codex: "00:00:00",
    codex_secondary: "00:00:00",
    antigravity: "00:00:00",
    antigravity_claude: "00:00:00",
    grok: "00:00:00"
  });
  
  const [currentTime, setCurrentTime] = useState("");

  // ── Ambient random pulse: occasionally one orb flows by itself ──
  const orbNames = ['claude', 'codex', 'antigravity', 'grok'];
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
    if (!backendUrl) return undefined;
    let eventSource = null;
    let retryTimer = null;
    let cancelled = false;

    const connectSSE = () => {
      if (cancelled) return;
      eventSource = new EventSource(`${backendUrl}/api/stream`);

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
        if (!cancelled) {
          retryTimer = setTimeout(connectSSE, 3000);
        }
      };
    };

    connectSSE();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [backendUrl]);

  useEffect(() => {
    const timer = setInterval(() => {
      const d = dataRef.current;
      const curT = tRef.current;
      setTimers({
        claude: formatClaudePrimaryCountdown(d.claude, curT),
        claude_secondary: formatCountdownHMS(d.claude.resetsAt_secondary, curT.ready),
        codex: formatCodexPrimaryCountdown(d.codex, curT),
        codex_secondary: formatCountdownHMS(d.codex.resetsAt_secondary, curT.ready),
        antigravity: formatCountdownHMS(d.antigravity.resetsAt_secondary, curT.ready),
        antigravity_claude: formatCountdownHMS(d.antigravity.resetsAt, curT.ready),
        grok: formatCountdownHMS(d.grok?.resetsAt, curT.ready)
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

  const orbLabels = getCustomOrbLabels(IS_APP_STORE, lang);
  const openDatasourceSettings = () => {
    setSettingsInitialTab('datasource');
    setShowSettings(true);
  };

  return (
    <div className="pulse-desktop-environment">
      {/* ── Trial-ended lock screen (direct distribution only) ── */}
      {!IS_APP_STORE && isExpired && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 6000, background: 'rgba(8,8,11,0.92)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center' }}>
          <div style={{ fontSize: '34px' }}>⏳</div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>{t.trialEndedTitle}</h2>
          <p style={{ margin: 0, color: 'rgba(255,255,255,0.6)', fontSize: '13px', maxWidth: '260px' }}>{t.trialEndedDesc}</p>
          <button onClick={() => openUrl(CHECKOUT_FULL)} style={{ padding: '10px 24px', background: '#ff8c00', color: '#111', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}>{t.buyFullBtn}</button>
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <input id="licenseKeyExpired" placeholder={t.licensePlaceholder} style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #333', background: '#111', color: '#fff', fontFamily: 'monospace', fontSize: '12px', width: '180px' }} />
            <button onClick={async () => { const ok = await activateLicense(document.getElementById('licenseKeyExpired').value); if (!ok) alert(t.invalidLicense); }} style={{ padding: '8px 14px', background: '#333', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>{t.activateBtn}</button>
          </div>
        </div>
      )}

      {/* 3. High-Fidelity Ando Dark Concrete Popover Window */}
      <div className="popover-window">
        {showSettings && <SettingsModal
          onClose={() => { setShowSettings(false); setSettingsInitialTab(null); }}
          t={t}
          lang={lang} setLang={setLang}
          backendUrl={backendUrl}
          dataMode={dataMode} setDataMode={setDataMode}
          alertThreshold={alertThreshold} setAlertThreshold={setAlertThreshold}
          alertTimerMin={alertTimerMin} setAlertTimerMin={setAlertTimerMin}
          customTitles={customTitles} setCustomTitles={setCustomTitles}
          autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate}
          teamSharingEnabled={teamSharingEnabled} setTeamSharingEnabled={setTeamSharingEnabled}
          teamDisplayName={teamDisplayName} setTeamDisplayName={setTeamDisplayName}
          updateState={updateState} updateInfo={updateInfo} updateProgress={updateProgress}
          onCheckForUpdates={checkForUpdates} onRestartNow={restartNow}
          licensed={isLicensed} daysLeft={daysLeft}
          onActivate={activateLicense}
          checkoutUrl={CHECKOUT_TRIAL}
          onResetAll={resetAllSettings}
          initialTab={settingsInitialTab}
        />}
        <div className="concrete-overlay"></div>

        {/* Popover Header */}
        <header className="popover-header-section" data-tauri-drag-region>
          <div className="popover-title-group" data-tauri-drag-region>
            <div className="fluid-pixel-container" data-tauri-drag-region>
              <div className="fluid-pixel" data-tauri-drag-region></div>
            </div>
            <span className="popover-title" data-tauri-drag-region>{t.appName}</span>
          </div>
          
          <div className="popover-status-badge">
            <span className={`status-led ${connected ? 'live' : 'offline'}`}></span>
            <span className="status-text">
              {connected ? (dataMode === 'demo' ? t.demoModeBadge : t.liveSync) : t.offline}
            </span>
            {!IS_APP_STORE && !isLicensed && daysLeft != null && (
              <span
                title="Free trial"
                style={{ fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.05em', color: daysLeft <= 3 ? '#ff5a5a' : 'rgba(255,255,255,0.55)', padding: '2px 6px', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px' }}
              >
                {t.trialDays(daysLeft)}
              </span>
            )}
            <button className="settings-icon-btn" onClick={() => { setSettingsInitialTab(null); setShowSettings(true); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        </header>

        {/* The Volumetric Orbs Grid */}
        <main className="spheres-grid">
          
          {/* Orb 1: Slot 1 (Amber-Orange + Inner Yellow for Weekly) */}
          <DualRingOrb
            providerKey="claude"
            color="#ff8c00"
            secondaryColor="#facc15"
            glowColor="rgba(255, 85, 0, 0.4)"
            videoFilter="none"
            timer={timers.claude}
            secondaryTimer={timers.claude_secondary}
            percentage={(data.claude.rate_limit_pct_secondary >= 100 || data.claude.status_secondary === "EXHAUSTED") ? 0 : (100 - data.claude.rate_limit_pct)}
            secondaryPercentage={100 - data.claude.rate_limit_pct_secondary}
            label={orbLabels.claude.title}
            primaryLabel={orbLabels.claude.primary}
            secondaryLabel={orbLabels.claude.secondary}
            hasWeeklySecondary={true}
            stackLabels={true}
            connected={connected}
            dataLoaded={!!data.claude.loaded}
            introOrder={0}
            ambientPulse={ambientOrb === 'claude'}
            criticalPctThreshold={Number(alertThreshold)}
            criticalMinThreshold={Number(alertTimerMin)}
            t={t}
            needsLogin={!IS_APP_STORE && !!data.claude.needsLogin && (!data.claude.loaded || !!data.claude.stale)}
            onNeedsLogin={() => openUrl('https://claude.ai')}
            needsDiskAccess={!IS_APP_STORE && !!data.claude.needsDiskAccess && (!data.claude.loaded || !!data.claude.stale)}
            onNeedsDiskAccess={() => invoke('open_full_disk_access_settings').catch(() => {})}
            needsSetup={!!data.claude.needsSetup}
            onNeedsSetup={openDatasourceSettings}
            backendUrl={backendUrl}
            onPopOut={() => { launchWidget('claude'); setHasPoppedOutWidget(true); }}
          />

          {/* Orb 2: Slot 2 (Red) */}
          <DualRingOrb
            providerKey="codex"
            color="#ef4444"
            secondaryColor="#fb7185"
            glowColor="rgba(239, 68, 68, 0.4)"
            videoFilter="hue-rotate(320deg) saturate(2) brightness(1.2)"
            timer={timers.codex}
            secondaryTimer={timers.codex_secondary}
            percentage={(data.codex.rate_limit_pct_secondary >= 100 || data.codex.status_secondary === "EXHAUSTED") ? 0 : (100 - data.codex.rate_limit_pct)}
            secondaryPercentage={100 - data.codex.rate_limit_pct_secondary}
            label={orbLabels.codex.title}
            primaryLabel={orbLabels.codex.primary}
            secondaryLabel={orbLabels.codex.secondary}
            hasWeeklySecondary={true}
            stackLabels={true}
            connected={connected}
            dataLoaded={!!data.codex.loaded}
            introOrder={1}
            resetCredits={data.codex.reset_credits}
            ambientPulse={ambientOrb === 'codex'}
            criticalPctThreshold={Number(alertThreshold)}
            criticalMinThreshold={Number(alertTimerMin)}
            t={t}
            needsSetup={!!data.codex.needsSetup}
            onNeedsSetup={openDatasourceSettings}
            backendUrl={backendUrl}
            onPopOut={() => { launchWidget('codex'); setHasPoppedOutWidget(true); }}
          />

          {/* Orb 3: Slot 3 (Cyan-Blue + Orange) */}
          <DualRingOrb
            providerKey="antigravity"
            color="#06b6d4"
            secondaryColor="#fb923c"
            glowColor="rgba(6, 182, 212, 0.4)"
            videoFilter="hue-rotate(185deg) saturate(1.8) brightness(1.2)"
            timer={timers.antigravity}
            secondaryTimer={timers.antigravity_claude}
            percentage={100 - (data.antigravity?.rate_limit_pct_secondary ?? 0)}
            secondaryPercentage={100 - (data.antigravity?.rate_limit_pct ?? 0)}
            label={orbLabels.antigravity.title}
            primaryLabel={orbLabels.antigravity.primary}
            secondaryLabel={orbLabels.antigravity.secondary}
            stackLabels={true}
            connected={connected}
            dataLoaded={!!data.antigravity.loaded}
            introOrder={2}
            offline={data.antigravity.available === false && !data.antigravity.needsSetup}
            appName={IS_APP_STORE ? orbLabels.antigravity.title : "Antigravity"}
            ambientPulse={ambientOrb === 'antigravity'}
            criticalPctThreshold={Number(alertThreshold)}
            criticalMinThreshold={Number(alertTimerMin)}
            t={t}
            needsSetup={!!data.antigravity.needsSetup}
            onNeedsSetup={openDatasourceSettings}
            backendUrl={backendUrl}
            onPopOut={() => { launchWidget('antigravity'); setHasPoppedOutWidget(true); }}
          />

          {/* Orb 4: Slot 4 (Monochrome Silver/Cool Slate) */}
          <DualRingOrb
            providerKey="grok"
            color="#e2e8f0"
            secondaryColor="#94a3b8"
            glowColor="rgba(226, 232, 240, 0.4)"
            videoFilter="grayscale(1) brightness(1.25) contrast(1.1)"
            timer={timers.grok}
            percentage={data.grok?.status === "EXHAUSTED" ? 0 : (100 - (data.grok?.rate_limit_pct || 0))}
            label={orbLabels.grok.title}
            primaryLabel={orbLabels.grok.primary}
            secondaryLabel={data.grok?.plan ? (IS_APP_STORE ? orbLabels.grok.secondary : `${data.grok.plan.toUpperCase()} PLAN`) : orbLabels.grok.secondary}
            connected={connected}
            dataLoaded={!!data.grok?.loaded}
            introOrder={3}
            offline={data.grok?.available === false && !data.grok?.needsSetup}
            appName={IS_APP_STORE ? orbLabels.grok.title : "Grok Bot"}
            ambientPulse={ambientOrb === 'grok'}
            criticalPctThreshold={Number(alertThreshold)}
            criticalMinThreshold={Number(alertTimerMin)}
            t={t}
            needsSetup={!!data.grok?.needsSetup}
            onNeedsSetup={openDatasourceSettings}
            backendUrl={backendUrl}
            onPopOut={() => { launchWidget('grok'); setHasPoppedOutWidget(true); }}
          />

        </main>

        {!hasPoppedOutWidget && (
          <p className="widget-hint">{t.clickDesktopHint}</p>
        )}

        {/* Team View: 2-3 pinned teammates' usage, LAN-only, opt-in. */}
        <div className="team-panel">
          {pinnedPeers.map(pinned => {
            const live = teamPeersLive.find(p => p.instance_id === pinned.instance_id);
            const providers = live && live.providers;
            const chip = (key) => (
              <span
                key={key}
                className={`team-chip team-chip-${key}${providers && providers[key] && providers[key].critical ? ' critical' : ''}`}
              >
                {providers && providers[key] != null ? `${Math.round(providers[key].remaining_pct)}%` : '···'}
              </span>
            );
            return (
              <div key={pinned.instance_id} className={`team-row${live && live.online ? '' : ' team-row-offline'}`}>
                <span className="team-row-name">{pinned.display_name || 'Teammate'}</span>
                <div className="team-row-chips">
                  {chip('claude')}
                  {chip('codex')}
                  {chip('antigravity')}
                  {chip('grok')}
                </div>
                <button className="team-row-remove" onClick={() => unpinTeamPeer(pinned.instance_id)} title={t.teamRemoveTitle}>×</button>
              </div>
            );
          })}

          <div className="team-panel-actions">
            <button
              className={`team-share-btn${teamSharingEnabled ? ' active' : ''}`}
              onClick={handleShareClick}
              title={t.teamShareTooltip}
            >
              {teamSharingEnabled ? t.teamSharingActive : t.teamShareBtn}
            </button>
            {pinnedPeers.length < 3 && (
              <button
                className="team-add-btn"
                onClick={() => { setShowTeamAdd(v => !v); setShowTeamNamePrompt(false); setTeamManualError(''); }}
              >
                {showTeamAdd ? t.teamCancel : (pinnedPeers.length === 0 ? t.teamAddFirst : t.teamAddMore)}
              </button>
            )}
          </div>

          {showTeamNamePrompt && (
            <div className="team-add-picker">
              <p className="team-add-label">{t.teamNamePrompt}</p>
              <div className="team-add-manual">
                <input
                  className="ando-input"
                  type="text"
                  maxLength={40}
                  placeholder={t.teamNamePromptPlaceholder}
                  value={teamNameDraft}
                  onChange={(e) => setTeamNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmTeamName(); }}
                  autoFocus
                />
                <button className="ando-btn" onClick={confirmTeamName}>{t.teamStartSharing}</button>
              </div>
            </div>
          )}

          {showTeamAdd && (
            <div className="team-add-picker">
              {teamPeersLive
                .filter(p => !pinnedPeers.some(pp => pp.instance_id === p.instance_id))
                .map(p => (
                  <button key={p.instance_id} className="team-add-discovered-item" onClick={() => pinTeamPeer(p)}>
                    {p.display_name} <span className="team-add-discovered-hint">{t.teamFoundOnNetwork}</span>
                  </button>
                ))}
              <div className="team-add-manual">
                <input
                  className="ando-input"
                  type="text"
                  placeholder={t.teamManualPlaceholder}
                  value={teamManualHost}
                  onChange={(e) => setTeamManualHost(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTeamPeerManual(); }}
                />
                <button className="ando-btn" onClick={addTeamPeerManual}>{t.teamAddBtn}</button>
              </div>
              {teamManualError && <p className="team-add-error">{teamManualError}</p>}
            </div>
          )}
        </div>

        {/* Tactile Ando Concrete Bottom Border Accent */}
        <div className="popover-footer-accent">
          <span className="credits-readout">{currentTime}</span>
          {IS_APP_STORE ? (
            <span className="branding-readout">{t.appName}</span>
          ) : (
            <span className="branding-readout branding-link" onClick={() => openUrl('https://aiusageball.com')} title="aiusageball.com">AI Usage Ball</span>
          )}
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

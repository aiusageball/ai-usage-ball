export const formatCountdownHMS = (resetsAtIso, readyLabel = 'READY') => {
  if (!resetsAtIso) return readyLabel;
  try {
    const resetDate = new Date(resetsAtIso);
    const now = new Date();
    const diffMs = resetDate - now;
    if (diffMs <= 0) return readyLabel;

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
  } catch {
    return readyLabel;
  }
};

export const formatClaudePrimaryCountdown = (claude, t) => {
  if (claude?.rate_limit_pct_secondary >= 100 || claude?.status_secondary === 'EXHAUSTED') {
    return t ? t.waitReset : 'WAIT RESET';
  }
  return formatCountdownHMS(claude?.resetsAt, t ? t.ready : 'READY');
};

// A fresh Codex five-hour window has no countdown until the first request is
// made. The backend marks that state explicitly because the API still returns
// a rolling reset_at timestamp while the window is idle.
// When weekly quota is exhausted, the 5-hour window is unusable until weekly reset.
export const formatCodexPrimaryCountdown = (codex, t) => {
  if (codex?.rate_limit_pct_secondary >= 100 || codex?.status_secondary === 'EXHAUSTED') {
    return t ? t.waitReset : 'WAIT RESET';
  }
  if (codex?.primary_window_started === false) return t ? t.readyToGo : 'READY TO GO';
  return formatCountdownHMS(codex?.resetsAt, t ? t.ready : 'READY');
};

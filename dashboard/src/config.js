export const IS_APP_STORE = import.meta.env.VITE_APP_STORE === 'true';
export const APP_VERSION = '0.3.11';

export const CUSTOM_LABELS_STORAGE_KEY = 'aipulse_customLabels';

export function getDefaultOrbLabels(isAppStore = IS_APP_STORE, lang = 'en') {
  if (isAppStore) {
    if (lang === 'zh') {
      return {
        claude: {
          title: '模型 A',
          primary: '会话剩余',
          secondary: '周度剩余',
        },
        codex: {
          title: '代码引擎',
          primary: '引擎剩余',
          secondary: '周度剩余',
        },
        antigravity: {
          title: '工作区',
          primary: '快速配额',
          secondary: '专业配额',
        },
        grok: {
          title: '任务助手',
          primary: '配额剩余',
          secondary: '专业版',
        },
      };
    }
    return {
      claude: {
        title: 'MODEL A',
        primary: 'SESSION',
        secondary: 'WEEKLY',
      },
      codex: {
        title: 'CODE ENGINE',
        primary: 'ENGINE',
        secondary: 'WEEKLY',
      },
      antigravity: {
        title: 'WORKSPACE',
        primary: 'FAST QUOTA',
        secondary: 'PRO QUOTA',
      },
      grok: {
        title: 'TASK BOT',
        primary: 'BOT QUOTA',
        secondary: 'PRO PLAN',
      },
    };
  }

  return {
    claude: {
      title: 'CLAUDE',
      primary: 'CLAUDE REMAINING',
      secondary: 'WEEKLY REMAINING',
    },
    codex: {
      title: 'CODEX',
      primary: 'CODEX REMAINING',
      secondary: 'WEEKLY REMAINING',
    },
    antigravity: {
      title: 'ANTIGRAVITY',
      primary: 'GEMINI REMAINING',
      secondary: 'CLAUDE REMAINING',
    },
    grok: {
      title: 'GROK',
      primary: 'GROK REMAINING',
      secondary: 'GROK BOT',
    },
  };
}

export function getCustomOrbLabels(isAppStore = IS_APP_STORE, lang = 'en') {
  const defaults = getDefaultOrbLabels(isAppStore, lang);
  try {
    const raw = window.localStorage.getItem(CUSTOM_LABELS_STORAGE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return defaults;
    const merged = {};
    for (const key of ['claude', 'codex', 'antigravity', 'grok']) {
      const customTitle = typeof saved[key] === 'string' ? saved[key].trim() : '';
      merged[key] = {
        ...defaults[key],
        title: customTitle || defaults[key].title,
      };
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function getStoredCustomTitles() {
  try {
    const raw = window.localStorage.getItem(CUSTOM_LABELS_STORAGE_KEY);
    if (!raw) return { claude: '', codex: '', antigravity: '', grok: '' };
    const parsed = JSON.parse(raw);
    return {
      claude: typeof parsed?.claude === 'string' ? parsed.claude : '',
      codex: typeof parsed?.codex === 'string' ? parsed.codex : '',
      antigravity: typeof parsed?.antigravity === 'string' ? parsed.antigravity : '',
      grok: typeof parsed?.grok === 'string' ? parsed.grok : '',
    };
  } catch {
    return { claude: '', codex: '', antigravity: '', grok: '' };
  }
}

import { invoke } from '@tauri-apps/api/core';

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000';

// Tauri selects the actual free port before starting the local backend. Keep
// the default for plain-browser development, where the command is unavailable.
export async function resolveBackendUrl() {
  try {
    const url = await invoke('get_backend_url');
    if (typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
      return url;
    }
  } catch {
    // Plain Vite development does not have the Tauri command bridge.
  }
  return DEFAULT_BACKEND_URL;
}

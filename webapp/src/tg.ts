// Общие хелперы Telegram WebApp: подпись запросов к API, haptics, склонения.
// API всегда same-origin (FastAPI отдаёт и статику, и /api; в dev — vite proxy),
// поэтому fetch ходит по относительным путям '/api/...'.

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void;
        close: () => void;
        expand: () => void;
        sendData: (data: string) => void;
        openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
        HapticFeedback: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
        };
        initDataUnsafe?: {
          user?: {
            id?: number;
            first_name?: string;
            last_name?: string;
            username?: string;
            language_code?: string;
          };
        };
        initData?: string;
      };
    };
    __webappUid?: number | null;
    __webappSig?: string | null;
  }
}

// Подпись для GET: initData (HMAC Telegram) + подписанный ботом ?uid=&sig= как фолбэк
// (см. server_api.py:_verify_user_id).
export function buildIdentityParams(): URLSearchParams {
  const params = new URLSearchParams({
    init_data: window.Telegram?.WebApp?.initData ?? ''
  });
  if (window.__webappUid) params.set('webapp_uid', String(window.__webappUid));
  if (window.__webappSig) params.set('webapp_sig', window.__webappSig);
  return params;
}

// Та же подпись для JSON-тела POST-запросов.
export function identityBody() {
  return {
    init_data: window.Telegram?.WebApp?.initData || undefined,
    webapp_uid: window.__webappUid || undefined,
    webapp_sig: window.__webappSig || undefined,
  };
}

export function getUserId(): number | undefined {
  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  return tgUser?.id ?? window.__webappUid ?? undefined;
}

export function triggerHaptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);
}

export function triggerHapticNotification(type: 'error' | 'success' | 'warning') {
  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type);
}

export function getPluralRussian(count: number, one: string, two: string, five: string): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return five;
  if (n1 > 1 && n1 < 5) return two;
  if (n1 === 1) return one;
  return five;
}

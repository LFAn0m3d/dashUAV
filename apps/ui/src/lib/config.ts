interface AppConfig {
  WS_URL?: string;
  HTTP_POLL_URL?: string;
  API_BASE_URL?: string;
  MAPBOX_TOKEN?: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

const defaultConfig: Required<Pick<AppConfig, 'HTTP_POLL_URL'>> & AppConfig = {
  HTTP_POLL_URL: '/api/events',
};

type ResolvedAppConfig = AppConfig & Required<Pick<AppConfig, 'HTTP_POLL_URL'>>;

export function getAppConfig(): ResolvedAppConfig {
  return {
    ...defaultConfig,
    ...(typeof window !== 'undefined' ? window.__APP_CONFIG__ : undefined),
  };
}

export type { AppConfig };
export type { ResolvedAppConfig };

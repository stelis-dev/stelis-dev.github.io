import { parseAppWebEnvironment } from './environment';

/** One validated build-time environment snapshot for every app-web consumer. */
export const APP_WEB_ENVIRONMENT = parseAppWebEnvironment(import.meta.env);

export const APP_WEB_RELAY_API_BASE = APP_WEB_ENVIRONMENT.relayApiBase;

import { parseAppAdminEnvironment } from './environment';

/** Dev uses the Vite proxy; production uses the one validated Host origin. */
export const APP_ADMIN_API_BASE = import.meta.env.DEV
  ? ''
  : parseAppAdminEnvironment(import.meta.env).apiBase;

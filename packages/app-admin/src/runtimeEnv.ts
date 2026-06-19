export type AppAdminNetwork = 'testnet' | 'mainnet';

function readRequiredEnv(key: 'VITE_SUI_RPC_URL'): string {
  const raw = import.meta.env[key];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value) return value;

  throw new Error(
    `[app-admin] Missing required env ${key}. Set it in packages/app-admin/.env (see .env.example).`,
  );
}

export const APP_ADMIN_SUI_RPC_URL = readRequiredEnv('VITE_SUI_RPC_URL');

/**
 * @stelis/core-api/studio — Studio platform domain types.
 *
 * Framework-agnostic domain types and interfaces.
 * Runtime host types (singleton, env, boot) remain in the host application.
 */
import type { HostContext } from '../context.js';
import type { PrepareHandlerConfig } from '../handlers/prepare.js';

/**
 * Studio host context — extends the base HostContext with studio-specific domain.
 *
 * Type definition is domain (`core-api`).
 * Singleton creation, env, and boot remain runtime concerns (`app-api`).
 */
export type StudioHostContext = HostContext & {
  prepareConfig: PrepareHandlerConfig;
};

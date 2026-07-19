import type { PrepareRequestAdmission } from '../src/handlers/prepare.js';

/** Successful Host-owned sponsor-capacity admission for tests outside that boundary. */
export const ALLOW_PREPARE_REQUEST: PrepareRequestAdmission = Object.freeze({
  async assertSponsorAvailable(): Promise<void> {},
});

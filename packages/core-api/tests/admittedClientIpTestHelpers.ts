import { admitClientIp, type AdmittedClientIp } from '../src/abuseBlocking.js';
import type { AbuseBlockerAdapter } from '../src/store/abuseBlockTypes.js';

/** Test tokens still pass through the production successful-IP-check gate. */
export async function admitTestClientIp(
  blocker: AbuseBlockerAdapter,
  ip = '127.0.0.1',
): Promise<AdmittedClientIp> {
  const result = await admitClientIp(blocker, ip);
  if (result.blocked) throw new Error(`Test IP ${ip} was unexpectedly blocked`);
  return result.admittedClientIp;
}

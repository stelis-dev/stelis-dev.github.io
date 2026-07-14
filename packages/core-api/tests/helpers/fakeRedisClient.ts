import type { RedisClientLike } from '../../src/store/redisClient.js';

type RedisSetOptions = Parameters<RedisClientLike['set']>[2];

interface FakeRedisEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * Minimal in-memory Redis implementation for adapter unit tests.
 *
 * It intentionally supports only the subset used by Stelis adapters:
 * `GET`, `SET NX PX`, `DEL`, `HGETALL`, `SCAN`, and the small Lua scripts
 * embedded in the Redis-backed stores. Counter and TTL mutations inside Lua
 * scripts are emulated by private helpers, not exposed on RedisClientLike.
 *
 * This is not production Redis semantics evidence. Real Redis conformance
 * lives in `*.redis.test.ts` and runs through `test:redis`.
 */
export class FakeRedisClient implements RedisClientLike {
  private readonly _store = new Map<string, FakeRedisEntry>();

  async get(key: string): Promise<string | null> {
    this.evictIfExpired(key);
    return this._store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    this.evictIfExpired(key);
    const exists = this._store.has(key);

    if (options?.nx && exists) return null;
    if (options?.xx && !exists) return null;

    this._store.set(key, {
      value,
      expiresAt: options?.px != null ? Date.now() + options.px : null,
    });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      this.evictIfExpired(key);
      if (this._store.delete(key)) deleted += 1;
    }
    return deleted;
  }

  private incrementForLua(key: string): number {
    this.evictIfExpired(key);
    const entry = this._store.get(key);
    const current = entry ? Number(entry.value) : 0;
    const next = current + 1;
    this._store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? null,
    });
    return next;
  }

  private setExpiryForLua(key: string, ttlMs: number): boolean {
    this.evictIfExpired(key);
    const entry = this._store.get(key);
    if (!entry) return false;
    entry.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    // ── RedisSponsorPool LEASE_STATUS_SCRIPT emulation ──
    // Reads lease-key presence for all configured sponsor slots and returns
    // the same positional rows as the production Lua script.
    if (script.includes('RedisSponsorPool LEASE_STATUS_SCRIPT')) {
      let leasedSlots = 0;
      const rows: string[][] = [];
      for (let i = 0; i < keys.length; i++) {
        const value = await this.get(keys[i]!);
        const leased = value !== null;
        if (leased) leasedSlots += 1;
        rows.push([args[i] ?? '', leased ? '1' : '0']);
      }
      return [String(leasedSlots), rows];
    }

    // ── RedisSponsorPool LEASE_CHECKOUT_SCRIPT emulation ──
    // Tries rotated lease keys in order and returns the first reserved
    // slot address plus its one-based offset, matching the production Lua
    // response used to advance RedisSponsorPool's local cursor.
    if (script.includes('RedisSponsorPool LEASE_CHECKOUT_SCRIPT')) {
      const ttlMs = Number(args[0]);
      const slotCount = keys.length;
      for (let i = 0; i < slotCount; i++) {
        const slotAddress = args[1 + i];
        const reservedProof = args[1 + slotCount + i];
        if (slotAddress === undefined || reservedProof === undefined) continue;
        const result = await this.set(keys[i]!, reservedProof, { nx: true, px: ttlMs });
        if (result === 'OK') {
          return [slotAddress, String(i + 1)];
        }
      }
      return null;
    }

    // ── Sponsor operations state updateEntityLuaScript emulation ──
    // Distinct marker: the script stamps both `lastObservedAtMs` via TIME
    // and `writeSeq` via HINCRBY, then applies caller-supplied field/value
    // pairs from ARGV. Emulate the monotonic-seq + server-time contract
    // exactly: each call increments the entity's writeSeq and refreshes
    // lastObservedAtMs.
    if (
      script.includes("redis.call('TIME')") &&
      script.includes('HINCRBY') &&
      script.includes('writeSeq')
    ) {
      const key = keys[0];
      const nowMs = String(Date.now());
      const nextSeq = this._hashIncr(key, 'writeSeq', 1);
      this._hashSet(key, 'lastObservedAtMs', nowMs);
      for (let i = 0; i < args.length; i += 2) {
        const field = args[i];
        const value = args[i + 1];
        if (field !== undefined && value !== undefined) {
          this._hashSet(key, field, value);
        }
      }
      return [nowMs, String(nextSeq)];
    }

    if (script.includes("redis.call('INCR'")) {
      const key = keys[0];
      const ttlMs = Number(args[0]);
      const current = this.incrementForLua(key);
      if (current === 1) {
        this.setExpiryForLua(key, ttlMs);
      }
      const ttl = this.pttl(key);
      return [current, ttl];
    }

    // ── RedisSponsorPool LEASE_COMMIT_CAS_SCRIPT emulation ──
    // if GET == reserved → SET committed with PX; else LEASE_MISSING/CAS_FAILED.
    if (script.includes("return 'LEASE_COMMIT_CAS_FAILED'")) {
      const key = keys[0];
      const reservedProof = args[0];
      const committedProof = args[1];
      const pxMs = Number(args[2]);
      const current = await this.get(key);
      if (current === null) return 'LEASE_MISSING';
      if (current !== reservedProof) return 'LEASE_COMMIT_CAS_FAILED';
      await this.set(key, committedProof, { px: pxMs });
      return 'OK';
    }

    // ── RedisSponsorPool LEASE_CHECKIN_CAS_SCRIPT emulation ──
    // if GET == expected → DEL; else MISMATCH.
    if (script.includes("return 'MISMATCH'")) {
      const key = keys[0];
      const expected = args[0];
      const current = await this.get(key);
      if (current === expected) {
        await this.del(key);
        return 'OK';
      }
      return 'MISMATCH';
    }

    if (
      script.includes("redis.call('GET', KEYS[1])") &&
      script.includes("redis.call('DEL', KEYS[1])") &&
      !script.includes('cjson.decode')
    ) {
      const value = await this.get(keys[0]);
      if (value !== null) {
        await this.del(keys[0]);
      }
      if (keys[1]) {
        await this.del(keys[1]);
      }
      return value;
    }

    // ── RedisPrepareStore CHECK_USER_QUOTA_SCRIPT emulation ──
    // Mirrors STORE_SCRIPT's `liveUser` semantics so the precheck and
    // the authoritative store-time quota agree on which entries count
    // when reading the same Redis snapshot (concurrent stores between
    // precheck and store() can still diverge — STORE_SCRIPT is the
    // only authoritative gate). Logical TTL (`item.t + ttlMs < nowMs`)
    // drops an entry even while its physical key survives in the PX
    // grace window.
    if (script.includes('if not userRaw then return 0 end')) {
      const userKey = keys[0];
      const prefix = args[0] ?? '';
      const ttlMs = Number(args[1] ?? '60000');
      const maxPerStudioUser = Number(args[2] ?? '0');
      const nowMs = Date.now();

      const userRaw = userKey ? await this.get(userKey) : null;
      if (!userRaw) return 0;

      const userList = JSON.parse(userRaw) as Array<Record<string, unknown>>;
      let live = 0;
      for (const item of userList) {
        const t = item['t'];
        if (typeof t === 'number' && t + ttlMs < nowMs) continue;
        const exists = await this.get(prefix + String(item['pid']));
        if (exists !== null) {
          live += 1;
          if (live >= maxPerStudioUser) return live;
        }
      }
      return live;
    }

    // ── RedisPrepareStore STORE_SCRIPT emulation ──
    if (script.includes('RedisPrepareStore STORE_SCRIPT')) {
      const entryKey = keys[0];
      const ipKey = keys[1];
      const senderKey = keys[2];
      const userKey = keys[3] ?? '';
      const draftJson = args[0] ?? '';
      const entryPx = Number(args[1]);
      const maxPerIp = Number(args[2]);
      const ipPx = Number(args[3]);
      const prefix = args[4] ?? '';
      const maxPerStudioUser = Number(args[5]);
      const senderPx = Number(args[6]);
      const ttlMs = Number(args[7] ?? '60000');
      const userPx = Number(args[8] ?? '120000');
      const nowMs = Date.now();
      const issuedAt = nowMs;

      const draft = JSON.parse(draftJson) as Record<string, unknown>;
      const pid = draft.receiptId;
      const nonce = draft.nonce;
      const entryMode = draft.mode;
      if (
        typeof pid !== 'string' ||
        typeof nonce !== 'string' ||
        (entryMode !== 'generic' && entryMode !== 'promotion')
      ) {
        throw new Error('invalid prepared draft');
      }

      // ── Sender index — live-compact regardless of mode (S-14 nonce coordination) ──
      const senderRaw = senderKey ? await this.get(senderKey) : null;
      let senderList: Array<Record<string, unknown>> = [];
      if (senderRaw) {
        senderList = JSON.parse(senderRaw) as typeof senderList;
      }
      const liveSender: Array<Record<string, unknown>> = [];
      for (const item of senderList) {
        if (
          typeof item.pid === 'string' &&
          typeof item.t === 'number' &&
          typeof item.nonce === 'string'
        ) {
          if (item.pending === true) {
            if (item.t + ttlMs >= nowMs) {
              liveSender.push({
                pid: item.pid,
                nonce: item.nonce,
                pending: true,
                t: item.t,
              });
            }
          } else if (item.pending === undefined) {
            if (item.t + ttlMs < nowMs) {
              // Logical TTL expired — drop even if physical key still exists
            } else {
              const exists = await this.get(prefix + item.pid);
              if (exists !== null) {
                liveSender.push({ pid: item.pid, nonce: item.nonce, t: item.t });
              }
            }
          }
        }
      }

      // ── Studio user quota — promotion-mode only, keyed by userIndex ──
      const liveUser: Array<Record<string, unknown>> = [];
      if (entryMode === 'promotion' && userKey !== '') {
        const userRaw = await this.get(userKey);
        if (userRaw) {
          const userList = JSON.parse(userRaw) as Array<Record<string, unknown>>;
          for (const item of userList) {
            const t = item['t'];
            const itemPid = item['pid'];
            if (typeof t !== 'number' || typeof itemPid !== 'string') continue;
            if (t + ttlMs < nowMs) continue;
            const exists = await this.get(prefix + itemPid);
            if (exists !== null) liveUser.push({ pid: itemPid, t });
          }
        }
        if (liveUser.length >= maxPerStudioUser) {
          return '__user_quota__';
        }
      }

      // Read and decode the IP index before any mutation. This ordering is
      // the branch-parity evidence for the real Lua no-partial-commit guard.
      const ipRaw = await this.get(ipKey);
      let list: Array<{ pid: string; t: number }> = [];
      if (ipRaw) {
        list = JSON.parse(ipRaw) as typeof list;
      }

      // Prune stale entries
      const live: typeof list = [];
      for (const item of list) {
        if (typeof item.pid !== 'string' || typeof item.t !== 'number') continue;
        const exists = await this.get(prefix + item.pid);
        if (exists !== null) {
          live.push({ pid: item.pid, t: item.t });
        }
      }

      // Evict oldest if over limit
      const evicted: Array<{ pid: string; entryJson: string }> = [];
      while (live.length >= maxPerIp) {
        const oldest = live.shift()!;
        const evictedEntryJson = (await this.get(prefix + oldest.pid)) ?? '';
        evicted.push({ pid: oldest.pid, entryJson: evictedEntryJson });
      }

      // Construct every stored/result projection before the first mutation.
      live.push({ pid, t: issuedAt });

      const evictedPids = new Set(evicted.map((e) => e.pid));
      const updatedSender = liveSender.filter((item) => {
        const itemPid = (item as Record<string, unknown>).pid;
        return itemPid !== pid && !evictedPids.has(itemPid as string);
      });
      updatedSender.push({ pid, t: issuedAt, nonce });

      let updatedUser: Array<Record<string, unknown>> | null = null;
      if (entryMode === 'promotion' && userKey !== '') {
        updatedUser = liveUser.filter((item) => {
          const itemPid = item['pid'];
          return itemPid !== pid && !evictedPids.has(itemPid as string);
        });
        updatedUser.push({ pid, t: issuedAt });
      }

      const committedJson = JSON.stringify({ ...draft, issuedAt });
      const encodedIp = JSON.stringify(live);
      const encodedSender = JSON.stringify(updatedSender);
      const encodedUser = updatedUser ? JSON.stringify(updatedUser) : null;
      const encodedEvicted = JSON.stringify(evicted);

      // Mutation section mirrors the production Lua after all fallible
      // data-derived work has completed.
      for (const item of evicted) {
        await this.del(prefix + item.pid);
      }
      await this.set(entryKey, committedJson, { px: entryPx });
      await this.set(ipKey, encodedIp, { px: ipPx });
      if (senderKey) {
        await this.set(senderKey, encodedSender, { px: senderPx });
      }
      if (encodedUser !== null) {
        await this.set(userKey, encodedUser, { px: userPx });
      }

      return [String(issuedAt), encodedEvicted];
    }

    // ── RedisPrepareStore PEEK_SCRIPT emulation ──
    if (script.includes('RedisPrepareStore PEEK_SCRIPT')) {
      const raw = await this.get(keys[0]);
      if (!raw) return null;
      let entry: unknown;
      try {
        entry = JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return raw;
      const issuedAt = (entry as Record<string, unknown>).issuedAt;
      if (typeof issuedAt !== 'number') return raw;
      const ttlMs = Number(args[0] ?? '60000');
      return issuedAt + ttlMs < Date.now() ? null : raw;
    }

    // ── RedisPrepareStore reserveNonce emulation (sender-local, no HWM key) ──
    if (script.includes('compareDecStrings') && script.includes('addOneDecString')) {
      const senderKey = keys[0];
      const onchain = BigInt(args[0] ?? '0');
      const resId = args[1] ?? '';
      const senderPx = Number(args[2] ?? '120000');
      const prefix = args[3] ?? '';
      const reserveTtlMs = Number(args[4] ?? '60000');
      const maxOutstandingPerSender = Number(args[5] ?? '3');
      const reserveNowMs = Date.now();

      // Compact: keep non-expired pending + logically-live entries only (same as real Lua)
      let senderMax = 0n;
      const senderRaw = senderKey ? await this.get(senderKey) : null;
      const rawList: Array<Record<string, unknown>> = senderRaw ? JSON.parse(senderRaw) : [];
      const senderList: Array<Record<string, unknown>> = [];
      for (const item of rawList) {
        if (
          typeof item.pid === 'string' &&
          typeof item.t === 'number' &&
          typeof item.nonce === 'string'
        ) {
          const nonce = BigInt(item.nonce);
          if (item.pending === true) {
            if (item.t + reserveTtlMs >= reserveNowMs) {
              senderList.push({
                pid: item.pid,
                nonce: nonce.toString(),
                pending: true,
                t: item.t,
              });
              if (nonce > senderMax) senderMax = nonce;
            }
          } else if (item.pending === undefined) {
            if (item.t + reserveTtlMs < reserveNowMs) {
              // Logical TTL expired — drop
            } else {
              const exists = await this.get(prefix + item.pid);
              if (exists !== null) {
                senderList.push({ pid: item.pid, nonce: nonce.toString(), t: item.t });
                if (nonce > senderMax) senderMax = nonce;
              }
            }
          }
        }
      }

      if (senderList.length >= maxOutstandingPerSender) {
        return '__sender_quota__';
      }

      const next = (onchain > senderMax ? onchain : senderMax) + 1n;

      // Add pending reservation to sender-local metadata
      senderList.push({ pid: resId, nonce: next.toString(), pending: true, t: reserveNowMs });
      await this.set(senderKey, JSON.stringify(senderList), { px: senderPx });

      return next.toString();
    }

    // ── RedisPrepareStore EVICT_PREPARED_ENTRY_SCRIPT emulation ──
    if (script.includes('local function rewriteList') && script.includes('return raw')) {
      const entryKey = keys[0];
      const pid = args[0] ?? '';
      const prefix = args[1] ?? '';
      const ttlMs = Number(args[2] ?? '60000');
      const raw = await this.get(entryKey);
      if (raw === null) return null;
      await this.del(entryKey);

      let entry: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return raw;
        entry = parsed as Record<string, unknown>;
      } catch {
        return raw;
      }

      const nowMs = Date.now();
      const rewriteList = async (key: string, indexKind: 'ip' | 'sender' | 'user') => {
        const listRaw = await this.get(key);
        if (!listRaw) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(listRaw) as unknown;
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const list = Array.isArray(parsed) ? parsed : [];
        const updated: Array<Record<string, unknown>> = [];
        for (const candidate of list) {
          if (typeof candidate !== 'object' || candidate === null) continue;
          const item = candidate as Record<string, unknown>;
          if (typeof item.pid !== 'string' || typeof item.t !== 'number') continue;
          if (item.pid === pid) continue;
          if (indexKind === 'sender') {
            if (item.pending === true && typeof item.nonce === 'string') {
              if (item.t + ttlMs >= nowMs) {
                updated.push({ pid: item.pid, nonce: item.nonce, pending: true, t: item.t });
              }
            } else if (item.pending === undefined && typeof item.nonce === 'string') {
              if (item.t + ttlMs < nowMs) {
                // Logical TTL expired — drop
              } else if ((await this.get(prefix + item.pid)) !== null) {
                updated.push({ pid: item.pid, nonce: item.nonce, t: item.t });
              }
            }
          } else {
            if (item.t + ttlMs < nowMs) {
              // Logical TTL expired — drop
            } else if ((await this.get(prefix + item.pid)) !== null) {
              updated.push({ pid: item.pid, t: item.t });
            }
          }
        }
        if (updated.length === 0) {
          await this.del(key);
        } else {
          const currentTtl = this.pttl(key);
          await this.set(
            key,
            JSON.stringify(updated),
            currentTtl > 0 ? { px: currentTtl } : undefined,
          );
        }
      };

      if (typeof entry.clientIp === 'string') {
        await rewriteList(prefix + 'ip:' + entry.clientIp, 'ip').catch(() => {});
      }
      if (typeof entry.senderAddress === 'string') {
        await rewriteList(prefix + 'sender:' + entry.senderAddress, 'sender').catch(() => {});
      }
      if (entry.mode === 'promotion' && typeof entry.userId === 'string') {
        await rewriteList(prefix + 'user:' + entry.userId, 'user').catch(() => {});
      }

      return raw;
    }

    // ── RedisPrepareStore releaseReservation emulation ──
    if (
      script.includes('item.pending and item.pid == resId') ||
      (script.includes('resId') &&
        script.includes('updated') &&
        !script.includes('addOneDecString'))
    ) {
      const senderKey = keys[0];
      const resId = args[0] ?? '';
      const senderPx = Number(args[1] ?? '120000');

      const senderRaw = await this.get(senderKey);
      if (!senderRaw) return 0;

      const senderList = JSON.parse(senderRaw) as Array<Record<string, unknown>>;
      // Drop only the matching pending reservation. Live entries (no
      // `pending` flag) are preserved even when their `pid` matches, so
      // a post-store call cannot damage the promoted live entry's
      // metadata. Mirrors the real Lua script in redisPrepareStore.ts.
      const updated: Array<Record<string, unknown>> = [];
      for (const item of senderList) {
        if (
          typeof item.pid !== 'string' ||
          typeof item.t !== 'number' ||
          typeof item.nonce !== 'string'
        ) {
          continue;
        }
        if (item.pending === true) {
          if (item.pid !== resId) {
            updated.push({ pid: item.pid, nonce: item.nonce, pending: true, t: item.t });
          }
        } else if (item.pending === undefined) {
          updated.push({ pid: item.pid, nonce: item.nonce, t: item.t });
        }
      }

      if (updated.length === 0) {
        await this.del(senderKey);
      } else {
        await this.set(senderKey, JSON.stringify(updated), { px: senderPx });
      }
      return 1;
    }

    // ── RedisPrepareStore CONSUME_SCRIPT_WITH_IP emulation ──
    if (script.includes('__expired_entry__') && script.includes('__hash_mismatch_entry__')) {
      const entryKey = keys[0];
      const expectedHash = args[0];
      const ttlMs = Number(args[1]);
      const pid = args[2];
      const prefix = args[3];

      const raw = await this.get(entryKey);
      if (raw === null) return null;

      let entry: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
          entry = parsed as Record<string, unknown>;
        }
      } catch {
        // Real Lua deletes malformed JSON and returns the raw value so the
        // TypeScript layer can run its best-effort lease recovery.
      }

      const nowMs = Date.now();

      const removeFromIndex = async (key: string, indexKind: 'ip' | 'sender') => {
        const indexRaw = await this.get(key);
        if (!indexRaw) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(indexRaw) as unknown;
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const list = Array.isArray(parsed) ? parsed : [];
        const updated: Array<Record<string, unknown>> = [];
        for (const candidate of list) {
          if (typeof candidate !== 'object' || candidate === null) continue;
          const item = candidate as Record<string, unknown>;
          if (typeof item.pid !== 'string' || item.pid === pid || typeof item.t !== 'number') {
            continue;
          }
          if (indexKind === 'sender') {
            if (item.pending === true && typeof item.nonce === 'string') {
              updated.push({ pid: item.pid, nonce: item.nonce, pending: true, t: item.t });
            } else if (item.pending === undefined && typeof item.nonce === 'string') {
              updated.push({ pid: item.pid, nonce: item.nonce, t: item.t });
            }
          } else {
            updated.push({ pid: item.pid, t: item.t });
          }
        }
        if (updated.length > 0) {
          const currentTtl = this.pttl(key);
          await this.set(
            key,
            JSON.stringify(updated),
            currentTtl > 0 ? { px: currentTtl } : undefined,
          );
        } else {
          await this.del(key);
        }
      };

      let resultKind: 'success' | 'expired' | 'hash_mismatch' = 'success';
      if (entry && typeof entry.issuedAt === 'number' && entry.issuedAt + ttlMs < nowMs) {
        resultKind = 'expired';
      } else if (
        entry &&
        typeof entry.txBytesHash === 'string' &&
        entry.txBytesHash !== expectedHash
      ) {
        resultKind = 'hash_mismatch';
      }

      await this.del(entryKey);
      if (entry && typeof entry.clientIp === 'string') {
        await removeFromIndex(prefix + 'ip:' + entry.clientIp, 'ip').catch(() => {});
      }
      if (entry && typeof entry.senderAddress === 'string') {
        await removeFromIndex(prefix + 'sender:' + entry.senderAddress, 'sender').catch(() => {});
      }

      if (resultKind === 'expired') return '__expired_entry__:' + raw;
      if (resultKind === 'hash_mismatch') return '__hash_mismatch_entry__:' + raw;
      return raw;
    }

    // ── PromotionStore CREATE_LUA emulation ──
    if (
      script.includes("redis.call('EXISTS', KEYS[1])") &&
      script.includes("redis.call('SADD', KEYS[2], ARGV[2])") &&
      script.includes("redis.call('SADD', KEYS[3], ARGV[2])")
    ) {
      if ((await this.get(keys[0])) !== null) return 'CURRENT_CONFLICT';
      await this.set(keys[0], args[0]);
      this._sadd(keys[1], args[1]);
      this._sadd(keys[2], args[1]);
      return 'OK';
    }

    // ── PromotionStore LIST_LUA emulation ──
    if (
      script.includes("redis.call('SMEMBERS', KEYS[1])") &&
      script.includes("redis.call('MGET', unpack(keys))")
    ) {
      const ids = this._smembers(keys[0]);
      if (ids.length === 0) return [];
      const results: (string | null)[] = [];
      for (const id of ids) {
        results.push(await this.get(args[0] + id));
      }
      return results;
    }

    // ── PromotionStore UPDATE_LUA (exact-record CAS) emulation ──
    if (
      script.includes('currentRaw ~= ARGV[1]') &&
      script.includes("redis.call('SET', KEYS[1], ARGV[2])") &&
      !script.includes("redis.call('SREM', KEYS[2], ARGV[3])")
    ) {
      const raw = await this.get(keys[0]);
      if (raw === null || raw !== args[0]) return 'CURRENT_CONFLICT';
      await this.set(keys[0], args[1]);
      return 'OK';
    }

    // ── PromotionStore STATUS_LUA (record CAS + index move) emulation ──
    if (
      script.includes('currentRaw ~= ARGV[1]') &&
      script.includes("redis.call('SET', KEYS[1], ARGV[2])") &&
      script.includes("redis.call('SREM', KEYS[2], ARGV[3])") &&
      script.includes("redis.call('SADD', KEYS[3], ARGV[3])")
    ) {
      const raw = await this.get(keys[0]);
      if (raw === null || raw !== args[0]) return 'CURRENT_CONFLICT';
      await this.set(keys[0], args[1]);
      this._srem(keys[1], args[2]);
      this._sadd(keys[2], args[2]);
      return 'OK';
    }

    // ── PromotionStore DELETE_LUA emulation ──
    if (
      script.includes("current.status ~= 'draft'") &&
      script.includes("redis.call('DEL', KEYS[1])") &&
      script.includes("redis.call('SREM', KEYS[2], ARGV[2])") &&
      script.includes("redis.call('SREM', KEYS[3], ARGV[2])")
    ) {
      const raw = await this.get(keys[0]);
      if (raw === null) return args[0] === '' ? 'NOT_FOUND' : 'CURRENT_CONFLICT';
      if (args[0] === '' || raw !== args[0]) return 'CURRENT_CONFLICT';
      const current = JSON.parse(raw) as { status?: string };
      if (current.status !== 'draft') return 'NOT_DELETABLE';
      await this.del(keys[0]);
      this._srem(keys[1], args[1]);
      this._srem(keys[2], args[1]);
      return 'OK';
    }

    throw new Error(`FakeRedisClient: unsupported eval script\n${script}`);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this._hashes.get(key);
    if (!h) return {};
    const result: Record<string, string> = {};
    for (const [field, value] of h.entries()) {
      result[field] = value;
    }
    return result;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<void> {
    this._store.clear();
  }

  async scan(pattern: string, _count?: number): Promise<string[]> {
    // Convert Redis MATCH glob to regex (supports only * and ?)
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`);
    const results: string[] = [];
    for (const key of this._store.keys()) {
      this.evictIfExpired(key);
      if (this._store.has(key) && regex.test(key)) {
        results.push(key);
      }
    }
    return results;
  }

  private pttl(key: string): number {
    this.evictIfExpired(key);
    const entry = this._store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt == null) return -1;
    return Math.max(entry.expiresAt - Date.now(), 0);
  }

  private evictIfExpired(key: string): void {
    const entry = this._store.get(key);
    if (!entry?.expiresAt) return;
    if (entry.expiresAt <= Date.now()) {
      this._store.delete(key);
    }
  }

  // ── Redis SET data structure emulation ──────────────────────────────

  private readonly _sets = new Map<string, Set<string>>();

  /** SADD equivalent — add member to a set. */
  private _sadd(key: string, member: string): void {
    let s = this._sets.get(key);
    if (!s) {
      s = new Set<string>();
      this._sets.set(key, s);
    }
    s.add(member);
  }

  /** SMEMBERS equivalent — return all members of a set. */
  private _smembers(key: string): string[] {
    const s = this._sets.get(key);
    return s ? Array.from(s) : [];
  }

  /** SREM equivalent — remove member from a set. */
  private _srem(key: string, member: string): void {
    const s = this._sets.get(key);
    if (s) {
      s.delete(member);
      if (s.size === 0) this._sets.delete(key);
    }
  }

  // ── Redis HASH data structure emulation ─────────────────────────────

  private readonly _hashes = new Map<string, Map<string, string>>();

  /** HSET equivalent — set a field on a hash. */
  private _hashSet(key: string, field: string, value: string): void {
    let h = this._hashes.get(key);
    if (!h) {
      h = new Map<string, string>();
      this._hashes.set(key, h);
    }
    h.set(field, value);
  }

  /** HINCRBY equivalent — increment a numeric field atomically. */
  private _hashIncr(key: string, field: string, delta: number): number {
    let h = this._hashes.get(key);
    if (!h) {
      h = new Map<string, string>();
      this._hashes.set(key, h);
    }
    const current = Number(h.get(field) ?? '0');
    const next = current + delta;
    h.set(field, String(next));
    return next;
  }
}

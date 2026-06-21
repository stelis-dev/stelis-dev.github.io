import type { RedisClientLike, RedisSetOptions } from '../../src/store/redisClient.js';

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
    if (script.includes('cjson.encode(evicted)')) {
      const entryKey = keys[0];
      const ipKey = keys[1];
      const senderKey = keys[2];
      const userKey = keys[3] ?? '';
      const entryJson = args[0];
      const entryPx = Number(args[1]);
      const pid = args[2];
      const slotId = args[3];
      const issuedAt = Number(args[4]);
      const maxPerIp = Number(args[5]);
      const ipPx = Number(args[6]);
      const prefix = args[7];
      const maxPerStudioUser = Number(args[8]);
      const senderPx = Number(args[9]);
      const nonce = args[10] ?? '0';
      const entryMode = args[11] ?? 'generic';
      const ttlMs = Number(args[12] ?? '60000');
      const userPx = Number(args[13] ?? '120000');
      const nowMs = Date.now();

      // ── Sender index — live-compact regardless of mode (S-14 nonce coordination) ──
      const senderRaw = senderKey ? await this.get(senderKey) : null;
      let senderList: Array<{
        pid: string;
        slotId: string;
        t: number;
        nonce: string;
      }> = [];
      if (senderRaw) {
        senderList = JSON.parse(senderRaw) as typeof senderList;
      }
      const liveSender: Array<Record<string, unknown>> = [];
      for (const item of senderList) {
        if ((item as Record<string, unknown>).pending) {
          const t = (item as Record<string, unknown>).t;
          if (typeof t === 'number' && t + ttlMs >= nowMs) {
            liveSender.push(item);
          }
        } else if (
          typeof (item as Record<string, unknown>).t === 'number' &&
          ((item as Record<string, unknown>).t as number) + ttlMs < nowMs
        ) {
          // Logical TTL expired — drop even if physical key still exists
        } else {
          const exists = await this.get(prefix + (item as Record<string, unknown>).pid);
          if (exists !== null) {
            liveSender.push(item);
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
            if (typeof t === 'number' && t + ttlMs < nowMs) continue;
            const exists = await this.get(prefix + (item['pid'] as string));
            if (exists !== null) liveUser.push(item);
          }
        }
        if (liveUser.length >= maxPerStudioUser) {
          return '__user_quota__';
        }
      }

      // SET entry with PX
      await this.set(entryKey, entryJson, { px: entryPx });

      // Read IP index
      const ipRaw = await this.get(ipKey);
      let list: Array<{ pid: string; slotId: string; t: number }> = [];
      if (ipRaw) {
        list = JSON.parse(ipRaw) as typeof list;
      }

      // Prune stale entries
      const live: typeof list = [];
      for (const item of list) {
        const exists = await this.get(prefix + item.pid);
        if (exists !== null) {
          live.push(item);
        }
      }

      // Evict oldest if over limit
      const evicted: Array<{ pid: string; slotId: string; entryJson: string }> = [];
      while (live.length >= maxPerIp) {
        const oldest = live.shift()!;
        const evictedEntryJson = (await this.get(prefix + oldest.pid)) ?? '';
        await this.del(prefix + oldest.pid);
        evicted.push({
          pid: oldest.pid,
          slotId: oldest.slotId,
          entryJson: evictedEntryJson,
        });
      }

      // Add new entry to IP index
      live.push({ pid, slotId, t: issuedAt });
      await this.set(ipKey, JSON.stringify(live), { px: ipPx });

      // Update sender index: remove pending for this pid + evicted pids, add live entry
      const evictedPids = new Set(evicted.map((e) => e.pid));
      const updatedSender = liveSender.filter((item) => {
        const itemPid = (item as Record<string, unknown>).pid;
        return itemPid !== pid && !evictedPids.has(itemPid as string);
      });
      updatedSender.push({ pid, slotId, t: issuedAt, nonce });
      if (senderKey) {
        await this.set(senderKey, JSON.stringify(updatedSender), { px: senderPx });
      }

      // Update user index for promotion entries (Studio outstanding-prepare quota).
      if (entryMode === 'promotion' && userKey !== '') {
        const updatedUser = liveUser.filter((item) => {
          const itemPid = item['pid'];
          return itemPid !== pid && !evictedPids.has(itemPid as string);
        });
        updatedUser.push({ pid, t: issuedAt });
        await this.set(userKey, JSON.stringify(updatedUser), { px: userPx });
      }

      return JSON.stringify(evicted);
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
        if (item.pending) {
          if (typeof item.t === 'number' && item.t + reserveTtlMs >= reserveNowMs) {
            senderList.push(item);
            if (item.nonce != null) {
              const nonce = BigInt(item.nonce as string);
              if (nonce > senderMax) senderMax = nonce;
            }
          }
        } else if (typeof item.t === 'number' && (item.t as number) + reserveTtlMs < reserveNowMs) {
          // Logical TTL expired — drop
        } else if (item.pid && prefix) {
          const exists = await this.get(prefix + String(item.pid));
          if (exists !== null) {
            senderList.push(item);
            if (item.nonce != null) {
              const nonce = BigInt(item.nonce as string);
              if (nonce > senderMax) senderMax = nonce;
            }
          }
        } else if (item.nonce != null) {
          // No prefix provided — keep item
          senderList.push(item);
          const nonce = BigInt(item.nonce as string);
          if (nonce > senderMax) senderMax = nonce;
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
        entry = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return raw;
      }

      const nowMs = Date.now();
      const rewriteList = async (key: string) => {
        const listRaw = await this.get(key);
        if (!listRaw) return;
        let list: Array<Record<string, unknown>>;
        try {
          list = JSON.parse(listRaw) as Array<Record<string, unknown>>;
        } catch {
          return;
        }
        const updated: Array<Record<string, unknown>> = [];
        for (const item of list) {
          if (item.pid === pid) continue;
          if (item.pending) {
            if (typeof item.t === 'number' && item.t + ttlMs >= nowMs) {
              updated.push(item);
            }
          } else if (typeof item.t === 'number' && item.t + ttlMs < nowMs) {
            // Logical TTL expired — drop
          } else if (item.pid && (await this.get(prefix + String(item.pid))) !== null) {
            updated.push(item);
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
        await rewriteList(prefix + 'ip:' + entry.clientIp);
      }
      if (typeof entry.senderAddress === 'string') {
        await rewriteList(prefix + 'sender:' + entry.senderAddress);
      }
      if (entry.mode === 'promotion' && typeof entry.userId === 'string') {
        await rewriteList(prefix + 'user:' + entry.userId);
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
      const updated = senderList.filter((item) => !(item.pending && item.pid === resId));

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

      const entry = JSON.parse(raw) as {
        issuedAt: number;
        txBytesHash: string;
        slotId: string;
        clientIp: string;
        senderAddress: string;
        receiptId: string;
      };
      const ipKey = prefix + 'ip:' + entry.clientIp;

      const nowMs = Date.now();

      const removeFromIp = async () => {
        const ipRaw = await this.get(ipKey);
        if (!ipRaw) return;
        const list = JSON.parse(ipRaw) as Array<{
          pid: string;
          slotId: string;
          t: number;
        }>;
        const updated = list.filter((item) => item.pid !== pid);
        if (updated.length > 0) {
          const currentTtl = this.pttl(ipKey);
          await this.set(
            ipKey,
            JSON.stringify(updated),
            currentTtl > 0 ? { px: currentTtl } : undefined,
          );
        } else {
          await this.del(ipKey);
        }
      };

      const removeFromSender = async () => {
        const senderKey = prefix + 'sender:' + entry.senderAddress;
        const senderRaw = await this.get(senderKey);
        if (!senderRaw) return;
        const list = JSON.parse(senderRaw) as Array<Record<string, unknown>>;
        const updated = list.filter((item) => item.pid !== pid);
        if (updated.length > 0) {
          const currentTtl = this.pttl(senderKey);
          await this.set(
            senderKey,
            JSON.stringify(updated),
            currentTtl > 0 ? { px: currentTtl } : undefined,
          );
        } else {
          await this.del(senderKey);
        }
      };

      if (entry.issuedAt + ttlMs < nowMs) {
        await this.del(entryKey);
        await removeFromIp();
        await removeFromSender();
        return '__expired_entry__:' + raw;
      }

      if (entry.txBytesHash !== expectedHash) {
        await this.del(entryKey);
        await removeFromIp();
        await removeFromSender();
        return '__hash_mismatch_entry__:' + raw;
      }

      await this.del(entryKey);
      await removeFromIp();
      await removeFromSender();
      return raw;
    }

    // ── PromotionStore CREATE_LUA emulation ──
    if (
      script.includes("redis.call('SET', KEYS[1], ARGV[1])") &&
      script.includes("redis.call('SADD', KEYS[2], ARGV[2])") &&
      script.includes("redis.call('SADD', KEYS[3], ARGV[2])")
    ) {
      await this.set(keys[0], args[0]);
      this._sadd(keys[1], args[1]);
      this._sadd(keys[2], args[1]);
      return 1;
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

    // ── PromotionStore TRANSITION_LUA (CAS-guarded) emulation ──
    if (script.includes("'CAS_FAIL:'") && script.includes('cjson.decode(currentRaw)')) {
      const raw = await this.get(keys[0]);
      if (raw === null) return 'NOT_FOUND';
      let current: { status?: string };
      try {
        current = JSON.parse(raw) as { status?: string };
      } catch {
        return 'NOT_FOUND';
      }
      const expected = args[2];
      if (current.status !== expected) {
        return `CAS_FAIL:${current.status ?? ''}`;
      }
      await this.set(keys[0], args[0]);
      this._srem(keys[1], args[1]);
      this._sadd(keys[2], args[1]);
      return 'OK';
    }

    // ── PromotionStore DELETE_LUA emulation ──
    if (
      script.includes("redis.call('DEL', KEYS[1])") &&
      script.includes("redis.call('SREM', KEYS[2], ARGV[1])") &&
      script.includes("redis.call('SREM', KEYS[3], ARGV[1])")
    ) {
      await this.del(keys[0]);
      this._srem(keys[1], args[0]);
      this._srem(keys[2], args[0]);
      return 1;
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

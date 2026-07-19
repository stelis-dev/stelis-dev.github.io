import { describe } from 'vitest';
import { RedisRateLimiter } from '../src/store/redisRateLimiter.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';
import {
  runRateLimitConformanceTests,
  type RateLimiterFactory,
  type RateLimiterHandle,
} from './rateLimiter.conformance.js';

const redisRateLimiterFactory: RateLimiterFactory = ({ windowMs, maxRequests }) => {
  const limiter = new RedisRateLimiter(new FakeRedisClient(), { windowMs, maxRequests });
  const handle: RateLimiterHandle = {
    limiter,
    dispose: () => {},
  };
  return handle;
};

describe('RedisRateLimiter — shared conformance', () => {
  runRateLimitConformanceTests(redisRateLimiterFactory);
});

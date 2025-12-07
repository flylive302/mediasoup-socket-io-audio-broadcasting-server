import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from './rateLimiter.js';
import type { Redis } from 'ioredis';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      multi: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(),
    };
    rateLimiter = new RateLimiter(mockRedis as Redis);
  });

  it('allows request within limit', async () => {
    // Mock redis response: [[null, 5]] (5th request)
    mockRedis.exec.mockResolvedValue([[null, 5]]);

    const allowed = await rateLimiter.isAllowed('user:123', 10, 60);
    expect(allowed).toBe(true);
    expect(mockRedis.multi).toHaveBeenCalled();
    expect(mockRedis.incr).toHaveBeenCalledWith('ratelimit:user:123');
  });

  it('blocks request exceeding limit', async () => {
    // Mock redis response: [[null, 11]] (11th request, limit 10)
    mockRedis.exec.mockResolvedValue([[null, 11]]);

    const allowed = await rateLimiter.isAllowed('user:123', 10, 60);
    expect(allowed).toBe(false);
  });

  it('handles redis errors gracefully', async () => {
    mockRedis.exec.mockResolvedValue(null);
    const allowed = await rateLimiter.isAllowed('user:123', 10, 60);
    expect(allowed).toBe(false); // Fail closed or open? Implementation returns false on error currently
  });
});

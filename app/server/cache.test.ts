import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedFetch, cacheKey, type Fetcher } from './cache.ts';

function counter(body: string, status = 200): { fetcher: Fetcher; calls: () => number } {
  let n = 0;
  return { fetcher: async () => { n++; return new Response(body, { status }); }, calls: () => n };
}

const tmp = () => mkdtemp(path.join(tmpdir(), 'sp-cache-'));

describe('cache', () => {
  it('keys differ by method, url and body', () => {
    expect(cacheKey('GET', 'u')).not.toBe(cacheKey('POST', 'u'));
    expect(cacheKey('POST', 'u', 'a')).not.toBe(cacheKey('POST', 'u', 'b'));
    expect(cacheKey('GET', 'u')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('second call is served from disk', async () => {
    const dir = await tmp();
    const c = counter('{"a":1}');
    const a = await cachedFetch({ url: 'https://x/a' }, { dir, fetcher: c.fetcher });
    const b = await cachedFetch({ url: 'https://x/a' }, { dir, fetcher: c.fetcher });
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(true);
    expect(b.body).toBe('{"a":1}');
    expect(b.fetchedAt).toBe(a.fetchedAt);
    expect(c.calls()).toBe(1);
    expect((await readdir(dir)).length).toBe(1);
  });

  it('refetches after ttl and serves stale when the service fails', async () => {
    const dir = await tmp();
    let t = Date.parse('2026-01-01T00:00:00Z');
    const now = () => t;
    const c = counter('ok');
    await cachedFetch({ url: 'https://x/w' }, { dir, fetcher: c.fetcher, ttlMin: 60, now });
    t += 30 * 60000;
    await cachedFetch({ url: 'https://x/w' }, { dir, fetcher: c.fetcher, ttlMin: 60, now });
    expect(c.calls()).toBe(1);
    t += 61 * 60000;
    await cachedFetch({ url: 'https://x/w' }, { dir, fetcher: c.fetcher, ttlMin: 60, now });
    expect(c.calls()).toBe(2);
    t += 61 * 60000;
    const down: Fetcher = async () => { throw new Error('down'); };
    const stale = await cachedFetch({ url: 'https://x/w' }, { dir, fetcher: down, ttlMin: 60, now });
    expect(stale.stale).toBe(true);
  });

  it('does not cache errors or rejected bodies', async () => {
    const dir = await tmp();
    await expect(cachedFetch({ url: 'https://x/e' }, { dir, fetcher: counter('x', 500).fetcher })).rejects.toThrow('500');
    await expect(cachedFetch({ url: 'https://x/e' }, { dir, fetcher: counter('nope').fetcher, accept: () => false })).rejects.toThrow();
    expect((await readdir(dir).catch(() => [])).length).toBe(0);
  });

  it('concurrent calls for one key all succeed with one fetch', async () => {
    const dir = await tmp();
    const c = counter('{"ok":true}');
    const slow: Fetcher = async (u, i) => { await new Promise((r) => setTimeout(r, 10)); return c.fetcher(u, i); };
    const all = await Promise.all([1, 2, 3].map(() => cachedFetch({ url: 'https://x/same' }, { dir, fetcher: slow })));
    expect(all.map((r) => r.body)).toEqual(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
    expect(c.calls()).toBe(1);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed cache write still returns the fetched body', async () => {
    const base = await tmp();
    const notADir = path.join(base, 'file');
    await writeFile(notADir, 'x');
    const r = await cachedFetch({ url: 'https://x/w' }, { dir: path.join(notADir, 'cache'), fetcher: counter('good').fetcher });
    expect(r).toMatchObject({ body: 'good', fromCache: false });
  });

  it('a logical cacheKey shares one entry across urls', async () => {
    const dir = await tmp();
    await cachedFetch({ url: 'https://mirror-b/q', cacheKey: 'q1' }, { dir, fetcher: counter('B').fetcher });
    const c = counter('A');
    const r = await cachedFetch({ url: 'https://mirror-a/q', cacheKey: 'q1' }, { dir, fetcher: c.fetcher });
    expect(r).toMatchObject({ body: 'B', fromCache: true });
    expect(c.calls()).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchJson, fetchText, postForm } from '../../src/lib/http.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('http helpers', () => {
  it('fetchJson parses a successful JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    await expect(fetchJson<{ ok: boolean }>('https://api.example.com/x')).resolves.toEqual({ ok: true });
  });

  it('fetchJson posts JSON bodies with content type', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    vi.stubGlobal('fetch', mock);
    await fetchJson('https://api.example.com/x', { method: 'POST', body: { a: 1 } });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('fetchJson maps non-2xx responses to an upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500)));
    await expect(fetchJson('https://api.example.com/x')).rejects.toMatchObject({
      statusCode: 502,
      details: { status: 500 },
    });
  });

  it('fetchJson maps transport failures to an upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    await expect(fetchJson('https://api.example.com/x')).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('fetchText returns the raw body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('raw text', { status: 200 })));
    await expect(fetchText('https://api.example.com/toml')).resolves.toBe('raw text');
  });

  it('fetchText maps non-2xx to an upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(fetchText('https://api.example.com/toml')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('postForm sends urlencoded fields and parses JSON', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ token: 'abc' }));
    vi.stubGlobal('fetch', mock);
    const result = await postForm<{ token: string }>('https://anchor.example.com/auth', {
      account: 'GA',
      memo: undefined,
      memo_type: 'id',
    });
    expect(result.token).toBe('abc');
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(init.body)).toContain('account=GA');
    expect(String(init.body)).toContain('memo_type=id');
    expect(String(init.body)).not.toContain('memo=');
  });

  it('postForm throws upstream on non-JSON anchor responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>', { status: 200 })));
    await expect(postForm('https://anchor.example.com/deposit', { account: 'GA' })).rejects.toThrow(
      /non-JSON/i,
    );
  });

  it('postForm throws upstream on anchor error responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"kyc"}', { status: 403 })));
    await expect(postForm('https://anchor.example.com/deposit', { account: 'GA' })).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});
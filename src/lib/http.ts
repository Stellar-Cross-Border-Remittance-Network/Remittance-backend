import { upstream } from './errors.js';

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  allowInsecure?: boolean;
}

async function fetchWithTimeout(url: string, opts: FetchOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw upstream(`Request to ${url} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch JSON from an upstream service, mapping transport/HTTP failures to AppError. */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw upstream(`Upstream ${url} responded ${res.status}: ${body.slice(0, 500)}`, {
      status: res.status,
      body: body.slice(0, 500),
    });
  }
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    throw upstream(`Upstream ${url} responded ${res.status}`);
  }
  return res.text();
}

/**
 * POST application/x-www-form-urlencoded (SEP-24/SEP-6 anchor endpoints accept
 * urlencoded bodies and return JSON). JSON-parses the response; anchors may
 * return `text/html` for errors, which surfaces as an upstream error.
 */
export async function postForm<T>(
  url: string,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      body.set(k, v);
    }
  }
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: body.toString(),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw upstream(`Anchor ${url} responded ${res.status}: ${text.slice(0, 500)}`, {
      status: res.status,
      body: text.slice(0, 500),
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw upstream(`Anchor ${url} returned non-JSON response`, { body: text.slice(0, 300) });
  }
}
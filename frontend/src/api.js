export async function api(url, opt = {}) {
  const o = { credentials: 'include', ...opt };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers = { 'Content-Type': 'application/json' };
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(url, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

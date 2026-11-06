export type PublicOriginPolicy = {
  origin: string;
  secureCookies: boolean;
};

// Next's Node adapter can construct request URLs from the internal listener
// (for example 0.0.0.0:3000). Neither that URL nor forwarded host/proto headers
// establish the public browser origin. Only this server configuration does.
export function publicOriginPolicy(value: string | undefined, environment: string | undefined): PublicOriginPolicy | null {
  if (!value || value !== value.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== value || url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === 'https:') return {origin: url.origin, secureCookies: true};
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (environment === 'development' && url.protocol === 'http:' && loopback) return {origin: url.origin, secureCookies: false};
  return null;
}

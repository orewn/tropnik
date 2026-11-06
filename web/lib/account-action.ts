export type AccountAction = {action: 'verify_email' | 'reset_password'; token: string};

// Email secrets are accepted only from the fragment. They never belong in a
// query, cookie, browser storage or a navigation link after the initial read.
export function parseAccountAction(fragment: string): AccountAction | null {
  if (!fragment.startsWith('#') || fragment.length > 200) return null;
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  if (params.getAll('action').length !== 1 || params.getAll('token').length !== 1 || [...params.keys()].some(key => key !== 'action' && key !== 'token')) return null;
  const action = params.get('action'), token = params.get('token');
  if (action !== 'verify_email' && action !== 'reset_password') return null;
  if (!token || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) return null;
  return {action, token};
}

export function validAccountPassword(password: string) {
  return [...password].length >= 12 && [...password].length <= 128;
}

export function clearsAccountSession(method: string, path: readonly string[], status: number) {
  return method === 'POST' && status >= 200 && status < 300 && (path.join('/') === 'me/delete' || path.join('/') === 'auth/password/reset');
}

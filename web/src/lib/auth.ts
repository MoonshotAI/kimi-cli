const AUTH_TOKEN_KEY = "kimi_auth_token";
const AUTH_TOKEN_PARAM = "token";

export function getAuthToken(): string | null {
  return sessionStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
}

export function consumeAuthTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get(AUTH_TOKEN_PARAM);
  if (!token) {
    return null;
  }
  url.searchParams.delete(AUTH_TOKEN_PARAM);
  window.history.replaceState({}, "", url.toString());
  return token;
}

export function getAuthHeader(): Record<string, string> {
  let token = getAuthToken();
  // Fallback: try reading from URL if sessionStorage is empty
  if (!token) {
    const url = new URL(window.location.href);
    token = url.searchParams.get("token");
  }
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

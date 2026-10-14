/**
 * Google sign-in for Drive access, using Google Identity Services' browser "token model".
 * - Only the public Client ID is used. There is no client secret anywhere.
 * - Scope: drive.file only.
 * - The access token (about 1 hour) lives in memory only. It is never stored or logged.
 * - Browsers get no refresh token. When the token expires, the next sync asks again; if Google needs a
 *   click (consent or account choice), sync shows "Authentication required" and local use continues.
 */
import type { TokenProvider } from './driveApi';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  scope?: string;
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
  callback: (r: TokenResponse) => void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

let gisPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not load Google sign-in. Check your connection.'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export function googleClientId(): string {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? '';
}

export class GoogleAuth implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private client: TokenClient | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly clientId: string = googleClientId(), private readonly now: () => number = () => Date.now()) {}

  get configured(): boolean {
    return this.clientId.length > 0;
  }

  get signedIn(): boolean {
    return !!this.token && this.now() < this.expiresAt - 60_000;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  async getToken(): Promise<string | null> {
    return this.signedIn ? this.token : null;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
    this.emit();
  }

  /**
   * Ask Google for a token. Must be called from a user gesture (button click) when `interactive`,
   * otherwise browsers block the popup.
   */
  async signIn(interactive = true): Promise<void> {
    if (!this.configured) throw new Error('Google sign-in is not configured for this copy of the app (missing Client ID).');
    await loadGis();
    const oauth2 = window.google!.accounts.oauth2;
    await new Promise<void>((resolve, reject) => {
      const done = (r: TokenResponse) => {
        if (r.error || !r.access_token) {
          reject(new Error(r.error === 'access_denied' ? 'Google access was not granted' : 'Google sign-in failed'));
          return;
        }
        if (r.scope && !r.scope.split(' ').includes(DRIVE_SCOPE)) {
          reject(new Error('Google Drive permission was not granted. Tick the Drive checkbox when signing in.'));
          return;
        }
        this.token = r.access_token;
        this.expiresAt = this.now() + (r.expires_in ?? 3600) * 1000;
        this.emit();
        resolve();
      };
      this.client ??= oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_SCOPE,
        callback: done,
        error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in window was closed' : 'Google sign-in failed')),
      });
      this.client.callback = done;
      this.client.requestAccessToken({ prompt: interactive ? '' : 'none' });
    });
  }

  signOut(): void {
    const t = this.token;
    this.invalidate();
    if (t) window.google?.accounts.oauth2.revoke(t);
  }
}

/** One auth instance for the app. */
export const googleAuth = new GoogleAuth();

/**
 * Minimal Google Drive v3 client over fetch. Scope: drive.file (only files this app created).
 * - Exponential backoff with jitter for 429 / 5xx / rate-limit 403 / network errors.
 * - 401 → one silent token refresh attempt, then an 'auth' error.
 * - Storage quota exhaustion → a 'quota' error (not retried).
 * Never logs request bodies, tokens or file contents.
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  appProperties?: Record<string, string>;
  trashed?: boolean;
}

export type DriveErrorKind = 'auth' | 'quota' | 'rate' | 'notFound' | 'network' | 'server' | 'other';

export class DriveError extends Error {
  constructor(public readonly kind: DriveErrorKind, message: string, public readonly status?: number) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface TokenProvider {
  /** A valid access token, or null if the user must sign in interactively. */
  getToken(): Promise<string | null>;
  /** Called after a 401 so the next getToken() fetches a fresh one. */
  invalidate(): void;
}

export interface DriveApi {
  list(q: string, opts?: { orderBy?: string }): Promise<DriveFile[]>;
  createFolder(name: string, parentId: string | 'root', appProperties?: Record<string, string>): Promise<DriveFile>;
  upload(meta: { name: string; parentId: string; mimeType: string; appProperties?: Record<string, string> }, body: Uint8Array): Promise<DriveFile>;
  download(fileId: string): Promise<Uint8Array>;
  /** Permanent delete (bypasses trash). Resolves if the file is already gone. */
  remove(fileId: string): Promise<void>;
  /** True if the file exists and is not trashed. */
  exists(fileId: string): Promise<boolean>;
}

export function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface HttpDriveOptions {
  tokens: TokenProvider;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  random?: () => number;
}

export class HttpDriveApi implements DriveApi {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly random: () => number;

  constructor(private readonly opts: HttpDriveOptions) {
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 4;
    this.random = opts.random ?? Math.random;
  }

  private async request(url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.getToken();
      if (!token) throw new DriveError('auth', 'Sign in to Google Drive to sync');
      let res: Response;
      try {
        res = await this.fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
      } catch {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw new DriveError('network', 'Network error talking to Google Drive');
      }
      if (res.ok || okStatuses.includes(res.status)) return res;
      const reason = await errorReason(res);
      if (res.status === 401) {
        this.opts.tokens.invalidate();
        if (!authRetried) {
          authRetried = true;
          continue;
        }
        throw new DriveError('auth', 'Google sign-in expired', 401);
      }
      if (res.status === 404) throw new DriveError('notFound', 'File not found', 404);
      if (res.status === 403 && /storageQuotaExceeded|quotaExceeded/i.test(reason) && !/rateLimit/i.test(reason)) {
        throw new DriveError('quota', 'Google Drive storage is full', 403);
      }
      const retriable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(reason));
      if (retriable && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('Retry-After'));
        await (Number.isFinite(ra) && ra > 0 ? this.sleep(Math.min(ra, 60) * 1000) : this.backoff(attempt));
        continue;
      }
      if (retriable) throw new DriveError(res.status === 429 || res.status === 403 ? 'rate' : 'server', 'Google Drive is busy; will retry later', res.status);
      if (res.status === 403) throw new DriveError('auth', 'Google Drive refused access', 403);
      throw new DriveError('other', `Google Drive error ${res.status}`, res.status);
    }
  }

  private backoff(attempt: number): Promise<void> {
    const base = 1000 * 2 ** attempt; // 1s, 2s, 4s, 8s
    return this.sleep(base + Math.floor(this.random() * 500));
  }

  async list(query: string, opts: { orderBy?: string } = {}): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        spaces: 'drive',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,appProperties)',
      });
      if (opts.orderBy) params.set('orderBy', opts.orderBy);
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.request(`${DRIVE_API}/files?${params}`);
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFolder(name: string, parentId: string | 'root', appProperties?: Record<string, string>): Promise<DriveFile> {
    const res = await this.request(`${DRIVE_API}/files?fields=id,name,mimeType,appProperties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
    });
    return (await res.json()) as DriveFile;
  }

  async upload(meta: { name: string; parentId: string; mimeType: string; appProperties?: Record<string, string> }, body: Uint8Array): Promise<DriveFile> {
    const boundary = `pl-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name: meta.name, parents: [meta.parentId], mimeType: meta.mimeType, appProperties: meta.appProperties });
    const multipart = new Blob(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
        body as BlobPart,
        `\r\n--${boundary}--`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    );
    const res = await this.request(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size,appProperties`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    return (await res.json()) as DriveFile;
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async remove(fileId: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, [404]);
  }

  async exists(fileId: string): Promise<boolean> {
    const res = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {}, [404]);
    if (res.status === 404) return false;
    const body = (await res.json()) as { trashed?: boolean };
    return !body.trashed;
  }
}

async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string } };
    return [body.error?.status, ...(body.error?.errors ?? []).map((e) => e.reason), body.error?.message].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

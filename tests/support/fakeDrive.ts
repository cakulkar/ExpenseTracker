/**
 * In-memory fake of the Google Drive v3 HTTP API — just the endpoints PocketLedger uses.
 * Works at the HTTP level so the real HttpDriveApi client is exercised.
 * Used by Vitest (as a fetch replacement) and Playwright (via page.route).
 */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  createdTime: string;
  trashed: boolean;
  data: Uint8Array;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const enc = new TextEncoder();

function bytesToBinary(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}
function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class FakeDrive {
  files = new Map<string, FakeFile>();
  requests: Array<{ method: string; path: string }> = [];
  validTokens = new Set<string>(['token-1']);
  quotaFull = false;
  private faults: Array<{ status: number; reason: string; match?: RegExp }> = [];
  private clock = Date.UTC(2026, 0, 1);
  private seq = 0;

  /** The next matching request(s) fail with this status. */
  failNext(status: number, reason = '', count = 1, match?: RegExp): void {
    for (let i = 0; i < count; i++) this.faults.push({ status, reason, match });
  }

  fileCount(predicate: (f: FakeFile) => boolean = () => true): number {
    return [...this.files.values()].filter(predicate).length;
  }

  findByName(name: string): FakeFile | undefined {
    return [...this.files.values()].find((f) => f.name === name);
  }

  allData(): Uint8Array[] {
    return [...this.files.values()].map((f) => f.data);
  }

  private json(status: number, value: unknown, headers: Record<string, string> = {}): FakeResponse {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: enc.encode(JSON.stringify(value)) };
  }

  private error(status: number, reason: string, message = reason): FakeResponse {
    return this.json(status, { error: { code: status, message, errors: [{ reason, message }] } });
  }

  private meta(f: FakeFile) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.data.length), createdTime: f.createdTime, appProperties: f.appProperties, trashed: f.trashed };
  }

  private create(name: string, mimeType: string, parents: string[], appProperties: Record<string, string> | undefined, data: Uint8Array): FakeFile {
    if (this.quotaFull) throw Object.assign(new Error('quota'), { quota: true });
    this.clock += 1000;
    const f: FakeFile = {
      id: `f${++this.seq}`,
      name,
      mimeType,
      parents: parents.length ? parents : ['root'],
      appProperties: appProperties ?? {},
      createdTime: new Date(this.clock).toISOString(),
      trashed: false,
      data,
    };
    this.files.set(f.id, f);
    return f;
  }

  private matches(f: FakeFile, query: string): boolean {
    let rest = query;
    const props = [...query.matchAll(/appProperties has \{ key='([^']*)' and value='([^']*)' \}/g)];
    for (const p of props) {
      if (f.appProperties[p[1]!] !== p[2]) return false;
      rest = rest.replace(p[0], 'true');
    }
    for (const term of rest.split(' and ').map((t) => t.trim())) {
      let m: RegExpExecArray | null;
      if (term === 'true') continue;
      if ((m = /^'([^']+)' in parents$/.exec(term))) {
        if (!f.parents.includes(m[1]!)) return false;
      } else if ((m = /^name = '((?:[^'\\]|\\.)*)'$/.exec(term))) {
        if (f.name !== m[1]!.replace(/\\(.)/g, '$1')) return false;
      } else if ((m = /^mimeType = '([^']+)'$/.exec(term))) {
        if (f.mimeType !== m[1]) return false;
      } else if ((m = /^mimeType != '([^']+)'$/.exec(term))) {
        if (f.mimeType === m[1]) return false;
      } else if (term === 'trashed = false') {
        if (f.trashed) return false;
      } else if ((m = /^createdTime > '([^']+)'$/.exec(term))) {
        if (!(f.createdTime > new Date(m[1]!).toISOString())) return false;
      } else {
        throw new Error(`FakeDrive: unsupported query term: ${term}`);
      }
    }
    return true;
  }

  handle(req: FakeRequest): FakeResponse {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, path: url.pathname });
    const auth = req.headers.authorization ?? req.headers.Authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!this.validTokens.has(token)) return this.error(401, 'authError', 'Invalid Credentials');
    const fault = this.faults.findIndex((f) => !f.match || f.match.test(`${req.method} ${url.pathname}`));
    if (fault >= 0) {
      const f = this.faults.splice(fault, 1)[0]!;
      return this.error(f.status, f.reason || 'backendError');
    }
    try {
      return this.route(req, url);
    } catch (e) {
      if ((e as { quota?: boolean }).quota) return this.error(403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota');
      throw e;
    }
  }

  private route(req: FakeRequest, url: URL): FakeResponse {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/drive/v3/files') {
      const query = url.searchParams.get('q') ?? '';
      const all = [...this.files.values()].filter((f) => this.matches(f, query)).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      const pageSize = Number(url.searchParams.get('pageSize') ?? 100);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
      return this.json(200, { files: page.map((f) => this.meta(f)), nextPageToken: next });
    }
    if (req.method === 'POST' && path === '/drive/v3/files') {
      const meta = JSON.parse(new TextDecoder().decode(req.body)) as { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> };
      const f = this.create(meta.name, meta.mimeType ?? FOLDER_MIME, meta.parents ?? [], meta.appProperties, new Uint8Array());
      return this.json(200, this.meta(f));
    }
    if (req.method === 'POST' && path === '/upload/drive/v3/files') {
      const ct = req.headers['content-type'] ?? '';
      const boundary = /boundary=([^;]+)/.exec(ct)?.[1];
      if (!boundary || !req.body) return this.error(400, 'badRequest');
      const text = bytesToBinary(req.body);
      const parts = text.split(`--${boundary}`).slice(1, -1);
      const parsePart = (p: string) => {
        const idx = p.indexOf('\r\n\r\n');
        let content = p.slice(idx + 4);
        if (content.endsWith('\r\n')) content = content.slice(0, -2);
        return content;
      };
      const meta = JSON.parse(parsePart(parts[0]!)) as { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> };
      const data = binaryToBytes(parsePart(parts[1]!));
      const f = this.create(meta.name, meta.mimeType, meta.parents ?? [], meta.appProperties, data);
      return this.json(200, this.meta(f));
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]!));
      if (!f) return this.error(404, 'notFound', 'File not found');
      if (req.method === 'DELETE') {
        this.files.delete(f.id);
        return { status: 204, headers: {}, body: new Uint8Array() };
      }
      if (req.method === 'GET') {
        if (url.searchParams.get('alt') === 'media') return { status: 200, headers: { 'content-type': f.mimeType }, body: f.data };
        return this.json(200, this.meta(f));
      }
    }
    return this.error(400, 'unsupported', `FakeDrive does not support ${req.method} ${path}`);
  }

  /** A fetch() replacement for unit/integration tests. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const r = new Request(input, init);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : new Uint8Array(await r.arrayBuffer());
    const res = this.handle({ method: r.method, url: r.url, headers, body });
    return new Response(res.status === 204 ? null : (res.body as BodyInit), { status: res.status, headers: res.headers });
  };
}

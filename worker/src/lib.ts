// Pure helpers shared by the Worker and its tests. No Worker globals here.

// The most any minted token may carry, unless the deployment sets
// MAX_PERMISSIONS. Requests can only narrow it, and the broker also caps it at
// what the installation was granted. Conservative by default: no workflow
// edits, no repository administration, no secrets, read-only Actions.
export const DEFAULT_MAX_PERMISSIONS: PermissionSet = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
};

// The only permissions the broker will ever grant write access to, whatever
// MAX_PERMISSIONS says; a ceiling asking for write on anything else fails every
// mint and is reported by GET /version. Everything else (workflows,
// administration, members, every kind of secret, hooks, runners, environments,
// variables, org settings) is read-only at most. An allowlist, so permissions
// GitHub adds later are read-only until someone decides otherwise.
export const WRITABLE = [
  "contents",
  "pull_requests",
  "issues",
  "actions",
  "checks",
  "statuses",
  "deployments",
  "pages",
  "discussions",
];

// Parse a MAX_PERMISSIONS JSON object ({"contents":"write",...}); fall back to
// the default when unset. Malformed config throws so a bad deploy fails loudly.
export function parseMaxPermissions(raw: string | undefined): PermissionSet {
  if (!raw) return { ...DEFAULT_MAX_PERMISSIONS };
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MAX_PERMISSIONS must be a JSON object");
  }
  const result: PermissionSet = { metadata: "read" };
  for (const [name, level] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z_]{1,64}$/.test(name)) throw new Error(`MAX_PERMISSIONS: bad permission name ${name}`);
    if (level !== "read" && level !== "write") throw new Error(`MAX_PERMISSIONS: ${name} must be read or write`);
    if (level === "write" && !WRITABLE.includes(name)) throw new Error(`MAX_PERMISSIONS: ${name} may not be write`);
    result[name] = level;
  }
  return result;
}

export const MAX_REPOSITORIES_PER_TOKEN = 20;

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export type PermissionSet = Record<string, "read" | "write">;

// What a request gets when it names no permissions: "read" (the ceiling with
// every permission lowered to read) unless the deployment says "ceiling".
export type DefaultAccess = "read" | "ceiling";

export function parseDefaultAccess(raw: string | undefined): DefaultAccess {
  if (raw === undefined || raw === "" || raw === "read") return "read";
  if (raw === "ceiling") return "ceiling";
  throw new Error("DEFAULT_ACCESS must be read or ceiling");
}

export function readOnly(permissions: PermissionSet): PermissionSet {
  return Object.fromEntries(Object.keys(permissions).map((name) => [name, "read"])) as PermissionSet;
}

export type MintRequest = {
  repositories?: string[];
  permissions?: PermissionSet;
  // "write" asks for the full ceiling; "read" (the default) for its read-only form.
  access?: "read" | "write";
  label?: string;
};

export type ValidatedMint = {
  repositories?: string[];
  permissions: PermissionSet;
  label: string;
};

export function validateMintRequest(
  body: unknown,
  maxPermissions: PermissionSet = DEFAULT_MAX_PERMISSIONS,
  defaultAccess: DefaultAccess = "read",
): ValidatedMint | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const req = body as Record<string, unknown>;
  for (const key of Object.keys(req)) {
    if (!["repositories", "permissions", "access", "label"].includes(key)) {
      return { error: `unknown field: ${key}` };
    }
  }

  // Every token names its repositories; there is no org-wide default.
  let repositories: string[] | undefined;
  if (req.repositories === undefined) return { error: "repositories is required (bare names, max 20)" };
  {
    if (!Array.isArray(req.repositories) || req.repositories.length === 0) {
      return { error: "repositories must be a non-empty array of repository names" };
    }
    if (req.repositories.length > MAX_REPOSITORIES_PER_TOKEN) {
      return { error: `at most ${MAX_REPOSITORIES_PER_TOKEN} repositories per token` };
    }
    for (const name of req.repositories) {
      if (typeof name !== "string" || !REPO_NAME.test(name)) {
        return { error: `invalid repository name: ${String(name)} (use the bare name, not owner/name)` };
      }
    }
    if (req.repositories.some((name) => name === "." || name === "..")) {
      return { error: "invalid repository name" };
    }
    repositories = [...new Set(req.repositories as string[])].sort();
  }

  // Writes are asked for, never assumed: no permissions and no access means
  // read-only, unless this deployment keeps the old "ceiling" default.
  if (req.access !== undefined && req.access !== "read" && req.access !== "write") {
    return { error: "access must be read or write" };
  }
  if (req.access !== undefined && req.permissions !== undefined) {
    return { error: "send access or permissions, not both" };
  }
  const wantsCeiling = req.access === "write" || (req.access === undefined && defaultAccess === "ceiling");
  let permissions: PermissionSet = wantsCeiling ? { ...maxPermissions } : readOnly(maxPermissions);
  if (req.permissions !== undefined) {
    if (req.permissions === null || typeof req.permissions !== "object" || Array.isArray(req.permissions)) {
      return { error: "permissions must be an object like {\"contents\": \"read\"}" };
    }
    permissions = { metadata: "read" };
    for (const [name, level] of Object.entries(req.permissions as Record<string, unknown>)) {
      const max = Object.hasOwn(maxPermissions, name) ? maxPermissions[name] : undefined;
      if (!max) return { error: `permission not allowed: ${name}` };
      if (level !== "read" && level !== "write") {
        return { error: `permission level must be read or write: ${name}` };
      }
      if (level === "write" && max === "read") {
        return { error: `permission ${name} is capped at read` };
      }
      permissions[name] = level;
    }
  }

  let label = "unlabeled";
  if (req.label !== undefined) {
    if (typeof req.label !== "string" || !/^[A-Za-z0-9._:@/-]{1,128}$/.test(req.label)) {
      return { error: "label must be 1-128 characters of [A-Za-z0-9._:@/-]" };
    }
    label = req.label;
  }

  return { repositories, permissions, label };
}

export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(prefix: string, bytes = 32): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// GitHub's audit log records `hashed_token` as base64(SHA-256(token)).
export async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// DER length prefix.
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  while (length > 0) {
    bytes.unshift(length & 0xff);
    length >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

// GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports PKCS#8.
// Wrap the PKCS#1 bytes in a PKCS#8 PrivateKeyInfo structure.
export function pemToPkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der;

  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(der.length)];
  const innerLength = version.length + algorithm.length + octet.length + der.length;
  const out = new Uint8Array(1 + derLength(innerLength).length + innerLength);
  let offset = 0;
  for (const b of [0x30, ...derLength(innerLength), ...version, ...algorithm, ...octet]) out[offset++] = b;
  out.set(der, offset);
  return out;
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Der(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// GitHub App JWT: valid 9 minutes, backdated 60s for clock drift.
export async function appJwt(key: CryptoKey, issuer: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: issuer });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  appJwt,
  DEFAULT_MAX_PERMISSIONS,
  importAppKey,
  parseDefaultAccess,
  parseMaxPermissions,
  readOnly,
  sha256Base64,
  validateMintRequest,
} from "../worker/src/lib";

describe("validateMintRequest", () => {
  test("is read-only unless writes are asked for", () => {
    expect(validateMintRequest({ repositories: ["docs"] })).toEqual({
      repositories: ["docs"],
      permissions: readOnly(DEFAULT_MAX_PERMISSIONS),
      label: "unlabeled",
    });
    expect(validateMintRequest({ repositories: ["docs"], access: "read" })).toMatchObject({ permissions: readOnly(DEFAULT_MAX_PERMISSIONS) });
    expect(validateMintRequest({ repositories: ["docs"], access: "write" })).toMatchObject({ permissions: DEFAULT_MAX_PERMISSIONS });
  });

  test("a deployment may keep the old ceiling default", () => {
    expect(validateMintRequest({ repositories: ["docs"] }, DEFAULT_MAX_PERMISSIONS, "ceiling")).toMatchObject({ permissions: DEFAULT_MAX_PERMISSIONS });
    expect(validateMintRequest({ repositories: ["docs"], access: "read" }, DEFAULT_MAX_PERMISSIONS, "ceiling")).toMatchObject({
      permissions: readOnly(DEFAULT_MAX_PERMISSIONS),
    });
  });

  test("narrows permissions and always keeps metadata read", () => {
    const result = validateMintRequest({ repositories: ["api", "api", "docs"], permissions: { contents: "read" }, label: "session:abc" });
    expect(result).toEqual({ repositories: ["api", "docs"], permissions: { metadata: "read", contents: "read" }, label: "session:abc" });
  });

  test("honours a deployment's configured cap", () => {
    const max = parseMaxPermissions('{"contents":"read","actions":"write"}');
    expect(validateMintRequest({ repositories: ["api"], access: "write" }, max)).toMatchObject({ permissions: { metadata: "read", contents: "read", actions: "write" } });
    expect(validateMintRequest({ repositories: ["api"], permissions: { contents: "write" } }, max)).toEqual({ error: "permission contents is capped at read" });
  });

  test.each([
    [{}, "repositories is required"],
    [{ repositories: [".."] }, "invalid repository name"],
    [{ repositories: ["docs"], permissions: { workflows: "write" } }, "permission not allowed: workflows"],
    [{ repositories: ["docs"], permissions: { administration: "read" } }, "permission not allowed: administration"],
    [{ repositories: ["docs"], permissions: { secrets: "read" } }, "permission not allowed: secrets"],
    [{ repositories: ["docs"], permissions: { members: "read" } }, "permission not allowed: members"],
    [{ repositories: ["docs"], permissions: { actions: "write" } }, "capped at read"],
    [{ repositories: ["docs"], permissions: { contents: "admin" } }, "read or write"],
    [{ repositories: ["myorg/api"] }, "invalid repository name"],
    [{ repositories: [] }, "non-empty"],
    [{ repositories: Array.from({ length: 21 }, (_, i) => `r${i}`) }, "at most 20"],
    [{ repositories: ["docs"], label: "bad label with spaces" }, "label must be"],
    [{ repositories: ["docs"], installation_id: 1 }, "unknown field"],
    [{ repositories: ["docs"], access: "admin" }, "access must be read or write"],
    [{ repositories: ["docs"], access: "write", permissions: { contents: "read" } }, "not both"],
    [{ repositories: ["docs"], permissions: { constructor: "read" } }, "permission not allowed: constructor"],
    [[], "JSON object"],
  ])("rejects %j", (body, message) => {
    const result = validateMintRequest(body);
    expect("error" in result && result.error).toContain(message);
  });
});

describe("parseMaxPermissions", () => {
  test("defaults when unset", () => {
    expect(parseMaxPermissions(undefined)).toEqual(DEFAULT_MAX_PERMISSIONS);
  });

  test("the default never writes workflows, administration, secrets or Actions", () => {
    for (const name of ["workflows", "administration", "secrets", "members"]) expect(DEFAULT_MAX_PERMISSIONS[name]).toBeUndefined();
    expect(DEFAULT_MAX_PERMISSIONS.actions).toBe("read");
  });

  test.each([
    ['{"administration":"write"}', "may not be write"],
    ['{"secrets":"write"}', "may not be write"],
    ['{"environments":"write"}', "may not be write"],
    ['{"workflows":"write"}', "may not be write"],
    ['{"contents":"admin"}', "read or write"],
    ['["contents"]', "JSON object"],
    ['{"Bad-Name":"read"}', "bad permission name"],
  ])("rejects %s", (raw, message) => {
    expect(() => parseMaxPermissions(raw)).toThrow(message);
  });
});

describe("deployment settings", () => {
  test("DEFAULT_ACCESS accepts read or ceiling only", () => {
    expect(parseDefaultAccess(undefined)).toBe("read");
    expect(parseDefaultAccess("ceiling")).toBe("ceiling");
    expect(() => parseDefaultAccess("write")).toThrow("read or ceiling");
  });

  test("the audit hash matches GitHub's base64 hashed_token form", async () => {
    // printf abc | openssl dgst -sha256 -binary | base64
    expect(await sha256Base64("abc")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });
});

describe("app JWT", () => {
  test("signs with a PKCS#1 key as GitHub issues it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(pem).toContain("BEGIN RSA PRIVATE KEY");
    const jwt = await appJwt(await importAppKey(pem), "Iv23test", 1_700_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "Iv23test" });
    const ok = verify("sha256", Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  test("also accepts PKCS#8", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect((await appJwt(await importAppKey(pem), "x")).split(".")).toHaveLength(3);
  });
});

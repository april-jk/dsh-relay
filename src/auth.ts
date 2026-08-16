import { createHmac, randomBytes } from "node:crypto";

function b64(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}
export function signToken(
  payload: Record<string, unknown>,
  secret: string,
  ttlMs: number,
) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
}
export function verifyToken(
  token: string | undefined,
  secret: string,
): Record<string, any> | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64(createHmac("sha256", secret).update(body).digest());
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
export function randomToken() {
  return randomBytes(32).toString("hex");
}

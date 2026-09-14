import { createClient } from "@supabase/supabase-js";

export class AdminAuthError extends Error {
  constructor(public readonly status: 401 | 403 | 503, message: string) {
    super(message);
    this.name = "AdminAuthError";
  }
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match) throw new AdminAuthError(401, "Missing administrator access token");
  return match[1];
}

export async function requireSignedAdmin(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new AdminAuthError(503, "Supabase auth is not configured");

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.getUser(bearerToken(request));
  if (error || !data.user) throw new AdminAuthError(401, "Invalid administrator access token");
  const metadata = data.user.app_metadata || {};
  if (metadata.role !== "admin" && metadata.is_admin !== true) {
    throw new AdminAuthError(403, "Administrator claim required");
  }
  return data.user;
}

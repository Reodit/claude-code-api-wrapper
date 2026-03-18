import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/antigravity";

/**
 * GET /api/antigravity/auth/callback — OAuth callback from Google
 * Exchanges the authorization code for tokens, saves credentials,
 * and returns an HTML page that notifies the opener window via postMessage.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Login Failed</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff">
  <div style="text-align:center">
    <h1 style="color:#ef4444">Login Failed</h1>
    <p>${error}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'antigravity-auth-error', error: '${error}' }, '*');
        setTimeout(() => window.close(), 3000);
      }
    </script>
  </div>
</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  if (!code) {
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invalid Callback</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff">
  <div style="text-align:center">
    <h1 style="color:#ef4444">Invalid Callback</h1>
    <p>No authorization code received.</p>
  </div>
</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  try {
    const { email } = await exchangeCodeForTokens(code);

    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Login Success</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff">
  <div style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px">&#10003;</div>
    <h1 style="color:#22c55e;margin-bottom:8px">Login Success!</h1>
    <p style="color:#a1a1aa">${email || "Authenticated"}</p>
    <p style="color:#71717a;font-size:14px;margin-top:16px">This window will close automatically.</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'antigravity-auth-success', email: '${email}' }, '*');
        setTimeout(() => window.close(), 2000);
      }
    </script>
  </div>
</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authentication Error</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff">
  <div style="text-align:center">
    <h1 style="color:#ef4444">Authentication Error</h1>
    <p style="color:#a1a1aa">${message}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'antigravity-auth-error', error: 'Token exchange failed' }, '*');
        setTimeout(() => window.close(), 3000);
      }
    </script>
  </div>
</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

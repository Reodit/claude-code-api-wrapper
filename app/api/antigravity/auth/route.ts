import { NextResponse } from "next/server";
import {
  isAuthenticated,
  loadCredentials,
  buildOAuthUrl,
  deleteCredentials,
  getValidAccessToken,
  fetchAvailableImageModels,
} from "@/lib/antigravity";

/**
 * GET /api/antigravity/auth — Check authentication status and current tier
 */
export async function GET() {
  const authenticated = isAuthenticated();
  const result: Record<string, unknown> = { authenticated };

  if (authenticated) {
    try {
      const accessToken = await getValidAccessToken();
      const models = await fetchAvailableImageModels(accessToken);
      result.availableModels = models;
      result.tier = models.length > 0 ? "image_gen" : "basic";
    } catch {
      result.tier = "unknown";
      result.availableModels = [];
    }

    const creds = loadCredentials();
    if (creds?.expires_at) {
      result.expiresAt = creds.expires_at;
    }
  }

  return NextResponse.json(result);
}

/**
 * POST /api/antigravity/auth — Return OAuth URL for frontend-driven flow
 */
export async function POST() {
  try {
    if (isAuthenticated()) {
      return NextResponse.json({
        success: true,
        message: "Already authenticated",
      });
    }

    const { url, state } = buildOAuthUrl();
    return NextResponse.json({ success: true, authUrl: url, state });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/antigravity/auth — Logout (delete stored credentials)
 */
export async function DELETE() {
  deleteCredentials();
  return NextResponse.json({ success: true, message: "Logged out" });
}

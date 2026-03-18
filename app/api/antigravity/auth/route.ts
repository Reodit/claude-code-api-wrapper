import { NextResponse } from "next/server";
import {
  isAuthenticated,
  runOAuthFlow,
  deleteCredentials,
} from "@/lib/antigravity";

/**
 * GET /api/antigravity/auth — Check authentication status
 */
export async function GET() {
  return NextResponse.json({ authenticated: isAuthenticated() });
}

/**
 * POST /api/antigravity/auth — Trigger OAuth flow (opens browser)
 */
export async function POST() {
  try {
    if (isAuthenticated()) {
      return NextResponse.json({
        success: true,
        message: "Already authenticated",
      });
    }

    await runOAuthFlow();
    return NextResponse.json({ success: true, message: "Authentication complete" });
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

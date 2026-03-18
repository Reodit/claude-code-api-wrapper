import { NextRequest, NextResponse } from "next/server";
import {
  getValidAccessToken,
  generateImage,
  refreshAccessToken,
  loadCredentials,
  type ImagePart,
} from "@/lib/antigravity";

export const maxDuration = 300; // 5 minutes

interface RequestBody {
  prompt: string;
  image?: ImagePart;
  referenceImages?: ImagePart[];
  aspectRatio?: string;
}

/**
 * POST /api/antigravity/image — Generate image using Antigravity API
 *
 * Body: {
 *   prompt: string;
 *   image?: { data: string; mimeType: string };
 *   referenceImages?: Array<{ data: string; mimeType: string }>;
 *   aspectRatio?: string;  // default "1:1"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;

    if (!body.prompt || typeof body.prompt !== "string") {
      return NextResponse.json(
        { success: false, images: [], error: "prompt is required" },
        { status: 400 }
      );
    }

    let accessToken: string;
    try {
      accessToken = await getValidAccessToken();
    } catch {
      return NextResponse.json(
        {
          success: false,
          images: [],
          error: "Not authenticated. Call POST /api/antigravity/auth first.",
        },
        { status: 401 }
      );
    }

    // Attempt generation, with automatic retry on 401
    try {
      const images = await generateImage(
        accessToken,
        body.prompt,
        body.image,
        body.referenceImages,
        body.aspectRatio ?? "1:1"
      );

      return NextResponse.json({ success: true, images });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // If 401, try refreshing the token once and retrying
      if (message.includes("401")) {
        const creds = loadCredentials();
        if (creds?.refresh_token) {
          try {
            const refreshed = await refreshAccessToken(creds.refresh_token);
            const images = await generateImage(
              refreshed.access_token,
              body.prompt,
              body.image,
              body.referenceImages,
              body.aspectRatio ?? "1:1"
            );
            return NextResponse.json({ success: true, images });
          } catch (retryErr) {
            const retryMsg =
              retryErr instanceof Error ? retryErr.message : String(retryErr);
            return NextResponse.json(
              { success: false, images: [], error: retryMsg },
              { status: 502 }
            );
          }
        }
      }

      return NextResponse.json(
        { success: false, images: [], error: message },
        { status: 502 }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, images: [], error: message },
      { status: 500 }
    );
  }
}

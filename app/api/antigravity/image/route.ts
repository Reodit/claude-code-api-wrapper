import { NextRequest, NextResponse } from "next/server";
import {
  generateImage,
  isAuthenticated,
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
    if (!isAuthenticated()) {
      return NextResponse.json(
        {
          success: false,
          images: [],
          error: "Not authenticated. Call POST /api/antigravity/auth first.",
        },
        { status: 401 }
      );
    }

    const body = (await request.json()) as RequestBody;

    if (!body.prompt || typeof body.prompt !== "string") {
      return NextResponse.json(
        { success: false, images: [], error: "prompt is required" },
        { status: 400 }
      );
    }

    const result = await generateImage({
      prompt: body.prompt,
      image: body.image,
      referenceImages: body.referenceImages,
      aspectRatio: body.aspectRatio ?? "1:1",
    });

    return NextResponse.json({ success: true, images: result.images });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("401") ? 401 : 502;
    return NextResponse.json(
      { success: false, images: [], error: message },
      { status }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import {
  FileAttachment,
  SavedFile,
  validateFiles,
  saveFilesToTemp,
} from '@/lib/file-handler';
import { spawnGeminiStream, collectGeminiStream } from '@/lib/gemini-spawn';

/**
 * Gemini CLI API Wrapper (Sync)
 *
 * Internally uses the same streaming spawn as /api/gemini/stream,
 * but collects all events and returns a single JSON response.
 *
 * POST /api/gemini
 * Body: {
 *   prompt: string;
 *   model?: string;       // 기본값: gemini-2.5-pro
 *   files?: FileAttachment[];
 *   yolo?: boolean;        // 도구 자동 승인 (기본값: true)
 *   sandbox?: boolean;     // 도구 사용 금지
 * }
 */
export const maxDuration = 1200; // 20분

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      files,
      model,
      yolo = true,
      sandbox = false,
    } = body as {
      prompt: string;
      files?: FileAttachment[];
      model?: string;
      yolo?: boolean;
      sandbox?: boolean;
    };

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Prompt is required and must be a string' },
        { status: 400 }
      );
    }

    // 파일 첨부 처리
    let savedFiles: SavedFile[] = [];
    if (files && Array.isArray(files) && files.length > 0) {
      const validationError = validateFiles(files);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      savedFiles = await saveFilesToTemp(files);
    }

    // Spawn stream and collect all events
    const { stream } = spawnGeminiStream({
      prompt,
      model,
      yolo,
      sandbox,
      savedFiles,
    });

    const responseData = await collectGeminiStream(stream, model);

    // 인증 에러 감지: collectStream은 throw하지 않고 { success: false, error } 반환
    if (!responseData.success && responseData.error) {
      const err = responseData.error;
      if (
        (err.includes('auth') && !err.includes('Loaded cached credentials')) ||
        err.includes('not authenticated') ||
        err.includes('login required')
      ) {
        return NextResponse.json(
          {
            error: 'Gemini CLI authentication required',
            details: 'Run "gemini" in terminal first to complete Google OAuth login.',
          },
          { status: 401 }
        );
      }
    }

    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log('Gemini', 'ERROR', errorMessage);

    return NextResponse.json(
      { error: 'Failed to execute Gemini', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for documentation
 */
export async function GET() {
  return NextResponse.json({
    message: 'Gemini CLI API Wrapper',
    provider: 'gemini',
    model: 'gemini-2.5-pro (default)',
    cost: 'Free (Google account)',
    auth: 'Google OAuth (run "gemini" in terminal first)',
    limits: {
      free: '1,000 req/day, 60 req/min',
    },
    usage: 'POST /api/gemini with { "prompt": "your prompt here" }',
    options: {
      prompt: 'string (required) - The prompt to send to Gemini',
      files: 'FileAttachment[] (optional) - Attached files as base64',
      model: 'string (optional, default: gemini-2.5-pro)',
      yolo: 'boolean (optional, default: true) - Auto-approve tool usage',
      sandbox: 'boolean (optional, default: false) - Disable tool usage',
    },
    note: 'Uses Gemini CLI stream-json output format for structured responses.',
  });
}

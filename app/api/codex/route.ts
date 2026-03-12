import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import {
  FileAttachment,
  SavedFile,
  validateFiles,
  saveFilesToTemp,
  cleanupTempFiles,
} from '@/lib/file-handler';
import { spawnCodexStream, collectCodexStream } from '@/lib/codex-spawn';

export const maxDuration = 1200; // 20분

/**
 * Codex CLI API Wrapper (sync endpoint)
 *
 * POST /api/codex
 * Internally uses the streaming spawn, collects all events,
 * then returns the assembled JSON response.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      files,
      model,
      sandbox = 'read-only',
    } = body as {
      prompt: string;
      files?: FileAttachment[];
      model?: string;
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    };

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Prompt is required and must be a string' },
        { status: 400 }
      );
    }

    let savedFiles: SavedFile[] = [];
    if (files && Array.isArray(files) && files.length > 0) {
      const validationError = validateFiles(files);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      savedFiles = await saveFilesToTemp(files);
    }

    try {
      const { stream } = spawnCodexStream({ prompt, model, sandbox, savedFiles });
      const response = await collectCodexStream(stream, model);

      // 인증 에러 감지: collectStream은 throw하지 않고 { success: false, error } 반환
      if (!response.success && response.error) {
        const err = response.error;
        if (err.includes('auth') || err.includes('login') || err.includes('ChatGPT')) {
          return NextResponse.json(
            {
              error: 'Codex CLI authentication required',
              details: 'Run "codex" in terminal first to complete ChatGPT OAuth login.',
            },
            { status: 401 }
          );
        }
      }

      return NextResponse.json(response);
    } finally {
      if (savedFiles.length > 0) {
        await cleanupTempFiles(savedFiles);
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log('Codex', 'ERROR', errorMessage);

    return NextResponse.json(
      { error: 'Failed to execute Codex', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for documentation
 */
export async function GET() {
  return NextResponse.json({
    message: 'Codex CLI API Wrapper',
    provider: 'codex',
    model: 'codex default',
    cost: 'ChatGPT subscription (Plus $20/mo or higher)',
    auth: 'ChatGPT OAuth (run "codex" in terminal first)',
    usage: 'POST /api/codex with { "prompt": "your prompt here" }',
    options: {
      prompt: 'string (required) - The prompt to send to Codex',
      files: 'FileAttachment[] (optional) - Attached files as base64',
      model: 'string (optional) - Model to use',
      sandbox: 'string (optional, default: read-only) - read-only | workspace-write | danger-full-access',
    },
    note: 'Requires ChatGPT Plus subscription.',
  });
}

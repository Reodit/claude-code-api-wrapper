import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import {
  FileAttachment,
  SavedFile,
  validateFiles,
  saveFilesToTemp,
  buildFilePromptInstructions,
  cleanupTempFiles,
} from '@/lib/file-handler';

/**
 * Gemini CLI API Wrapper
 *
 * POST /api/gemini
 * Body: {
 *   prompt: string;
 *   model?: string;       // 기본값: gemini-2.5-pro
 *   files?: FileAttachment[];
 *   yolo?: boolean;        // 도구 자동 승인 (기본값: true)
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      files,
      model,
      yolo = true,
    } = body as {
      prompt: string;
      files?: FileAttachment[];
      model?: string;
      yolo?: boolean;
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

    // Gemini CLI 경로 감지
    const possiblePaths = [
      '/opt/homebrew/bin/gemini',
      '/usr/local/bin/gemini',
      'gemini',
    ];

    const geminiPath = possiblePaths.find(path =>
      path === 'gemini' || existsSync(path)
    ) || 'gemini';

    const args: string[] = [];

    // 모델 설정
    if (model && typeof model === 'string') {
      args.push('-m', model);
    }

    // yolo 모드 (도구 자동 승인)
    if (yolo) {
      args.push('-y');
    }

    // 프롬프트 구성
    let augmentedPrompt = prompt;
    if (savedFiles.length > 0) {
      const fileInstructions = buildFilePromptInstructions(savedFiles);
      augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
    }

    args.push('-p', augmentedPrompt);

    console.log(`Executing Gemini CLI: ${geminiPath} ${args.slice(0, -1).join(' ')}`);

    try {
      const startTime = Date.now();

      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(geminiPath, args, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
            TERM: 'xterm-256color',
            CLAUDECODE: '',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        child.stdin.end();

        let stdoutData = '';
        let stderrData = '';

        child.stdout.on('data', (data) => {
          stdoutData += data.toString();
        });

        child.stderr.on('data', (data) => {
          stderrData += data.toString();
        });

        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('Gemini request timed out'));
        }, 600000); // 10분 타임아웃

        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve(stdoutData);
          } else {
            const errorMsg = `Process exited with code ${code}, signal ${signal}`;
            const fullError = stderrData ? `${errorMsg}\nStderr: ${stderrData}` : errorMsg;
            reject(new Error(fullError));
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const durationMs = Date.now() - startTime;

      // Gemini CLI는 텍스트만 출력 — "Loaded cached credentials." 줄 제거
      const resultText = output
        .split('\n')
        .filter(line => !line.startsWith('Loaded cached credentials'))
        .join('\n')
        .trim();

      return NextResponse.json({
        success: true,
        provider: 'gemini',
        result: resultText,
        metadata: {
          model: model || 'gemini-2.5-pro',
          duration_ms: durationMs,
          cost_usd: 0, // Gemini CLI는 무료
        },
        raw_output: output,
      });

    } finally {
      if (savedFiles.length > 0) {
        await cleanupTempFiles(savedFiles);
      }
    }
  } catch (error: unknown) {
    console.error('Gemini API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // 인증 에러 감지
    if (errorMessage.includes('credentials') || errorMessage.includes('auth')) {
      return NextResponse.json(
        {
          error: 'Gemini CLI authentication required',
          details: 'Run "gemini" in terminal first to complete Google OAuth login.',
        },
        { status: 401 }
      );
    }

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
    },
    note: 'Gemini CLI outputs plain text only. No JSON streaming or detailed metadata available.',
  });
}

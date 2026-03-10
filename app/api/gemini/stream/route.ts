import { NextRequest } from 'next/server';
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
 * Gemini CLI Streaming API Wrapper
 *
 * Gemini CLI의 --output-format stream-json JSONL 출력을 그대로 스트리밍합니다.
 */
export async function POST(request: NextRequest) {
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
    return new Response(JSON.stringify({ error: 'Prompt required' }), { status: 400 });
  }

  // 파일 첨부 처리
  let savedFiles: SavedFile[] = [];
  if (files && Array.isArray(files) && files.length > 0) {
    const validationError = validateFiles(files);
    if (validationError) {
      return new Response(JSON.stringify({ error: validationError }), { status: 400 });
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

  const args: string[] = ['--output-format', 'stream-json'];

  if (model && typeof model === 'string') {
    args.push('-m', model);
  }

  if (yolo) {
    args.push('-y');
  }

  let augmentedPrompt = prompt;
  if (savedFiles.length > 0) {
    const fileInstructions = buildFilePromptInstructions(savedFiles);
    augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
  }

  args.push('-p', augmentedPrompt);

  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;
      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      };

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

      let buffer = '';

      child.stdout.on('data', (data) => {
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('Loaded cached credentials') || trimmed.startsWith('Skill conflict')) continue;
          try {
            JSON.parse(trimmed); // 유효성 검사
            controller.enqueue(new TextEncoder().encode(trimmed + '\n'));
          } catch {
            // non-JSON line, skip
          }
        }
      });

      child.stderr.on('data', (data) => {
        console.error('Gemini stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        child.kill();
        controller.enqueue(new TextEncoder().encode(
          JSON.stringify({ type: 'error', message: 'Request timed out' }) + '\n'
        ));
        safeClose();
        if (savedFiles.length > 0) {
          cleanupTempFiles(savedFiles).catch(console.error);
        }
      }, 600000); // 10분

      child.on('close', (code) => {
        clearTimeout(timeout);

        // 버퍼에 남은 데이터 처리
        if (buffer.trim()) {
          try {
            JSON.parse(buffer.trim());
            controller.enqueue(new TextEncoder().encode(buffer.trim() + '\n'));
          } catch {
            // skip
          }
        }

        if (code !== 0) {
          controller.enqueue(new TextEncoder().encode(
            JSON.stringify({ type: 'error', message: `Process exited with code ${code}` }) + '\n'
          ));
        }
        safeClose();
        if (savedFiles.length > 0) {
          cleanupTempFiles(savedFiles).catch(console.error);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        controller.enqueue(new TextEncoder().encode(
          JSON.stringify({ type: 'error', message: err.message }) + '\n'
        ));
        safeClose();
        if (savedFiles.length > 0) {
          cleanupTempFiles(savedFiles).catch(console.error);
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

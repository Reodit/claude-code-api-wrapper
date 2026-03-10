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
 * Codex CLI Streaming API Wrapper
 *
 * Codex CLI의 --json JSONL 출력을 그대로 스트리밍합니다.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    prompt,
    files,
    model,
    sandboxMode = 'danger-full-access',
  } = body as {
    prompt: string;
    files?: FileAttachment[];
    model?: string;
    sandboxMode?: string;
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

  // Codex CLI 경로 감지
  const possiblePaths = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    'codex',
  ];

  const codexPath = possiblePaths.find(path =>
    path === 'codex' || existsSync(path)
  ) || 'codex';

  const args: string[] = ['exec', '--json'];

  if (sandboxMode) {
    args.push('--sandbox', sandboxMode);
  }

  if (model && typeof model === 'string') {
    args.push('-m', model);
  }

  let augmentedPrompt = prompt;
  if (savedFiles.length > 0) {
    const fileInstructions = buildFilePromptInstructions(savedFiles);
    augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
  }

  args.push(augmentedPrompt);

  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;
      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      };

      const child = spawn(codexPath, args, {
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
          if (line.trim()) {
            try {
              JSON.parse(line); // 유효성 검사
              controller.enqueue(new TextEncoder().encode(line + '\n'));
            } catch {
              // 무시
            }
          }
        }
      });

      child.stderr.on('data', (data) => {
        console.error('Codex stderr:', data.toString());
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
      }, 1200000); // 20분

      child.on('close', (code) => {
        clearTimeout(timeout);

        if (buffer.trim()) {
          try {
            JSON.parse(buffer);
            controller.enqueue(new TextEncoder().encode(buffer + '\n'));
          } catch {
            // 무시
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

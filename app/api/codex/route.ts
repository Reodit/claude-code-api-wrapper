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

interface CodexItem {
  id?: string;
  type?: string;
  item_type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  file_path?: string;
  diff?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  message?: string;
  error?: { message: string };
}

/**
 * Codex CLI API Wrapper
 *
 * POST /api/codex
 * Body: {
 *   prompt: string;
 *   model?: string;         // 기본값: CLI 기본 모델
 *   files?: FileAttachment[];
 *   sandboxMode?: string;   // 'read-only' | 'workspace-write' | 'danger-full-access'
 * }
 */
export async function POST(request: NextRequest) {
  try {
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

    // sandbox 모드
    if (sandboxMode) {
      args.push('--sandbox', sandboxMode);
    }

    // 모델 설정
    if (model && typeof model === 'string') {
      args.push('-m', model);
    }

    // 프롬프트 구성
    let augmentedPrompt = prompt;
    if (savedFiles.length > 0) {
      const fileInstructions = buildFilePromptInstructions(savedFiles);
      augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
    }

    args.push(augmentedPrompt);

    console.log(`Executing Codex CLI: ${codexPath} ${args.slice(0, -1).join(' ')}`);

    try {
      const output = await new Promise<string>((resolve, reject) => {
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
          reject(new Error('Codex request timed out'));
        }, 1200000); // 20분

        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve(stdoutData);
          } else {
            // Codex는 에러 시에도 JSON을 stdout에 출력하므로 stdout 우선 반환
            if (stdoutData.trim()) {
              resolve(stdoutData);
            } else {
              const errorMsg = `Process exited with code ${code}, signal ${signal}`;
              const fullError = stderrData ? `${errorMsg}\nStderr: ${stderrData}` : errorMsg;
              reject(new Error(fullError));
            }
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // JSONL 파싱
      const lines = output.trim().split('\n');
      const events: CodexEvent[] = [];
      let resultText = '';
      const toolsUsed: string[] = [];
      let threadId = '';
      let hasError = false;
      let errorMessage = '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as CodexEvent;
          events.push(parsed);

          if (parsed.type === 'thread.started') {
            threadId = parsed.thread_id || '';
          }

          // 텍스트 응답 추출
          if (parsed.type === 'item.completed' && parsed.item) {
            if (parsed.item.item_type === 'assistant_message' || parsed.item.type === 'assistant_message') {
              resultText += (parsed.item.text || '') + '\n';
            }
            if (parsed.item.item_type === 'command_execution' || parsed.item.type === 'command_execution') {
              if (!toolsUsed.includes('Bash')) toolsUsed.push('Bash');
            }
            if (parsed.item.item_type === 'file_change' || parsed.item.type === 'file_change') {
              if (!toolsUsed.includes('FileEdit')) toolsUsed.push('FileEdit');
            }
            if (parsed.item.item_type === 'web_search' || parsed.item.type === 'web_search') {
              if (!toolsUsed.includes('WebSearch')) toolsUsed.push('WebSearch');
            }
          }

          // 에러 감지
          if (parsed.type === 'error') {
            hasError = true;
            errorMessage = parsed.message || '';
          }
          if (parsed.type === 'turn.failed') {
            hasError = true;
            errorMessage = parsed.error?.message || errorMessage;
          }
        } catch {
          console.error('Failed to parse Codex line:', line.substring(0, 100));
        }
      }

      return NextResponse.json({
        success: !hasError,
        provider: 'codex',
        result: resultText.trim(),
        events,
        metadata: {
          thread_id: threadId,
          tools_used: toolsUsed,
          model: model || 'default',
          cost_usd: 0, // 구독 기반
        },
        ...(hasError && { error: errorMessage }),
        raw_output: output,
      });

    } finally {
      if (savedFiles.length > 0) {
        await cleanupTempFiles(savedFiles);
      }
    }
  } catch (error: unknown) {
    console.error('Codex API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // 인증 에러 감지
    if (errorMessage.includes('auth') || errorMessage.includes('login') || errorMessage.includes('ChatGPT')) {
      return NextResponse.json(
        {
          error: 'Codex CLI authentication required',
          details: 'Run "codex" in terminal first to complete ChatGPT OAuth login. ChatGPT Plus subscription required.',
        },
        { status: 401 }
      );
    }

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
    model: 'gpt-5.3-codex (default)',
    cost: 'ChatGPT subscription (Plus $20/mo or higher)',
    auth: 'ChatGPT OAuth (run "codex" in terminal first)',
    usage: 'POST /api/codex with { "prompt": "your prompt here" }',
    options: {
      prompt: 'string (required) - The prompt to send to Codex',
      files: 'FileAttachment[] (optional) - Attached files as base64',
      model: 'string (optional) - Model to use',
      sandboxMode: 'string (optional, default: danger-full-access) - read-only | workspace-write | danger-full-access',
    },
    note: 'Requires ChatGPT Plus subscription. Free accounts are not supported for Codex CLI.',
  });
}

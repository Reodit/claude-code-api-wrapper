import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { log } from '@/lib/logger';
import {
  SavedFile,
  buildFilePromptInstructions,
} from '@/lib/file-handler';

export interface CodexSpawnOptions {
  prompt: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  savedFiles?: SavedFile[];
}

const IDLE_TIMEOUT_MS = 300000; // 5분간 데이터 없으면 타임아웃

function findCodexPath(): string {
  const possiblePaths = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    'codex',
  ];
  return possiblePaths.find(p => p === 'codex' || existsSync(p)) || 'codex';
}

/**
 * Spawns the Codex CLI (exec --json) and returns a ReadableStream of JSONL lines + child process.
 * The caller is responsible for cleanup of savedFiles after the stream ends.
 */
export function spawnCodexStream(options: CodexSpawnOptions): { stream: ReadableStream<Uint8Array>; child: ChildProcess } {
  const {
    prompt,
    model,
    sandbox = 'read-only',
    savedFiles = [],
  } = options;

  const codexPath = findCodexPath();
  const args: string[] = ['exec', '--json', '--sandbox', sandbox];

  if (model && typeof model === 'string') {
    args.push('-m', model);
  }

  let augmentedPrompt = prompt;
  if (savedFiles.length > 0) {
    const fileInstructions = buildFilePromptInstructions(savedFiles);
    augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
  }

  args.push(augmentedPrompt);

  log('Codex', 'INFO', `Executing: ${codexPath} ${args.slice(0, -1).join(' ')} [${augmentedPrompt.length} chars]`);

  const child = spawn(codexPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.end();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let isClosed = false;
      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      };

      let buffer = '';

      let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
      function resetIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
      }
      function onIdle() {
        log('Codex', 'WARN', `Idle timeout: no data for ${IDLE_TIMEOUT_MS / 1000}s`);
        child.kill();
        controller.enqueue(encoder.encode(
          JSON.stringify({ type: 'error', message: `Idle timeout: no data for ${IDLE_TIMEOUT_MS / 1000}s` }) + '\n'
        ));
        safeClose();
      }

      child.stdout.on('data', (data: Buffer) => {
        resetIdleTimer();
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            JSON.parse(trimmed);
            controller.enqueue(encoder.encode(trimmed + '\n'));
          } catch {
            // non-JSON line, skip
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        resetIdleTimer();
        const chunk = data.toString();
        log('Codex', 'WARN', `stderr: ${chunk.trim()}`);
      });

      child.on('close', (code, signal) => {
        clearTimeout(idleTimer);
        log('Codex', 'INFO', `Process exited: code=${code} signal=${signal}`);

        if (buffer.trim()) {
          try {
            JSON.parse(buffer.trim());
            controller.enqueue(encoder.encode(buffer.trim() + '\n'));
          } catch {
            // skip
          }
        }

        if (code !== 0) {
          controller.enqueue(encoder.encode(
            JSON.stringify({ type: 'error', message: `Process exited with code ${code}` }) + '\n'
          ));
        }
        safeClose();
      });

      child.on('error', (err) => {
        clearTimeout(idleTimer);
        controller.enqueue(encoder.encode(
          JSON.stringify({ type: 'error', message: err.message }) + '\n'
        ));
        safeClose();
      });
    },
  });

  return { stream, child };
}

/**
 * Collects all JSONL events from a Codex stream into a structured response.
 * Used by the sync endpoint.
 */
export async function collectCodexStream(
  stream: ReadableStream<Uint8Array>,
  model?: string,
): Promise<{
  success: boolean;
  provider: string;
  result: string;
  events: Record<string, unknown>[];
  metadata: {
    thread_id: string;
    model: string;
    duration_ms: number;
    usage: Record<string, unknown>;
    cost_usd: number;
  };
  error?: string;
  raw_output: string;
}> {
  const startTime = Date.now();
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  let rawOutput = '';
  let resultText = '';
  let threadId = '';
  let usedModel = model || '';
  let usage: Record<string, unknown> = {};
  let hasError = false;
  let errorMessage = '';
  const events: Record<string, unknown>[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      rawOutput += chunk;

      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          events.push(parsed);

          if (parsed.type === 'thread.started') {
            threadId = parsed.thread_id || '';
          }
          if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message') {
            resultText += parsed.item.text || '';
          }
          if (parsed.type === 'turn.completed' && parsed.usage) {
            usage = parsed.usage;
          }
          if (parsed.type === 'item.completed' && parsed.item?.type === 'error') {
            hasError = true;
            errorMessage = parsed.item.message || '';
          }
          if (parsed.type === 'error') {
            hasError = true;
            errorMessage = parsed.message || '';
          }
        } catch {
          // skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const durationMs = Date.now() - startTime;

  log('Codex', 'INFO', 'Response', {
    result: resultText.trim().substring(0, 200),
    duration_ms: durationMs,
    model: usedModel,
    usage,
  });

  return {
    success: !hasError,
    provider: 'codex',
    result: resultText.trim(),
    events,
    metadata: {
      thread_id: threadId,
      model: usedModel || 'codex-default',
      duration_ms: durationMs,
      usage,
      cost_usd: 0,
    },
    ...(hasError && { error: errorMessage }),
    raw_output: rawOutput,
  };
}

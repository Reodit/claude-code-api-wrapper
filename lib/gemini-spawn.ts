import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { log } from '@/lib/logger';
import {
  SavedFile,
  buildFilePromptInstructions,
} from '@/lib/file-handler';

export interface GeminiSpawnOptions {
  prompt: string;
  model?: string;
  yolo?: boolean;
  sandbox?: boolean;
  savedFiles?: SavedFile[];
}

const STDERR_NOISE = ['Loaded cached credentials', 'Skill conflict', 'YOLO mode'];

function isStderrNoise(chunk: string): boolean {
  return STDERR_NOISE.some(pattern => chunk.includes(pattern));
}

/**
 * Finds the Gemini CLI binary path.
 */
function findGeminiPath(): string {
  const possiblePaths = [
    '/opt/homebrew/bin/gemini',
    '/usr/local/bin/gemini',
    'gemini',
  ];
  return possiblePaths.find(p => p === 'gemini' || existsSync(p)) || 'gemini';
}

const IDLE_TIMEOUT_MS = 300000; // 5분간 데이터 없으면 타임아웃

/**
 * Spawns the Gemini CLI and returns a ReadableStream of JSONL lines + child process.
 *
 * Each chunk is a single JSON line followed by '\n'.
 * On timeout or process error, an error event is enqueued before closing.
 * The caller is responsible for cleanup of savedFiles after the stream ends.
 */
export function spawnGeminiStream(options: GeminiSpawnOptions): { stream: ReadableStream<Uint8Array>; child: ChildProcess } {
  const {
    prompt,
    model,
    yolo = true,
    sandbox = false,
    savedFiles = [],
  } = options;

  const geminiPath = findGeminiPath();
  const args: string[] = ['--output-format', 'stream-json', '--include-directories', tmpdir()];

  if (model && typeof model === 'string') {
    args.push('-m', model);
  }

  if (sandbox) {
    args.push('--sandbox');
  }

  if (yolo && !sandbox) {
    args.push('-y');
  }

  let augmentedPrompt = prompt;
  if (savedFiles.length > 0) {
    const fileInstructions = buildFilePromptInstructions(savedFiles);
    augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
  }

  args.push('-p', augmentedPrompt);

  log('Gemini', 'INFO', `Executing: ${geminiPath} ${args.slice(0, -1).join(' ')}`);
  log('Gemini', 'INFO', `Prompt length: ${augmentedPrompt.length} chars`);

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
        log('Gemini', 'WARN', `Idle timeout: no data for ${IDLE_TIMEOUT_MS / 1000}s`);
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
          if (isStderrNoise(trimmed)) continue;
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
        if (!isStderrNoise(chunk)) {
          log('Gemini', 'WARN', `stderr: ${chunk.trim()}`);
        }
      });

      child.on('close', (code, signal) => {
        clearTimeout(idleTimer);
        log('Gemini', 'INFO', `Process exited: code=${code} signal=${signal}`);

        // Flush remaining buffer
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
 * Collects all JSONL events from a Gemini stream into a structured response.
 * Used by the sync endpoint to internally consume the stream.
 */
export async function collectGeminiStream(
  stream: ReadableStream<Uint8Array>,
  model?: string,
): Promise<{
  success: boolean;
  provider: string;
  result: string;
  events: Record<string, unknown>[];
  metadata: {
    session_id: string;
    model: string;
    duration_ms: number;
    stats: Record<string, unknown>;
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
  let sessionId = '';
  let usedModel = model || '';
  let stats: Record<string, unknown> = {};
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

          if (parsed.type === 'init') {
            sessionId = parsed.session_id || '';
            usedModel = parsed.model || usedModel;
          }
          if (parsed.type === 'message' && parsed.role === 'assistant') {
            resultText += parsed.content || '';
          }
          if (parsed.type === 'result') {
            stats = parsed.stats || {};
            hasError = parsed.status !== 'success';
          }
          if (parsed.type === 'error') {
            hasError = true;
            errorMessage = parsed.message || parsed.content || '';
          }
        } catch {
          // non-JSON line, skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const durationMs = Date.now() - startTime;

  log('Gemini', 'INFO', 'Response', {
    result: resultText.trim().substring(0, 200),
    duration_ms: durationMs,
    model: usedModel,
    stats,
  });

  return {
    success: !hasError,
    provider: 'gemini',
    result: resultText.trim(),
    events,
    metadata: {
      session_id: sessionId,
      model: usedModel || 'gemini-2.5-pro',
      duration_ms: durationMs,
      stats,
      cost_usd: 0,
    },
    ...(hasError && { error: errorMessage }),
    raw_output: rawOutput,
  };
}

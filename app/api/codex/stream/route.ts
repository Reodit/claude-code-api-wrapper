import { NextRequest } from 'next/server';
import {
  FileAttachment,
  SavedFile,
  validateFiles,
  saveFilesToTemp,
  cleanupTempFiles,
} from '@/lib/file-handler';
import { spawnCodexStream } from '@/lib/codex-spawn';
import { log, createStreamLogger } from '@/lib/logger';

/**
 * Codex CLI Streaming API Wrapper
 *
 * POST /api/codex/stream
 */
export async function POST(request: NextRequest) {
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
    return new Response(JSON.stringify({ error: 'Prompt required' }), { status: 400 });
  }

  let savedFiles: SavedFile[] = [];
  if (files && Array.isArray(files) && files.length > 0) {
    const validationError = validateFiles(files);
    if (validationError) {
      return new Response(JSON.stringify({ error: validationError }), { status: 400 });
    }
    savedFiles = await saveFilesToTemp(files);
  }

  const { stream: rawStream, child } = spawnCodexStream({ prompt, model, sandbox, savedFiles });
  const streamLog = createStreamLogger('codex');
  const decoder = new TextDecoder();

  const loggedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = rawStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          streamLog.logLine(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (err) {
        child.kill();
        const msg = err instanceof Error ? err.message : 'Stream error';
        log('Codex', 'ERROR', msg);
        const errLine = JSON.stringify({ type: 'error', message: msg }) + '\n';
        streamLog.logLine(errLine);
        controller.enqueue(new TextEncoder().encode(errLine));
      } finally {
        controller.close();
        if (savedFiles.length > 0) {
          await cleanupTempFiles(savedFiles);
        }
      }
    },
    cancel() {
      child.kill();
      streamLog.logLine(JSON.stringify({ type: 'cancel', message: 'Client disconnected' }) + '\n');
      if (savedFiles.length > 0) {
        cleanupTempFiles(savedFiles).catch(console.error);
      }
    },
  });

  return new Response(loggedStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

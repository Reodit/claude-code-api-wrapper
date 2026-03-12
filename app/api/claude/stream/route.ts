import { NextRequest } from 'next/server';
import { log, createStreamLogger } from '@/lib/logger';
import {
  cleanupTempFiles,
} from '@/lib/file-handler';
import {
  ClaudeRequestBody,
  prepareRequest,
  isPreparedRequest,
  spawnClaudeStream,
} from '@/lib/claude-stream';

export const maxDuration = 1200; // 20분

/**
 * Claude Code API Wrapper (streaming endpoint)
 *
 * POST /api/claude/stream
 * Pipes JSONL events from the Claude CLI directly to the client.
 */
export async function POST(request: NextRequest) {
  let body: ClaudeRequestBody;
  try {
    body = await request.json() as ClaudeRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const prepared = await prepareRequest(body);
  if (!isPreparedRequest(prepared)) {
    return new Response(JSON.stringify({ error: prepared.error }), { status: 400 });
  }

  const { augmentedPrompt, savedFiles } = prepared;
  const { stream, child } = spawnClaudeStream(body, augmentedPrompt);
  const streamLog = createStreamLogger('claude');
  const decoder = new TextDecoder();

  const wrappedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // 스트림 내역을 파일에 기록
          streamLog.logLine(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (err) {
        child.kill();
        const msg = err instanceof Error ? err.message : 'Stream error';
        log('Claude', 'ERROR', msg);
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

  return new Response(wrappedStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

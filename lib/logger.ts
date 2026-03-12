import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'logs');
const STREAM_LOG_DIR = join(LOG_DIR, 'streams');
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(STREAM_LOG_DIR, { recursive: true });

function getLogPath(): string {
  const date = new Date().toISOString().split('T')[0];
  return join(LOG_DIR, `${date}.log`);
}

function timestamp(): string {
  return new Date().toISOString();
}

export function log(provider: string, level: 'INFO' | 'ERROR' | 'WARN', message: string, data?: Record<string, unknown>) {
  const line = `[${timestamp()}] [${provider}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  console.log(line.trim());
  try {
    appendFileSync(getLogPath(), line);
  } catch {
    // 파일 쓰기 실패 시 콘솔에만 출력
  }
}

/**
 * 스트림 세션 로거. 각 요청마다 개별 JSONL 파일에 스트림 내역 기록.
 * logs/streams/{provider}_{timestamp}_{id}.jsonl
 */
export function createStreamLogger(provider: string, requestId?: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = requestId || Math.random().toString(36).substring(2, 8);
  const filename = `${provider}_${ts}_${id}.jsonl`;
  const filepath = join(STREAM_LOG_DIR, filename);

  log(provider, 'INFO', `Stream log: ${filename}`);

  return {
    /** JSONL 한 줄 기록 */
    logLine(line: string) {
      try {
        appendFileSync(filepath, line.endsWith('\n') ? line : line + '\n');
      } catch {}
    },
    filepath,
    filename,
  };
}

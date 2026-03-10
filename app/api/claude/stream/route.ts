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

interface MCPServer {
  name: string;
  transport: 'http' | 'stdio' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
}

// MCP 서버 설정 (예시 - 필요시 추가)
// WebSearch는 Claude Code 내장 도구로 이미 사용 가능
const MCP_SERVERS: MCPServer[] = [
  // 예시: Alpha Vantage (금융 데이터) - API 키 필요
  // { name: 'alphavantage', transport: 'http', url: 'https://mcp.alphavantage.co/mcp?apikey=YOUR_KEY' },
];

interface CustomAgent {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

const DEFAULT_AGENTS: Record<string, CustomAgent> = {
  'financial-analyst': {
    description: '금융 분석 전문가. 주식, 경제지표, 시장 동향 분석에 사용.',
    prompt: `금융 분석 전문가. 데이터 출처 명시, 리스크 언급, 면책 조항 포함.`,
    tools: ['WebSearch', 'WebFetch'],
    model: 'sonnet'
  }
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { prompt, files, agents, useDefaultAgents = true } = body as {
    prompt: string;
    files?: FileAttachment[];
    agents?: Record<string, CustomAgent>;
    useDefaultAgents?: boolean;
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

  // Claude CLI 경로 감지
  const possiblePaths = [
    '/opt/homebrew/bin/claude',  // macOS Homebrew
    'claude'  // PATH에서 찾기
  ];

  const claudePath = possiblePaths.find(path =>
    path === 'claude' || existsSync(path)
  ) || 'claude';
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-opus-4-5-20251101',  // 최신 Opus 4.5
    '--dangerously-skip-permissions',
  ];

  // MCP 서버 설정
  if (MCP_SERVERS.length > 0) {
    const mcpConfig: Record<string, Record<string, unknown>> = {};
    for (const server of MCP_SERVERS) {
      if (server.transport === 'stdio') {
        mcpConfig[server.name] = {
          transport: 'stdio',
          command: server.command,
          args: server.args || [],
        };
      } else {
        mcpConfig[server.name] = { transport: server.transport, url: server.url || '' };
      }
    }
    args.push('--mcp-config', JSON.stringify(mcpConfig));
  }

  // 에이전트 설정
  const mergedAgents: Record<string, CustomAgent> = {};
  if (useDefaultAgents) Object.assign(mergedAgents, DEFAULT_AGENTS);
  if (agents && typeof agents === 'object') Object.assign(mergedAgents, agents);
  if (Object.keys(mergedAgents).length > 0) {
    args.push('--agents', JSON.stringify(mergedAgents));
  }

  // 파일 첨부 시 프롬프트에 파일 경로 및 처리 지시 추가
  let augmentedPrompt = prompt;
  if (savedFiles.length > 0) {
    const fileInstructions = buildFilePromptInstructions(savedFiles);
    augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
  }

  args.push(augmentedPrompt);

  // ReadableStream으로 스트리밍 응답
  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;
      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      };

      const child = spawn(claudePath, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
          TERM: 'xterm-256color',
          CLAUDECODE: '',  // 중첩 세션 방지 우회
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.end();

      let buffer = '';

      child.stdout.on('data', (data) => {
        buffer += data.toString();

        // 줄바꿈으로 분리하여 완전한 JSON 라인만 전송
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 마지막 불완전한 라인은 버퍼에 유지

        for (const line of lines) {
          if (line.trim()) {
            try {
              // JSON 유효성 검사
              JSON.parse(line);
              controller.enqueue(new TextEncoder().encode(line + '\n'));
            } catch {
              // 유효하지 않은 JSON은 무시
            }
          }
        }
      });

      child.stderr.on('data', (data) => {
        console.error('Claude stderr:', data.toString());
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
      }, 1200000); // 20분 타임아웃

      child.on('close', (code) => {
        clearTimeout(timeout);

        // 남은 버퍼 처리
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
        // 임시 파일 정리
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

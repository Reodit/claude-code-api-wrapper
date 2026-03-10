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

// MCP 서버 설정 (예시 - 필요시 추가)
// WebSearch는 Claude Code 내장 도구로 이미 사용 가능
const MCP_SERVERS: MCPServer[] = [
  // 예시: Alpha Vantage (금융 데이터) - API 키 필요
  // { name: 'alphavantage', transport: 'http', url: 'https://mcp.alphavantage.co/mcp?apikey=YOUR_KEY' },
  // 예시: Notion - OAuth 필요
  // { name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' },
];

interface MCPServer {
  name: string;
  transport: 'http' | 'stdio' | 'sse';
  url?: string;           // for http/sse
  command?: string;       // for stdio
  args?: string[];        // for stdio
  env?: Record<string, string>;  // environment variables
}

// 커스텀 서브에이전트 인터페이스
interface CustomAgent {
  description: string;           // 에이전트 설명 (Claude가 위임 시점 결정에 사용)
  prompt: string;                // 시스템 프롬프트
  tools?: string[];              // 사용 가능한 도구 목록
  disallowedTools?: string[];    // 차단할 도구 목록
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';  // 모델 선택
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

// 기본 서브에이전트 설정
const DEFAULT_AGENTS: Record<string, CustomAgent> = {
  'financial-analyst': {
    description: '금융 분석 전문가. 주식, 경제지표, 시장 동향 분석에 사용.',
    prompt: `금융 분석 전문가. 데이터 출처 명시, 리스크 언급, 면책 조항 포함.`,
    tools: ['WebSearch', 'WebFetch'],
    model: 'sonnet'
  }
};

interface ClaudeMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event';
  subtype?: string;
  event?: {
    type: string;
    message?: Record<string, unknown>;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  };
  message?: {
    model?: string;
    id?: string;
    role?: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: Record<string, unknown>;
    stop_reason?: string | null;
  };
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  mcp_servers?: string[];
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claude_code_version?: string;
  output_style?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: string[];
  uuid?: string;
  parent_tool_use_id?: string | null;
}

interface ClaudeAPIResponse {
  success: boolean;
  result: string;
  messages: ClaudeMessage[];  // 모든 메시지 (init, stream_event, assistant, user, result)
  metadata: {
    session_id: string;
    duration_ms: number;
    duration_api_ms: number;
    num_turns: number;
    cost_usd: number;
    tools_used: string[];
    model: string;
    usage: Record<string, unknown>;
    modelUsage: Record<string, unknown>;
    permission_denials: string[];
  };
  init: {
    cwd: string;
    tools: string[];
    agents: string[];
    slash_commands: string[];
    mcp_servers: string[];
    model: string;
    permissionMode: string;
    claude_code_version: string;
    output_style: string;
  };
  stream_events: ClaudeMessage[];  // stream_event만 별도로
  raw_output: string;  // 원본 출력
}

/**
 * Claude Code API Wrapper
 *
 * POST /api/claude
 * Body: {
 *   prompt: string;
 *   allowedTools?: string[];    // 허용할 도구 목록
 *   disallowedTools?: string[]; // 차단할 도구 목록
 *   systemPrompt?: string;      // 시스템 프롬프트
 *   appendSystemPrompt?: string; // 추가 시스템 프롬프트
 *   agents?: Record<string, CustomAgent>;  // 추가 커스텀 서브에이전트
 *   useDefaultAgents?: boolean; // 기본 에이전트 사용 여부 (기본값: true)
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      files,
      allowedTools,
      disallowedTools,
      systemPrompt,
      appendSystemPrompt,
      agents,
      useDefaultAgents = true,
    } = body as {
      prompt: string;
      files?: FileAttachment[];
      allowedTools?: string[];
      disallowedTools?: string[];
      systemPrompt?: string;
      appendSystemPrompt?: string;
      agents?: Record<string, CustomAgent>;
      useDefaultAgents?: boolean;
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
      '--include-partial-messages',  // 실시간 토큰 스트리밍
      '--model', 'claude-opus-4-5-20251101',  // 최신 Opus 4.5
      '--dangerously-skip-permissions',
    ];

    // 허용 도구
    if (allowedTools && Array.isArray(allowedTools) && allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','));
    }

    // 차단 도구
    if (disallowedTools && Array.isArray(disallowedTools) && disallowedTools.length > 0) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }

    // 시스템 프롬프트
    if (systemPrompt && typeof systemPrompt === 'string') {
      args.push('--system-prompt', systemPrompt);
    }

    // 추가 시스템 프롬프트
    if (appendSystemPrompt && typeof appendSystemPrompt === 'string') {
      args.push('--append-system-prompt', appendSystemPrompt);
    }

    // MCP 서버 설정 추가
    if (MCP_SERVERS.length > 0) {
      const mcpConfig: Record<string, unknown> = {};
      for (const server of MCP_SERVERS) {
        if (server.transport === 'http' || server.transport === 'sse') {
          mcpConfig[server.name] = {
            transport: server.transport,
            url: server.url,
          };
        } else {
          mcpConfig[server.name] = {
            transport: 'stdio',
            command: server.command,
            args: server.args || [],
            env: server.env || {},
          };
        }
      }
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    // 서브에이전트 설정 추가
    const mergedAgents: Record<string, CustomAgent> = {};

    // 기본 에이전트 추가 (useDefaultAgents가 true인 경우)
    if (useDefaultAgents) {
      Object.assign(mergedAgents, DEFAULT_AGENTS);
    }

    // 사용자 정의 에이전트 추가 (기본 에이전트 덮어쓰기 가능)
    if (agents && typeof agents === 'object') {
      Object.assign(mergedAgents, agents);
    }

    // 에이전트가 있으면 CLI에 추가
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

    console.log(`Executing Claude Code: ${claudePath} ${args.slice(0, -1).join(' ')}`);

    try {
    // Execute Claude Code using spawn
    const output = await new Promise<string>((resolve, reject) => {
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

      // Send prompt via stdin for complex prompts
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
        reject(new Error('Claude request timed out'));
      }, 1200000); // 20분 타임아웃

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

    // Parse stream-json output (multiple JSON objects, one per line)
    const lines = output.trim().split('\n');
    const messages: ClaudeMessage[] = [];
    const streamEvents: ClaudeMessage[] = [];
    let initData: ClaudeMessage | null = null;
    let resultData: ClaudeMessage | null = null;
    const toolsUsed: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ClaudeMessage;
        messages.push(parsed);

        if (parsed.type === 'system' && parsed.subtype === 'init') {
          initData = parsed;
        }

        if (parsed.type === 'stream_event') {
          streamEvents.push(parsed);
        }

        if (parsed.type === 'result') {
          resultData = parsed;
        }

        // Track tool usage
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'tool_use' && content.name) {
              if (!toolsUsed.includes(content.name)) {
                toolsUsed.push(content.name);
              }
            }
          }
        }
      } catch {
        console.error('Failed to parse line:', line.substring(0, 100));
      }
    }

    if (!resultData) {
      return NextResponse.json(
        { error: 'No result in Claude response', raw: output.substring(0, 1000) },
        { status: 500 }
      );
    }

    const response: ClaudeAPIResponse = {
      success: !resultData.is_error,
      result: resultData.result || '',
      messages,
      stream_events: streamEvents,
      raw_output: output,
      metadata: {
        session_id: resultData.session_id || '',
        duration_ms: resultData.duration_ms || 0,
        duration_api_ms: resultData.duration_api_ms || 0,
        num_turns: resultData.num_turns || 0,
        cost_usd: resultData.total_cost_usd || 0,
        tools_used: toolsUsed,
        model: 'opus',
        usage: resultData.usage || {},
        modelUsage: resultData.modelUsage || {},
        permission_denials: resultData.permission_denials || [],
      },
      init: {
        cwd: initData?.cwd || '',
        tools: initData?.tools || [],
        agents: initData?.agents || [],
        slash_commands: initData?.slash_commands || [],
        mcp_servers: initData?.mcp_servers || [],
        model: initData?.model || 'opus',
        permissionMode: initData?.permissionMode || '',
        claude_code_version: initData?.claude_code_version || '',
        output_style: initData?.output_style || '',
      },
    };

    return NextResponse.json(response);

    } finally {
      // 임시 파일 정리
      if (savedFiles.length > 0) {
        await cleanupTempFiles(savedFiles);
      }
    }
  } catch (error: unknown) {
    console.error('Claude API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { error: 'Failed to execute Claude', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for documentation
 */
export async function GET() {
  return NextResponse.json({
    message: 'Claude Code API Wrapper (Opus Model)',
    model: 'opus (fixed)',
    mcp_servers: MCP_SERVERS.map(s => s.name),
    default_agents: Object.keys(DEFAULT_AGENTS),
    usage: 'POST /api/claude with { "prompt": "your prompt here" }',
    options: {
      prompt: 'string (required) - The prompt to send to Claude',
      files: 'FileAttachment[] (optional) - Attached files as base64. Each: { filename: string, data: string (base64), mimeType?: string }. Supported: .png, .jpg, .jpeg, .gif, .webp, .pdf, .xlsx, .xls, .docx, .doc, .pptx, .ppt',
      allowedTools: 'string[] (optional) - Tools to allow (e.g., ["WebSearch", "Read"])',
      disallowedTools: 'string[] (optional) - Tools to block (e.g., ["Edit", "Write"])',
      systemPrompt: 'string (optional) - Custom system prompt',
      appendSystemPrompt: 'string (optional) - Append to default system prompt',
      agents: 'Record<string, CustomAgent> (optional) - Custom subagents',
      useDefaultAgents: 'boolean (optional, default: true) - Include default agents',
    },
    agent_schema: {
      description: 'string (required) - When Claude should delegate to this agent',
      prompt: 'string (required) - System prompt for the agent',
      tools: 'string[] (optional) - Allowed tools',
      disallowedTools: 'string[] (optional) - Blocked tools',
      model: 'sonnet | opus | haiku | inherit (optional)',
      permissionMode: 'default | acceptEdits | bypassPermissions | plan (optional)',
    },
    available_tools: [
      'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
      'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill',
    ],
    examples: {
      basic: {
        method: 'POST',
        url: '/api/claude',
        body: {
          prompt: '삼성전자 주가 분석해줘',
        },
      },
      with_custom_agent: {
        method: 'POST',
        url: '/api/claude',
        body: {
          prompt: '최신 AI 뉴스를 요약해줘',
          agents: {
            'news-researcher': {
              description: '뉴스 리서치 전문가. 최신 뉴스 검색 및 요약에 사용.',
              prompt: '당신은 뉴스 리서처입니다. 최신 뉴스를 검색하고 핵심만 요약하세요.',
              tools: ['WebSearch', 'WebFetch'],
              model: 'haiku',
            },
          },
        },
      },
    },
  });
}

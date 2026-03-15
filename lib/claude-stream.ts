import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { log } from '@/lib/logger';
import {
  FileAttachment,
  SavedFile,
  validateFiles,
  saveFilesToTemp,
  buildFilePromptInstructions,
  cleanupTempFiles,
} from '@/lib/file-handler';

// ── Shared types ──

export interface MCPServer {
  name: string;
  transport: 'http' | 'stdio' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CustomAgent {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

export interface ClaudeMessage {
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

export interface ClaudeAPIResponse {
  success: boolean;
  result: string;
  messages: ClaudeMessage[];
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
  stream_events: ClaudeMessage[];
  raw_output: string;
}

export interface ClaudeRequestBody {
  prompt: string;
  files?: FileAttachment[];
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  agents?: Record<string, CustomAgent>;
  useDefaultAgents?: boolean;
}

// ── Shared constants ──

export const MCP_SERVERS: MCPServer[] = [];

export const DEFAULT_AGENTS: Record<string, CustomAgent> = {
  'financial-analyst': {
    description: '금융 분석 전문가. 주식, 경제지표, 시장 동향 분석에 사용.',
    prompt: '금융 분석 전문가. 데이터 출처 명시, 리스크 언급, 면책 조항 포함.',
    tools: ['WebSearch', 'WebFetch'],
    model: 'sonnet',
  },
};

const IDLE_TIMEOUT_MS = 300000; // 5분간 데이터 없으면 타임아웃

// ── Helpers ──

function findClaudePath(): string {
  const possiblePaths = [
    '/opt/homebrew/bin/claude',
    'claude',
  ];
  return possiblePaths.find(p => p === 'claude' || existsSync(p)) || 'claude';
}

function buildArgs(body: ClaudeRequestBody, augmentedPrompt: string): string[] {
  const {
    model,
    allowedTools,
    disallowedTools,
    systemPrompt,
    appendSystemPrompt,
    agents,
    useDefaultAgents = true,
  } = body;

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model || 'claude-opus-4-6-20260205',
    '--dangerously-skip-permissions',
  ];

  if (allowedTools && Array.isArray(allowedTools) && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  if (disallowedTools && Array.isArray(disallowedTools) && disallowedTools.length > 0) {
    args.push('--disallowedTools', disallowedTools.join(','));
  }

  if (systemPrompt && typeof systemPrompt === 'string') {
    args.push('--system-prompt', systemPrompt);
  }

  if (appendSystemPrompt && typeof appendSystemPrompt === 'string') {
    args.push('--append-system-prompt', appendSystemPrompt);
  }

  // MCP servers
  if (MCP_SERVERS.length > 0) {
    const mcpConfig: Record<string, unknown> = {};
    for (const server of MCP_SERVERS) {
      if (server.transport === 'http' || server.transport === 'sse') {
        mcpConfig[server.name] = { transport: server.transport, url: server.url };
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

  // Agents
  const mergedAgents: Record<string, CustomAgent> = {};
  if (useDefaultAgents) Object.assign(mergedAgents, DEFAULT_AGENTS);
  if (agents && typeof agents === 'object') Object.assign(mergedAgents, agents);
  if (Object.keys(mergedAgents).length > 0) {
    args.push('--agents', JSON.stringify(mergedAgents));
  }

  args.push('-p', augmentedPrompt);
  return args;
}

function buildSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}`,
    TERM: 'xterm-256color',
    CLAUDECODE: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
  };
}

// ── File handling wrapper ──

export interface PreparedRequest {
  augmentedPrompt: string;
  savedFiles: SavedFile[];
}

export async function prepareRequest(body: ClaudeRequestBody): Promise<PreparedRequest | { error: string }> {
  const { prompt, files } = body;

  if (!prompt || typeof prompt !== 'string') {
    return { error: 'Prompt is required and must be a string' };
  }

  let savedFiles: SavedFile[] = [];
  if (files && Array.isArray(files) && files.length > 0) {
    const validationError = validateFiles(files);
    if (validationError) {
      return { error: validationError };
    }
    savedFiles = await saveFilesToTemp(files);
  }

  let augmentedPrompt = prompt;
  if (savedFiles.length > 0) {
    const fileInstructions = buildFilePromptInstructions(savedFiles);
    augmentedPrompt = `${fileInstructions}\n\n${prompt}`;
  }

  return { augmentedPrompt, savedFiles };
}

export function isPreparedRequest(result: PreparedRequest | { error: string }): result is PreparedRequest {
  return 'augmentedPrompt' in result;
}

// ── Core streaming function ──

/**
 * Spawns Claude CLI and returns a ReadableStream of JSONL lines.
 * Each chunk is a single JSON line (terminated with \n).
 * The caller is responsible for cleanup of savedFiles after the stream ends.
 */
export function spawnClaudeStream(
  body: ClaudeRequestBody,
  augmentedPrompt: string,
): { stream: ReadableStream<Uint8Array>; child: ChildProcess } {
  const claudePath = findClaudePath();
  const args = buildArgs(body, augmentedPrompt);

  log('Claude', 'INFO', `Executing: ${claudePath} ${args.slice(0, -2).join(' ')} -p [${augmentedPrompt.length} chars]`);

  const child = spawn(claudePath, args, {
    cwd: process.cwd(),
    env: buildSpawnEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.end();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let isClosed = false;
      const safeEnqueue = (data: Uint8Array) => {
        if (!isClosed) controller.enqueue(data);
      };
      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      };

      let buffer = '';

      // 데이터가 흐르는 동안은 타임아웃 안 걸림. 5분간 아무 데이터도 안 오면 죽임.
      let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
      function resetIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
      }
      function onIdle() {
        log('Claude', 'WARN', `Idle timeout: no data for ${IDLE_TIMEOUT_MS / 1000}s`);
        child.kill();
        safeEnqueue(encoder.encode(
          JSON.stringify({ type: 'error', message: `Idle timeout: no data for ${IDLE_TIMEOUT_MS / 1000}s` }) + '\n'
        ));
        safeClose();
      }

      child.stdout!.on('data', (data: Buffer) => {
        resetIdleTimer();
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line); // validate
            safeEnqueue(encoder.encode(line + '\n'));
          } catch {
            // skip invalid JSON
          }
        }
      });

      child.stderr!.on('data', (data: Buffer) => {
        resetIdleTimer();
        const chunk = data.toString();
        log('Claude', 'WARN', `stderr: ${chunk.trim()}`);
      });

      child.on('close', (code, signal) => {
        clearTimeout(idleTimer);
        log('Claude', 'INFO', `Process exited: code=${code} signal=${signal}`);

        // flush remaining buffer
        if (buffer.trim()) {
          try {
            JSON.parse(buffer);
            safeEnqueue(encoder.encode(buffer + '\n'));
          } catch {
            // skip
          }
        }

        if (code !== 0) {
          safeEnqueue(encoder.encode(
            JSON.stringify({ type: 'error', message: `Process exited with code ${code}` }) + '\n'
          ));
        }
        safeClose();
      });

      child.on('error', (err) => {
        clearTimeout(idleTimer);
        safeEnqueue(encoder.encode(
          JSON.stringify({ type: 'error', message: err.message }) + '\n'
        ));
        safeClose();
      });
    },
  });

  return { stream, child };
}

// ── Collect stream into sync response ──

/**
 * Reads all JSONL lines from a Claude stream and assembles the ClaudeAPIResponse.
 */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<ClaudeAPIResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let rawOutput = '';

  const messages: ClaudeMessage[] = [];
  const streamEvents: ClaudeMessage[] = [];
  let initData: ClaudeMessage | null = null;
  let resultData: ClaudeMessage | null = null;
  const toolsUsed: string[] = [];

  // Read the stream to completion
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    rawOutput += chunk;

    const lines = chunk.split('\n');
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
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'tool_use' && content.name && !toolsUsed.includes(content.name)) {
              toolsUsed.push(content.name);
            }
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  if (!resultData) {
    throw new Error(`No result in Claude response. Raw output (first 1000 chars): ${rawOutput.substring(0, 1000)}`);
  }

  const response: ClaudeAPIResponse = {
    success: !resultData.is_error,
    result: resultData.result || '',
    messages,
    stream_events: streamEvents,
    raw_output: rawOutput,
    metadata: {
      session_id: resultData.session_id || '',
      duration_ms: resultData.duration_ms || 0,
      duration_api_ms: resultData.duration_api_ms || 0,
      num_turns: resultData.num_turns || 0,
      cost_usd: resultData.total_cost_usd || 0,
      tools_used: toolsUsed,
      model: initData?.model || 'opus',
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

  log('Claude', 'INFO', 'Response', {
    result: response.result.substring(0, 200),
    cost_usd: response.metadata.cost_usd,
    duration_ms: response.metadata.duration_ms,
    tools_used: toolsUsed,
    usage: response.metadata.usage,
    model: response.init.model,
  });

  return response;
}

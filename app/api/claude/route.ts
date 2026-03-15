import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import {
  cleanupTempFiles,
} from '@/lib/file-handler';
import {
  ClaudeRequestBody,
  MCP_SERVERS,
  DEFAULT_AGENTS,
  prepareRequest,
  isPreparedRequest,
  spawnClaudeStream,
  collectStream,
} from '@/lib/claude-stream';

export const maxDuration = 1200; // 20분

/**
 * Claude Code API Wrapper (sync endpoint)
 *
 * POST /api/claude
 * Internally uses the streaming spawn, collects all events,
 * then returns the assembled JSON response.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ClaudeRequestBody;

    const prepared = await prepareRequest(body);
    if (!isPreparedRequest(prepared)) {
      return NextResponse.json({ error: prepared.error }, { status: 400 });
    }

    const { augmentedPrompt, savedFiles } = prepared;

    try {
      const { stream } = spawnClaudeStream(body, augmentedPrompt);
      const response = await collectStream(stream);

      return NextResponse.json(response);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.startsWith('No result in Claude response')) {
        return NextResponse.json(
          { error: 'No result in Claude response', raw: msg },
          { status: 500 }
        );
      }
      throw error;
    } finally {
      if (savedFiles.length > 0) {
        await cleanupTempFiles(savedFiles);
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log('Claude', 'ERROR', errorMessage);

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
    message: 'Claude Code API Wrapper',
    model: 'claude-opus-4-6-20260205 (default, configurable)',
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

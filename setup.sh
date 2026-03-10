#!/bin/bash
set -e

echo "========================================"
echo "  Claude Code API Wrapper - Setup"
echo "========================================"
echo ""

# Node.js 확인
if ! command -v node &>/dev/null; then
  echo "❌ Node.js가 설치되어 있지 않습니다."
  echo "   https://nodejs.org 에서 설치하세요."
  exit 1
fi
echo "✅ Node.js $(node -v)"

# npm 확인
if ! command -v npm &>/dev/null; then
  echo "❌ npm이 설치되어 있지 않습니다."
  exit 1
fi
echo "✅ npm $(npm -v)"

# Python3 확인
if ! command -v python3 &>/dev/null; then
  echo "⚠️  Python3가 없습니다. 오피스 파일 처리가 제한됩니다."
else
  echo "✅ Python3 $(python3 --version 2>&1 | awk '{print $2}')"
fi

echo ""
echo "----------------------------------------"
echo "  1. 프로젝트 의존성 설치"
echo "----------------------------------------"
npm install

echo ""
echo "----------------------------------------"
echo "  2. CLI 도구 설치"
echo "----------------------------------------"

# Claude Code CLI
if command -v claude &>/dev/null; then
  echo "✅ Claude Code CLI ($(claude --version 2>/dev/null || echo 'installed'))"
else
  echo "📦 Claude Code CLI 설치 중..."
  npm i -g @anthropic-ai/claude-code
  echo "✅ Claude Code CLI 설치 완료"
fi

# Gemini CLI
if command -v gemini &>/dev/null; then
  echo "✅ Gemini CLI ($(gemini --version 2>/dev/null || echo 'installed'))"
else
  echo "📦 Gemini CLI 설치 중..."
  npm i -g @google/gemini-cli
  echo "✅ Gemini CLI 설치 완료"
fi

# Codex CLI
if command -v codex &>/dev/null; then
  echo "✅ Codex CLI ($(codex --version 2>/dev/null || echo 'installed'))"
else
  echo "📦 Codex CLI 설치 중..."
  npm i -g @openai/codex
  echo "✅ Codex CLI 설치 완료"
fi

echo ""
echo "----------------------------------------"
echo "  3. 오피스 스킬 설치 (전체 CLI 공유)"
echo "----------------------------------------"

SKILLS=("anthropics/skills@pdf" "anthropics/skills@xlsx" "anthropics/skills@docx" "anthropics/skills@pptx")
SKILL_NAMES=("PDF" "Excel" "Word" "PPT")
AGENTS=("claude-code" "codex" "gemini-cli")

for i in "${!SKILLS[@]}"; do
  skill="${SKILLS[$i]}"
  name="${SKILL_NAMES[$i]}"
  echo "📦 ${name} 스킬 설치 중..."
  for agent in "${AGENTS[@]}"; do
    npx skills add "$skill" -a "$agent" -y 2>/dev/null \
      && echo "   ✅ ${name} → ${agent}" \
      || echo "   ⚠️  ${name} → ${agent} 설치 실패"
  done
done

echo ""
echo "----------------------------------------"
echo "  4. Python 라이브러리 설치"
echo "----------------------------------------"
if command -v python3 &>/dev/null; then
  pip3 install openpyxl python-docx python-pptx pandas 2>/dev/null \
    || pip3 install --break-system-packages openpyxl python-docx python-pptx pandas 2>/dev/null \
    || echo "⚠️  Python 라이브러리 설치 실패. 수동 설치: pip3 install openpyxl python-docx python-pptx pandas"
  echo "✅ Python 라이브러리 설치 완료"
else
  echo "⚠️  Python3 없음 - 건너뜀"
fi

echo ""
echo "========================================"
echo "  5. 인증 상태 확인"
echo "========================================"

# Claude 인증
if [ -f ~/.claude/.credentials.json ] || [ -f ~/.claude/credentials.json ]; then
  echo "✅ Claude: 인증됨"
else
  echo "⚠️  Claude: 미인증 → 터미널에서 'claude' 실행하여 로그인하세요"
fi

# Gemini 인증
if [ -f ~/.gemini/oauth_creds.json ]; then
  echo "✅ Gemini: 인증됨"
else
  echo "⚠️  Gemini: 미인증 → 터미널에서 'gemini' 실행하여 Google 로그인하세요"
fi

# Codex 인증
if [ -f ~/.codex/auth.json ]; then
  echo "✅ Codex: 인증됨 (ChatGPT Plus 구독 필요)"
else
  echo "⚠️  Codex: 미인증 → 터미널에서 'codex' 실행하여 ChatGPT 로그인하세요"
fi

echo ""
echo "========================================"
echo "  설치 완료!"
echo "========================================"
echo ""
echo "  서버 시작: npm run dev"
echo ""
echo "  API 엔드포인트:"
echo "    Claude:  POST http://localhost:3000/api/claude"
echo "    Gemini:  POST http://localhost:3000/api/gemini"
echo "    Codex:   POST http://localhost:3000/api/codex"
echo ""
echo "  스트리밍:"
echo "    Claude:  POST http://localhost:3000/api/claude/stream"
echo "    Gemini:  POST http://localhost:3000/api/gemini/stream"
echo "    Codex:   POST http://localhost:3000/api/codex/stream"
echo ""

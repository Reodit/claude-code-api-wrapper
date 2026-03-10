# Claude Code API Wrapper

Claude Code, Gemini, Codex CLI를 HTTP API로 래핑하여 외부에서 호출할 수 있게 해주는 Next.js 프로젝트입니다.

## 왜 이 프로젝트를 만들었나?

- **비용 절감**: API 직접 호출 대신 각 서비스 구독으로 사용 (별도 API 비용 없음)
- **멀티 프로바이더**: Claude, Gemini, Codex 3개 AI를 동일한 인터페이스로 사용
- **파일 처리**: 이미지, PDF, Excel, Word, PPT 파일을 base64로 첨부 가능
- **도구 활용**: 각 CLI의 내장 도구 및 스킬 자동 활용

## 빠른 시작

### 1. 클론 및 설치

```bash
git clone https://github.com/Reodit/claude-code-api-wrapper.git
cd claude-code-api-wrapper
bash setup.sh
```

`setup.sh` 하나로 아래가 전부 설치됩니다:
- npm 의존성
- CLI 3개 (Claude Code, Gemini, Codex)
- 오피스 스킬 (PDF, Excel, Word, PPT) - 전체 CLI 공유
- Python 라이브러리 (openpyxl, python-docx 등)

### 2. CLI 인증 (각각 한번만)

```bash
claude    # Anthropic 계정 (브라우저 로그인)
gemini    # Google 계정 (브라우저 로그인)
codex     # ChatGPT 계정 (Plus 구독 필요)
```

다른 계정으로 전환하려면:
```bash
# Claude
claude /logout && claude

# Gemini
rm ~/.gemini/oauth_creds.json && gemini

# Codex
rm ~/.codex/auth.json && codex
```

### 3. 서버 실행

```bash
npm run dev
```

`http://localhost:3000` 으로 접속하면 웹 UI도 사용 가능합니다.

## API 엔드포인트

| 프로바이더 | Sync | Stream | 구독 |
|-----------|------|--------|------|
| Claude | `POST /api/claude` | `POST /api/claude/stream` | Claude Code 구독 |
| Gemini | `POST /api/gemini` | `POST /api/gemini/stream` | 무료 (Google 계정) |
| Codex | `POST /api/codex` | `POST /api/codex/stream` | ChatGPT Plus ($20/mo) |

각 엔드포인트의 `GET` 요청으로 API 문서를 확인할 수 있습니다.

## 사용 예시

### 기본 텍스트 요청

```bash
# Claude
curl -X POST http://localhost:3000/api/claude \
  -H "Content-Type: application/json" \
  -d '{"prompt": "안녕하세요"}'

# Gemini
curl -X POST http://localhost:3000/api/gemini \
  -H "Content-Type: application/json" \
  -d '{"prompt": "안녕하세요"}'

# Codex
curl -X POST http://localhost:3000/api/codex \
  -H "Content-Type: application/json" \
  -d '{"prompt": "안녕하세요"}'
```

### 스트리밍

```bash
curl -N -X POST http://localhost:3000/api/claude/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt": "분석해줘"}' --no-buffer
```

### 파일 첨부 (base64)

```bash
# 이미지
IMG_B64=$(base64 < photo.png)
curl -X POST http://localhost:3000/api/claude \
  -H "Content-Type: application/json" \
  -d "{\"prompt\": \"이 이미지 설명해줘\", \"files\": [{\"filename\": \"photo.png\", \"data\": \"$IMG_B64\"}]}"

# Excel
EXCEL_B64=$(base64 < data.xlsx)
curl -X POST http://localhost:3000/api/gemini \
  -H "Content-Type: application/json" \
  -d "{\"prompt\": \"매출 합계 알려줘\", \"files\": [{\"filename\": \"data.xlsx\", \"data\": \"$EXCEL_B64\"}]}"
```

지원 파일 형식: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`, `.xlsx`, `.xls`, `.docx`, `.doc`, `.pptx`, `.ppt`

### Python

```python
import requests

# Sync
res = requests.post("http://localhost:3000/api/claude", json={"prompt": "안녕"})
print(res.json()["result"])

# Stream
res = requests.post("http://localhost:3000/api/claude/stream", json={"prompt": "분석해줘"}, stream=True)
for line in res.iter_lines():
    if line:
        print(line.decode())
```

### JavaScript

```javascript
// Sync
const res = await fetch('http://localhost:3000/api/gemini', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: '안녕하세요' })
});
const data = await res.json();
console.log(data.result);

// Stream
const stream = await fetch('http://localhost:3000/api/gemini/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: '분석해줘' })
});
const reader = stream.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

## 요청 옵션

### Claude

| 옵션 | 타입 | 설명 |
|------|------|------|
| `prompt` | string | **필수**. 요청 내용 |
| `files` | FileAttachment[] | 첨부 파일 (base64) |
| `agents` | object | 커스텀 서브에이전트 |
| `useDefaultAgents` | boolean | 기본 에이전트 사용 (기본: true) |
| `allowedTools` | string[] | 허용할 도구 목록 |
| `disallowedTools` | string[] | 차단할 도구 목록 |
| `systemPrompt` | string | 시스템 프롬프트 |
| `appendSystemPrompt` | string | 시스템 프롬프트 추가 |
| `mcpConfig` | object | MCP 서버 설정 |

### Gemini

| 옵션 | 타입 | 설명 |
|------|------|------|
| `prompt` | string | **필수**. 요청 내용 |
| `files` | FileAttachment[] | 첨부 파일 (base64) |
| `model` | string | 모델 (기본: gemini-2.5-pro) |
| `yolo` | boolean | 도구 자동 승인 (기본: true) |

### Codex

| 옵션 | 타입 | 설명 |
|------|------|------|
| `prompt` | string | **필수**. 요청 내용 |
| `files` | FileAttachment[] | 첨부 파일 (base64) |
| `model` | string | 모델 |
| `sandboxMode` | string | `read-only` \| `workspace-write` \| `danger-full-access` |

### FileAttachment

```typescript
{
  filename: string;   // "report.xlsx"
  data: string;       // base64 인코딩된 파일 내용
  mimeType?: string;  // "image/png" (선택)
}
```

## 프로젝트 구조

```
.
├── app/
│   ├── api/
│   │   ├── claude/
│   │   │   ├── route.ts              # Claude 동기 API
│   │   │   └── stream/route.ts       # Claude 스트리밍 API
│   │   ├── gemini/
│   │   │   ├── route.ts              # Gemini 동기 API
│   │   │   └── stream/route.ts       # Gemini 스트리밍 API
│   │   └── codex/
│   │       ├── route.ts              # Codex 동기 API
│   │       └── stream/route.ts       # Codex 스트리밍 API
│   ├── page.tsx                      # 웹 UI
│   └── layout.tsx
├── lib/
│   └── file-handler.ts              # 파일 업로드 처리
├── .agents/skills/                   # 오피스 스킬 (전체 CLI 공유)
│   ├── pdf/
│   ├── xlsx/
│   ├── docx/
│   └── pptx/
├── setup.sh                         # 원클릭 설치 스크립트
└── README.md
```

## 오피스 스킬

`setup.sh`가 PDF, Excel, Word, PPT 스킬을 3개 CLI 모두에 설치합니다. 파일을 첨부하면 AI가 자동으로 적절한 스킬을 선택해서 처리합니다.

```bash
# 수동 설치 시
npx skills add anthropics/skills@pdf -a claude-code -y
npx skills add anthropics/skills@pdf -a gemini-cli -y
npx skills add anthropics/skills@pdf -a codex -y
```

## 인증 상태 확인

```bash
ls ~/.claude/credentials.json 2>/dev/null && echo "Claude: OK" || echo "Claude: 미인증"
ls ~/.gemini/oauth_creds.json 2>/dev/null && echo "Gemini: OK" || echo "Gemini: 미인증"
ls ~/.codex/auth.json 2>/dev/null && echo "Codex: OK" || echo "Codex: 미인증"
```

## 주의사항

- 각 CLI 인증이 필수입니다 (브라우저 로그인)
- Claude Code, Gemini는 구독만으로 사용 가능 (API 비용 없음)
- Codex는 ChatGPT Plus 이상 구독 필요
- `--dangerously-skip-permissions` 플래그를 사용하므로 신뢰할 수 있는 환경에서만 실행하세요
- 파일 크기 제한: 50MB/파일, 100MB 전체

## 라이선스

MIT

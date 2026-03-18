import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as http from "http";
import * as crypto from "crypto";

// ── Load .env manually (Next.js production may not load it) ─────────────────

function loadEnvFile(): Record<string, string> {
  const envVars: Record<string, string> = {};
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '..', '.env'),
  ];
  for (const envPath of envPaths) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const match = line.match(/^([^#=]+)=(.*)$/);
          if (match) envVars[match[1].trim()] = match[2].trim();
        }
      }
    } catch { /* */ }
  }
  return envVars;
}

const _env = loadEnvFile();

// ── Constants ──────────────────────────────────────────────────────────────────

const AUTH_FILE = path.join(os.homedir(), ".config", "artifex-mcp", "auth.json");

// Read credentials lazily at runtime (not at module load / build time)
function getClientCredentials(): { id: string; secret: string } {
  // 1. env vars (use dynamic access to prevent Next.js build-time inlining)
  const env = process["env"];
  let id = env["ANTIGRAVITY_CLIENT_ID"] || _env.ANTIGRAVITY_CLIENT_ID || "";
  let secret = env["ANTIGRAVITY_CLIENT_SECRET"] || _env.ANTIGRAVITY_CLIENT_SECRET || "";
  if (id && secret) return { id, secret };
  // 2. auth.json
  try {
    const authData = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    id = authData.clientId || id;
    secret = authData.clientSecret || secret;
  } catch { /* */ }
  return { id, secret };
}
// Use getter functions instead of constants (Next.js build may inline empty process.env values)
const CLIENT_ID = () => getClientCredentials().id;
const CLIENT_SECRET = () => getClientCredentials().secret;
const OAUTH_PORT = 51122;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth-callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GENERATE_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
const MODELS_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const LOAD_CODE_ASSIST_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const HEADERS: Record<string, string> = {
  "User-Agent": "antigravity/1.15.8 darwin/arm64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata":
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

// ── Cached values ────────────────────────────────────────────────────────────

let cachedProjectId: string | null = null;
let cachedImageModel: string | null = null;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Credentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at?: number;
}

export interface ImagePart {
  data: string;
  mimeType: string;
}

export interface GenerateImageOptions {
  prompt: string;
  image?: ImagePart;
  referenceImages?: ImagePart[];
  aspectRatio?: string; // default "1:1"
}

export interface GenerateImageResult {
  images: ImagePart[];
}

// ── Credential management ──────────────────────────────────────────────────────

export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    const data = JSON.parse(raw);
    // Normalize field names (auth.json uses camelCase, Credentials uses snake_case)
    return {
      access_token: data.access_token || data.accessToken || "",
      refresh_token: data.refresh_token || data.refreshToken || "",
      token_type: data.token_type || data.tokenType || "Bearer",
      expires_at: data.expires_at || data.expiresAt,
    } as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  const dir = path.dirname(AUTH_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // Merge with existing data to preserve clientId, clientSecret, projectId, email
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(AUTH_FILE)) {
      existing = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    }
  } catch { /* */ }
  const merged = { ...existing, ...creds };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(merged, null, 2), "utf-8");
}

export function deleteCredentials(): void {
  try {
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  } catch {
    // ignore
  }
}

export function isAuthenticated(): boolean {
  return loadCredentials() !== null;
}

// ── Token refresh ──────────────────────────────────────────────────────────────

export async function refreshAccessToken(
  refreshToken: string
): Promise<Credentials> {
  // Read credentials directly from auth.json every time (Next.js may inline env vars at build)
  let cid = CLIENT_ID();
  let csecret = CLIENT_SECRET();
  if (!cid || !csecret) {
    try {
      const raw = fs.readFileSync(
        path.join(os.homedir(), ".config", "artifex-mcp", "auth.json"),
        "utf8"
      );
      const d = JSON.parse(raw);
      cid = d.clientId || cid;
      csecret = d.clientSecret || csecret;
    } catch { /* */ }
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cid,
      client_secret: csecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text} [clientId=${cid ? 'set' : 'EMPTY'}]`);
  }

  const data = await res.json();
  const creds: Credentials = {
    access_token: data.access_token,
    refresh_token: refreshToken, // refresh_token is not returned on refresh
    token_type: data.token_type || "Bearer",
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  saveCredentials(creds);
  return creds;
}

// ── Ensure valid access token (auto-refresh) ────────────────────────────────

export async function getValidAccessToken(): Promise<string> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not authenticated");

  // If we have an expiry and it's still valid (with 60s buffer), reuse
  if (creds.expires_at && Date.now() < creds.expires_at - 60_000) {
    return creds.access_token;
  }

  // Refresh
  const refreshed = await refreshAccessToken(creds.refresh_token);
  return refreshed.access_token;
}

// ── Frontend-driven OAuth ────────────────────────────────────────────────────

export function buildOAuthUrl(): { url: string; state: string } {
  const state = crypto.randomBytes(16).toString("hex");

  // The callback URL points to our own API route
  const port = process.env.PORT || "3000";
  const callbackUrl = `http://localhost:${port}/api/antigravity/auth/callback`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID(),
    response_type: "code",
    redirect_uri: callbackUrl,
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return {
    url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
  };
}

export async function exchangeCodeForTokens(
  code: string
): Promise<{ credentials: Credentials; email: string; projectId: string }> {
  const port = process.env.PORT || "3000";
  const callbackUrl = `http://localhost:${port}/api/antigravity/auth/callback`;

  // 1. Exchange authorization code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }

  const data = await tokenRes.json();
  const creds: Credentials = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };

  // 2. Fetch user email from Google userinfo
  let email = "";
  try {
    const userinfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${creds.access_token}` } }
    );
    if (userinfoRes.ok) {
      const userinfo = await userinfoRes.json();
      email = userinfo.email || "";
    }
  } catch {
    /* ignore */
  }

  // 3. Fetch project ID via loadCodeAssist
  let projectId = "";
  try {
    projectId = await fetchProjectId(creds.access_token);
  } catch {
    /* ignore — projectId will be fetched later when needed */
  }

  // 4. Save credentials with all metadata
  const { id: clientId, secret: clientSecret } = getClientCredentials();
  const fullData: Record<string, unknown> = {
    // snake_case (Credentials interface)
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    token_type: creds.token_type,
    expires_at: creds.expires_at,
    // camelCase (backward compatibility)
    accessToken: creds.access_token,
    refreshToken: creds.refresh_token,
    tokenType: creds.token_type,
    expiresAt: creds.expires_at,
    // Metadata
    clientId,
    clientSecret,
    projectId,
    email,
  };
  const dir = path.dirname(AUTH_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(fullData, null, 2), "utf-8");

  return { credentials: creds, email, projectId };
}

// ── OAuth flow (legacy, server-side — kept for backward compatibility) ───────

export async function runOAuthFlow(): Promise<Credentials> {
  return new Promise<Credentials>((resolve, reject) => {
    const state = crypto.randomUUID();
    let server: http.Server | null = null;

    const cleanup = () => {
      if (server) {
        server.close();
        server = null;
      }
    };

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth flow timed out (2 minutes)"));
    }, 120_000);

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${OAUTH_PORT}`);

      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      if (!code || returnedState !== state) {
        res.writeHead(400);
        res.end("Invalid callback");
        return;
      }

      try {
        // Exchange code for tokens
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: CLIENT_ID(),
            client_secret: CLIENT_SECRET(),
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
          }),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          throw new Error(
            `Token exchange failed (${tokenRes.status}): ${text}`
          );
        }

        const data = await tokenRes.json();
        const creds: Credentials = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          token_type: data.token_type || "Bearer",
          expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
        };

        saveCredentials(creds);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authentication successful!</h2><p>You can close this tab.</p></body></html>"
        );

        clearTimeout(timeout);
        cleanup();
        resolve(creds);
      } catch (err) {
        res.writeHead(500);
        res.end("Authentication failed");
        clearTimeout(timeout);
        cleanup();
        reject(err);
      }
    });

    server.listen(OAUTH_PORT, "127.0.0.1", async () => {
      const params = new URLSearchParams({
        client_id: CLIENT_ID(),
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
        access_type: "offline",
        prompt: "consent",
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const open = require("open") as typeof import("open");
        (open as { default: (url: string) => Promise<unknown> }).default(
          authUrl
        );
      } catch {
        // Fallback: use macOS open command
        try {
          const { exec } = require("child_process");
          exec(`open "${authUrl}"`);
        } catch {
          console.log(`Open this URL to authenticate:\n${authUrl}`);
        }
      }
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      cleanup();
      reject(err);
    });
  });
}

// ── Fetch available image models ────────────────────────────────────────────

export async function fetchAvailableImageModels(
  accessToken: string
): Promise<string[]> {
  const res = await fetch(MODELS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...HEADERS,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetchAvailableModels failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const modelIds: string[] = data.imageGenerationModelIds || [];
  return modelIds;
}

// ── Fetch project ID ────────────────────────────────────────────────────────

export async function fetchProjectId(accessToken: string): Promise<string> {
  const res = await fetch(LOAD_CODE_ASSIST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...HEADERS,
    },
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`loadCodeAssist failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const projectId =
    (typeof data.cloudaicompanionProject === "string"
      ? data.cloudaicompanionProject
      : data.cloudaicompanionProject?.id) ||
    data.project ||
    data.projectId;
  if (!projectId) {
    // Fallback: read from auth.json
    try {
      const authData = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
      if (authData.projectId) return authData.projectId;
    } catch { /* */ }
    throw new Error(
      "Could not determine project ID from loadCodeAssist response"
    );
  }
  return projectId;
}

// ── Image generation ───────────────────────────────────────────────────────────

export async function generateImage(
  options: GenerateImageOptions
): Promise<GenerateImageResult> {
  const { prompt, image, referenceImages, aspectRatio = "1:1" } = options;

  // 1. Load credentials, get valid access token
  let accessToken = await getValidAccessToken();

  // 2. Fetch project ID if not cached
  if (!cachedProjectId) {
    cachedProjectId = await fetchProjectId(accessToken);
  }

  // 3. Fetch available image model if not cached
  if (!cachedImageModel) {
    const models = await fetchAvailableImageModels(accessToken);
    if (models.length === 0) {
      throw new Error("No image generation models available");
    }
    // Prefer gemini-3.1-flash-image if available, otherwise use first
    cachedImageModel =
      models.find((m) => m.includes("flash-image")) || models[0];
  }

  // 4. Build request parts
  const parts: Array<Record<string, unknown>> = [];

  if (image) {
    parts.push({
      inlineData: { mimeType: image.mimeType, data: image.data },
    });
  }

  parts.push({ text: prompt });

  if (referenceImages?.length) {
    parts.push({
      text: "\n\nBelow are reference images of furniture products to place in the room:",
    });
    for (const ref of referenceImages) {
      parts.push({
        inlineData: { mimeType: ref.mimeType, data: ref.data },
      });
    }
  }

  // 5. Build request body
  const body = {
    project: cachedProjectId,
    model: cachedImageModel,
    request: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio },
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
      ],
    },
    requestType: "image_gen",
    userAgent: "antigravity",
    requestId: `image_gen/${Date.now()}/${crypto.randomUUID()}/12`,
  };

  // 6. Call the API (with auto-retry on 401)
  const callApi = async (token: string): Promise<GenerateImageResult> => {
    const response = await fetch(GENERATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...HEADERS,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (response.status === 429) {
      throw new Error("Rate limit exceeded");
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const responseData = data.response || data;
    const images: ImagePart[] = [];

    for (const candidate of responseData.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData?.data) {
          images.push({
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
        }
      }
    }

    return { images };
  };

  // 7. Execute with 401 retry
  try {
    return await callApi(accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("401")) {
      // Refresh token and retry once
      const creds = loadCredentials();
      if (creds?.refresh_token) {
        const refreshed = await refreshAccessToken(creds.refresh_token);
        accessToken = refreshed.access_token;
        return await callApi(accessToken);
      }
    }
    throw err;
  }
}

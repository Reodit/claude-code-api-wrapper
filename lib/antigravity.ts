import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as http from "http";
import * as crypto from "crypto";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID || "default-client-id";
const CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET || "default-client-secret";
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
const GENERATE_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
];
const HEADERS: Record<string, string> = {
  "User-Agent": "antigravity/1.15.8 darwin/arm64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata":
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};
const MODEL = "gemini-3-pro-image";
const AUTH_FILE = path.join(
  os.homedir(),
  ".config",
  "artifex-mcp",
  "auth.json"
);

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

// ── Credential management ──────────────────────────────────────────────────────

export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  const dir = path.dirname(AUTH_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2), "utf-8");
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
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
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

// ── OAuth flow ─────────────────────────────────────────────────────────────────

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
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
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
        client_id: CLIENT_ID,
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
        (open as { default: (url: string) => Promise<unknown> }).default(authUrl);
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

// ── Image generation ───────────────────────────────────────────────────────────

export async function generateImage(
  accessToken: string,
  prompt: string,
  inputImage?: ImagePart,
  referenceImages?: ImagePart[],
  aspectRatio: string = "1:1"
): Promise<ImagePart[]> {
  const parts: Array<Record<string, unknown>> = [];

  // Add input image if provided
  if (inputImage) {
    parts.push({
      inlineData: { mimeType: inputImage.mimeType, data: inputImage.data },
    });
  }

  // Add prompt
  parts.push({ text: prompt });

  // Add reference images
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

  const body = {
    project: "artifex-mcp",
    model: MODEL,
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
    requestType: "agent",
    userAgent: "artifex",
    requestId: `agent-${crypto.randomUUID()}`,
  };

  let lastError: Error | null = null;

  for (const endpoint of GENERATE_ENDPOINTS) {
    try {
      const response = await fetch(
        `${endpoint}/v1internal:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...HEADERS,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        }
      );

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
        for (const part of candidate.content.parts) {
          if (part.inlineData?.data) {
            images.push({
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
            });
          }
        }
      }

      return images;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // If not the last endpoint, try the next one
      if (endpoint !== GENERATE_ENDPOINTS[GENERATE_ENDPOINTS.length - 1]) {
        continue;
      }
    }
  }

  throw lastError ?? new Error("All endpoints failed");
}

import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface FileAttachment {
  filename: string;    // e.g. "report.xlsx", "photo.png"
  data: string;        // base64-encoded file content
  mimeType?: string;   // optional hint: "image/png", "application/pdf"
}

export interface SavedFile {
  tempPath: string;
  originalName: string;
  extension: string;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const PDF_EXTENSIONS = ['.pdf'];
const OFFICE_EXTENSIONS = ['.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt'];
const ALL_SUPPORTED = [...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS, ...OFFICE_EXTENSIONS];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.substring(lastDot).toLowerCase();
}

export function validateFiles(files: FileAttachment[]): string | null {
  if (!Array.isArray(files)) return 'files must be an array';
  if (files.length === 0) return 'files array is empty';

  let totalSize = 0;

  for (const file of files) {
    if (!file.filename || typeof file.filename !== 'string') {
      return 'Each file must have a filename';
    }
    if (!file.data || typeof file.data !== 'string') {
      return `File "${file.filename}" must have base64 data`;
    }

    const ext = getExtension(file.filename);
    if (!ALL_SUPPORTED.includes(ext)) {
      return `Unsupported file type: ${ext}. Supported: ${ALL_SUPPORTED.join(', ')}`;
    }

    // base64 size estimate (base64 is ~4/3 of original)
    const estimatedSize = Math.ceil(file.data.length * 3 / 4);
    if (estimatedSize > MAX_FILE_SIZE) {
      return `File "${file.filename}" exceeds 50MB limit`;
    }
    totalSize += estimatedSize;
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    return 'Total file size exceeds 100MB limit';
  }

  return null;
}

export async function saveFilesToTemp(files: FileAttachment[]): Promise<SavedFile[]> {
  const tempDir = join(tmpdir(), `claude-upload-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  const savedFiles: SavedFile[] = [];

  for (const file of files) {
    const buffer = Buffer.from(file.data, 'base64');
    const tempPath = join(tempDir, file.filename);
    await writeFile(tempPath, buffer);

    savedFiles.push({
      tempPath,
      originalName: file.filename,
      extension: getExtension(file.filename),
    });
  }

  return savedFiles;
}

export function buildFilePromptInstructions(files: SavedFile[]): string {
  const lines: string[] = ['[첨부 파일]', '사용자가 다음 파일을 첨부했습니다:', ''];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    lines.push(`${i + 1}. ${file.originalName}`);
    lines.push(`   - 파일 경로: ${file.tempPath}`);
    lines.push('');
  }

  lines.push('[사용자 요청]');
  return lines.join('\n');
}

export async function cleanupTempFiles(files: SavedFile[]): Promise<void> {
  if (files.length === 0) return;

  // All files are in the same temp directory
  const tempDir = join(files[0].tempPath, '..');
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error('Failed to cleanup temp files:', err);
  }
}

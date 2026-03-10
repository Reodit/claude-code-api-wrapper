import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface FileAttachment {
  filename: string;    // e.g. "report.xlsx", "photo.png"
  data: string;        // base64-encoded file content
  mimeType?: string;   // optional hint: "image/png", "application/pdf"
}

export type FileCategory = 'image' | 'pdf' | 'office';

export interface SavedFile {
  tempPath: string;
  originalName: string;
  category: FileCategory;
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

function categorizeFile(filename: string): FileCategory {
  const ext = getExtension(filename);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (OFFICE_EXTENSIONS.includes(ext)) return 'office';
  throw new Error(`Unsupported file type: ${ext}`);
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
      category: categorizeFile(file.filename),
      extension: getExtension(file.filename),
    });
  }

  return savedFiles;
}

export function buildFilePromptInstructions(files: SavedFile[]): string {
  const lines: string[] = ['[첨부 파일]', '사용자가 다음 파일을 첨부했습니다. 각 파일을 읽고 처리하세요:', ''];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    lines.push(`${i + 1}. ${file.originalName} (${getCategoryLabel(file.category)})`);
    lines.push(`   - 파일 경로: ${file.tempPath}`);
    lines.push(`   - ${getProcessingInstruction(file)}`);
    lines.push('');
  }

  lines.push('[사용자 요청]');
  return lines.join('\n');
}

function getCategoryLabel(category: FileCategory): string {
  switch (category) {
    case 'image': return '이미지';
    case 'pdf': return 'PDF';
    case 'office': return '오피스 문서';
  }
}

function getProcessingInstruction(file: SavedFile): string {
  switch (file.category) {
    case 'image':
      return `Read 도구를 사용하여 이 이미지 파일을 시각적으로 확인하세요.`;
    case 'pdf':
      return `Read 도구를 사용하여 이 PDF 파일의 내용을 읽으세요.`;
    case 'office':
      return getOfficeInstruction(file.extension, file.tempPath);
  }
}

function getOfficeInstruction(ext: string, path: string): string {
  switch (ext) {
    case '.xlsx':
    case '.xls':
      return `이 Excel 파일을 분석하세요. pandas를 사용: python3 -c "import pandas as pd; df = pd.read_excel('${path}', sheet_name=None); [print(f'Sheet: {k}\\n{v.to_string()}') for k,v in df.items()]"`;
    case '.docx':
    case '.doc':
      return `이 Word 문서를 읽으세요. pandoc을 사용: pandoc '${path}' -t plain`;
    case '.pptx':
    case '.ppt':
      return `이 PowerPoint 파일을 읽으세요. markitdown을 사용: python3 -m markitdown '${path}'`;
    default:
      return `이 파일을 적절한 방법으로 읽고 분석하세요.`;
  }
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

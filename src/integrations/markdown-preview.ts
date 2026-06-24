import { createServer, type Server, type ServerResponse } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, relative, resolve, sep } from 'path';

export interface MarkdownPreviewConfig {
  enabled: boolean;
  host: string;
  port: number;
  public_base_url?: string;
}

export interface MarkdownPreviewLink {
  path: string;
  title: string;
  url: string;
}

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i;

export function isPreviewableMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT_RE.test(path);
}

export function createMarkdownPreviewBaseUrl(config: MarkdownPreviewConfig): string {
  return (config.public_base_url ?? `http://${config.host}:${config.port}`).replace(/\/+$/, '');
}

export function createMarkdownPreviewUrl(baseUrl: string, workspaceRoot: string, filePath: string): string | null {
  const relativePath = toSafeWorkspaceRelativePath(workspaceRoot, filePath);
  if (!relativePath || !isPreviewableMarkdownPath(relativePath)) {
    return null;
  }

  return `${baseUrl.replace(/\/+$/, '')}/preview/${encodeURIComponent(relativePath)}`;
}

export function createMarkdownPreviewLinks(
  filePaths: string[],
  options: { baseUrl: string; workspaceRoot: string },
): MarkdownPreviewLink[] {
  const links: MarkdownPreviewLink[] = [];
  const seen = new Set<string>();

  for (const filePath of filePaths) {
    if (seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    const url = createMarkdownPreviewUrl(options.baseUrl, options.workspaceRoot, filePath);
    if (!url) {
      continue;
    }
    links.push({
      path: filePath,
      title: basename(filePath),
      url,
    });
  }

  return links;
}

export class MarkdownPreviewServer {
  private server: Server | null = null;
  private readonly allowedRoot: string;

  constructor(
    private readonly config: MarkdownPreviewConfig,
    private readonly workspaceRoot: string,
  ) {
    this.allowedRoot = resolve(workspaceRoot, 'metaclaw-tasks');
  }

  start(): Promise<void> {
    if (!this.config.enabled || this.server) {
      return Promise.resolve();
    }

    this.server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', createMarkdownPreviewBaseUrl(this.config)).pathname;
      if (request.method !== 'GET' || !pathname.startsWith('/preview/')) {
        writeHtml(response, 404, '<h1>Not Found</h1>');
        return;
      }

      const encodedPath = pathname.slice('/preview/'.length);
      const relativePath = decodeURIComponent(encodedPath);
      const filePath = this.resolvePreviewPath(relativePath);
      if (!filePath) {
        writeHtml(response, 403, '<h1>Forbidden</h1>');
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        writeHtml(response, 404, '<h1>Markdown file not found</h1>');
        return;
      }

      const markdown = readFileSync(filePath, 'utf-8');
      writeHtml(response, 200, renderMarkdownPreviewPage(markdown, basename(filePath)));
    });

    return new Promise((resolveStart, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        resolveStart();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    const server = this.server;
    this.server = null;
    return new Promise((resolveStop, reject) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(error => error ? reject(error) : resolveStop());
    });
  }

  private resolvePreviewPath(relativePath: string): string | null {
    if (!isPreviewableMarkdownPath(relativePath) || relativePath.includes('\0')) {
      return null;
    }
    const resolvedPath = resolve(this.workspaceRoot, relativePath);
    const rootRelative = relative(this.allowedRoot, resolvedPath);
    if (rootRelative.startsWith('..') || rootRelative === '' || rootRelative.split(sep).includes('..')) {
      return null;
    }
    return resolvedPath;
  }
}

function toSafeWorkspaceRelativePath(workspaceRoot: string, filePath: string): string | null {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = resolve(filePath);
  const relativePath = relative(resolvedWorkspace, resolvedPath);
  if (!relativePath || relativePath.startsWith('..') || relativePath.split(sep).includes('..')) {
    return null;
  }
  if (!relativePath.startsWith(`metaclaw-tasks${sep}`) && relativePath !== 'metaclaw-tasks') {
    return null;
  }
  return relativePath.split(sep).join('/');
}

function renderMarkdownPreviewPage(markdown: string, title: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} - Metaclaw Preview</title>`,
    '<style>',
    'body{margin:0;background:#f5f1e8;color:#241f1a;font-family:Georgia,"Noto Serif SC",serif;line-height:1.72;}',
    'main{max-width:880px;margin:48px auto;padding:40px;background:#fffdf7;border:1px solid #e2d7c5;box-shadow:0 18px 55px rgba(69,50,27,.12);}',
    'h1,h2,h3{line-height:1.25;color:#17130f;} h1{font-size:2.2rem;} h2{border-bottom:1px solid #e6dccd;padding-bottom:.35rem;margin-top:2.2rem;}',
    'pre{overflow:auto;background:#1f241f;color:#f8f4e8;padding:18px;border-radius:12px;} code{font-family:"SFMono-Regular",Consolas,monospace;}',
    'p code,li code{background:#efe7d8;padding:.12rem .32rem;border-radius:5px;color:#5b3716;}',
    'blockquote{border-left:4px solid #a66a2b;margin-left:0;padding:.2rem 1rem;color:#5f554a;background:#fbf6eb;}',
    'table{border-collapse:collapse;width:100%;margin:1rem 0;} th,td{border:1px solid #d8cbb8;padding:.55rem .7rem;text-align:left;} th{background:#f0e7d8;}',
    'a{color:#8a4d16;}',
    '</style>',
    '</head>',
    '<body>',
    `<main>${renderMarkdownToHtml(markdown)}</main>`,
    '</body>',
    '</html>',
  ].join('');
}

function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      html.push(`<ul>${list.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
      list = [];
    }
  };
  const flushCode = () => {
    if (code.length > 0) {
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      code = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? '');
      continue;
    }

    const quote = line.match(/^>\s*(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInlineMarkdown(quote[1] ?? '')}</blockquote>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();
  return html.join('\n');
}

function renderInlineMarkdown(input: string): string {
  return escapeHtml(input)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

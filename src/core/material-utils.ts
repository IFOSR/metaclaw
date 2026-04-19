import { existsSync, readFileSync, statSync } from 'fs';

export interface MaterialTextSnippet {
  path: string;
  content: string;
  sourceType: 'file' | 'link';
}

export interface MaterialSummary {
  totalCount: number;
  localFileCount: number;
  webLinkCount: number;
  fileSnippetCount: number;
  linkSnippetCount: number;
  readableSnippetCount: number;
  status: 'missing' | 'partial' | 'ready';
  overview: string;
  sufficiency: string;
}

export function isWebLink(resource: string): boolean {
  return /^(https?:\/\/|data:text\/)/i.test(resource);
}

export async function extractMaterialTextSnippets(
  resources: string[],
  options: {
    fetchImpl?: typeof fetch;
    maxEntries?: number;
    maxCharsPerEntry?: number;
  } = {},
): Promise<MaterialTextSnippet[]> {
  const supportedExtensions = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.log']);
  const snippets: MaterialTextSnippet[] = [];
  const maxEntries = options.maxEntries ?? 3;
  const maxCharsPerEntry = options.maxCharsPerEntry ?? 800;
  const fetchImpl = options.fetchImpl ?? fetch;

  for (const resourcePath of resources) {
    if (snippets.length >= maxEntries) {
      break;
    }

    if (isWebLink(resourcePath)) {
      const webSnippet = await fetchWebSnippet(resourcePath, maxCharsPerEntry, fetchImpl);
      if (webSnippet) {
        snippets.push(webSnippet);
      }
      continue;
    }

    const extension = resourcePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
    if (!supportedExtensions.has(extension)) {
      continue;
    }

    try {
      if (!existsSync(resourcePath)) {
        continue;
      }

      const stat = statSync(resourcePath);
      if (!stat.isFile()) {
        continue;
      }

      const raw = readFileSync(resourcePath, 'utf-8');
      if (looksBinary(raw)) {
        continue;
      }

      const normalized = raw.replace(/\r\n/g, '\n').trim();
      if (!normalized) {
        continue;
      }

      const content = normalized.length > maxCharsPerEntry
        ? `${normalized.slice(0, maxCharsPerEntry)}...`
        : normalized;

      snippets.push({
        path: resourcePath,
        content,
        sourceType: 'file',
      });
    } catch {
      continue;
    }
  }

  return snippets;
}

export function splitTaskResources(resources: string[]): { files: string[]; links: string[] } {
  const files: string[] = [];
  const links: string[] = [];

  for (const resource of resources) {
    if (isWebLink(resource)) {
      links.push(resource);
    } else {
      files.push(resource);
    }
  }

  return { files, links };
}

export function buildMaterialSummary(
  resources: string[],
  textSnippets: MaterialTextSnippet[] = [],
): MaterialSummary {
  const { files, links } = splitTaskResources(resources);
  const fileSnippetCount = textSnippets.filter(snippet => snippet.sourceType === 'file').length;
  const linkSnippetCount = textSnippets.filter(snippet => snippet.sourceType === 'link').length;
  const readableSnippetCount = textSnippets.length;

  if (resources.length === 0) {
    return {
      totalCount: 0,
      localFileCount: 0,
      webLinkCount: 0,
      fileSnippetCount: 0,
      linkSnippetCount: 0,
      readableSnippetCount: 0,
      status: 'missing',
      overview: '暂无材料',
      sufficiency: '当前没有关联材料，主要依赖任务描述，建议先补充文件、链接或其他上下文',
    };
  }

  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(`${files.length} 个本地文件`);
  }
  if (links.length > 0) {
    parts.push(`${links.length} 个网页链接`);
  }
  if (readableSnippetCount > 0) {
    parts.push(`已提取 ${readableSnippetCount} 份可读摘录`);
  }

  if (readableSnippetCount > 0) {
    return {
      totalCount: resources.length,
      localFileCount: files.length,
      webLinkCount: links.length,
      fileSnippetCount,
      linkSnippetCount,
      readableSnippetCount,
      status: 'ready',
      overview: parts.join('，'),
      sufficiency: '现有材料已包含可读内容，可先继续推进任务；若结果仍不够具体，再补充更多材料',
    };
  }

  return {
    totalCount: resources.length,
    localFileCount: files.length,
    webLinkCount: links.length,
    fileSnippetCount,
    linkSnippetCount,
    readableSnippetCount,
    status: 'partial',
    overview: parts.join('，') || '已有材料',
    sufficiency: links.length > 0
      ? '已有文件或链接材料，但尚未形成可读摘录；可先基于现有链接继续尝试，若信息仍不足再补充更明确材料'
      : '已有文件材料，但尚未形成可读摘录；如当前结果不够具体，建议补充更明确的文本材料',
  };
}

function looksBinary(content: string): boolean {
  return /\u0000/.test(content);
}

async function fetchWebSnippet(
  resourcePath: string,
  maxCharsPerFile: number,
  fetchImpl: typeof fetch,
): Promise<MaterialTextSnippet | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetchImpl(resourcePath, {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!/text\/html|text\/plain|application\/json|application\/xml|text\/xml/.test(contentType)) {
      return null;
    }

    const raw = await response.text();
    const normalized = /text\/html/.test(contentType)
      ? extractReadableHtmlText(raw)
      : raw.replace(/\r\n/g, '\n').trim();

    if (!normalized) {
      return null;
    }

    const content = normalized.length > maxCharsPerFile
      ? `${normalized.slice(0, maxCharsPerFile)}...`
      : normalized;

    return {
      path: resourcePath,
      content,
      sourceType: 'link',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractReadableHtmlText(raw: string): string {
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  const body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  return [title, body].filter(Boolean).join('\n').trim();
}

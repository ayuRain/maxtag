import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import JSZip from 'jszip';
import type { KnowledgeSourceExtraction } from '@opentag/core';

export const MAX_KNOWLEDGE_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_KNOWLEDGE_TEXT_BYTES = 200_000;
export const MAX_KNOWLEDGE_PDF_PAGES = 200;

const TEXT_MEDIA_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/xml',
  'application/yaml', 'application/x-yaml', 'text/csv', 'text/markdown',
  'text/plain', 'text/tab-separated-values', 'text/xml', 'text/yaml',
]);

export interface KnowledgeContentExtractionResult {
  content: string;
  mediaType: 'text/markdown' | 'text/plain';
  extraction: KnowledgeSourceExtraction;
}

function mediaTypeValue(value: string): string {
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (!type || type.length > 120) throw new Error('knowledge_extraction_media_type_invalid');
  return type;
}

function normalizedText(value: string): string {
  const text = value
    .replace(/\r\n?/gu, '\n')
    .replace(/\0/gu, '')
    .replace(/[\t ]+$/gmu, '')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim();
  if (!text) throw new Error('knowledge_extraction_empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_KNOWLEDGE_TEXT_BYTES) {
    throw new Error('knowledge_extraction_text_too_large');
  }
  return text;
}

function utf8(buffer: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (/\0/u.test(text)) throw new Error('knowledge_extraction_text_binary');
  return text;
}

function metadata(
  buffer: Buffer,
  sourceMediaType: string,
  extractor: KnowledgeSourceExtraction['extractor'],
  fileName?: string,
  pageCount?: number,
): KnowledgeSourceExtraction {
  return {
    sourceMediaType,
    extractor,
    inputBytes: buffer.byteLength,
    rawHash: createHash('sha256').update(buffer).digest('hex'),
    fileName: fileName?.replace(/[\0\r\n]/gu, '').trim().slice(0, 240) || undefined,
    extractedAt: new Date().toISOString(),
    pageCount,
  };
}

export async function extractKnowledgeContent(input: {
  buffer: Buffer;
  mediaType: string;
  fileName?: string;
}): Promise<KnowledgeContentExtractionResult> {
  if (!input.buffer.byteLength) throw new Error('knowledge_extraction_empty_input');
  if (input.buffer.byteLength > MAX_KNOWLEDGE_INPUT_BYTES) {
    throw new Error('knowledge_extraction_input_too_large');
  }
  const sourceMediaType = mediaTypeValue(input.mediaType);
  if (sourceMediaType === 'application/pdf') {
    const parser = new PDFParse({ data: input.buffer });
    try {
      const info = await parser.getInfo();
      if (info.total > MAX_KNOWLEDGE_PDF_PAGES) {
        throw new Error('knowledge_extraction_pdf_too_many_pages');
      }
      const result = await parser.getText({
        first: info.total,
        pageJoiner: '\n\n[Page page_number of total_number]\n\n',
      });
      return {
        content: normalizedText(result.text),
        mediaType: 'text/plain',
        extraction: metadata(input.buffer, sourceMediaType, 'pdf-parse', input.fileName, info.total),
      };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (
    sourceMediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const archive = await JSZip.loadAsync(input.buffer, { createFolders: false });
    const entries = Object.values(archive.files);
    if (entries.length > 2_000) throw new Error('knowledge_extraction_docx_too_many_entries');
    const declaredBytes = entries.reduce((total, entry) => {
      const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
      return total + Math.max(0, Number(data?.uncompressedSize) || 0);
    }, 0);
    if (declaredBytes > 30 * 1024 * 1024) {
      throw new Error('knowledge_extraction_docx_expanded_too_large');
    }
    const result = await mammoth.extractRawText({ buffer: input.buffer });
    return {
      content: normalizedText(result.value),
      mediaType: 'text/plain',
      extraction: metadata(input.buffer, sourceMediaType, 'mammoth', input.fileName),
    };
  }
  if (sourceMediaType === 'text/html' || sourceMediaType === 'application/xhtml+xml') {
    const content = convert(utf8(input.buffer), {
      baseElements: { selectors: ['main', 'article', 'body'] },
      limits: {
        ellipsis: '[...]',
        maxBaseElements: 8,
        maxChildNodes: 20_000,
        maxDepth: 40,
      },
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'noscript', format: 'skip' },
        { selector: 'svg', format: 'skip' },
        { selector: 'img', format: 'skip' },
      ],
      wordwrap: false,
    });
    return {
      content: normalizedText(content),
      mediaType: 'text/plain',
      extraction: metadata(input.buffer, sourceMediaType, 'html-to-text', input.fileName),
    };
  }
  if (sourceMediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(sourceMediaType)) {
    return {
      content: normalizedText(utf8(input.buffer)),
      mediaType: sourceMediaType === 'text/markdown' ? 'text/markdown' : 'text/plain',
      extraction: metadata(input.buffer, sourceMediaType, 'plain-text', input.fileName),
    };
  }
  throw new Error('knowledge_extraction_media_type_unsupported');
}

export function decodeKnowledgeContentBase64(value: string): Buffer {
  const encoded = value.trim();
  if (!encoded || encoded.length > Math.ceil(MAX_KNOWLEDGE_INPUT_BYTES / 3) * 4 + 16) {
    throw new Error('knowledge_extraction_input_too_large');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('knowledge_extraction_base64_invalid');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.byteLength > MAX_KNOWLEDGE_INPUT_BYTES || buffer.toString('base64') !== encoded) {
    throw new Error('knowledge_extraction_base64_invalid');
  }
  return buffer;
}

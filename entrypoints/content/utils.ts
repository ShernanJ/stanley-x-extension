import {
  MAX_REWRITE_INSTRUCTIONS_CHARS,
  MIN_DRAFT_LENGTH_FOR_GENERATION,
  SIGNIFICANT_CHAR_DELTA,
  SIGNIFICANT_TOKEN_DISTANCE,
} from './constants';
import type { AttachedImage } from './types';

export function normalize(text: string): string {
  if (!text) {
    return '';
  }

  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

export function normalizeRewriteInstructions(text: string): string {
  return normalize(text).trim().slice(0, MAX_REWRITE_INSTRUCTIONS_CHARS);
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
}

function tokenizeForDiff(text: string): Set<string> {
  const tokens = normalize(text)
    .toLowerCase()
    .split(/[^a-z0-9#@]+/g)
    .filter((token) => token.length > 1);
  return new Set(tokens);
}

function computeTokenDistance(previous: string, next: string): number {
  const previousTokens = tokenizeForDiff(previous);
  const nextTokens = tokenizeForDiff(next);
  const union = new Set([...previousTokens, ...nextTokens]);
  if (union.size === 0) {
    return 0;
  }
  let intersectionSize = 0;
  for (const token of previousTokens) {
    if (nextTokens.has(token)) {
      intersectionSize += 1;
    }
  }
  return 1 - intersectionSize / union.size;
}

export function isSignificantChange(previous: string, next: string): boolean {
  const previousText = normalize(previous);
  const nextText = normalize(next);

  if (!nextText.trim()) {
    return false;
  }

  if (!previousText.trim()) {
    return nextText.length >= MIN_DRAFT_LENGTH_FOR_GENERATION;
  }

  const charDelta = Math.abs(nextText.length - previousText.length);
  if (charDelta >= SIGNIFICANT_CHAR_DELTA) {
    return true;
  }

  const tokenDistance = computeTokenDistance(previousText, nextText);
  return tokenDistance >= SIGNIFICANT_TOKEN_DISTANCE;
}

export async function sha256Hex(input: string): Promise<string> {
  const normalizedInput = normalize(input);
  if (!normalizedInput) {
    return '';
  }

  if (!globalThis.crypto?.subtle) {
    return `${normalizedInput.length}:${normalizedInput.slice(0, 64)}`;
  }

  const encoded = new TextEncoder().encode(normalizedInput);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const hashBytes = Array.from(new Uint8Array(digest));
  return hashBytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function toAttachedImage(value: unknown): AttachedImage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as Partial<AttachedImage>;
  if (
    typeof item.id !== 'string' ||
    typeof item.name !== 'string' ||
    typeof item.dataUrl !== 'string' ||
    typeof item.addedAt !== 'number'
  ) {
    return null;
  }

  if (!item.dataUrl.startsWith('data:image/')) {
    return null;
  }

  return {
    id: item.id,
    name: item.name,
    dataUrl: item.dataUrl,
    addedAt: item.addedAt,
  };
}

export function countWords(text: string): number {
  const normalizedText = normalize(text).trim();
  if (!normalizedText) {
    return 0;
  }
  return normalizedText.split(/\s+/).filter(Boolean).length;
}

export function formatCompactCharCount(value: number): string {
  const count = Math.max(0, Math.floor(value));
  if (count < 1000) {
    return String(count);
  }

  const truncated = Math.floor((count / 1000) * 10) / 10;
  if (Number.isInteger(truncated)) {
    return `${truncated}k`;
  }
  return `${truncated.toFixed(1)}k`;
}

export function buildXComposeUrl(text: string): string {
  const composeUrl = new URL('https://x.com/compose/post');
  const normalizedText = normalize(text).trim();
  if (normalizedText) {
    composeUrl.searchParams.set('text', normalizedText);
  }
  return composeUrl.toString();
}

export function toHandleFromName(name: string): string {
  const normalizedName = normalize(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 15);
  if (!normalizedName) {
    return '@creator';
  }
  return `@${normalizedName}`;
}

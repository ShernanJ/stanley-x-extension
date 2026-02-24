import { THREAD_URL_RE } from './constants';

export function isThreadUrl(url: string): boolean {
  return THREAD_URL_RE.test(url);
}

export function getThreadIdFromUrl(url: string): string {
  const match = url.match(/\/thread\/([^/?#]+)/i);
  return match?.[1] || 'unknown-thread';
}

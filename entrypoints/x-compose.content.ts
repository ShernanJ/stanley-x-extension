import { X_COMPOSE_PENDING_KEY } from './content/constants';
import { normalize } from './content/utils';

type StanleyXComposeWindow = Window & {
  __STANLEY_X_COMPOSE_INIT__?: boolean;
};

type PendingComposeDraft = {
  id: string;
  text: string;
  createdAt: number;
};

const MAX_PENDING_AGE_MS = 15 * 60 * 1000;
const MAX_WAIT_MS = 30 * 1000;
const POLL_INTERVAL_MS = 250;

function readPendingComposeDraft(value: unknown): PendingComposeDraft | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<PendingComposeDraft>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.text !== 'string' ||
    typeof candidate.createdAt !== 'number'
  ) {
    return null;
  }

  const normalizedText = normalize(candidate.text).trim();
  if (!normalizedText) {
    return null;
  }

  return {
    id: candidate.id,
    text: normalizedText,
    createdAt: candidate.createdAt,
  };
}

function getComposeIdFromUrl(): string {
  const url = new URL(window.location.href);
  return url.searchParams.get('stanley_x_compose_id')?.trim() || '';
}

function findComposeTextbox(): HTMLElement | null {
  const selectors = [
    'div[data-testid="tweetTextarea_0"][contenteditable="true"]',
    'div.public-DraftEditor-content[role="textbox"][contenteditable="true"][aria-label="Post text"]',
    'div[role="textbox"][contenteditable="true"][data-testid^="tweetTextarea_"]',
  ];

  for (const selector of selectors) {
    const node = document.querySelector<HTMLElement>(selector);
    if (node) {
      return node;
    }
  }

  return null;
}

function getTextboxText(textbox: HTMLElement): string {
  const visibleText = normalize(textbox.innerText || '');
  const fallbackText = normalize(textbox.textContent || '');
  return normalize(visibleText || fallbackText).trim();
}

function selectTextboxContent(textbox: HTMLElement, collapseToStart = false): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(textbox);
  if (collapseToStart) {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeForComposeCompare(text: string): string {
  return normalize(text.replace(/\u00a0/g, ' '))
    .replace(/\r\n?/g, '\n')
    .trim();
}

function isSameComposeText(a: string, b: string): boolean {
  return normalizeForComposeCompare(a) === normalizeForComposeCompare(b);
}

function insertComposeText(textbox: HTMLElement, text: string): boolean {
  const normalizedText = normalize(text).trim();
  if (!normalizedText) {
    return false;
  }

  textbox.focus();
  selectTextboxContent(textbox);

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, normalizedText);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    textbox.textContent = normalizedText;
  }

  textbox.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: normalizedText,
    }),
  );

  let currentText = getTextboxText(textbox);
  if (isSameComposeText(currentText, normalizedText)) {
    return true;
  }

  // DraftJS can occasionally keep only the last chunk after insertText;
  // retry with select-all + line-break insertion before falling back.
  try {
    textbox.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    const lines = normalizedText.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      document.execCommand('insertText', false, lines[index] || '');
      if (index < lines.length - 1) {
        document.execCommand('insertLineBreak', false);
      }
    }
  } catch {
    // continue to fallback
  }

  textbox.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: normalizedText,
    }),
  );

  currentText = getTextboxText(textbox);
  if (isSameComposeText(currentText, normalizedText)) {
    return true;
  }

  textbox.textContent = normalizedText;
  textbox.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: normalizedText,
    }),
  );

  return isSameComposeText(getTextboxText(textbox), normalizedText);
}

async function getPendingComposeDraft(
  composeId: string,
): Promise<PendingComposeDraft | null> {
  const stored = await browser.storage.local.get(X_COMPOSE_PENDING_KEY);
  const pending = readPendingComposeDraft(stored[X_COMPOSE_PENDING_KEY]);
  if (!pending) {
    return null;
  }

  if (Date.now() - pending.createdAt > MAX_PENDING_AGE_MS) {
    void browser.storage.local.remove(X_COMPOSE_PENDING_KEY).catch(() => undefined);
    return null;
  }

  if (pending.id !== composeId) {
    return null;
  }

  return pending;
}

async function consumePendingComposeDraft(composeId: string): Promise<void> {
  const stored = await browser.storage.local.get(X_COMPOSE_PENDING_KEY);
  const pending = readPendingComposeDraft(stored[X_COMPOSE_PENDING_KEY]);
  if (!pending || pending.id !== composeId) {
    return;
  }

  await browser.storage.local.remove(X_COMPOSE_PENDING_KEY);
}

export default defineContentScript({
  matches: ['https://x.com/compose/post*', 'https://twitter.com/compose/post*'],
  runAt: 'document_idle',
  main() {
    const composeId = getComposeIdFromUrl();
    if (!composeId) {
      return;
    }

    const win = window as StanleyXComposeWindow;
    if (win.__STANLEY_X_COMPOSE_INIT__) {
      return;
    }
    win.__STANLEY_X_COMPOSE_INIT__ = true;

    let isStopped = false;

    const observer = new MutationObserver(() => {
      void tryFillComposeTextbox();
    });

    const stop = (): void => {
      if (isStopped) {
        return;
      }
      isStopped = true;
      observer.disconnect();
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
    };

    const tryFillComposeTextbox = async (): Promise<void> => {
      if (isStopped) {
        return;
      }

      const textbox = findComposeTextbox();
      if (!textbox) {
        return;
      }

      const pending = await getPendingComposeDraft(composeId);
      if (!pending) {
        return;
      }

      const currentText = getTextboxText(textbox);
      if (isSameComposeText(currentText, pending.text)) {
        await consumePendingComposeDraft(composeId);
        stop();
        return;
      }

      const inserted = insertComposeText(textbox, pending.text);
      if (!inserted) {
        return;
      }

      await consumePendingComposeDraft(composeId);
      stop();
    };

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    const pollTimer = window.setInterval(() => {
      void tryFillComposeTextbox();
    }, POLL_INTERVAL_MS);

    const timeoutTimer = window.setTimeout(() => {
      stop();
    }, MAX_WAIT_MS);

    void tryFillComposeTextbox();
  },
});

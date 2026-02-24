import type { PreviewElements } from './types';

export function findPreviewElements(): PreviewElements | null {
  const postContentEl = document.querySelector<HTMLElement>(
    '.post-content[contenteditable="true"]',
  );
  if (!postContentEl) {
    return null;
  }

  return {
    postContentEl,
    postContainerEl: postContentEl.closest<HTMLElement>('.post-container'),
  };
}

export function findPreviewFeedbackButton(
  postContainerEl: HTMLElement | null,
): HTMLButtonElement | null {
  const scoped =
    postContainerEl?.querySelector<HTMLButtonElement>('.footer-fixed .feedback-btn');
  if (scoped) {
    return scoped;
  }

  return document.querySelector<HTMLButtonElement>(
    '.post-container .footer-fixed .feedback-btn',
  );
}

export function findPreviewWordCountEl(
  postContainerEl: HTMLElement | null,
): HTMLElement | null {
  const scoped =
    postContainerEl?.querySelector<HTMLElement>('.footer-fixed [title="Word count"]');
  if (scoped) {
    return scoped;
  }

  return document.querySelector<HTMLElement>(
    '.post-container .footer-fixed [title="Word count"]',
  );
}

export function findPreviewCopyButton(
  postContainerEl: HTMLElement | null,
): HTMLButtonElement | null {
  const selector =
    '.footer-fixed button[title="Copy to clipboard"], .footer-fixed button[data-stanley-x-copy="true"]';
  const scoped = postContainerEl?.querySelector<HTMLButtonElement>(selector);
  if (scoped) {
    return scoped;
  }

  return document.querySelector<HTMLButtonElement>(
    '.post-container .footer-fixed button[title="Copy to clipboard"], .post-container .footer-fixed button[data-stanley-x-copy="true"]',
  );
}

export function findPreviewShareButton(
  postContainerEl: HTMLElement | null,
): HTMLButtonElement | null {
  const scoped =
    postContainerEl?.querySelector<HTMLButtonElement>('.footer-fixed .linkedin-post-btn');
  if (scoped) {
    return scoped;
  }

  return document.querySelector<HTMLButtonElement>(
    '.post-container .footer-fixed .linkedin-post-btn',
  );
}

export function findPreviewCreateImageButton(
  postContainerEl: HTMLElement | null,
): HTMLButtonElement | null {
  const scoped = postContainerEl?.querySelector<HTMLButtonElement>('.create-image-btn');
  if (scoped) {
    return scoped;
  }

  return document.querySelector<HTMLButtonElement>('.post-container .create-image-btn');
}

export function findPreviewCreateImageHost(
  postContainerEl: HTMLElement | null,
): HTMLElement | null {
  const scoped =
    postContainerEl?.querySelector<HTMLElement>('.create-image-btn')?.parentElement;
  if (scoped) {
    return scoped;
  }

  const global = document.querySelector<HTMLElement>('.post-container .create-image-btn');
  return global?.parentElement ?? null;
}

export function setButtonLeadText(
  button: HTMLButtonElement,
  text: string,
): void {
  const iconSpan = button.querySelector('span');
  for (const child of Array.from(button.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      child.remove();
    }
  }
  button.insertBefore(document.createTextNode(`${text} `), iconSpan ?? null);
}

type StanleyXWindow = Window & {
  __STANLEY_X_INIT__?: boolean;
};

type PreviewElements = {
  postContentEl: HTMLElement;
  postContainerEl: HTMLElement | null;
};

type Mode = 'linkedin' | 'x';
type Signal = 'attach' | 'input' | 'mutation' | 'maxWait';

const THREAD_URL_RE =
  /^https:\/\/(?:[a-z0-9-]+\.)?stanley\.stan\.store\/thread\/?/i;
const DISCOVERY_INTERVAL_MS = 500;
const MAX_DISCOVERY_ATTEMPTS = 40;
const DEBOUNCE_MS = 800;
const MAX_WAIT_MS = 5000;

type ContentState = {
  currentUrl: string;
  postContentEl: HTMLElement | null;
  postContainerEl: HTMLElement | null;
  onInput: ((event: Event) => void) | null;
  editorObserver: MutationObserver | null;
  lifecycleObserver: MutationObserver | null;
  lifecycleTickTimer: number | null;
  lifecycleCheckTimer: number | null;
  discoveryTimer: number | null;
  discoveryAttempts: number;
  debounceTimer: number | null;
  maxWaitTimer: number | null;
  lastCommittedText: string | null;
  latestText: string;
  mode: Mode;
  modeToggleHost: HTMLButtonElement | null;
  xContentEl: HTMLDivElement | null;
  xContentTextEl: HTMLParagraphElement | null;
  cssInjected: boolean;
};

export default defineContentScript({
  matches: [
    'https://stanley.stan.store/thread/*',
    'https://*.stanley.stan.store/thread/*',
  ],
  runAt: 'document_idle',
  main() {
    if (!isThreadUrl(window.location.href)) {
      return;
    }

    const win = window as StanleyXWindow;
    if (win.__STANLEY_X_INIT__) {
      return;
    }
    win.__STANLEY_X_INIT__ = true;

    const state: ContentState = {
      currentUrl: window.location.href,
      postContentEl: null,
      postContainerEl: null,
      onInput: null,
      editorObserver: null,
      lifecycleObserver: null,
      lifecycleTickTimer: null,
      lifecycleCheckTimer: null,
      discoveryTimer: null,
      discoveryAttempts: 0,
      debounceTimer: null,
      maxWaitTimer: null,
      lastCommittedText: null,
      latestText: '',
      mode: 'linkedin',
      modeToggleHost: null,
      xContentEl: null,
      xContentTextEl: null,
      cssInjected: false,
    };
    const linkedInIconUrl = browser.runtime.getURL('/linkedin.svg');
    const xIconUrl = browser.runtime.getURL('/x.svg');
    const xIconFallbackUrl = browser.runtime.getURL('/x.png');

    function normalize(text: string): string {
      if (!text) {
        return '';
      }

      return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n');
    }

    function findPreviewElements(): PreviewElements | null {
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

    function findPreviewFeedbackButton(): HTMLButtonElement | null {
      const scoped = state.postContainerEl?.querySelector<HTMLButtonElement>(
        '.footer-fixed .feedback-btn',
      );
      if (scoped) {
        return scoped;
      }

      return document.querySelector<HTMLButtonElement>(
        '.post-container .footer-fixed .feedback-btn',
      );
    }

    function stopDiscovery(): void {
      if (state.discoveryTimer !== null) {
        window.clearInterval(state.discoveryTimer);
        state.discoveryTimer = null;
      }
    }

    function clearCommitTimers(): void {
      if (state.debounceTimer !== null) {
        window.clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
      if (state.maxWaitTimer !== null) {
        window.clearTimeout(state.maxWaitTimer);
        state.maxWaitTimer = null;
      }
    }

    function ensureCss(): void {
      if (state.cssInjected || document.getElementById('stanley-x-inline-style')) {
        state.cssInjected = true;
        return;
      }

      const style = document.createElement('style');
      style.id = 'stanley-x-inline-style';
      style.textContent = `
        #stanley-x-mode-toggle {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-left: 8px;
          width: 92px;
          height: 38px;
          padding: 4px;
          border-radius: 999px;
          border: 0;
          background: #0a66c2;
          box-shadow: 0 8px 20px rgba(10, 102, 194, 0.32);
          cursor: pointer;
          user-select: none;
          overflow: hidden;
          transition: transform 0.15s ease, background-color 0.2s ease, box-shadow 0.2s ease;
        }
        #stanley-x-mode-toggle:hover {
          transform: translateY(-1px);
        }
        #stanley-x-mode-toggle[data-mode="x"] {
          background: #000000;
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
        }
        #stanley-x-mode-toggle::before {
          content: "";
          position: absolute;
          top: 4px;
          left: 4px;
          width: calc(50% - 4px);
          height: calc(100% - 8px);
          border-radius: 999px;
          background: #ffffff;
          box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18);
          transition: transform 0.2s ease;
        }
        #stanley-x-mode-toggle .stanley-x-mode-slot {
          position: relative;
          z-index: 1;
          width: 50%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
        }
        #stanley-x-mode-toggle .stanley-x-mode-icon {
          width: 18px;
          height: 18px;
          display: block;
          object-fit: contain;
          opacity: 0.72;
          transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;
          pointer-events: none;
        }
        #stanley-x-mode-toggle[data-mode="x"]::before {
          transform: translateX(100%);
        }
        #stanley-x-mode-toggle[data-mode="linkedin"] .stanley-x-mode-icon-linkedin {
          opacity: 1;
          transform: scale(1.08);
        }
        #stanley-x-mode-toggle[data-mode="x"] .stanley-x-mode-icon-x {
          opacity: 1;
          transform: scale(1.08);
        }
        .stanley-x-li-hidden {
          opacity: 0 !important;
          max-height: 0 !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          pointer-events: none !important;
          border: 0 !important;
        }
        .stanley-x-twitter-content {
          white-space: pre-wrap;
          outline: none;
          border: none;
          min-height: 200px;
          border-radius: 8px;
          border: 1px dashed rgba(99, 85, 255, 0.45);
          background: rgba(99, 85, 255, 0.08);
          color: inherit;
          padding: 12px;
          margin-bottom: 12px;
          box-sizing: border-box;
        }
        .stanley-x-twitter-content p {
          margin: 0;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }
        .stanley-x-chat-input-disabled textarea[data-chat-input] {
          opacity: 0.55 !important;
          cursor: not-allowed !important;
        }
        .feedback-btn.stanley-x-feedback-disabled {
          opacity: 0.45 !important;
          cursor: not-allowed !important;
          pointer-events: none !important;
          filter: saturate(0.4);
        }
        @media (prefers-color-scheme: dark) {
          .stanley-x-twitter-content {
            border-color: rgba(129, 140, 248, 0.55);
            background: rgba(67, 56, 202, 0.2);
          }
        }
      `;

      document.head.appendChild(style);
      state.cssInjected = true;
    }

    function removeTwitterReplacement(): void {
      if (state.xContentEl) {
        state.xContentEl.remove();
      }
      state.xContentEl = null;
      state.xContentTextEl = null;
    }

    function applyModeToPreview(): void {
      const postContentEl = state.postContentEl;
      if (!postContentEl) {
        removeTwitterReplacement();
        return;
      }

      const host = postContentEl.parentElement;
      if (!host) {
        return;
      }

      if (state.mode === 'linkedin') {
        postContentEl.classList.remove('stanley-x-li-hidden');
        if (state.xContentEl) {
          state.xContentEl.style.display = 'none';
        }
        return;
      }

      if (!state.xContentEl || state.xContentEl.parentElement !== host) {
        removeTwitterReplacement();

        const xContent = document.createElement('div');
        xContent.className = 'stanley-x-twitter-content';

        const xText = document.createElement('p');
        xText.textContent = 'twitter';

        xContent.appendChild(xText);
        postContentEl.insertAdjacentElement('afterend', xContent);

        state.xContentEl = xContent;
        state.xContentTextEl = xText;
      }

      if (state.xContentEl) {
        state.xContentEl.style.display = 'block';
        state.xContentEl.style.width = postContentEl.style.width || '';
        state.xContentEl.style.maxWidth = postContentEl.style.maxWidth || '';
      }

      postContentEl.classList.add('stanley-x-li-hidden');
    }

    function updateModeToggleUi(): void {
      if (!state.modeToggleHost) {
        return;
      }

      const isLinkedIn = state.mode === 'linkedin';
      state.modeToggleHost.dataset.mode = state.mode;
      const currentModeLabel = isLinkedIn ? 'LinkedIn' : 'X';
      const nextModeLabel = isLinkedIn ? 'X' : 'LinkedIn';
      state.modeToggleHost.setAttribute(
        'aria-label',
        `Current mode: ${currentModeLabel}. Click to switch to ${nextModeLabel} mode.`,
      );
      state.modeToggleHost.setAttribute('title', `Switch to ${nextModeLabel} mode`);
      state.modeToggleHost.setAttribute(
        'aria-pressed',
        state.mode === 'x' ? 'true' : 'false',
      );
    }

    function applyChatInputMode(): void {
      const textarea =
        document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input]');
      if (!textarea) {
        return;
      }

      const inputArea = textarea.closest<HTMLElement>('.input-area');
      const shouldDisable = state.mode === 'x';

      if (!textarea.dataset.stanleyXPlaceholder) {
        textarea.dataset.stanleyXPlaceholder = textarea.placeholder || '';
      }

      textarea.disabled = shouldDisable;
      textarea.readOnly = shouldDisable;
      textarea.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');

      if (shouldDisable) {
        textarea.blur();
        textarea.placeholder = 'X mode active';
      } else {
        textarea.placeholder = textarea.dataset.stanleyXPlaceholder || '';
      }

      if (inputArea) {
        inputArea.classList.toggle('stanley-x-chat-input-disabled', shouldDisable);
      }
    }

    function applyFeedbackButtonMode(): void {
      const feedbackBtn = findPreviewFeedbackButton();
      if (!feedbackBtn) {
        return;
      }

      const shouldDisable = state.mode === 'x';
      if (!feedbackBtn.dataset.stanleyXTitle) {
        feedbackBtn.dataset.stanleyXTitle = feedbackBtn.getAttribute('title') || '';
      }

      feedbackBtn.disabled = shouldDisable;
      feedbackBtn.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');
      feedbackBtn.classList.toggle('stanley-x-feedback-disabled', shouldDisable);

      if (shouldDisable) {
        feedbackBtn.setAttribute('title', 'Disabled in X mode');
      } else {
        const originalTitle = feedbackBtn.dataset.stanleyXTitle;
        if (originalTitle) {
          feedbackBtn.setAttribute('title', originalTitle);
        } else {
          feedbackBtn.removeAttribute('title');
        }
      }
    }

    function setMode(mode: Mode): void {
      state.mode = mode;
      updateModeToggleUi();
      applyModeToPreview();
      applyChatInputMode();
      applyFeedbackButtonMode();
    }

    function ensureModeToggle(): void {
      const feedbackBtn = findPreviewFeedbackButton();
      if (!feedbackBtn || !feedbackBtn.parentElement) {
        return;
      }

      if (!state.modeToggleHost) {
        const toggle = document.createElement('button');
        toggle.id = 'stanley-x-mode-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', 'false');

        const linkedInIcon = document.createElement('img');
        linkedInIcon.className = 'stanley-x-mode-icon stanley-x-mode-icon-linkedin';
        linkedInIcon.src = linkedInIconUrl;
        linkedInIcon.alt = 'LinkedIn';

        const xIcon = document.createElement('img');
        xIcon.className = 'stanley-x-mode-icon stanley-x-mode-icon-x';
        xIcon.src = xIconUrl;
        xIcon.alt = 'X';
        xIcon.addEventListener(
          'error',
          () => {
            if (xIcon.src !== xIconFallbackUrl) {
              xIcon.src = xIconFallbackUrl;
            }
          },
          { once: true },
        );

        const linkedInSlot = document.createElement('span');
        linkedInSlot.className =
          'stanley-x-mode-slot stanley-x-mode-slot-linkedin';
        linkedInSlot.append(linkedInIcon);

        const xSlot = document.createElement('span');
        xSlot.className = 'stanley-x-mode-slot stanley-x-mode-slot-x';
        xSlot.append(xIcon);

        toggle.append(linkedInSlot, xSlot);
        toggle.addEventListener('click', () => {
          setMode(state.mode === 'linkedin' ? 'x' : 'linkedin');
        });

        state.modeToggleHost = toggle;
      }

      if (
        state.modeToggleHost.parentElement !== feedbackBtn.parentElement ||
        state.modeToggleHost.previousElementSibling !== feedbackBtn
      ) {
        feedbackBtn.insertAdjacentElement('afterend', state.modeToggleHost);
      }

      updateModeToggleUi();
    }

    function ensureUi(): void {
      ensureCss();
      ensureModeToggle();
      applyModeToPreview();
      applyChatInputMode();
      applyFeedbackButtonMode();
    }

    function cleanupEditorBinding(): void {
      clearCommitTimers();

      if (state.postContentEl && state.onInput) {
        state.postContentEl.removeEventListener('input', state.onInput);
      }
      state.onInput = null;

      if (state.editorObserver) {
        state.editorObserver.disconnect();
        state.editorObserver = null;
      }

      if (state.postContentEl) {
        state.postContentEl.classList.remove('stanley-x-li-hidden');
      }
      removeTwitterReplacement();

      state.postContentEl = null;
      state.postContainerEl = null;
    }

    function commitDraft(signal: Signal): void {
      clearCommitTimers();

      const el = state.postContentEl;
      if (!el || !el.isConnected) {
        startDiscovery();
        return;
      }

      const text = normalize(el.innerText ?? '');
      if (text === state.lastCommittedText) {
        return;
      }

      state.lastCommittedText = text;
      state.latestText = text;

      console.log('[Stanley-X] LinkedIn draft updated:', {
        chars: text.length,
        preview: text.slice(0, 120),
      });

      void browser.storage.local
        .set({
          stanley_x_lastDraft: text,
          stanley_x_lastUpdatedAt: Date.now(),
        })
        .catch((error: unknown) => {
          console.debug('[Stanley-X] storage write skipped:', error, signal);
        });
    }

    function scheduleCommit(signal: Signal): void {
      if (!state.postContentEl) {
        return;
      }

      if (state.debounceTimer !== null) {
        window.clearTimeout(state.debounceTimer);
      }
      state.debounceTimer = window.setTimeout(() => {
        commitDraft(signal);
      }, DEBOUNCE_MS);

      if (state.maxWaitTimer === null) {
        state.maxWaitTimer = window.setTimeout(() => {
          commitDraft('maxWait');
        }, MAX_WAIT_MS);
      }
    }

    function attachEditor(
      postContentEl: HTMLElement,
      postContainerEl: HTMLElement | null,
    ): void {
      if (state.postContentEl === postContentEl) {
        applyModeToPreview();
        return;
      }

      cleanupEditorBinding();

      state.postContentEl = postContentEl;
      state.postContainerEl = postContainerEl;
      state.lastCommittedText = null;

      state.onInput = () => {
        scheduleCommit('input');
      };

      state.postContentEl.addEventListener('input', state.onInput, {
        passive: true,
      });

      state.editorObserver = new MutationObserver(() => {
        scheduleCommit('mutation');
      });
      state.editorObserver.observe(state.postContentEl, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      applyModeToPreview();
      scheduleCommit('attach');
    }

    function tryInitialize(): boolean {
      if (!isThreadUrl(window.location.href)) {
        return false;
      }

      const found = findPreviewElements();
      if (!found) {
        return false;
      }

      attachEditor(found.postContentEl, found.postContainerEl);
      return true;
    }

    function startDiscovery(): void {
      if (!isThreadUrl(window.location.href)) {
        return;
      }
      if (state.discoveryTimer !== null) {
        return;
      }

      state.discoveryAttempts = 0;

      const attempt = (): void => {
        state.discoveryAttempts += 1;
        const initialized = tryInitialize();
        if (initialized || state.discoveryAttempts >= MAX_DISCOVERY_ATTEMPTS) {
          stopDiscovery();
        }
      };

      attempt();
      if (!state.postContentEl && state.discoveryAttempts < MAX_DISCOVERY_ATTEMPTS) {
        state.discoveryTimer = window.setInterval(attempt, DISCOVERY_INTERVAL_MS);
      }
    }

    function runLifecycleCheck(): void {
      const nowUrl = window.location.href;
      if (nowUrl !== state.currentUrl) {
        state.currentUrl = nowUrl;
        state.lastCommittedText = null;
      }

      if (!isThreadUrl(nowUrl)) {
        stopDiscovery();
        if (state.postContentEl) {
          cleanupEditorBinding();
        }
        const textarea = document.querySelector<HTMLTextAreaElement>(
          'textarea[data-chat-input]',
        );
        const inputArea = textarea?.closest<HTMLElement>('.input-area');
        if (textarea) {
          textarea.disabled = false;
          textarea.readOnly = false;
          textarea.setAttribute('aria-disabled', 'false');
          if (textarea.dataset.stanleyXPlaceholder) {
            textarea.placeholder = textarea.dataset.stanleyXPlaceholder;
          }
        }
        if (inputArea) {
          inputArea.classList.remove('stanley-x-chat-input-disabled');
        }
        const feedbackBtn = findPreviewFeedbackButton();
        if (feedbackBtn) {
          feedbackBtn.disabled = false;
          feedbackBtn.setAttribute('aria-disabled', 'false');
          feedbackBtn.classList.remove('stanley-x-feedback-disabled');
          if (feedbackBtn.dataset.stanleyXTitle) {
            feedbackBtn.setAttribute('title', feedbackBtn.dataset.stanleyXTitle);
          } else {
            feedbackBtn.removeAttribute('title');
          }
        }
        if (state.modeToggleHost) {
          state.modeToggleHost.style.display = 'none';
        }
        return;
      }

      ensureUi();
      if (state.modeToggleHost) {
        state.modeToggleHost.style.display = 'inline-flex';
      }

      if (state.postContentEl && !state.postContentEl.isConnected) {
        cleanupEditorBinding();
      }

      const found = findPreviewElements();
      if (!found) {
        startDiscovery();
        return;
      }

      if (found.postContentEl !== state.postContentEl) {
        attachEditor(found.postContentEl, found.postContainerEl);
      } else {
        applyModeToPreview();
      }
    }

    function queueLifecycleCheck(): void {
      if (state.lifecycleCheckTimer !== null) {
        return;
      }

      state.lifecycleCheckTimer = window.setTimeout(() => {
        state.lifecycleCheckTimer = null;
        runLifecycleCheck();
      }, 100);
    }

    function startLifecycleMonitoring(): void {
      state.lifecycleObserver = new MutationObserver(() => {
        queueLifecycleCheck();
      });
      state.lifecycleObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      state.lifecycleTickTimer = window.setInterval(runLifecycleCheck, 1000);
      window.addEventListener('popstate', queueLifecycleCheck);
      window.addEventListener('hashchange', queueLifecycleCheck);
      window.addEventListener('resize', queueLifecycleCheck);
    }

    ensureUi();
    startLifecycleMonitoring();
    startDiscovery();
  },
});

function isThreadUrl(url: string): boolean {
  return THREAD_URL_RE.test(url);
}

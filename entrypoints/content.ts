type StanleyXWindow = Window & {
  __STANLEY_X_INIT__?: boolean;
};

type PreviewElements = {
  postContentEl: HTMLElement;
  postContainerEl: HTMLElement | null;
};

type Signal = 'attach' | 'input' | 'mutation' | 'maxWait';

const THREAD_URL_RE =
  /^https:\/\/(staging2?\.)?stanley\.stan\.store\/thread\/[^/?#]+/i;
const DISCOVERY_INTERVAL_MS = 500;
const MAX_DISCOVERY_ATTEMPTS = 40;
const DEBOUNCE_MS = 800;
const MAX_WAIT_MS = 5000;

export default defineContentScript({
  matches: [
    'https://stanley.stan.store/thread/*',
    'https://staging.stanley.stan.store/thread/*',
    'https://staging2.stanley.stan.store/thread/*',
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

    const state: {
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
    } = {
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
    };

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
        return;
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
    }

    startLifecycleMonitoring();
    startDiscovery();
  },
});

function isThreadUrl(url: string): boolean {
  return THREAD_URL_RE.test(url);
}

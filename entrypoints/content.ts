import type {
  AttachedImage,
  ContentState,
  GenerateTrigger,
  GenerateXDraftPayload,
  GenerateXDraftResponse,
  Mode,
  PersistedXDraftHistory,
  Signal,
  StanleyXWindow,
  XDraftCacheEntry,
  XDraftRevision,
  XDraftStatus,
} from './content/types';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  DEBOUNCE_MS,
  DEFAULT_BACKEND_URL,
  DISCOVERY_INTERVAL_MS,
  GENERATE_X_DRAFT_MESSAGE,
  MAX_ATTACHED_IMAGES,
  MAX_DISCOVERY_ATTEMPTS,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_FILE_BYTES,
  MAX_REWRITE_INSTRUCTIONS_CHARS,
  MAX_STORED_IMAGE_DATA_URL_LENGTH,
  MAX_WAIT_MS,
  X_STANDARD_CHAR_LIMIT,
  X_DRAFT_CACHE_PREFIX,
  X_DRAFT_HISTORY_LIMIT,
  X_DRAFT_HISTORY_PREFIX,
  X_DRAFT_IMAGES_PREFIX,
  X_VERIFIED_CHAR_LIMIT,
} from './content/constants';
import {
  findPreviewCopyButton,
  findPreviewCreateImageButton,
  findPreviewCreateImageHost,
  findPreviewElements,
  findPreviewFeedbackButton,
  findPreviewShareButton,
  findPreviewWordCountEl,
  setButtonLeadText,
} from './content/dom';
import { getThreadIdFromUrl, isThreadUrl } from './content/url';
import {
  buildXComposeUrl,
  countWords,
  formatErrorMessage,
  isSignificantChange,
  normalize,
  normalizeRewriteInstructions,
  sha256Hex,
  toAttachedImage,
  toHandleFromName,
} from './content/utils';

export default defineContentScript({
  matches: [
    'https://stanley.stan.store/thread/*',
    'https://*.stanley.stan.store/thread/*',
  ],
  runAt: 'document_idle',
  main() {
    try {
      if (!isThreadUrl(window.location.href)) {
        return;
      }

      const win = window as StanleyXWindow;
      if (win.__STANLEY_X_INIT__) {
        const hasExistingUi =
          !!document.getElementById('stanley-x-mode-toggle') ||
          !!document.getElementById('stanley-x-inline-style');
        if (hasExistingUi) {
          return;
        }
        // Recover when HMR/extension reload leaves a stale global flag behind.
        win.__STANLEY_X_INIT__ = false;
      }
      win.__STANLEY_X_INIT__ = true;

      console.log('[Stanley-X] content script initialized', {
        url: window.location.href,
      });

      const state: ContentState = {
        currentUrl: window.location.href,
        threadId: getThreadIdFromUrl(window.location.href),
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
        xHeaderEl: null,
        xToolbarEl: null,
        xContentEl: null,
        xContentTextEl: null,
        rewriteToggleButtonEl: null,
        xVerifiedToggleButtonEl: null,
        rewritePanelEl: null,
        rewriteTextareaEl: null,
        rewriteApplyButtonEl: null,
        rewriteChipButtons: [],
        revisionControlsEl: null,
        revisionPrevButtonEl: null,
        revisionNextButtonEl: null,
        revisionRevertButtonEl: null,
        xImagesGridEl: null,
        addImagesHostEl: null,
        addImagesButtonEl: null,
        addImagesClickHandler: null,
        addImagesInputEl: null,
        attachedImages: [],
        feedbackButtonEl: null,
        feedbackClickHandler: null,
        feedbackModalEl: null,
        feedbackModalAvatarEl: null,
        feedbackModalNameEl: null,
        feedbackModalHandleEl: null,
        feedbackModalTweetTextEl: null,
        feedbackModalImagesEl: null,
        feedbackModalCloseBtnEl: null,
        feedbackModalBackdropEl: null,
        feedbackModalIsOpen: false,
        footerShareButtonEl: null,
        footerShareHandler: null,
        footerCopyButtonEl: null,
        footerCopyHandler: null,
        rewritePanelOpen: false,
        rewriteTextareaExpanded: false,
        rewriteInstructions: '',
        cssInjected: false,
        xDraftStatus: 'idle',
        xDraftText: '',
        xDraftError: null,
        lastGeneratedSourceText: null,
        lastGeneratedSourceHash: null,
        lastGeneratedAt: null,
        generationRequestId: 0,
        activeGenerationRequestId: null,
        generationInFlightHash: null,
        revisionHistory: [],
        currentRevisionIndex: -1,
        isXVerified: false,
      };
      const linkedInIconUrl = browser.runtime.getURL('/linkedin.svg');
      const xIconUrl = browser.runtime.getURL('/x.svg');
      const xIconFallbackUrl = browser.runtime.getURL('/x.png');
      const xVerifiedIconUrl = browser.runtime.getURL('/x-verified.svg');

    function getXDraftCacheKey(sourceHash: string): string {
      return `${X_DRAFT_CACHE_PREFIX}${sourceHash}`;
    }

    function getXDraftHistoryKey(threadId: string): string {
      return `${X_DRAFT_HISTORY_PREFIX}${threadId}`;
    }

    function getXDraftImagesKey(threadId: string): string {
      return `${X_DRAFT_IMAGES_PREFIX}${threadId}`;
    }

    function getCurrentSourceText(): string {
      const liveText = normalize(state.postContentEl?.innerText ?? '');
      if (liveText) {
        return liveText;
      }
      return normalize(state.latestText);
    }

    function getCurrentXCharacterLimit(): number {
      return state.isXVerified ? X_VERIFIED_CHAR_LIMIT : X_STANDARD_CHAR_LIMIT;
    }

    function stripAutoLimitInstructions(text: string): string {
      const normalized = normalize(text);
      if (!normalized) {
        return '';
      }
      const cleaned = normalized
        .split('\n')
        .filter(
          (line) =>
            !/^\s*keep this within \d[\d,]* characters\.?\s*$/i.test(line.trim()),
        )
        .join('\n');
      return normalizeRewriteInstructions(cleaned);
    }

    function clampXTextToLimit(text: string): string {
      const normalizedText = normalize(text);
      const limit = getCurrentXCharacterLimit();
      if (normalizedText.length <= limit) {
        return normalizedText;
      }
      return normalizedText.slice(0, limit).trimEnd();
    }

    function getVisibleXText(): string {
      return clampXTextToLimit(state.xDraftText);
    }

    function getXDraftDisplayText(): string {
      if (state.xDraftStatus === 'loading') {
        return 'Generating X draft...';
      }
      if (state.xDraftStatus === 'error') {
        const message = state.xDraftError || 'Unable to generate X draft right now.';
        return `Could not generate X draft.\n${message}`;
      }
      if (state.xDraftStatus === 'ready') {
        return getVisibleXText() || 'No X draft returned.';
      }
      return 'Switch to X mode to generate an X-native draft.';
    }

    function renderXContent(): void {
      if (!state.xContentTextEl) {
        return;
      }
      state.xContentTextEl.textContent = getXDraftDisplayText();
    }

    function setXDraftState(
      status: XDraftStatus,
      options?: {
        text?: string;
        error?: string | null;
      },
    ): void {
      state.xDraftStatus = status;
      if (typeof options?.text === 'string') {
        state.xDraftText = options.text;
      }
      if (typeof options?.error !== 'undefined') {
        state.xDraftError = options.error;
      } else if (status !== 'error') {
        state.xDraftError = null;
      }
      renderXContent();
      updateRewritePanelUi();
      updateRevisionUi();
      updateFooterControls();
      updateFeedbackModalContent();
    }

    function updateRevisionUi(): void {
      if (
        !state.revisionControlsEl ||
        !state.revisionPrevButtonEl ||
        !state.revisionNextButtonEl ||
        !state.revisionRevertButtonEl
      ) {
        return;
      }

      const total = state.revisionHistory.length;
      const hasSelection =
        state.currentRevisionIndex >= 0 && state.currentRevisionIndex < total;
      const isBusy = state.xDraftStatus === 'loading';

      state.revisionControlsEl.style.display = total > 1 ? 'inline-flex' : 'none';

      state.revisionPrevButtonEl.disabled =
        isBusy || !hasSelection || state.currentRevisionIndex <= 0;
      state.revisionNextButtonEl.disabled =
        isBusy || !hasSelection || state.currentRevisionIndex >= total - 1;
      state.revisionPrevButtonEl.style.display =
        hasSelection && state.currentRevisionIndex > 0 ? 'inline-flex' : 'none';
      state.revisionNextButtonEl.style.display =
        hasSelection && state.currentRevisionIndex < total - 1
          ? 'inline-flex'
          : 'none';
      state.revisionRevertButtonEl.disabled = isBusy || !hasSelection;
      state.revisionRevertButtonEl.style.display =
        hasSelection && state.currentRevisionIndex > 0 ? 'inline-flex' : 'none';
    }

    function toRevision(value: unknown): XDraftRevision | null {
      if (!value || typeof value !== 'object') {
        return null;
      }

      const item = value as Partial<XDraftRevision>;
      if (
        typeof item.sourceHash !== 'string' ||
        typeof item.sourceText !== 'string' ||
        typeof item.xText !== 'string' ||
        typeof item.generatedAt !== 'number'
      ) {
        return null;
      }

      return {
        sourceHash: item.sourceHash,
        sourceText: normalize(item.sourceText),
        rewriteInstructions: normalizeRewriteInstructions(
          typeof item.rewriteInstructions === 'string'
            ? item.rewriteInstructions
            : '',
        ),
        xText: normalize(item.xText),
        generatedAt: item.generatedAt,
      };
    }

    function persistRevisionHistory(): void {
      const historyKey = getXDraftHistoryKey(state.threadId);
      const payload: PersistedXDraftHistory = {
        revisions: state.revisionHistory,
        currentRevisionIndex: state.currentRevisionIndex,
      };

      void browser.storage.local
        .set({
          [historyKey]: payload,
        })
        .catch((error: unknown) => {
          console.debug('[Stanley-X] x-draft history write skipped:', error);
        });
    }

    function selectRevision(
      index: number,
      options?: {
        persist?: boolean;
      },
    ): void {
      const revision = state.revisionHistory[index];
      if (!revision) {
        return;
      }

      state.currentRevisionIndex = index;
      state.rewriteInstructions = normalizeRewriteInstructions(
        revision.rewriteInstructions,
      );
      if (state.rewriteTextareaEl) {
        state.rewriteTextareaEl.value = state.rewriteInstructions;
        state.rewriteTextareaExpanded = false;
      }

      state.lastGeneratedSourceHash = revision.sourceHash;
      state.lastGeneratedSourceText = revision.sourceText;
      state.lastGeneratedAt = revision.generatedAt;
      setXDraftState('ready', {
        text: revision.xText,
        error: null,
      });

      if (options?.persist !== false) {
        persistRevisionHistory();
      }
    }

    function upsertRevision(revision: XDraftRevision): void {
      const normalizedRevision: XDraftRevision = {
        sourceHash: revision.sourceHash,
        sourceText: normalize(revision.sourceText),
        rewriteInstructions: normalizeRewriteInstructions(revision.rewriteInstructions),
        xText: normalize(revision.xText),
        generatedAt: revision.generatedAt,
      };

      const existingIndex = state.revisionHistory.findIndex((item) => {
        return (
          item.sourceHash === normalizedRevision.sourceHash &&
          item.rewriteInstructions === normalizedRevision.rewriteInstructions &&
          item.xText === normalizedRevision.xText
        );
      });

      if (existingIndex >= 0) {
        state.revisionHistory.splice(existingIndex, 1);
      }

      state.revisionHistory.unshift(normalizedRevision);
      if (state.revisionHistory.length > X_DRAFT_HISTORY_LIMIT) {
        state.revisionHistory.length = X_DRAFT_HISTORY_LIMIT;
      }
      state.currentRevisionIndex = 0;

      updateRevisionUi();
      persistRevisionHistory();
    }

    async function loadPersistedHistoryForThread(threadId: string): Promise<void> {
      const historyKey = getXDraftHistoryKey(threadId);

      try {
        const stored = await browser.storage.local.get(historyKey);
        if (threadId !== state.threadId) {
          return;
        }

        const raw = stored[historyKey] as Partial<PersistedXDraftHistory> | undefined;
        const rawRevisions = Array.isArray(raw?.revisions) ? raw.revisions : [];

        const revisions = rawRevisions
          .map((item) => toRevision(item))
          .filter((item): item is XDraftRevision => item !== null)
          .sort((left, right) => right.generatedAt - left.generatedAt);

        state.revisionHistory = revisions;

        if (revisions.length === 0) {
          state.currentRevisionIndex = -1;
          updateRevisionUi();
          return;
        }

        selectRevision(0, { persist: false });
      } catch (error: unknown) {
        console.debug('[Stanley-X] x-draft history read skipped:', error);
      }
    }

    function resetRevisionState(): void {
      state.revisionHistory = [];
      state.currentRevisionIndex = -1;
      updateRevisionUi();
    }

    function revertToCurrentRevision(): void {
      if (state.currentRevisionIndex <= 0) {
        return;
      }
      const selectedRevision = state.revisionHistory[state.currentRevisionIndex];
      if (!selectedRevision) {
        return;
      }

      const revertedRevision: XDraftRevision = {
        ...selectedRevision,
        generatedAt: Date.now(),
      };
      upsertRevision(revertedRevision);
      selectRevision(0);
    }

    function navigateRevision(step: -1 | 1): void {
      if (state.xDraftStatus === 'loading') {
        return;
      }

      const nextIndex = state.currentRevisionIndex + step;
      if (nextIndex < 0 || nextIndex >= state.revisionHistory.length) {
        return;
      }

      selectRevision(nextIndex);
    }

    function persistAttachedImages(): void {
      const key = getXDraftImagesKey(state.threadId);
      void browser.storage.local
        .set({
          [key]: state.attachedImages,
        })
        .catch((error: unknown) => {
          console.warn('[Stanley-X] image persistence failed:', error);
        });
    }

    function removeAttachedImage(imageId: string): void {
      const nextImages = state.attachedImages.filter((item) => item.id !== imageId);
      if (nextImages.length === state.attachedImages.length) {
        return;
      }
      state.attachedImages = nextImages;
      persistAttachedImages();
      renderAttachedImages();
    }

    async function loadPersistedImagesForThread(threadId: string): Promise<void> {
      const key = getXDraftImagesKey(threadId);
      try {
        const stored = await browser.storage.local.get(key);
        if (threadId !== state.threadId) {
          return;
        }

        const raw = stored[key];
        const rawList = Array.isArray(raw) ? raw : [];
        state.attachedImages = rawList
          .map((item) => toAttachedImage(item))
          .filter((item): item is AttachedImage => item !== null)
          .sort((a, b) => a.addedAt - b.addedAt)
          .slice(-MAX_ATTACHED_IMAGES);
      } catch (error: unknown) {
        state.attachedImages = [];
        console.debug('[Stanley-X] image history read skipped:', error);
      }
      renderAttachedImages();
    }

    async function readFileAsDataUrl(file: File): Promise<string> {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => {
          reject(new Error(`Unable to read file: ${file.name}`));
        };
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
            return;
          }
          reject(new Error(`Invalid file content: ${file.name}`));
        };
        reader.readAsDataURL(file);
      });
    }

    async function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to decode selected image'));
        image.src = dataUrl;
      });
    }

    async function optimizeImageDataUrl(dataUrl: string): Promise<string> {
      const image = await loadImageElement(dataUrl);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        return dataUrl;
      }

      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        return dataUrl;
      }
      context.drawImage(image, 0, 0, targetWidth, targetHeight);

      const qualities = [0.86, 0.76, 0.66, 0.56];
      let best = canvas.toDataURL('image/jpeg', qualities[0]);
      for (const quality of qualities) {
        const encoded = canvas.toDataURL('image/jpeg', quality);
        if (encoded.length <= MAX_STORED_IMAGE_DATA_URL_LENGTH) {
          return encoded;
        }
        best = encoded;
      }

      if (best.length < dataUrl.length) {
        return best;
      }
      return dataUrl;
    }

    function openImagePicker(): void {
      const input = ensureImagePickerInput();
      input.value = '';
      const maybeInput = input as HTMLInputElement & {
        showPicker?: () => void;
      };

      try {
        input.click();
        return;
      } catch {
        // Fallback below.
      }

      if (typeof maybeInput.showPicker === 'function') {
        try {
          maybeInput.showPicker();
        } catch {
          // No-op.
        }
      }
    }

    async function handleImageSelection(files: FileList | null): Promise<void> {
      if (!files) {
        return;
      }

      const selected = Array.from(files)
        .filter((file) => file.type.startsWith('image/'))
        .filter((file) => file.size > 0);
      if (selected.length === 0) {
        return;
      }

      const availableSlots = MAX_ATTACHED_IMAGES - state.attachedImages.length;
      if (availableSlots <= 0) {
        console.info(`[Stanley-X] Max ${MAX_ATTACHED_IMAGES} images allowed.`);
        return;
      }

      const nextItems: AttachedImage[] = [];
      for (const file of selected.slice(0, availableSlots)) {
        if (file.size > MAX_IMAGE_FILE_BYTES) {
          console.info(
            `[Stanley-X] Skipped ${file.name}: file too large (${Math.round(file.size / 1024)} KB).`,
          );
          continue;
        }

        try {
          const rawDataUrl = await readFileAsDataUrl(file);
          const dataUrl = await optimizeImageDataUrl(rawDataUrl);
          nextItems.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'image',
            dataUrl,
            addedAt: Date.now(),
          });
        } catch (error: unknown) {
          console.warn('[Stanley-X] image read failed:', error);
        }
      }

      if (nextItems.length === 0) {
        return;
      }

      state.attachedImages = [...state.attachedImages, ...nextItems].slice(
        -MAX_ATTACHED_IMAGES,
      );
      persistAttachedImages();
      renderAttachedImages();
    }

    function ensureImagePickerInput(): HTMLInputElement {
      if (!state.addImagesInputEl || !state.addImagesInputEl.isConnected) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.top = '0';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        input.style.width = '1px';
        input.style.height = '1px';
        input.addEventListener('change', () => {
          void handleImageSelection(input.files).finally(() => {
            input.value = '';
          });
        });
        document.body.appendChild(input);
        state.addImagesInputEl = input;
      }
      return state.addImagesInputEl;
    }

    function renderAttachedImages(): void {
      const createImageButton = state.addImagesButtonEl;
      const createImageHost = state.addImagesHostEl;
      if (!state.xImagesGridEl || !createImageButton || !createImageHost) {
        return;
      }
      if (state.xImagesGridEl.parentElement !== createImageHost) {
        return;
      }

      state.xImagesGridEl.replaceChildren();
      const imageCount = state.attachedImages.length;
      const useSingleColumn = imageCount <= 1;
      state.xImagesGridEl.classList.toggle('is-single', useSingleColumn);
      state.xImagesGridEl.classList.toggle('is-multi', !useSingleColumn);

      if (state.mode !== 'x') {
        createImageHost.classList.remove('stanley-x-image-host');
        state.xImagesGridEl.style.display = 'none';
        createImageButton.style.display = '';
        updateFeedbackModalContent();
        return;
      }

      createImageHost.classList.add('stanley-x-image-host');
      createImageButton.style.display = 'none';

      for (const image of state.attachedImages) {
        const card = document.createElement('div');
        card.className = 'stanley-x-image-card';

        const thumb = document.createElement('img');
        thumb.className = 'stanley-x-image-thumb';
        thumb.src = image.dataUrl;
        thumb.alt = image.name;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'stanley-x-image-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${image.name}`);
        remove.addEventListener('click', () => {
          removeAttachedImage(image.id);
        });

        const name = document.createElement('p');
        name.className = 'stanley-x-image-name';
        name.textContent = image.name;

        card.append(thumb, remove, name);
        state.xImagesGridEl.append(card);
      }

      if (state.attachedImages.length < MAX_ATTACHED_IMAGES) {
        const addTile = document.createElement('button');
        addTile.type = 'button';
        addTile.className = 'stanley-x-image-add-tile';
        addTile.setAttribute('aria-label', 'Add image');
        addTile.innerHTML = '<span class="stanley-x-image-add-plus">+</span><span class="stanley-x-image-add-caption">Add Image</span>';
        addTile.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openImagePicker();
        });
        state.xImagesGridEl.append(addTile);
      }

      state.xImagesGridEl.style.display = 'grid';
      updateFeedbackModalContent();
    }

    function applyAddImagesButtonMode(): void {
      const createImageButton = findPreviewCreateImageButton(state.postContainerEl);
      const createImageHost = findPreviewCreateImageHost(state.postContainerEl);

      if (state.addImagesButtonEl !== createImageButton) {
        if (state.addImagesButtonEl && state.addImagesClickHandler) {
          state.addImagesButtonEl.removeEventListener(
            'click',
            state.addImagesClickHandler,
            true,
          );
        }
        state.addImagesButtonEl = createImageButton;
        state.addImagesClickHandler = null;
      }
      state.addImagesHostEl = createImageHost;

      if (!createImageButton || !createImageHost) {
        return;
      }

      if (
        !state.xImagesGridEl ||
        !state.xImagesGridEl.isConnected ||
        state.xImagesGridEl.parentElement !== createImageHost
      ) {
        if (state.xImagesGridEl && state.xImagesGridEl.parentElement) {
          state.xImagesGridEl.remove();
        }
        const grid = document.createElement('div');
        grid.className = 'stanley-x-images-grid';
        grid.style.display = 'none';
        createImageHost.insertBefore(grid, createImageButton);
        state.xImagesGridEl = grid;
      }

      const labelEl = createImageButton.querySelector('span');
      if (labelEl && !labelEl.dataset.stanleyXOriginalLabel) {
        labelEl.dataset.stanleyXOriginalLabel = labelEl.textContent?.trim() || 'Add Image';
      }

      if (state.mode === 'x') {
        if (labelEl) {
          labelEl.textContent = 'Add Images';
        }
        createImageButton.setAttribute('aria-hidden', 'true');
        createImageButton.tabIndex = -1;

        if (!state.addImagesClickHandler) {
          const handler = (event: Event): void => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            openImagePicker();
          };
          createImageButton.addEventListener('click', handler, true);
          state.addImagesClickHandler = handler;
        }
        renderAttachedImages();
      } else {
        if (labelEl) {
          labelEl.textContent = labelEl.dataset.stanleyXOriginalLabel || 'Add Image';
        }
        createImageButton.removeAttribute('aria-hidden');
        createImageButton.tabIndex = 0;
        createImageButton.style.display = '';
        createImageHost.classList.remove('stanley-x-image-host');
        if (state.xImagesGridEl) {
          state.xImagesGridEl.style.display = 'none';
        }
        if (state.addImagesClickHandler) {
          createImageButton.removeEventListener('click', state.addImagesClickHandler, true);
          state.addImagesClickHandler = null;
        }
      }
    }

    function closeFeedbackModal(): void {
      if (!state.feedbackModalEl) {
        return;
      }
      state.feedbackModalEl.classList.remove('is-open');
      state.feedbackModalIsOpen = false;
    }

    function updateFeedbackModalContent(): void {
      if (
        !state.feedbackModalAvatarEl ||
        !state.feedbackModalNameEl ||
        !state.feedbackModalHandleEl ||
        !state.feedbackModalTweetTextEl ||
        !state.feedbackModalImagesEl
      ) {
        return;
      }

      const linkedInHeaderCard =
        state.postContainerEl?.querySelector<HTMLElement>('.linkedin-card') || null;
      const avatarEl = linkedInHeaderCard?.querySelector<HTMLImageElement>(
        '.linkedin-header img',
      );
      const nameEl = linkedInHeaderCard?.querySelector<HTMLElement>('.actor-name-text');

      const name = normalize(nameEl?.innerText || avatarEl?.alt || 'Creator')
        .replace(/\s+/g, ' ')
        .trim();
      const handle = toHandleFromName(name);

      const avatarSrc = avatarEl?.getAttribute('src') || '';
      state.feedbackModalAvatarEl.src = avatarSrc;
      state.feedbackModalAvatarEl.alt = name || 'Avatar';
      state.feedbackModalAvatarEl.style.visibility = avatarSrc ? 'visible' : 'hidden';
      state.feedbackModalNameEl.textContent = name || 'Creator';
      state.feedbackModalHandleEl.textContent = handle;

      const text = getVisiblePreviewText();
      state.feedbackModalTweetTextEl.textContent =
        text || 'No X draft yet. Generate a draft first.';

      state.feedbackModalImagesEl.replaceChildren();
      const imageCount = state.attachedImages.length;
      state.feedbackModalImagesEl.classList.toggle('is-single', imageCount === 1);
      state.feedbackModalImagesEl.classList.toggle('is-multi', imageCount > 1);
      if (imageCount === 0) {
        state.feedbackModalImagesEl.style.display = 'none';
      } else {
        for (const image of state.attachedImages) {
          const imageEl = document.createElement('img');
          imageEl.className = 'stanley-x-feedback-tweet-image';
          imageEl.src = image.dataUrl;
          imageEl.alt = image.name;
          state.feedbackModalImagesEl.append(imageEl);
        }
        state.feedbackModalImagesEl.style.display = 'grid';
      }
    }

    function ensureFeedbackModal(): void {
      if (state.feedbackModalEl?.isConnected) {
        return;
      }

      if (state.feedbackModalEl) {
        state.feedbackModalEl.remove();
      }

      const modal = document.createElement('div');
      modal.id = 'stanley-x-feedback-modal';

      const backdrop = document.createElement('div');
      backdrop.className = 'stanley-x-feedback-backdrop';
      backdrop.addEventListener('click', () => {
        closeFeedbackModal();
      });

      const sheet = document.createElement('div');
      sheet.className = 'stanley-x-feedback-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', 'X post preview');

      const head = document.createElement('div');
      head.className = 'stanley-x-feedback-head';

      const title = document.createElement('p');
      title.className = 'stanley-x-feedback-title';
      title.textContent = 'X Post Preview';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'stanley-x-feedback-close';
      closeBtn.setAttribute('aria-label', 'Close preview');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => {
        closeFeedbackModal();
      });

      head.append(title, closeBtn);

      const tweet = document.createElement('div');
      tweet.className = 'stanley-x-feedback-tweet';

      const tweetHead = document.createElement('div');
      tweetHead.className = 'stanley-x-feedback-tweet-head';

      const avatar = document.createElement('img');
      avatar.className = 'stanley-x-feedback-tweet-avatar';

      const meta = document.createElement('div');
      meta.className = 'stanley-x-feedback-tweet-meta';

      const name = document.createElement('p');
      name.className = 'stanley-x-feedback-tweet-name';

      const handle = document.createElement('p');
      handle.className = 'stanley-x-feedback-tweet-handle';

      const dot = document.createElement('p');
      dot.className = 'stanley-x-feedback-tweet-time';
      dot.textContent = '·';

      const time = document.createElement('p');
      time.className = 'stanley-x-feedback-tweet-time';
      time.textContent = 'now';

      meta.append(name, handle, dot, time);
      tweetHead.append(avatar, meta);

      const text = document.createElement('div');
      text.className = 'stanley-x-feedback-tweet-text';

      const images = document.createElement('div');
      images.className = 'stanley-x-feedback-tweet-images';
      images.style.display = 'none';

      const actions = document.createElement('div');
      actions.className = 'stanley-x-feedback-tweet-actions';
      actions.innerHTML =
        '<span>Reply</span><span>Repost</span><span>Like</span><span>Bookmark</span><span>Share</span>';

      tweet.append(tweetHead, text, images, actions);
      sheet.append(head, tweet);
      modal.append(backdrop, sheet);

      document.body.append(modal);

      state.feedbackModalEl = modal;
      state.feedbackModalAvatarEl = avatar;
      state.feedbackModalNameEl = name;
      state.feedbackModalHandleEl = handle;
      state.feedbackModalTweetTextEl = text;
      state.feedbackModalImagesEl = images;
      state.feedbackModalCloseBtnEl = closeBtn;
      state.feedbackModalBackdropEl = backdrop;
    }

    function openFeedbackModal(): void {
      ensureFeedbackModal();
      updateFeedbackModalContent();
      if (!state.feedbackModalEl) {
        return;
      }
      state.feedbackModalEl.classList.add('is-open');
      state.feedbackModalIsOpen = true;
    }

    function handleGlobalKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && state.feedbackModalIsOpen) {
        closeFeedbackModal();
      }
    }

    function getVisiblePreviewText(): string {
      if (state.mode === 'x') {
        return getVisibleXText();
      }
      return normalize(state.postContentEl?.innerText ?? state.latestText);
    }

    function ensureShareButtonHandler(shareButton: HTMLButtonElement): void {
      if (state.footerShareButtonEl === shareButton && state.footerShareHandler) {
        return;
      }

      if (state.footerShareButtonEl && state.footerShareHandler) {
        state.footerShareButtonEl.removeEventListener(
          'click',
          state.footerShareHandler,
          true,
        );
      }

      const handler = (event: MouseEvent): void => {
        if (state.mode !== 'x') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const text = getVisiblePreviewText();
        const composeUrl = buildXComposeUrl(text);
        window.open(composeUrl, '_blank', 'noopener,noreferrer');
      };

      shareButton.addEventListener('click', handler, true);
      state.footerShareButtonEl = shareButton;
      state.footerShareHandler = handler;
    }

    async function copyTextToClipboard(text: string): Promise<boolean> {
      const value = normalize(text);
      if (!value.trim()) {
        return false;
      }

      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fallback below for contexts where navigator.clipboard is unavailable.
      }

      try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
      } catch {
        return false;
      }
    }

    function ensureCopyButtonHandler(): void {
      const copyButton = findPreviewCopyButton(state.postContainerEl);

      if (state.footerCopyButtonEl === copyButton) {
        return;
      }

      if (state.footerCopyButtonEl && state.footerCopyHandler) {
        state.footerCopyButtonEl.removeEventListener(
          'click',
          state.footerCopyHandler,
          true,
        );
      }

      state.footerCopyButtonEl = copyButton;
      state.footerCopyHandler = null;

      if (!copyButton) {
        return;
      }

      if (!copyButton.dataset.stanleyXBaseTitle) {
        copyButton.dataset.stanleyXBaseTitle =
          copyButton.getAttribute('title') || 'Copy to clipboard';
      }
      copyButton.dataset.stanleyXCopy = 'true';

      const handler = (event: MouseEvent): void => {
        if (state.mode !== 'x') {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const text = getVisiblePreviewText();
        void copyTextToClipboard(text).then((copied) => {
          const currentButton = state.footerCopyButtonEl;
          if (!currentButton || currentButton !== copyButton) {
            return;
          }

          currentButton.setAttribute('title', copied ? 'Copied' : 'Unable to copy');
          window.setTimeout(() => {
            if (state.footerCopyButtonEl !== currentButton) {
              return;
            }
            currentButton.setAttribute(
              'title',
              state.mode === 'x'
                ? 'Copy X post'
                : currentButton.dataset.stanleyXBaseTitle || 'Copy to clipboard',
            );
          }, 1200);
        });
      };

      copyButton.addEventListener('click', handler, true);
      state.footerCopyHandler = handler;
    }

    function updateFooterControls(): void {
      ensureCopyButtonHandler();

      const wordCountEl = findPreviewWordCountEl(state.postContainerEl);
      if (wordCountEl) {
        if (state.mode === 'x') {
          const visibleText = getVisiblePreviewText();
          const limit = getCurrentXCharacterLimit();
          wordCountEl.textContent = `${visibleText.length}/${limit} chars · U ${X_STANDARD_CHAR_LIMIT} / V ${X_VERIFIED_CHAR_LIMIT.toLocaleString()}`;
          wordCountEl.setAttribute(
            'title',
            state.isXVerified
              ? `Verified mode: up to ${X_VERIFIED_CHAR_LIMIT.toLocaleString()} chars`
              : `Unverified mode: up to ${X_STANDARD_CHAR_LIMIT} chars`,
          );
        } else {
          const words = countWords(getVisiblePreviewText());
          wordCountEl.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
          wordCountEl.setAttribute('title', 'Word count');
        }
      }

      const copyButton = findPreviewCopyButton(state.postContainerEl);
      if (copyButton) {
        copyButton.setAttribute(
          'title',
          state.mode === 'x'
            ? 'Copy X post'
            : copyButton.dataset.stanleyXBaseTitle || 'Copy to clipboard',
        );
      }

      const shareButton = findPreviewShareButton(state.postContainerEl);
      if (shareButton) {
        ensureShareButtonHandler(shareButton);
        if (!shareButton.dataset.stanleyXBaseLabel) {
          const existingLabel =
            Array.from(shareButton.childNodes)
              .find((child) => child.nodeType === Node.TEXT_NODE)
              ?.textContent?.trim() || 'Share';
          shareButton.dataset.stanleyXBaseLabel = existingLabel;
        }

        if (state.mode === 'x') {
          setButtonLeadText(shareButton, 'Post');
          shareButton.setAttribute('title', 'Post to X');
        } else {
          setButtonLeadText(
            shareButton,
            shareButton.dataset.stanleyXBaseLabel || 'Share',
          );
          shareButton.removeAttribute('title');
        }
      } else if (state.footerShareButtonEl && state.footerShareHandler) {
        state.footerShareButtonEl.removeEventListener(
          'click',
          state.footerShareHandler,
          true,
        );
        state.footerShareButtonEl = null;
        state.footerShareHandler = null;
      }
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

    async function getBackendUrl(): Promise<string> {
      const stored = await browser.storage.local.get('stanley_x_backend_url');
      const value = stored.stanley_x_backend_url;
      if (typeof value === 'string' && value.trim()) {
        return value.trim().replace(/\/$/, '');
      }
      return DEFAULT_BACKEND_URL;
    }

    async function requestXDraftDirect(
      payload: GenerateXDraftPayload,
    ): Promise<GenerateXDraftResponse> {
      const backendUrl = await getBackendUrl();
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, BACKEND_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(`${backendUrl}/v1/x-draft`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        let parsed: GenerateXDraftResponse | null = null;
        try {
          parsed = (await response.json()) as GenerateXDraftResponse;
        } catch {
          parsed = null;
        }

        if (!response.ok) {
          const fallback = `Backend request failed (${response.status})`;
          throw new Error(parsed?.error || fallback);
        }

        if (!parsed || parsed.ok !== true || typeof parsed.xText !== 'string') {
          throw new Error('Direct backend response missing xText');
        }

        return parsed;
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    async function requestXDraftFromBackground(
      payload: GenerateXDraftPayload,
    ): Promise<GenerateXDraftResponse> {
      let backgroundError: string | null = null;

      try {
        const response = (await browser.runtime.sendMessage({
          type: GENERATE_X_DRAFT_MESSAGE,
          payload,
        })) as GenerateXDraftResponse | undefined;

        if (response && response.ok === true && typeof response.xText === 'string') {
          return response;
        }

        if (response?.error) {
          backgroundError = response.error;
        } else {
          backgroundError = 'Background response was empty or invalid';
        }
      } catch (error: unknown) {
        backgroundError = formatErrorMessage(error);
      }

      console.warn(
        '[Stanley-X] Falling back to direct backend request:',
        backgroundError,
      );

      try {
        return await requestXDraftDirect(payload);
      } catch (directError: unknown) {
        const directMessage = formatErrorMessage(directError);
        if (backgroundError) {
          throw new Error(`${backgroundError}; fallback failed: ${directMessage}`);
        }
        throw new Error(directMessage);
      }
    }

    async function maybeGenerateXDraft(trigger: GenerateTrigger): Promise<void> {
      if (state.mode !== 'x' && trigger !== 'force') {
        return;
      }

      const sourceText = getCurrentSourceText();
      const rewriteInstructions = stripAutoLimitInstructions(
        state.rewriteInstructions,
      );
      if (!sourceText.trim()) {
        setXDraftState('idle', {
          text: '',
          error: null,
        });
        return;
      }

      if (
        trigger !== 'force' &&
        state.lastGeneratedSourceText &&
        !isSignificantChange(state.lastGeneratedSourceText, sourceText)
      ) {
        if (!state.xDraftText) {
          setXDraftState('idle', {
            text: '',
            error: null,
          });
        } else {
          renderXContent();
        }
        return;
      }

      const sourceHashSeed = rewriteInstructions
        ? `${sourceText}\n\n[rewrite_instructions]\n${rewriteInstructions}`
        : sourceText;
      const tierHashPart = `[x_tier]\n${
        state.isXVerified ? 'verified' : 'unverified'
      }\n[x_character_limit]\n${getCurrentXCharacterLimit()}`;
      const sourceHashSeedWithTier = `${sourceHashSeed}\n\n${tierHashPart}`;
      const sourceHash = await sha256Hex(sourceHashSeedWithTier);
      if (!sourceHash) {
        return;
      }

      if (
        trigger !== 'force' &&
        state.lastGeneratedSourceHash === sourceHash &&
        state.xDraftStatus === 'ready'
      ) {
        renderXContent();
        return;
      }

      if (state.generationInFlightHash === sourceHash) {
        return;
      }

      const cacheKey = getXDraftCacheKey(sourceHash);
      try {
        const cached = await browser.storage.local.get(cacheKey);
        const cacheEntry = cached[cacheKey] as XDraftCacheEntry | undefined;
        if (trigger !== 'force' && cacheEntry?.xText) {
          const normalizedXText = normalize(cacheEntry.xText);
          state.lastGeneratedSourceText = sourceText;
          state.lastGeneratedSourceHash = sourceHash;
          state.lastGeneratedAt = cacheEntry.generatedAt || Date.now();
          setXDraftState('ready', {
            text: normalizedXText,
            error: null,
          });
          upsertRevision({
            sourceHash,
            sourceText,
            rewriteInstructions,
            xText: normalizedXText,
            generatedAt: state.lastGeneratedAt ?? Date.now(),
          });
          return;
        }
      } catch (error: unknown) {
        console.debug('[Stanley-X] local x-draft cache read skipped:', error);
      }

      state.generationRequestId += 1;
      const requestId = state.generationRequestId;
      state.activeGenerationRequestId = requestId;
      state.generationInFlightHash = sourceHash;
      setXDraftState('loading', {
        error: null,
      });

      try {
        const payload: GenerateXDraftPayload = {
          threadId: getThreadIdFromUrl(window.location.href),
          sourceText,
          sourceHash,
          previousSourceText: state.lastGeneratedSourceText,
          rewriteInstructions: rewriteInstructions || null,
          isXVerified: state.isXVerified,
          xCharacterLimit: getCurrentXCharacterLimit(),
          force: trigger === 'force',
        };
        const result = await requestXDraftFromBackground(payload);

        if (state.activeGenerationRequestId !== requestId) {
          return;
        }

        const xText = normalize(result.xText || '');
        const generatedAt = Date.now();

        state.lastGeneratedSourceText = sourceText;
        state.lastGeneratedSourceHash = sourceHash;
        state.lastGeneratedAt = generatedAt;
        setXDraftState('ready', {
          text: xText,
          error: null,
        });
        upsertRevision({
          sourceHash,
          sourceText,
          rewriteInstructions,
          xText,
          generatedAt,
        });

        console.log('[Stanley-X] X draft updated:', {
          chars: xText.length,
          cached: !!result.cached,
          skipped: !!result.skipped,
          reason: result.reason || null,
        });

        void browser.storage.local
          .set({
            [cacheKey]: {
              sourceHash,
              sourceText,
              xText,
              generatedAt,
            } satisfies XDraftCacheEntry,
            stanley_x_lastGeneratedSourceHash: sourceHash,
            stanley_x_lastGeneratedSourceText: sourceText,
            stanley_x_lastGeneratedAt: generatedAt,
            stanley_x_lastXDraft: xText,
          })
          .catch((error: unknown) => {
            console.debug('[Stanley-X] local x-draft cache write skipped:', error);
          });
      } catch (error: unknown) {
        if (state.activeGenerationRequestId !== requestId) {
          return;
        }

        setXDraftState('error', {
          error: formatErrorMessage(error),
        });
        console.warn('[Stanley-X] X draft generation failed:', error);
      } finally {
        if (state.activeGenerationRequestId === requestId) {
          state.activeGenerationRequestId = null;
          state.generationInFlightHash = null;
        }
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
          border: 1px solid rgba(255, 255, 255, 0.22);
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
        .post-container.stanley-x-post-theme-x {
          background: #000000 !important;
          border-color: #2f3336 !important;
        }
        .post-container.stanley-x-post-theme-x > .flex-grow {
          background: #000000 !important;
        }
        .post-container.stanley-x-post-theme-x > .flex-grow > .sticky {
          background: #000000 !important;
        }
        .post-container.stanley-x-post-theme-x > .flex-grow > .p-4 {
          background: #000000 !important;
          padding-top: 8px !important;
        }
        .post-container.stanley-x-post-theme-x [class*="bg-white"],
        .post-container.stanley-x-post-theme-x [class*="dark:bg"] {
          background-color: #000000 !important;
        }
        .post-container.stanley-x-post-theme-x .footer-fixed {
          background: #000000 !important;
        }
        .post-container.stanley-x-post-theme-x .linkedin-post-btn {
          background: #ffffff !important;
          color: #000000 !important;
          border: 1px solid #d1d5db !important;
          border-radius: 999px !important;
          padding: 8px 14px !important;
          font-weight: 700 !important;
        }
        .post-container.stanley-x-post-theme-x .linkedin-post-btn .material-symbols-rounded {
          color: #000000 !important;
        }
        .post-container.stanley-x-post-theme-x .create-image-btn {
          color: #ffffff !important;
          border-color: #2f3336 !important;
        }
        .post-container.stanley-x-post-theme-x .create-image-btn span {
          color: #ffffff !important;
        }
        .post-container.stanley-x-post-theme-x .create-image-btn svg path {
          fill: #ffffff !important;
        }
        .stanley-x-twitter-header {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          padding: 8px 16px 6px;
          border-bottom: 1px solid #2f3336;
          background: #000000;
        }
        .stanley-x-twitter-header-avatar {
          width: 36px;
          height: 36px;
          border-radius: 999px;
          object-fit: cover;
          flex-shrink: 0;
          align-self: center;
          background: #1f2937;
        }
        .stanley-x-twitter-header-meta {
          min-width: 0;
          flex: 1;
          display: flex;
          align-items: center;
          align-self: center;
          justify-content: flex-start;
          min-height: 36px;
        }
        .stanley-x-twitter-header-row {
          display: flex;
          align-items: center;
          gap: 3px;
          min-width: 0;
          flex-wrap: nowrap;
          width: auto;
          height: 36px;
          line-height: 1.05;
        }
        .stanley-x-twitter-header-row > * {
          display: inline-flex;
          align-items: center;
        }
        .stanley-x-twitter-header-name {
          margin: 0;
          font-size: 15px;
          font-weight: 700;
          line-height: 1.05;
          color: #e7e9ea;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .stanley-x-twitter-header-verified {
          width: 15px;
          height: 15px;
          object-fit: contain;
          flex-shrink: 0;
          margin-right: 1px;
        }
        .stanley-x-twitter-header-handle,
        .stanley-x-twitter-header-time {
          margin: 0;
          font-size: 13px;
          line-height: 1.05;
          color: #71767b;
        }
        .stanley-x-twitter-header-badge {
          margin-left: 4px;
          border-radius: 999px;
          border: 1px solid #2f3336;
          background: #ffffff;
          color: #000000;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.03em;
          line-height: 1;
          padding: 3px 7px;
          text-transform: uppercase;
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .stanley-x-twitter-header-badge-icon {
          width: 10px;
          height: 10px;
          display: block;
          object-fit: contain;
        }
        .stanley-x-twitter-content {
          position: relative;
          white-space: pre-wrap;
          outline: none;
          border: none;
          min-height: 200px;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          border-radius: 8px;
          border: 1px solid #2f3336;
          background: #000000;
          color: #e7e9ea;
          padding: 12px;
          margin-bottom: 12px;
          box-sizing: border-box;
          overflow: visible;
        }
        .stanley-x-twitter-content-text {
          margin: 0;
          white-space: pre-wrap;
          font-size: 15px;
          line-height: 1.45;
          letter-spacing: 0.01em;
          color: #e7e9ea;
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .stanley-x-image-host {
          width: 100% !important;
          max-width: 100% !important;
        }
        .stanley-x-images-grid {
          margin-top: 8px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          width: 100%;
        }
        .stanley-x-images-grid.is-single {
          grid-template-columns: minmax(0, 1fr);
        }
        .stanley-x-images-grid.is-single .stanley-x-image-card,
        .stanley-x-images-grid.is-single .stanley-x-image-add-tile {
          grid-column: 1 / -1;
        }
        .stanley-x-images-grid.is-single .stanley-x-image-thumb {
          aspect-ratio: 16 / 9;
        }
        .stanley-x-images-grid.is-multi .stanley-x-image-thumb {
          aspect-ratio: 1 / 1;
        }
        .stanley-x-image-card {
          position: relative;
          border: 1px solid #2f3336;
          border-radius: 10px;
          overflow: hidden;
          background: #0f1419;
          min-height: 92px;
        }
        .stanley-x-image-thumb {
          display: block;
          width: 100%;
          aspect-ratio: 16 / 10;
          object-fit: cover;
          background: #111827;
        }
        .stanley-x-image-remove {
          position: absolute;
          top: 6px;
          right: 6px;
          width: 32px;
          height: 32px;
          border: 0;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.82);
          border: 1px solid rgba(255, 255, 255, 0.22);
          color: #ffffff;
          font-size: 18px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }
        .stanley-x-image-name {
          margin: 0;
          padding: 6px 8px;
          color: #9ca3af;
          font-size: 11px;
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .stanley-x-image-add-tile {
          border: 1px dashed #2f3336;
          border-radius: 10px;
          background: #0f1419;
          color: #e7e9ea;
          min-height: 112px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          cursor: pointer;
          padding: 8px;
        }
        .stanley-x-image-add-tile > * {
          pointer-events: none;
        }
        .stanley-x-image-add-plus {
          font-size: 24px;
          line-height: 1;
          color: #1d9bf0;
        }
        .stanley-x-image-add-caption {
          font-size: 12px;
          line-height: 1;
          color: #9ca3af;
        }
        .stanley-x-twitter-toolbar {
          position: relative;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          margin-bottom: 8px;
        }
        .stanley-x-twitter-controls {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 8px;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          flex-wrap: wrap;
          row-gap: 6px;
        }
        .stanley-x-revision-controls {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .stanley-x-revision-btn {
          width: auto;
          height: auto;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: #71767b;
          font-size: 17px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 0 2px;
          font-weight: 700;
        }
        .stanley-x-revision-btn:hover {
          color: #e7e9ea;
        }
        .stanley-x-revert-btn {
          height: 28px;
          border: 1px solid #2f3336;
          border-radius: 999px;
          background: #000000;
          color: #e7e9ea;
          font-size: 12px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 0 10px;
          letter-spacing: 0.01em;
          font-weight: 600;
        }
        .stanley-x-revision-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .stanley-x-revert-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .stanley-x-rewrite-btn {
          border: 0;
          background: #1d9bf0;
          color: #ffffff;
          border-radius: 999px;
          padding: 7px 15px;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.01em;
          cursor: pointer;
          transition: filter 0.15s ease;
        }
        .stanley-x-rewrite-btn:hover {
          filter: brightness(1.08);
        }
        .stanley-x-verified-toggle {
          margin-left: auto;
          height: 30px;
          border: 1px solid #2f3336;
          border-radius: 999px;
          background: #0f1419;
          color: #e7e9ea;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 0 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: border-color 0.15s ease, background-color 0.15s ease;
        }
        .stanley-x-verified-toggle:hover {
          border-color: #1d9bf0;
          background: #15202b;
        }
        .stanley-x-verified-toggle.is-active {
          border-color: #1d9bf0;
          background: #15202b;
          color: #ffffff;
        }
        .stanley-x-verified-toggle-icon {
          width: 14px;
          height: 14px;
          display: block;
          object-fit: contain;
        }
        .stanley-x-rewrite-panel {
          position: absolute;
          top: 34px;
          right: 0;
          width: min(380px, calc(100% - 16px));
          border-radius: 14px;
          border: 1px solid #2f3336;
          background: #16181c;
          box-shadow: 0 22px 34px rgba(0, 0, 0, 0.45);
          padding: 12px;
          z-index: 6;
          opacity: 0;
          transform: translateY(-6px);
          pointer-events: none;
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        .stanley-x-rewrite-panel.is-open {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto;
        }
        .stanley-x-rewrite-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .stanley-x-rewrite-title {
          margin: 0;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
          color: #e7e9ea;
          text-transform: uppercase;
        }
        .stanley-x-rewrite-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin-bottom: 10px;
        }
        .stanley-x-rewrite-chip {
          border: 1px solid #2f3336;
          border-radius: 999px;
          background: #0f1419;
          color: #e7e9ea;
          font-size: 11px;
          font-weight: 600;
          line-height: 1;
          padding: 7px 11px;
          cursor: pointer;
          white-space: nowrap;
          transition: border-color 0.15s ease, background-color 0.15s ease;
        }
        .stanley-x-rewrite-chip:hover {
          border-color: #1d9bf0;
          background: #15202b;
        }
        .stanley-x-rewrite-chip:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .stanley-x-rewrite-textarea {
          width: 100%;
          max-width: 100%;
          min-height: 32px;
          height: 32px;
          resize: none;
          border: 1px solid #2f3336;
          border-radius: 10px;
          padding: 7px 10px;
          font-size: 12px;
          line-height: 1.4;
          color: #e7e9ea;
          background: #0f1419;
          box-sizing: border-box;
          transition: min-height 0.15s ease, height 0.15s ease;
        }
        .stanley-x-rewrite-textarea.is-expanded {
          min-height: 92px;
          height: 92px;
          resize: vertical;
        }
        .stanley-x-rewrite-textarea:focus {
          outline: 2px solid rgba(29, 155, 240, 0.35);
          border-color: #1d9bf0;
        }
        .stanley-x-rewrite-apply {
          border: 0;
          border-radius: 999px;
          background: #1d9bf0;
          color: #ffffff;
          padding: 7px 13px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.025em;
          text-transform: uppercase;
          cursor: pointer;
          white-space: nowrap;
          transition: opacity 0.15s ease, filter 0.15s ease;
        }
        .stanley-x-rewrite-apply:hover {
          filter: brightness(1.05);
        }
        .stanley-x-rewrite-apply:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        #stanley-x-feedback-modal {
          position: fixed;
          inset: 0;
          z-index: 2147483645;
          display: none;
        }
        #stanley-x-feedback-modal.is-open {
          display: block;
        }
        .stanley-x-feedback-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.62);
          backdrop-filter: blur(2px);
        }
        .stanley-x-feedback-sheet {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(620px, calc(100vw - 24px));
          max-height: min(90vh, 900px);
          overflow: auto;
          border-radius: 16px;
          border: 1px solid #2f3336;
          background: #000000;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
          color: #e7e9ea;
          padding: 14px;
          box-sizing: border-box;
        }
        .stanley-x-feedback-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }
        .stanley-x-feedback-title {
          margin: 0;
          font-size: 14px;
          font-weight: 700;
          color: #e7e9ea;
        }
        .stanley-x-feedback-close {
          width: 30px;
          height: 30px;
          border: 1px solid #2f3336;
          border-radius: 999px;
          background: #111111;
          color: #e7e9ea;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .stanley-x-feedback-tweet {
          border: 1px solid #2f3336;
          border-radius: 14px;
          overflow: hidden;
          background: #000000;
        }
        .stanley-x-feedback-tweet-head {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          padding: 12px 12px 8px;
        }
        .stanley-x-feedback-tweet-avatar {
          width: 40px;
          height: 40px;
          border-radius: 999px;
          object-fit: cover;
          background: #1f2937;
          flex-shrink: 0;
        }
        .stanley-x-feedback-tweet-meta {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 4px;
          flex-wrap: wrap;
        }
        .stanley-x-feedback-tweet-name {
          margin: 0;
          font-size: 15px;
          font-weight: 700;
          color: #e7e9ea;
        }
        .stanley-x-feedback-tweet-handle,
        .stanley-x-feedback-tweet-time {
          margin: 0;
          font-size: 13px;
          color: #71767b;
        }
        .stanley-x-feedback-tweet-text {
          margin: 0;
          padding: 0 12px 12px;
          white-space: pre-wrap;
          font-size: 15px;
          line-height: 1.45;
          color: #e7e9ea;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .stanley-x-feedback-tweet-images {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          padding: 0 12px 12px;
        }
        .stanley-x-feedback-tweet-images.is-single {
          grid-template-columns: minmax(0, 1fr);
        }
        .stanley-x-feedback-tweet-images.is-single .stanley-x-feedback-tweet-image {
          aspect-ratio: 16 / 9;
        }
        .stanley-x-feedback-tweet-images.is-multi .stanley-x-feedback-tweet-image {
          aspect-ratio: 1 / 1;
        }
        .stanley-x-feedback-tweet-image {
          width: 100%;
          aspect-ratio: 1 / 1;
          object-fit: cover;
          border-radius: 10px;
          border: 1px solid #2f3336;
          background: #111827;
        }
        .stanley-x-feedback-tweet-actions {
          border-top: 1px solid #2f3336;
          padding: 8px 12px;
          display: flex;
          align-items: center;
          gap: 18px;
          color: #71767b;
          font-size: 13px;
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
        .post-container.stanley-x-post-theme-x .feedback-btn.stanley-x-feedback-preview {
          border-color: #2f3336 !important;
          background: #111111 !important;
          color: #e7e9ea !important;
        }
        .post-container.stanley-x-post-theme-x .feedback-btn.stanley-x-feedback-preview:hover {
          border-color: #1d9bf0 !important;
          background: #15202b !important;
        }
        .post-container.stanley-x-post-theme-x .feedback-btn.stanley-x-feedback-preview svg {
          color: #e7e9ea !important;
        }
        @media (prefers-color-scheme: dark) {
          .stanley-x-twitter-content,
          .stanley-x-twitter-header,
          .stanley-x-rewrite-panel {
            background: #000000;
          }
          .stanley-x-rewrite-panel {
            background: #16181c;
          }
        }
      `;

      document.head.appendChild(style);
      state.cssInjected = true;
    }

    function removeTwitterReplacement(): void {
      if (state.xHeaderEl) {
        state.xHeaderEl.remove();
      }
      state.xHeaderEl = null;
      if (state.xToolbarEl) {
        state.xToolbarEl.remove();
      }
      state.xToolbarEl = null;
      if (state.xContentEl) {
        state.xContentEl.remove();
      }
      state.xContentEl = null;
      state.xContentTextEl = null;
      state.rewriteToggleButtonEl = null;
      state.xVerifiedToggleButtonEl = null;
      state.rewritePanelEl = null;
      state.rewriteTextareaEl = null;
      state.rewriteApplyButtonEl = null;
      state.rewriteChipButtons = [];
      state.revisionControlsEl = null;
      state.revisionPrevButtonEl = null;
      state.revisionNextButtonEl = null;
      state.revisionRevertButtonEl = null;
      state.rewritePanelOpen = false;
      state.rewriteTextareaExpanded = false;
    }

    function updateRewritePanelUi(): void {
      if (
        !state.rewriteToggleButtonEl ||
        !state.rewritePanelEl ||
        !state.rewriteTextareaEl ||
        !state.rewriteApplyButtonEl
      ) {
        return;
      }

      const shouldShowPanel = state.mode === 'x' && state.rewritePanelOpen;
      const isBusy = state.xDraftStatus === 'loading';

      state.rewriteToggleButtonEl.textContent = shouldShowPanel
        ? 'Close rewrite'
        : 'Rewrite';
      state.rewriteToggleButtonEl.setAttribute(
        'aria-expanded',
        shouldShowPanel ? 'true' : 'false',
      );
      state.rewritePanelEl.classList.toggle('is-open', shouldShowPanel);
      state.rewriteApplyButtonEl.disabled = isBusy;
      for (const chipButton of state.rewriteChipButtons) {
        chipButton.disabled = isBusy;
      }

      state.rewriteTextareaEl.classList.toggle(
        'is-expanded',
        state.rewriteTextareaExpanded,
      );
    }

    function updateVerifiedToggleUi(): void {
      if (!state.xVerifiedToggleButtonEl) {
        return;
      }
      state.xVerifiedToggleButtonEl.classList.toggle('is-active', state.isXVerified);
      state.xVerifiedToggleButtonEl.setAttribute(
        'aria-pressed',
        state.isXVerified ? 'true' : 'false',
      );
      state.xVerifiedToggleButtonEl.setAttribute(
        'title',
        state.isXVerified
          ? `Verified enabled (${X_VERIFIED_CHAR_LIMIT.toLocaleString()} chars)`
          : `Standard limit (${X_STANDARD_CHAR_LIMIT} chars)`,
      );
    }

    function applyPreviewTheme(isXMode: boolean): void {
      const postContainerEl = state.postContainerEl;
      if (postContainerEl) {
        postContainerEl.classList.toggle('stanley-x-post-theme-x', isXMode);
      }
    }

    function updateTwitterHeaderContent(
      linkedInHeaderCard: HTMLElement,
      xHeader: HTMLElement,
    ): void {
      const avatarEl = linkedInHeaderCard.querySelector<HTMLImageElement>(
        '.linkedin-header img',
      );
      const nameEl = linkedInHeaderCard.querySelector<HTMLElement>('.actor-name-text');

      const name = normalize(nameEl?.innerText || avatarEl?.alt || 'Creator')
        .replace(/\s+/g, ' ')
        .trim();
      const handle = toHandleFromName(name);
      const resolvedName = name || 'Creator';
      const avatarSrc = avatarEl?.getAttribute('src') || '';
      const nextSignature = `${avatarSrc}|${resolvedName}|${handle}|${
        state.isXVerified ? '1' : '0'
      }`;
      if (xHeader.dataset.stanleyHeaderSignature === nextSignature) {
        return;
      }
      xHeader.dataset.stanleyHeaderSignature = nextSignature;

      const avatarTarget =
        xHeader.querySelector<HTMLImageElement>('.stanley-x-twitter-header-avatar');
      const nameTarget =
        xHeader.querySelector<HTMLElement>('.stanley-x-twitter-header-name');
      const handleTarget =
        xHeader.querySelector<HTMLElement>('.stanley-x-twitter-header-handle');
      const verifiedTarget = xHeader.querySelector<HTMLImageElement>(
        '.stanley-x-twitter-header-verified',
      );
      const badgeIconTarget = xHeader.querySelector<HTMLImageElement>(
        '.stanley-x-twitter-header-badge-icon',
      );

      if (avatarTarget) {
        if (avatarTarget.getAttribute('src') !== avatarSrc) {
          avatarTarget.src = avatarSrc;
        }
        if (avatarTarget.alt !== resolvedName) {
          avatarTarget.alt = resolvedName;
        }
        const nextVisibility = avatarSrc ? 'visible' : 'hidden';
        if (avatarTarget.style.visibility !== nextVisibility) {
          avatarTarget.style.visibility = nextVisibility;
        }
      }
      if (nameTarget && nameTarget.textContent !== resolvedName) {
        nameTarget.textContent = resolvedName;
      }
      if (handleTarget && handleTarget.textContent !== handle) {
        handleTarget.textContent = handle;
      }
      if (verifiedTarget) {
        if (verifiedTarget.getAttribute('src') !== xVerifiedIconUrl) {
          verifiedTarget.src = xVerifiedIconUrl;
        }
        const nextDisplay = state.isXVerified ? 'inline-flex' : 'none';
        if (verifiedTarget.style.display !== nextDisplay) {
          verifiedTarget.style.display = nextDisplay;
        }
      }
      if (badgeIconTarget) {
        if (badgeIconTarget.getAttribute('src') !== xIconUrl) {
          badgeIconTarget.src = xIconUrl;
        }
      }
    }

    function ensureTwitterHeaderReplacement(
      linkedInHeaderCard: HTMLElement,
    ): void {
      const headerHost = linkedInHeaderCard.parentElement;
      if (!headerHost) {
        return;
      }

      if (!state.xHeaderEl || state.xHeaderEl.parentElement !== headerHost) {
        if (state.xHeaderEl) {
          state.xHeaderEl.remove();
        }

        const xHeader = document.createElement('div');
        xHeader.className = 'stanley-x-twitter-header';

        const avatar = document.createElement('img');
        avatar.className = 'stanley-x-twitter-header-avatar';

        const meta = document.createElement('div');
        meta.className = 'stanley-x-twitter-header-meta';

        const row = document.createElement('div');
        row.className = 'stanley-x-twitter-header-row';

        const name = document.createElement('p');
        name.className = 'stanley-x-twitter-header-name';

        const verified = document.createElement('img');
        verified.className = 'stanley-x-twitter-header-verified';
        verified.alt = 'Verified';
        verified.src = xVerifiedIconUrl;
        verified.style.display = 'none';

        const handle = document.createElement('p');
        handle.className = 'stanley-x-twitter-header-handle';

        const dot = document.createElement('p');
        dot.className = 'stanley-x-twitter-header-time';
        dot.textContent = '·';

        const time = document.createElement('p');
        time.className = 'stanley-x-twitter-header-time';
        time.textContent = 'now';

        const badge = document.createElement('span');
        badge.className = 'stanley-x-twitter-header-badge';
        const badgeIcon = document.createElement('img');
        badgeIcon.className = 'stanley-x-twitter-header-badge-icon';
        badgeIcon.alt = 'X';
        badgeIcon.src = xIconUrl;
        badgeIcon.addEventListener(
          'error',
          () => {
            if (badgeIcon.src !== xIconFallbackUrl) {
              badgeIcon.src = xIconFallbackUrl;
            }
          },
          { once: true },
        );
        badge.append(badgeIcon);

        row.append(name, verified, handle, dot, time, badge);

        meta.append(row);
        xHeader.append(avatar, meta);

        linkedInHeaderCard.insertAdjacentElement('afterend', xHeader);
        state.xHeaderEl = xHeader;
      }

      updateTwitterHeaderContent(linkedInHeaderCard, state.xHeaderEl);
      state.xHeaderEl.style.display = 'flex';
      linkedInHeaderCard.classList.add('stanley-x-li-hidden');
    }

    function applyModeToPreview(): void {
      const postContentEl = state.postContentEl;
      if (!postContentEl) {
        removeTwitterReplacement();
        return;
      }
      const linkedInHeaderCard =
        state.postContainerEl?.querySelector<HTMLElement>('.linkedin-card') || null;

      const host = postContentEl.parentElement;
      if (!host) {
        return;
      }

      if (state.mode === 'linkedin') {
        applyPreviewTheme(false);
        postContentEl.classList.remove('stanley-x-li-hidden');
        linkedInHeaderCard?.classList.remove('stanley-x-li-hidden');
        if (state.xHeaderEl) {
          state.xHeaderEl.style.display = 'none';
        }
        if (state.xToolbarEl) {
          state.xToolbarEl.style.display = 'none';
        }
        if (state.xContentEl) {
          state.xContentEl.style.display = 'none';
        }
        renderAttachedImages();
        return;
      }

      if (
        !state.xContentEl ||
        state.xContentEl.parentElement !== host ||
        !state.xToolbarEl ||
        state.xToolbarEl.parentElement !== host
      ) {
        removeTwitterReplacement();

        const xToolbar = document.createElement('div');
        xToolbar.className = 'stanley-x-twitter-toolbar';

        const xContent = document.createElement('div');
        xContent.className = 'stanley-x-twitter-content';

        const controls = document.createElement('div');
        controls.className = 'stanley-x-twitter-controls';

        const revisionControls = document.createElement('div');
        revisionControls.className = 'stanley-x-revision-controls';

        const revisionPrev = document.createElement('button');
        revisionPrev.type = 'button';
        revisionPrev.className = 'stanley-x-revision-btn';
        revisionPrev.textContent = '→';
        revisionPrev.setAttribute('aria-label', 'Show newer revision');
        revisionPrev.setAttribute('title', 'Newer');
        revisionPrev.addEventListener('click', () => {
          navigateRevision(-1);
        });

        const revisionNext = document.createElement('button');
        revisionNext.type = 'button';
        revisionNext.className = 'stanley-x-revision-btn';
        revisionNext.textContent = '←';
        revisionNext.setAttribute('aria-label', 'Show older revision');
        revisionNext.setAttribute('title', 'Older');
        revisionNext.addEventListener('click', () => {
          navigateRevision(1);
        });

        revisionControls.append(revisionNext, revisionPrev);

        const revisionRevert = document.createElement('button');
        revisionRevert.type = 'button';
        revisionRevert.className = 'stanley-x-revert-btn';
        revisionRevert.textContent = 'Revert to this revision';
        revisionRevert.addEventListener('click', () => {
          revertToCurrentRevision();
        });

        const rewriteButton = document.createElement('button');
        rewriteButton.type = 'button';
        rewriteButton.className = 'stanley-x-rewrite-btn';
        rewriteButton.textContent = 'Rewrite';
        rewriteButton.setAttribute('aria-expanded', 'false');
        rewriteButton.addEventListener('click', () => {
          state.rewritePanelOpen = !state.rewritePanelOpen;
          updateRewritePanelUi();
        });

        const verifiedToggle = document.createElement('button');
        verifiedToggle.type = 'button';
        verifiedToggle.className = 'stanley-x-verified-toggle';
        verifiedToggle.setAttribute('aria-pressed', 'false');

        const verifiedToggleIcon = document.createElement('img');
        verifiedToggleIcon.className = 'stanley-x-verified-toggle-icon';
        verifiedToggleIcon.alt = 'X verified';
        verifiedToggleIcon.src = xVerifiedIconUrl;

        const verifiedToggleLabel = document.createElement('span');
        verifiedToggleLabel.textContent = 'Verified';

        verifiedToggle.append(verifiedToggleIcon, verifiedToggleLabel);
        verifiedToggle.addEventListener('click', () => {
          const previousLimit = getCurrentXCharacterLimit();
          state.isXVerified = !state.isXVerified;
          const nextLimit = getCurrentXCharacterLimit();
          state.rewriteInstructions = stripAutoLimitInstructions(
            state.rewriteInstructions,
          );
          if (state.rewriteTextareaEl) {
            state.rewriteTextareaEl.value = state.rewriteInstructions;
          }
          updateVerifiedToggleUi();
          renderXContent();
          updateFooterControls();
          updateFeedbackModalContent();
          if (linkedInHeaderCard) {
            ensureTwitterHeaderReplacement(linkedInHeaderCard);
          }
          const currentTextLength = normalize(state.xDraftText).length;
          const becameStricter = nextLimit < previousLimit;
          const requiresCompaction = becameStricter || currentTextLength > nextLimit;
          const shouldForceRegenerate =
            state.mode === 'x' &&
            state.xDraftStatus === 'ready';
          if (shouldForceRegenerate) {
            void maybeGenerateXDraft('force');
          }
        });

        controls.append(revisionControls, revisionRevert, verifiedToggle, rewriteButton);

        const rewritePanel = document.createElement('div');
        rewritePanel.className = 'stanley-x-rewrite-panel';

        const rewriteHeader = document.createElement('div');
        rewriteHeader.className = 'stanley-x-rewrite-header';

        const rewriteTitle = document.createElement('p');
        rewriteTitle.className = 'stanley-x-rewrite-title';
        rewriteTitle.textContent = 'Rewrite';

        const rewriteApply = document.createElement('button');
        rewriteApply.type = 'button';
        rewriteApply.className = 'stanley-x-rewrite-apply';
        rewriteApply.textContent = 'Apply Rewrite';
        rewriteApply.addEventListener('click', () => {
          const normalizedInstructions = normalizeRewriteInstructions(
            rewriteTextarea.value,
          );
          if (state.xDraftStatus === 'loading') {
            updateRewritePanelUi();
            return;
          }

          state.rewriteInstructions = normalizedInstructions;
          rewriteTextarea.value = normalizedInstructions;
          state.rewritePanelOpen = false;
          state.rewriteTextareaExpanded = false;
          updateRewritePanelUi();
          void maybeGenerateXDraft('force');
        });

        rewriteHeader.append(rewriteTitle, rewriteApply);

        const rewriteChips = document.createElement('div');
        rewriteChips.className = 'stanley-x-rewrite-chips';

        const chipConfigs: Array<{ label: string; prompt: string }> = [
          {
            label: 'More value-driven',
            prompt: 'Make it more value-driven and tactical with clearer specifics.',
          },
          {
            label: 'Sound cracked',
            prompt:
              'Make it sound cracked: concise, sharp, lower-case energy, and no fluff.',
          },
          {
            label: 'More community',
            prompt:
              'Make it more community-driven: friendlier and relatable while still direct.',
          },
          {
            label: 'Shorter',
            prompt: 'Make it shorter and tighter while keeping the core specifics.',
          },
          {
            label: 'Explain more',
            prompt:
              'Explain more context and reasoning while staying X-native and direct.',
          },
          {
            label: 'More direct',
            prompt: 'Make it more direct, stern, and high-conviction.',
          },
        ];

        const rewriteTextarea = document.createElement('textarea');
        rewriteTextarea.className = 'stanley-x-rewrite-textarea';
        rewriteTextarea.placeholder = 'Optional extra direction...';
        rewriteTextarea.rows = 1;
        rewriteTextarea.maxLength = MAX_REWRITE_INSTRUCTIONS_CHARS;
        rewriteTextarea.value = state.rewriteInstructions;
        rewriteTextarea.addEventListener('focus', () => {
          state.rewriteTextareaExpanded = true;
          updateRewritePanelUi();
        });
        rewriteTextarea.addEventListener('click', () => {
          state.rewriteTextareaExpanded = true;
          updateRewritePanelUi();
        });
        rewriteTextarea.addEventListener('blur', () => {
          state.rewriteTextareaExpanded = false;
          updateRewritePanelUi();
        });
        rewriteTextarea.addEventListener('input', () => {
          updateRewritePanelUi();
        });

        const chipButtons: HTMLButtonElement[] = chipConfigs.map((chipConfig) => {
          const chipButton = document.createElement('button');
          chipButton.type = 'button';
          chipButton.className = 'stanley-x-rewrite-chip';
          chipButton.textContent = chipConfig.label;
          chipButton.addEventListener('click', () => {
            if (state.xDraftStatus === 'loading') {
              return;
            }
            state.rewriteInstructions = normalizeRewriteInstructions(chipConfig.prompt);
            rewriteTextarea.value = state.rewriteInstructions;
            state.rewritePanelOpen = false;
            state.rewriteTextareaExpanded = false;
            updateRewritePanelUi();
            void maybeGenerateXDraft('force');
          });
          rewriteChips.appendChild(chipButton);
          return chipButton;
        });

        rewritePanel.append(rewriteHeader, rewriteChips, rewriteTextarea);

        const xText = document.createElement('div');
        xText.className = 'stanley-x-twitter-content-text';

        xToolbar.append(controls, rewritePanel);
        xContent.append(xText);
        postContentEl.insertAdjacentElement('afterend', xContent);
        xContent.insertAdjacentElement('beforebegin', xToolbar);

        state.xToolbarEl = xToolbar;
        state.xContentEl = xContent;
        state.xContentTextEl = xText;
        state.rewriteToggleButtonEl = rewriteButton;
        state.xVerifiedToggleButtonEl = verifiedToggle;
        state.rewritePanelEl = rewritePanel;
        state.rewriteTextareaEl = rewriteTextarea;
        state.rewriteApplyButtonEl = rewriteApply;
        state.rewriteChipButtons = chipButtons;
        state.revisionControlsEl = revisionControls;
        state.revisionPrevButtonEl = revisionPrev;
        state.revisionNextButtonEl = revisionNext;
        state.revisionRevertButtonEl = revisionRevert;
      }

      if (state.xContentEl) {
        state.xContentEl.style.display = 'block';
        state.xContentEl.style.width = '100%';
        state.xContentEl.style.maxWidth = '100%';
        state.xContentEl.style.minWidth = '0';
      }
      if (state.xToolbarEl) {
        state.xToolbarEl.style.display = 'block';
      }

      applyPreviewTheme(true);

      if (linkedInHeaderCard) {
        ensureTwitterHeaderReplacement(linkedInHeaderCard);
      } else if (state.xHeaderEl) {
        state.xHeaderEl.style.display = 'none';
      }

      postContentEl.classList.add('stanley-x-li-hidden');
      updateVerifiedToggleUi();
      updateRewritePanelUi();
      updateRevisionUi();
      renderXContent();
      renderAttachedImages();
    }

    function handleGlobalPointerDown(event: PointerEvent): void {
      if (!state.rewritePanelOpen || state.mode !== 'x') {
        return;
      }
      const targetNode = event.target;
      if (!(targetNode instanceof Node)) {
        return;
      }
      if (
        state.rewritePanelEl?.contains(targetNode) ||
        state.rewriteToggleButtonEl?.contains(targetNode)
      ) {
        return;
      }
      state.rewritePanelOpen = false;
      state.rewriteTextareaExpanded = false;
      updateRewritePanelUi();
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
      const feedbackBtn = findPreviewFeedbackButton(state.postContainerEl);
      if (state.feedbackButtonEl !== feedbackBtn) {
        if (state.feedbackButtonEl && state.feedbackClickHandler) {
          state.feedbackButtonEl.removeEventListener(
            'click',
            state.feedbackClickHandler,
            true,
          );
        }
        state.feedbackButtonEl = feedbackBtn;
        state.feedbackClickHandler = null;
      }

      if (!feedbackBtn) {
        closeFeedbackModal();
        return;
      }

      if (!feedbackBtn.dataset.stanleyXTitle) {
        feedbackBtn.dataset.stanleyXTitle = feedbackBtn.getAttribute('title') || '';
      }
      if (!feedbackBtn.dataset.stanleyXBaseHtml) {
        feedbackBtn.dataset.stanleyXBaseHtml = feedbackBtn.innerHTML;
      }

      if (state.mode === 'x') {
        feedbackBtn.classList.add('stanley-x-feedback-preview');
        feedbackBtn.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="text-base font-semibold whitespace-nowrap">Preview Post</span>';
        feedbackBtn.disabled = false;
        feedbackBtn.setAttribute('aria-disabled', 'false');
        feedbackBtn.classList.remove('stanley-x-feedback-disabled');
        feedbackBtn.setAttribute('title', 'Preview X post');
        if (!state.feedbackClickHandler) {
          const handler = (event: MouseEvent): void => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            openFeedbackModal();
          };
          feedbackBtn.addEventListener('click', handler, true);
          state.feedbackClickHandler = handler;
        }
      } else {
        feedbackBtn.classList.remove('stanley-x-feedback-preview');
        if (feedbackBtn.dataset.stanleyXBaseHtml) {
          feedbackBtn.innerHTML = feedbackBtn.dataset.stanleyXBaseHtml;
        }
        if (state.feedbackClickHandler) {
          feedbackBtn.removeEventListener('click', state.feedbackClickHandler, true);
          state.feedbackClickHandler = null;
        }
        closeFeedbackModal();
        feedbackBtn.disabled = false;
        feedbackBtn.setAttribute('aria-disabled', 'false');
        feedbackBtn.classList.remove('stanley-x-feedback-disabled');
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
      if (mode !== 'x') {
        state.rewritePanelOpen = false;
      }
      updateModeToggleUi();
      applyModeToPreview();
      applyChatInputMode();
      applyFeedbackButtonMode();
      applyAddImagesButtonMode();
      updateFooterControls();

      if (mode === 'x') {
        void maybeGenerateXDraft('toggle');
      }
    }

    function ensureModeToggle(): void {
      const feedbackBtn = findPreviewFeedbackButton(state.postContainerEl);
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
      applyAddImagesButtonMode();
      updateFooterControls();
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
      const linkedInHeaderCard =
        state.postContainerEl?.querySelector<HTMLElement>('.linkedin-card');
      linkedInHeaderCard?.classList.remove('stanley-x-li-hidden');
      applyPreviewTheme(false);
      removeTwitterReplacement();

      if (state.footerCopyButtonEl && state.footerCopyHandler) {
        state.footerCopyButtonEl.removeEventListener(
          'click',
          state.footerCopyHandler,
          true,
        );
      }
      state.footerCopyButtonEl = null;
      state.footerCopyHandler = null;

      if (state.footerShareButtonEl && state.footerShareHandler) {
        state.footerShareButtonEl.removeEventListener(
          'click',
          state.footerShareHandler,
          true,
        );
      }
      state.footerShareButtonEl = null;
      state.footerShareHandler = null;

      if (state.addImagesButtonEl && state.addImagesClickHandler) {
        state.addImagesButtonEl.removeEventListener(
          'click',
          state.addImagesClickHandler,
          true,
        );
      }
      const imageButtonLabel = state.addImagesButtonEl?.querySelector('span');
      if (imageButtonLabel?.dataset.stanleyXOriginalLabel) {
        imageButtonLabel.textContent = imageButtonLabel.dataset.stanleyXOriginalLabel;
      }
      if (state.xImagesGridEl) {
        state.xImagesGridEl.remove();
      }
      if (state.addImagesHostEl) {
        state.addImagesHostEl.classList.remove('stanley-x-image-host');
      }
      if (state.addImagesButtonEl) {
        state.addImagesButtonEl.style.display = '';
        state.addImagesButtonEl.removeAttribute('aria-hidden');
        state.addImagesButtonEl.tabIndex = 0;
      }
      state.addImagesButtonEl = null;
      state.addImagesHostEl = null;
      state.addImagesClickHandler = null;
      state.xImagesGridEl = null;

      if (state.feedbackButtonEl && state.feedbackClickHandler) {
        state.feedbackButtonEl.removeEventListener(
          'click',
          state.feedbackClickHandler,
          true,
        );
      }
      state.feedbackButtonEl = null;
      state.feedbackClickHandler = null;
      closeFeedbackModal();

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
      updateFooterControls();

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

      if (state.mode === 'x') {
        void maybeGenerateXDraft('edit');
      }
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
        state.threadId = getThreadIdFromUrl(nowUrl);
        state.lastCommittedText = null;
        state.lastGeneratedSourceHash = null;
        state.lastGeneratedSourceText = null;
        state.lastGeneratedAt = null;
        state.rewriteInstructions = '';
        state.rewritePanelOpen = false;
        state.rewriteTextareaExpanded = false;
        if (state.rewriteTextareaEl) {
          state.rewriteTextareaEl.value = '';
        }
        resetRevisionState();
        setXDraftState('idle', {
          text: '',
          error: null,
        });
        state.attachedImages = [];
        renderAttachedImages();

        if (isThreadUrl(nowUrl)) {
          void loadPersistedHistoryForThread(state.threadId);
          void loadPersistedImagesForThread(state.threadId);
        }
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
        const feedbackBtn = findPreviewFeedbackButton(state.postContainerEl);
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
        if (state.feedbackButtonEl && state.feedbackClickHandler) {
          state.feedbackButtonEl.removeEventListener(
            'click',
            state.feedbackClickHandler,
            true,
          );
        }
        state.feedbackButtonEl = null;
        state.feedbackClickHandler = null;
        if (state.footerShareButtonEl && state.footerShareHandler) {
          state.footerShareButtonEl.removeEventListener(
            'click',
            state.footerShareHandler,
            true,
          );
        }
        state.footerShareButtonEl = null;
        state.footerShareHandler = null;
        closeFeedbackModal();
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
      document.addEventListener('pointerdown', handleGlobalPointerDown);
      document.addEventListener('keydown', handleGlobalKeyDown);
    }

      ensureUi();
      void loadPersistedHistoryForThread(state.threadId);
      void loadPersistedImagesForThread(state.threadId);
      startLifecycleMonitoring();
      startDiscovery();
    } catch (error: unknown) {
      console.error('[Stanley-X] content script fatal error', error);
    }
  },
});

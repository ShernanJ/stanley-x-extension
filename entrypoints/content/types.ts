export type StanleyXWindow = Window & {
  __STANLEY_X_INIT__?: boolean;
};

export type PreviewElements = {
  postContentEl: HTMLElement;
  postContainerEl: HTMLElement | null;
};

export type Mode = 'linkedin' | 'x';
export type Signal = 'attach' | 'input' | 'mutation' | 'maxWait';
export type XDraftStatus = 'idle' | 'loading' | 'ready' | 'error';
export type GenerateTrigger = 'toggle' | 'edit' | 'force';

export type XDraftCacheEntry = {
  sourceHash: string;
  sourceText: string;
  xText: string;
  generatedAt: number;
};

export type XDraftRevision = {
  sourceHash: string;
  sourceText: string;
  rewriteInstructions: string;
  xText: string;
  generatedAt: number;
};

export type PersistedXDraftHistory = {
  revisions: XDraftRevision[];
  currentRevisionIndex: number;
};

export type GenerateXDraftPayload = {
  threadId: string;
  sourceText: string;
  sourceHash: string;
  previousSourceText: string | null;
  rewriteInstructions?: string | null;
  isXVerified?: boolean;
  xCharacterLimit?: number;
  force: boolean;
};

export type GenerateXDraftResponse = {
  ok: boolean;
  xText?: string;
  sourceHash?: string;
  cached?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

export type AttachedImage = {
  id: string;
  name: string;
  dataUrl: string;
  addedAt: number;
};

export type ContentState = {
  currentUrl: string;
  threadId: string;
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
  xHeaderEl: HTMLDivElement | null;
  xToolbarEl: HTMLDivElement | null;
  xContentEl: HTMLDivElement | null;
  xContentTextEl: HTMLDivElement | null;
  xContentInputHandler: ((event: Event) => void) | null;
  rewriteToggleButtonEl: HTMLButtonElement | null;
  xVerifiedToggleButtonEl: HTMLButtonElement | null;
  rewritePanelEl: HTMLDivElement | null;
  rewriteTextareaEl: HTMLTextAreaElement | null;
  rewriteApplyButtonEl: HTMLButtonElement | null;
  rewriteChipButtons: HTMLButtonElement[];
  revisionControlsEl: HTMLDivElement | null;
  revisionPrevButtonEl: HTMLButtonElement | null;
  revisionNextButtonEl: HTMLButtonElement | null;
  revisionRevertButtonEl: HTMLButtonElement | null;
  xImagesGridEl: HTMLDivElement | null;
  addImagesHostEl: HTMLElement | null;
  addImagesButtonEl: HTMLButtonElement | null;
  addImagesClickHandler: ((event: Event) => void) | null;
  addImagesInputEl: HTMLInputElement | null;
  attachedImages: AttachedImage[];
  feedbackButtonEl: HTMLButtonElement | null;
  feedbackClickHandler: ((event: MouseEvent) => void) | null;
  feedbackModalEl: HTMLDivElement | null;
  feedbackModalAvatarEl: HTMLImageElement | null;
  feedbackModalNameEl: HTMLParagraphElement | null;
  feedbackModalHandleEl: HTMLParagraphElement | null;
  feedbackModalTweetTextEl: HTMLDivElement | null;
  feedbackModalImagesEl: HTMLDivElement | null;
  feedbackModalCloseBtnEl: HTMLButtonElement | null;
  feedbackModalBackdropEl: HTMLDivElement | null;
  feedbackModalIsOpen: boolean;
  footerShareButtonEl: HTMLButtonElement | null;
  footerShareHandler: ((event: MouseEvent) => void) | null;
  footerCopyButtonEl: HTMLButtonElement | null;
  footerCopyHandler: ((event: MouseEvent) => void) | null;
  rewritePanelOpen: boolean;
  rewriteTextareaExpanded: boolean;
  rewriteInstructions: string;
  cssInjected: boolean;
  xDraftStatus: XDraftStatus;
  xDraftText: string;
  xDraftError: string | null;
  lastGeneratedSourceText: string | null;
  lastGeneratedSourceHash: string | null;
  lastGeneratedAt: number | null;
  generationRequestId: number;
  activeGenerationRequestId: number | null;
  generationInFlightHash: string | null;
  deferredEditGenerateTimer: number | null;
  deferredEditGenerateDueAt: number | null;
  revisionHistory: XDraftRevision[];
  currentRevisionIndex: number;
  isXVerified: boolean;
};

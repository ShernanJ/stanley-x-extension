type WritingStyleProfile = 'cracked_engineer' | 'value_operator' | 'community';

type GenerateXDraftPayload = {
  threadId: string;
  sourceText: string;
  sourceHash: string;
  previousSourceText: string | null;
  styleProfile?: WritingStyleProfile;
  rewriteInstructions?: string | null;
  isXVerified?: boolean;
  xCharacterLimit?: number;
  force: boolean;
};

type GenerateXDraftMessage = {
  type: 'stanley-x:generate-x-draft';
  payload: GenerateXDraftPayload;
};

type GenerateXDraftResponse = {
  ok: boolean;
  xText?: string;
  sourceHash?: string;
  cached?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

const DEFAULT_BACKEND_URL = 'http://localhost:8787';
const REQUEST_TIMEOUT_MS = 25_000;

function isGenerateXDraftMessage(value: unknown): value is GenerateXDraftMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<GenerateXDraftMessage>;
  const payload = candidate.payload;
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const rewriteInstructions = payload.rewriteInstructions;
  const styleProfile = payload.styleProfile;
  const isXVerified = payload.isXVerified;
  const xCharacterLimit = payload.xCharacterLimit;
  const rewriteInstructionsValid =
    typeof rewriteInstructions === 'undefined' ||
    rewriteInstructions === null ||
    typeof rewriteInstructions === 'string';
  const styleProfileValid =
    typeof styleProfile === 'undefined' ||
    styleProfile === 'cracked_engineer' ||
    styleProfile === 'value_operator' ||
    styleProfile === 'community';
  const verifiedValid =
    typeof isXVerified === 'undefined' || typeof isXVerified === 'boolean';
  const xCharacterLimitValid =
    typeof xCharacterLimit === 'undefined' ||
    (typeof xCharacterLimit === 'number' &&
      Number.isFinite(xCharacterLimit) &&
      xCharacterLimit > 0 &&
      xCharacterLimit <= 25_000);

  return (
    candidate.type === 'stanley-x:generate-x-draft' &&
    typeof payload.threadId === 'string' &&
    typeof payload.sourceText === 'string' &&
    typeof payload.sourceHash === 'string' &&
    rewriteInstructionsValid &&
    styleProfileValid &&
    verifiedValid &&
    xCharacterLimitValid
  );
}

async function getBackendUrl(): Promise<string> {
  const stored = await browser.storage.local.get('stanley_x_backend_url');
  const value = stored.stanley_x_backend_url;
  if (typeof value === 'string' && value.trim()) {
    return value.trim().replace(/\/$/, '');
  }
  return DEFAULT_BACKEND_URL;
}

async function fetchXDraftFromBackend(
  payload: GenerateXDraftPayload,
): Promise<GenerateXDraftResponse> {
  const backendUrl = await getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

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
      const fallback = `Backend request failed with status ${response.status}`;
      throw new Error(parsed?.error || fallback);
    }

    if (!parsed || parsed.ok !== true || typeof parsed.xText !== 'string') {
      throw new Error('Backend response missing xText');
    }

    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default defineBackground(() => {
  console.log('[Stanley-X] Background service worker started');

  browser.runtime.onInstalled.addListener(() => {
    console.log('[Stanley-X] Background installed');
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isGenerateXDraftMessage(message)) {
      return undefined;
    }

    return fetchXDraftFromBackend(message.payload)
      .then((result) => {
        console.log('[Stanley-X] X draft received from backend', {
          cached: !!result.cached,
          skipped: !!result.skipped,
          reason: result.reason || null,
        });
        return result;
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? 'Unknown error');
        console.warn('[Stanley-X] X draft request failed', errorMessage);
        return {
          ok: false,
          error: errorMessage,
        } satisfies GenerateXDraftResponse;
      });
  });
});

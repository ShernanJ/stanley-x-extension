export const GENERATE_X_DRAFT_MESSAGE = 'stanley-x:generate-x-draft';

export const THREAD_URL_RE =
  /^https:\/\/(?:[a-z0-9-]+\.)?stanley\.stan\.store\/thread\/?/i;
export const DISCOVERY_INTERVAL_MS = 500;
export const MAX_DISCOVERY_ATTEMPTS = 40;
export const DEBOUNCE_MS = 800;
export const MAX_WAIT_MS = 5000;
export const BACKEND_REQUEST_TIMEOUT_MS = 25_000;
export const DEFAULT_BACKEND_URL = 'http://localhost:8787';
export const MAX_REWRITE_INSTRUCTIONS_CHARS = 600;

export const SIGNIFICANT_CHAR_DELTA = 80;
export const SIGNIFICANT_TOKEN_DISTANCE = 0.2;
export const MIN_DRAFT_LENGTH_FOR_GENERATION = 40;
export const X_DRAFT_CACHE_PREFIX = 'stanley_x_xdraft_';
export const X_DRAFT_HISTORY_PREFIX = 'stanley_x_xdraft_history_';
export const X_DRAFT_IMAGES_PREFIX = 'stanley_x_ximages_';
export const X_DRAFT_HISTORY_LIMIT = 30;
export const MAX_ATTACHED_IMAGES = 4;
export const MAX_IMAGE_FILE_BYTES = 10_000_000;
export const MAX_STORED_IMAGE_DATA_URL_LENGTH = 550_000;
export const MAX_IMAGE_DIMENSION = 1280;
export const X_STANDARD_CHAR_LIMIT = 280;
export const X_VERIFIED_CHAR_LIMIT = 25_000;

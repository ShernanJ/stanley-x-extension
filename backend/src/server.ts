import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type WritingStyleProfile =
  | 'cracked_engineer'
  | 'value_operator'
  | 'builder_in_public'
  | 'community_builder'
  | 'thought_leader'
  | 'story_snap'
  | 'relatable'
  | 'signal_flex';

type XDraftRequestBody = {
  threadId?: unknown;
  sourceText?: unknown;
  referenceText?: unknown;
  sourceHash?: unknown;
  styleProfile?: unknown;
  rewriteInstructions?: unknown;
  isXVerified?: unknown;
  xCharacterLimit?: unknown;
  lowercaseOnly?: unknown;
  bypassHashCache?: unknown;
  force?: unknown;
};

type XDraftResponse = {
  ok: boolean;
  xText?: string;
  sourceHash?: string;
  cached?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

type GenerationRecord = {
  threadId: string;
  sourceHash: string;
  sourceText: string;
  referenceText: string;
  styleProfile: WritingStyleProfile;
  isXVerified: boolean;
  xCharacterLimit: number;
  lowercaseOnly: boolean;
  rewriteInstructions: string;
  xText: string;
  generatedAt: number;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type XMode = 'unverified' | 'verified';

type LlmTransformOutput = {
  x_post: string;
  char_count: number;
  mode: XMode;
  archetype: WritingStyleProfile;
  structure_used: string;
  banned_phrases_found: string[];
  edit_notes: string[];
};

const THIS_FILE = fileURLToPath(import.meta.url);
const BACKEND_SRC_DIR = dirname(THIS_FILE);
const BACKEND_DIR = resolve(BACKEND_SRC_DIR, '..');
const ROOT_DIR = resolve(BACKEND_DIR, '..');

loadEnvFiles([
  resolve(ROOT_DIR, '.env'),
  resolve(BACKEND_DIR, '.env'),
]);

const PORT = Number(process.env.PORT || 8787);
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_BASE_URL =
  process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

const SIGNIFICANT_CHAR_DELTA = 80;
const SIGNIFICANT_TOKEN_DISTANCE = 0.2;
const MIN_DRAFT_LENGTH_FOR_GENERATION = 40;
const MAX_SOURCE_CHARS = 15000;
const MAX_X_OUTPUT_CHARS = 900;
const X_STANDARD_CHAR_LIMIT = 280;
const X_VERIFIED_CHAR_LIMIT = 25_000;
const MAX_FACT_LINES = 14;
const MAX_STYLE_RETRIES = 3;
const GENERATION_PROMPT_VERSION =
  '2026-02-24-unverified-build-first-v8';

const cacheByThreadAndHash = new Map<string, GenerationRecord>();
const latestByThreadAndRewrite = new Map<string, GenerationRecord>();

const FEW_SHOT_EXAMPLES: Array<{ source: string; target: string }> = [
  {
    source:
      [
        'I am excited to share a launch update.',
        '',
        'How it works:',
        'We rebuilt onboarding and improved activation.',
        '',
        'Why this matters:',
        'Drop-off fell 32%.',
        '',
        "If you're building SaaS, this is for you.",
      ].join('\n'),
    target:
      [
        'Shipped a new onboarding flow this week.',
        '',
        'Activation improved fast.',
        '',
        'Drop-off is down 32%.',
        '',
        'Same product. Better first five minutes.',
      ].join('\n'),
  },
  {
    source:
      [
        'I would love feedback on this experiment.',
        '',
        'We translated a LinkedIn draft into X style.',
        '',
        'It was an incredible journey with many lessons.',
        '',
        'Thoughts?',
      ].join('\n'),
    target:
      [
        'Rewrote a LinkedIn draft for X.',
        '',
        'Same core message. Different delivery.',
        '',
        'Old draft sounded corporate.',
        '',
        'Now it reads native on X.',
      ].join('\n'),
  },
];

type StyleProfileConfig = {
  id: WritingStyleProfile;
  label: string;
  profilePrompt: string;
  minOutputChars: number;
  minParagraphs: number;
  maxParagraphs: number;
  maxOutputChars: number;
  preferLowercase?: boolean;
  requireTacticalDensity?: boolean;
  preferFriendlyTone?: boolean;
};

const STYLE_PROFILE_CONFIGS: Record<WritingStyleProfile, StyleProfileConfig> = {
  cracked_engineer: {
    id: 'cracked_engineer',
    label: 'Cracked Engineer',
    profilePrompt:
      [
        'Style profile: cracked_engineer.',
        'all lowercase.',
        '2-5 short lines.',
        '[sharp insight] [specific proof] [implied lesson].',
      ].join(' '),
    minOutputChars: 90,
    minParagraphs: 2,
    maxParagraphs: 5,
    maxOutputChars: 520,
    preferLowercase: true,
  },
  value_operator: {
    id: 'value_operator',
    label: 'Value Operator',
    profilePrompt:
      [
        'Style profile: value_operator.',
        '[bold claim] - point - point - point [punchline] [engagement question].',
        'Must stay tactical, specific, and high-signal.',
      ].join(' '),
    minOutputChars: 180,
    minParagraphs: 4,
    maxParagraphs: 9,
    maxOutputChars: 1400,
    requireTacticalDensity: true,
  },
  builder_in_public: {
    id: 'builder_in_public',
    label: 'Builder In Public',
    profilePrompt:
      [
        'Style profile: builder_in_public.',
        '[what happened] [metric] [lesson] [next step].',
      ].join(' '),
    minOutputChars: 140,
    minParagraphs: 3,
    maxParagraphs: 7,
    maxOutputChars: 1000,
  },
  community_builder: {
    id: 'community_builder',
    label: 'Community Builder',
    profilePrompt:
      [
        'Style profile: community_builder.',
        '[community statement] [specific group or win] [shared mission] [open CTA].',
        'Friendly but direct.',
      ].join(' '),
    minOutputChars: 120,
    minParagraphs: 4,
    maxParagraphs: 7,
    maxOutputChars: 980,
    preferFriendlyTone: true,
  },
  thought_leader: {
    id: 'thought_leader',
    label: 'Thought Leader',
    profilePrompt:
      [
        'Style profile: thought_leader.',
        '[strong POV] [why it matters] [conclusion].',
      ].join(' '),
    minOutputChars: 130,
    minParagraphs: 3,
    maxParagraphs: 7,
    maxOutputChars: 920,
  },
  story_snap: {
    id: 'story_snap',
    label: 'Story Snap',
    profilePrompt:
      [
        'Style profile: story_snap.',
        '[moment] [turning point] [lesson].',
      ].join(' '),
    minOutputChars: 110,
    minParagraphs: 3,
    maxParagraphs: 6,
    maxOutputChars: 860,
  },
  relatable: {
    id: 'relatable',
    label: 'Relatable',
    profilePrompt:
      [
        'Style profile: relatable.',
        '[struggle] [honesty] [question].',
      ].join(' '),
    minOutputChars: 95,
    minParagraphs: 2,
    maxParagraphs: 5,
    maxOutputChars: 760,
  },
  signal_flex: {
    id: 'signal_flex',
    label: 'Signal Flex',
    profilePrompt:
      [
        'Style profile: signal_flex.',
        '[result] [how it happened] [implication].',
      ].join(' '),
    minOutputChars: 110,
    minParagraphs: 3,
    maxParagraphs: 6,
    maxOutputChars: 900,
  },
};

const PROFILE_FEW_SHOT_EXAMPLES: Record<
  WritingStyleProfile,
  Array<{ source: string; target: string }>
> = {
  cracked_engineer: [
    {
      source:
        [
          'we shipped another update.',
          '',
          'it fixes the bug everyone hated.',
          '',
          'why this matters:',
          'support tickets dropped.',
        ].join('\n'),
      target:
        [
          'shipped a fix for the most annoying bug.',
          '',
          'tickets dropped right after deploy.',
          '',
          'small change, big relief.',
        ].join('\n'),
    },
  ],
  value_operator: [
    {
      source:
        [
          'we ran a growth workflow and it worked.',
          '',
          'how it works:',
          '1) qualify users',
          '2) tighten activation',
          '3) retarget intent',
        ].join('\n'),
      target:
        [
          'Ran one growth workflow and kept the winning version.',
          '',
          'Qualified traffic first.',
          '',
          'Then tightened activation.',
          '',
          'Then retargeted high-intent users.',
          '',
          'Conversion moved in the right direction.',
        ].join('\n'),
    },
  ],
  builder_in_public: [
    {
      source:
        [
          'Built a small internal workflow to speed up launch QA.',
          '',
          'It reduced time and gave us fewer regressions.',
          '',
          'Next we want to automate reporting.',
        ].join('\n'),
      target:
        [
          'built a lightweight qa workflow before each launch.',
          '',
          'qa time dropped by 41%. regressions dropped too.',
          '',
          'lesson: boring systems compound.',
          '',
          'next: automate reporting.',
        ].join('\n'),
    },
  ],
  community_builder: [
    {
      source:
        [
          'we launched a new community thread.',
          '',
          'it helps creators share wins and blockers.',
          '',
          'if this sounds useful, jump in.',
        ].join('\n'),
      target:
        [
          'Started a new community thread for creators.',
          '',
          'Use it to share wins and blockers in real time.',
          '',
          'If you are building, join us there.',
        ].join('\n'),
    },
  ],
  thought_leader: [
    {
      source:
        [
          'People over-focus on tools and under-focus on positioning.',
          '',
          'The best distribution starts from a clear market narrative.',
        ].join('\n'),
      target:
        [
          'most teams don’t have a tooling problem.',
          '',
          'they have a positioning problem.',
          '',
          'if the market narrative is weak, distribution stays expensive.',
        ].join('\n'),
    },
  ],
  story_snap: [
    {
      source:
        [
          'I almost shipped the wrong thing last week.',
          '',
          'A customer call changed the roadmap in 20 minutes.',
        ].join('\n'),
      target:
        [
          'last week i was ready to ship the wrong thing.',
          '',
          'one customer call flipped the roadmap in 20 minutes.',
          '',
          'lesson: talk to users before polishing plans.',
        ].join('\n'),
    },
  ],
  relatable: [
    {
      source:
        [
          'I keep overcomplicating simple decisions.',
          '',
          'It slows execution and creates unnecessary stress.',
        ].join('\n'),
      target:
        [
          'i still overcomplicate simple decisions.',
          '',
          'it slows everything down.',
          '',
          'you ever catch yourself doing this too?',
        ].join('\n'),
    },
  ],
  signal_flex: [
    {
      source:
        [
          'Our product hit a meaningful result after a distribution change.',
          '',
          'We reworked first-session onboarding and messaging.',
        ].join('\n'),
      target:
        [
          'activation moved +18% after one distribution change.',
          '',
          'we rewrote first-session onboarding and messaging.',
          '',
          'small messaging shifts can unlock real growth.',
        ].join('\n'),
    },
  ],
};

function loadEnvFiles(paths: string[]): void {
  const mergedFromFiles: Record<string, string> = {};

  for (const envPath of paths) {
    if (!existsSync(envPath)) {
      continue;
    }

    const content = readFileSync(envPath, 'utf-8');
    const parsed = parseDotEnv(content);
    Object.assign(mergedFromFiles, parsed);
  }

  for (const [key, value] of Object.entries(mergedFromFiles)) {
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }
}

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2] || '';

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');

    result[key] = value;
  }

  return result;
}

function parseStyleProfile(value: unknown): WritingStyleProfile | null {
  if (value === 'cracked_engineer') {
    return 'cracked_engineer';
  }
  if (value === 'value_operator') {
    return 'value_operator';
  }
  if (value === 'builder_in_public') {
    return 'builder_in_public';
  }
  if (value === 'community_builder' || value === 'community') {
    return 'community_builder';
  }
  if (value === 'thought_leader') {
    return 'thought_leader';
  }
  if (value === 'story_snap') {
    return 'story_snap';
  }
  if (value === 'relatable') {
    return 'relatable';
  }
  if (value === 'signal_flex') {
    return 'signal_flex';
  }
  return null;
}

function inferStyleProfileFromInstructions(
  rewriteInstructions: string,
): WritingStyleProfile | null {
  const normalized = normalize(rewriteInstructions).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    /\b(cracked|lower ?case|lowercase|ultra concise|short sharp|punchy)\b/.test(
      normalized,
    )
  ) {
    return 'cracked_engineer';
  }
  if (
    /\b(value|playbook|framework|tactical|operator|operators|informational)\b/.test(
      normalized,
    )
  ) {
    return 'value_operator';
  }
  if (/\b(builder in public|build in public|wip|next step)\b/.test(normalized)) {
    return 'builder_in_public';
  }
  if (/\b(community|friendly|shared mission|group)\b/.test(normalized)) {
    return 'community_builder';
  }
  if (/\b(pov|thesis|thought leader|strong opinion)\b/.test(normalized)) {
    return 'thought_leader';
  }
  if (/\b(story|moment|turning point|snap)\b/.test(normalized)) {
    return 'story_snap';
  }
  if (/\b(relatable|honesty|struggle)\b/.test(normalized)) {
    return 'relatable';
  }
  if (/\b(signal flex|result first|outcome first)\b/.test(normalized)) {
    return 'signal_flex';
  }

  return null;
}

function inferStyleProfileFromSource(sourceText: string): WritingStyleProfile {
  const normalized = normalize(sourceText);
  const lowered = normalized.toLowerCase();
  const sourceLength = normalized.length;

  const metricsCount = (normalized.match(/\b\d+(?:\.\d+)?%?\b/g) || []).length;
  const bulletCount = (normalized.match(/(^|\n)\s*(?:[-*•→]+|\d+[.)])\s+/g) || []).length;
  const questionCount = (normalized.match(/\?/g) || []).length;
  const quoteCount = (normalized.match(/"/g) || []).length;
  const ctaCount = (
    lowered.match(/\b(reply|dm|comment|drop|what do you think|thoughts)\b/g) || []
  ).length;
  const buildCount = (
    lowered.match(/\b(i built|we built|shipped|shipping|launch|launched)\b/g) || []
  ).length;
  const communityCount = (
    lowered.match(/\b(community|builders|founders|creators|together|us|we)\b/g) || []
  ).length;
  const struggleCount = (
    lowered.match(/\b(struggle|stuck|mess|hard|difficult|burned out)\b/g) || []
  ).length;
  const povCount = (
    lowered.match(/\b(i think|i believe|hot take|opinion|pov)\b/g) || []
  ).length;

  const letters = normalized.replace(/[^A-Za-z]/g, '');
  const uppercaseCount = (letters.match(/[A-Z]/g) || []).length;
  const lowercaseRatio =
    letters.length > 0 ? (letters.length - uppercaseCount) / letters.length : 0.5;

  const score: Record<WritingStyleProfile, number> = {
    cracked_engineer: 0,
    value_operator: 0,
    builder_in_public: 0,
    community_builder: 0,
    thought_leader: 0,
    story_snap: 0,
    relatable: 0,
    signal_flex: 0,
  };

  score.cracked_engineer += lowercaseRatio > 0.72 ? 2 : 0;
  score.cracked_engineer += sourceLength < 520 ? 1 : 0;
  score.cracked_engineer += buildCount > 0 ? 1 : 0;

  score.value_operator += metricsCount > 0 ? 2 : 0;
  score.value_operator += bulletCount >= 2 ? 3 : bulletCount > 0 ? 1 : 0;
  score.value_operator += ctaCount > 0 ? 1 : 0;

  score.builder_in_public += buildCount > 0 ? 2 : 0;
  score.builder_in_public += metricsCount > 0 ? 1 : 0;
  score.builder_in_public += /\b(next|roadmap|shipping next)\b/i.test(normalized) ? 1 : 0;

  score.community_builder += communityCount > 2 ? 2 : communityCount > 0 ? 1 : 0;
  score.community_builder += ctaCount > 0 ? 1 : 0;

  score.thought_leader += povCount > 0 ? 2 : 0;
  score.thought_leader += sourceLength > 550 ? 1 : 0;

  score.story_snap += /\b(last week|today|yesterday|then|suddenly)\b/i.test(normalized)
    ? 2
    : 0;
  score.story_snap += quoteCount >= 2 ? 1 : 0;

  score.relatable += struggleCount > 0 ? 2 : 0;
  score.relatable += questionCount > 0 ? 1 : 0;

  score.signal_flex += metricsCount >= 2 ? 2 : 0;
  score.signal_flex += /\b(result|grew|up|down|improved|increased)\b/i.test(normalized)
    ? 1
    : 0;

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const top = ranked[0] as [string, number] | undefined;
  if (!top || top[1] <= 0) {
    return sourceLength > 600 ? 'value_operator' : 'builder_in_public';
  }
  return top[0] as WritingStyleProfile;
}

function resolveStyleProfile(
  requestedStyleProfile: WritingStyleProfile | null,
  sourceText: string,
  rewriteInstructions: string,
): WritingStyleProfile {
  if (requestedStyleProfile) {
    return requestedStyleProfile;
  }

  const fromInstructions = inferStyleProfileFromInstructions(rewriteInstructions);
  if (fromInstructions) {
    return fromInstructions;
  }

  return inferStyleProfileFromSource(sourceText);
}

function getStyleProfileConfig(profile: WritingStyleProfile): StyleProfileConfig {
  return STYLE_PROFILE_CONFIGS[profile];
}

function getStructureBlueprint(profile: WritingStyleProfile): string {
  switch (profile) {
    case 'cracked_engineer':
      return '[sharp insight] [specific proof] [implied lesson]';
    case 'value_operator':
      return '[bold claim] - point - point - point [punchline] [engagement question]';
    case 'builder_in_public':
      return '[what happened] [metric] [lesson] [next step]';
    case 'community_builder':
      return '[community statement] [specific group or win] [shared mission] [open CTA]';
    case 'thought_leader':
      return '[strong POV] [why it matters] [conclusion]';
    case 'story_snap':
      return '[moment] [turning point] [lesson]';
    case 'relatable':
      return '[struggle] [honesty] [question]';
    case 'signal_flex':
      return '[result] [how it happened] [implication]';
    default:
      return '[what happened] [metric] [lesson] [next step]';
  }
}

function normalize(text: string): string {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
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

function isSignificantChange(previous: string, next: string): boolean {
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function createMockXDraft(
  sourceText: string,
  rewriteInstructions: string,
  styleProfile: WritingStyleProfile,
  maxOutputChars: number,
): string {
  const lines = sourceText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const hook = lines[0] || 'Quick update:';
  const body = lines.slice(1, 6).map((line) => `- ${line}`).join('\n');
  const styleLine = `\n\nStyle profile: ${styleProfile}`;
  const instructionsLine = rewriteInstructions
    ? `\n\nInstruction focus: ${rewriteInstructions}`
    : '';
  const tail =
    '\n\n(Backend is in mock mode. Set GROQ_API_KEY to get real LLM rewrites.)';
  return enforceOutputShape(
    `${hook}\n\n${body}${styleLine}${instructionsLine}${tail}`.trim(),
    maxOutputChars,
  );
}

function sanitizeFactLine(line: string): string {
  return normalize(line)
    .replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, '$1')
    .replace(/^\s*(?:[-*•→]+|\d+[.)])\s*/g, '')
    .replace(/^\s*(?:the problem|how it works|why this matters)\s*:\s*/i, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractFactCandidates(sourceText: string): string[] {
  const rawLines = normalize(sourceText)
    .split('\n')
    .map((line) => sanitizeFactLine(line))
    .filter(Boolean);

  const filtered = rawLines.filter((line) => {
    const lowered = line.toLowerCase();
    if (/^(if you'?re .* this is for you\.?)$/.test(lowered)) return false;
    if (/^(thoughts\??|let me know|would love feedback)/.test(lowered)) return false;
    if (/^(the problem|how it works|why this matters)$/.test(lowered)) return false;
    return true;
  });

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of filtered) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(line);
    if (deduped.length >= MAX_FACT_LINES) {
      break;
    }
  }

  return deduped;
}

function formatFactsBlock(lines: string[]): string {
  if (!lines.length) {
    return '';
  }
  return lines.join('\n');
}

function getFewShotMessages(styleProfile: WritingStyleProfile): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const examples = [
    ...FEW_SHOT_EXAMPLES,
    ...(PROFILE_FEW_SHOT_EXAMPLES[styleProfile] || []),
  ];

  for (const example of examples) {
    messages.push({
      role: 'user',
      content: `LinkedIn draft:\n${example.source}`,
    });
    messages.push({
      role: 'assistant',
      content: example.target,
    });
  }
  return messages;
}

function needsToneRetry(text: string): boolean {
  const normalized = normalize(text).toLowerCase();
  if (!normalized) {
    return false;
  }

  return detectBannedPhrases(normalized).length > 0;
}

function hasLinkedInStructure(text: string): boolean {
  const normalized = normalize(text).toLowerCase();
  if (!normalized) {
    return false;
  }

  const patterns = [
    /(^|\n)\s*(the problem|how it works|why this matters)\s*:/,
    /(^|\n)\s*(if you'?re .* this is for you)\s*\.?$/,
    /\bbuild in public\b/,
    /\bthoughts\?\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function detectBannedPhrases(text: string): string[] {
  const normalized = normalize(text).toLowerCase();
  if (!normalized) {
    return [];
  }

  const checks: Array<{ label: string; pattern: RegExp }> = [
    { label: 'excited to share', pattern: /\bexcited to share\b/i },
    { label: 'grateful', pattern: /\bgrateful\b/i },
    { label: 'journey', pattern: /\bjourney\b/i },
    { label: 'lessons learned', pattern: /\blessons learned\b/i },
    { label: 'thrilled', pattern: /\bthrilled\b/i },
    { label: 'game changer', pattern: /\bgame[- ]changer\b/i },
    { label: 'how it works', pattern: /\bhow it works\b/i },
    { label: 'why this matters', pattern: /\bwhy this matters\b/i },
    { label: 'the problem', pattern: /\bthe problem\b/i },
  ];

  const found: string[] = [];
  for (const check of checks) {
    if (check.pattern.test(normalized)) {
      found.push(check.label);
    }
  }
  return found;
}

function detectStyleViolations(
  text: string,
  styleProfile: WritingStyleProfile,
  mode: XMode,
): string[] {
  const normalized = normalize(text);
  const violations: string[] = [];

  const bannedPhrases = detectBannedPhrases(normalized);
  if (bannedPhrases.length) {
    violations.push('LinkedIn tone words or celebratory phrasing detected');
  }
  if (hasLinkedInStructure(normalized)) {
    violations.push('LinkedIn section headers or CTA structure detected');
  }
  if (/[🎉🔥🚀✨💯😊😅👏🙏]/.test(normalized)) {
    violations.push('Emoji detected');
  }
  if (/(^|\s)#[\p{L}\p{N}_-]+/u.test(normalized)) {
    violations.push('Hashtag detected');
  }
  const hasBullets = /(^|\n)\s*(?:[-*•→]+|\d+[.)])\s+/u.test(normalized);
  if (hasBullets && styleProfile !== 'value_operator') {
    violations.push('Bullet or numbered list marker detected');
  }
  if (mode === 'unverified' && hasBullets) {
    violations.push('Unverified mode should avoid list formatting');
  }
  if (/(^|\n)\s*(?:how it works|why this matters|the problem)\s*:/i.test(normalized)) {
    violations.push('LinkedIn section-heading style detected');
  }

  return violations;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractImportantAnchors(sourceText: string): string[] {
  const normalized = normalize(sourceText);
  const anchors: string[] = [];

  const quotedMatch = normalized.match(/"([^"\n]{12,120})"/);
  if (quotedMatch?.[1]) {
    anchors.push(quotedMatch[1]);
  }

  const phraseCandidates = [
    'LinkedIn-coded',
    'LinkedIn formatted',
    'Stan Hackathon',
    'Chrome extension',
    'cross-posting',
    'Stanley',
    'LinkedIn',
    'X',
  ];
  for (const phrase of phraseCandidates) {
    const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
    if (re.test(normalized)) {
      anchors.push(phrase);
    }
  }

  const numberMatches = [...normalized.matchAll(/\b\d+\b/g)]
    .map((match) => match[0])
    .slice(0, 3);
  anchors.push(...numberMatches);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const key = anchor.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(anchor);
    }
    if (unique.length >= 8) {
      break;
    }
  }

  return unique;
}

function getDynamicMinOutputChars(
  sourceText: string,
  profileConfig: StyleProfileConfig,
): number {
  const sourceLength = normalize(sourceText).length;
  const ratio =
    profileConfig.id === 'cracked_engineer'
      ? 0.28
      : profileConfig.id === 'relatable' || profileConfig.id === 'story_snap'
        ? 0.3
        : profileConfig.id === 'community_builder'
          ? 0.34
          : 0.4;

  const estimated = Math.round(sourceLength * ratio);
  return Math.min(
    profileConfig.maxOutputChars - 40,
    Math.max(profileConfig.minOutputChars, estimated),
  );
}

function getDynamicParagraphBounds(
  sourceText: string,
  profileConfig: StyleProfileConfig,
): { min: number; max: number } {
  const sourceLength = normalize(sourceText).length;
  if (sourceLength < 550) {
    return {
      min: Math.max(3, profileConfig.minParagraphs - 1),
      max: Math.max(profileConfig.maxParagraphs - 1, profileConfig.minParagraphs),
    };
  }
  if (sourceLength > 1200) {
    return {
      min: Math.min(profileConfig.minParagraphs + 2, profileConfig.maxParagraphs),
      max: profileConfig.maxParagraphs,
    };
  }
  return {
    min: profileConfig.minParagraphs,
    max: profileConfig.maxParagraphs,
  };
}

function getFirstSentence(text: string): string {
  const normalized = normalize(text).trim();
  if (!normalized) {
    return '';
  }

  const sentenceEndMatch = normalized.match(/^(.{1,280}?)(?:[.!?](?:\s|$)|\n|$)/);
  return normalize((sentenceEndMatch?.[1] ?? normalized).trim());
}

const UNVERIFIED_TRIGGER_PATTERN =
  /\b(comment|called out|linkedin(?:-coded| formatted)?|noticed|saw|post(?:ed)? on x|culture|problem|almost didn'?t read)\b/i;
const UNVERIFIED_BUILD_PATTERN =
  /\b(i|we)\s+(built|made|shipped|launched)\b|\b(chrome extension|extension|translator|tool)\b/i;

function splitXParagraphLines(text: string): string[] {
  return normalize(text)
    .split(/\n{2,}/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getUnverifiedTriggerBuildIndices(text: string): {
  triggerIndex: number;
  buildIndex: number;
} {
  const lines = splitXParagraphLines(text);
  return {
    triggerIndex: lines.findIndex((line) => UNVERIFIED_TRIGGER_PATTERN.test(line)),
    buildIndex: lines.findIndex((line) => UNVERIFIED_BUILD_PATTERN.test(line)),
  };
}

function inferBuildAnchor(sourceText: string): string | null {
  const normalized = normalize(sourceText).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/\bchrome extension\b/.test(normalized)) {
    return 'chrome extension';
  }
  if (/\bextension\b/.test(normalized)) {
    return 'extension';
  }

  const builtMatch = normalized.match(
    /\b(?:i|we)\s+built\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\- ]{2,48})/i,
  );
  if (builtMatch?.[1]) {
    return builtMatch[1].trim();
  }

  return null;
}

function inferPostedActor(sourceText: string): string | null {
  const normalized = normalize(sourceText);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/\b([A-Z][a-z]{2,})\s+posted on\s+X\b/i);
  if (!match?.[1]) {
    return null;
  }
  return match[1];
}

function inferPostedOnXLine(sourceText: string): string | null {
  const lines = normalize(sourceText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((candidate) => /\bposted on\s+X\b/i.test(candidate));
  if (!line) {
    return null;
  }

  const compact = line
    .replace(/\band how (she|he|they)\s+hired\b/gi, 'and hired')
    .replace(/\bfrom it\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return compact;
}

function inferTriggerQuote(sourceText: string): string | null {
  const normalized = normalize(sourceText);
  if (!normalized) {
    return null;
  }

  const quoteMatches = [...normalized.matchAll(/"([^"\n]{10,180})"/g)]
    .map((match) => normalize(match[1] || '').trim())
    .filter(Boolean);
  if (!quoteMatches.length) {
    return null;
  }

  const preferred =
    quoteMatches.find((quote) => /almost didn'?t read/i.test(quote)) ||
    quoteMatches.find((quote) => /linkedin(?:-coded| formatted)/i.test(quote)) ||
    quoteMatches[0];
  if (!preferred) {
    return null;
  }

  return preferred.replace(/\s{2,}/g, ' ').trim();
}

function inferTriggerObservationLine(sourceText: string): string | null {
  const lines = normalize(sourceText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const triggerLine = lines.find((candidate) =>
    /\b(comment|reply|linkedin(?:-coded| formatted)?|almost didn'?t read|called.*linkedin)\b/i.test(
      candidate,
    ),
  );
  if (!triggerLine) {
    return null;
  }
  return triggerLine.replace(/\s{2,}/g, ' ').trim();
}

function inferBuildLine(sourceText: string): string | null {
  const lines = normalize(sourceText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const buildLine = lines.find((candidate) =>
    /\b(?:i|we)\s+(?:built|made|shipped|launched)\b|\b(chrome extension|extension|translator|tool)\b/i.test(
      candidate,
    ),
  );
  if (buildLine) {
    return buildLine.replace(/\s{2,}/g, ' ').trim();
  }

  const anchor = inferBuildAnchor(sourceText);
  if (anchor) {
    return `built ${anchor}.`;
  }

  return null;
}

function inferPurposeLine(sourceText: string): string | null {
  const lines = normalize(sourceText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const purposeLine = lines.find((candidate) =>
    /\b(x-native|translate|rewrit(?:e|es|ing)|drafts?\s+an?\s+x\s+version|tailored for x|cross-post|format for x)\b/i.test(
      candidate,
    ),
  );
  if (!purposeLine) {
    return null;
  }

  return purposeLine.replace(/\s{2,}/g, ' ').trim();
}

function normalizeSentenceEnding(text: string): string {
  const normalizedText = normalize(text).trim();
  if (!normalizedText) {
    return '';
  }
  if (/[.!?]["'”’]?$/.test(normalizedText)) {
    return normalizedText;
  }
  return `${normalizedText}.`;
}

function lowerCaseFirstAscii(text: string): string {
  const normalizedText = normalize(text).trim();
  if (!normalizedText) {
    return '';
  }
  return normalizedText.charAt(0).toLowerCase() + normalizedText.slice(1);
}

function buildDeterministicUnverifiedDraft(
  sourceText: string,
  hardLimit: number,
  lowercaseOnly: boolean,
): string {
  const source = normalize(sourceText);
  if (!source) {
    return '';
  }

  const actorLine = inferPostedOnXLine(sourceText);
  const triggerQuote = inferTriggerQuote(sourceText);
  const triggerObservation = inferTriggerObservationLine(sourceText);
  const triggerLine = triggerQuote
    ? normalizeSentenceEnding(
        triggerObservation
          ? `${triggerObservation} "${triggerQuote}"`
          : `"${triggerQuote}"`,
      )
    : normalizeSentenceEnding(triggerObservation || '');
  const buildLine = inferBuildLine(sourceText);
  const purposeLine = inferPurposeLine(sourceText);

  const leadLine = buildLine
    ? normalizeSentenceEnding(
        purposeLine
          ? `${buildLine.replace(/[.!?]+$/, '')}. ${lowerCaseFirstAscii(purposeLine)}`
          : buildLine,
      )
    : normalizeSentenceEnding(purposeLine || '');
  const evidenceLine = actorLine && triggerLine
    ? normalizeSentenceEnding(
        `${actorLine.replace(/[.!?]+$/, '')}, but ${lowerCaseFirstAscii(
          triggerLine.replace(/[.!?]+$/, ''),
        )}`,
      )
    : normalizeSentenceEnding(triggerLine || actorLine || '');

  const lines = [leadLine, evidenceLine]
    .map((line) => normalize(line || '').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .filter((line, index, list) => list.indexOf(line) === index);
  if (!lines.length) {
    return '';
  }

  let draft = normalize(lines.join('\n\n'));
  if (draft.length > hardLimit) {
    const compactLead = normalizeSentenceEnding(buildLine || purposeLine || '');
    const compactEvidence = normalizeSentenceEnding(
      triggerQuote ? `"${triggerQuote}"` : triggerObservation || actorLine || '',
    );
    const compactDraft = normalize([compactLead, compactEvidence].filter(Boolean).join('\n\n'));
    if (compactDraft && compactDraft.length < draft.length) {
      draft = compactDraft;
    }
  }
  if (!draft.trim()) {
    draft = getFirstSentence(sourceText);
  }
  if (draft.length > hardLimit) {
    draft = truncateAtNaturalBoundary(draft, hardLimit);
  }

  return applyCasePreference(draft, lowercaseOnly);
}

function pickAnchorKeyword(anchor: string): string {
  const normalized = normalize(anchor).toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('extension')) {
    return 'extension';
  }

  const stopwords = new Set([
    'a',
    'an',
    'the',
    'new',
    'my',
    'our',
    'this',
    'that',
    'tool',
    'app',
    'project',
  ]);
  const tokens = normalized
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2 && !stopwords.has(token));
  if (!tokens.length) {
    return normalized.split(/[^a-z0-9]+/g).filter(Boolean).pop() || '';
  }
  return tokens[tokens.length - 1];
}

function detectNarrativeViolations(
  sourceText: string,
  outputText: string,
  styleProfile: WritingStyleProfile,
  xCharacterLimit: number,
): string[] {
  const source = normalize(sourceText);
  const output = normalize(outputText);
  const profileConfig = getStyleProfileConfig(styleProfile);
  const isCompactUnverifiedMode = xCharacterLimit <= X_STANDARD_CHAR_LIMIT;
  const violations: string[] = [];
  let minOutputChars = getDynamicMinOutputChars(source, profileConfig);
  let paragraphBounds = getDynamicParagraphBounds(source, profileConfig);
  if (isCompactUnverifiedMode) {
    minOutputChars = Math.min(minOutputChars, 170);
    paragraphBounds = { min: 1, max: 4 };
  }

  if (!output) {
    violations.push('Output is empty');
    return violations;
  }

  if (output.length < minOutputChars && source.length > 500) {
    violations.push(
      `Output is over-compressed for ${profileConfig.label}; keep more narrative detail`,
    );
  }

  const paragraphCount = output
    .split(/\n{2,}/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean).length;
  if (paragraphCount < paragraphBounds.min) {
    violations.push(
      `Output has too few short paragraphs for ${profileConfig.label}`,
    );
  }
  if (paragraphCount > paragraphBounds.max + 1) {
    violations.push(
      `Output has too many paragraphs for ${profileConfig.label}`,
    );
  }

  const sourceHasFirstPerson = /\b(i|my|we|our)\b/i.test(source);
  const outputHasFirstPerson = /\b(i|my|we|our)\b/i.test(output);
  if (sourceHasFirstPerson && !outputHasFirstPerson) {
    violations.push('First-person builder voice was removed');
  }

  if (!isCompactUnverifiedMode) {
    const anchors = extractImportantAnchors(source);
    const missingAnchors = anchors.filter((anchor) => {
      return !new RegExp(escapeRegExp(anchor), 'i').test(output);
    });
    if (missingAnchors.length >= 3) {
      violations.push(
        `Missing key specifics: ${missingAnchors.slice(0, 4).join(', ')}`,
      );
    }
  }

  if (profileConfig.preferLowercase) {
    const letters = output.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 80) {
      const uppercaseCount = (letters.match(/[A-Z]/g) || []).length;
      const uppercaseRatio = uppercaseCount / letters.length;
      if (uppercaseRatio > 0.18) {
        violations.push('Tone should feel more casual/lowercase for cracked engineer style');
      }
    }
    if (paragraphCount > 9) {
      violations.push('Cracked engineer style should be tighter');
    }
  }

  if (profileConfig.requireTacticalDensity && !isCompactUnverifiedMode) {
    if (!/\b\d+(\.\d+)?%?\b/.test(output)) {
      violations.push('Value operator style should include at least one concrete metric');
    }
    if (!/\b(playbook|framework|template|steps|system|checklist|process)\b/i.test(output)) {
      violations.push(
        'Value operator style should include at least one tactical term',
      );
    }
  }

  if (profileConfig.preferFriendlyTone) {
    if (!/\b(you|we|your|us)\b/i.test(output)) {
      violations.push('Community style should keep a relational voice');
    }
  }

  if (xCharacterLimit <= X_STANDARD_CHAR_LIMIT) {
    const sourceParagraphCount = source
      .split(/\n{2,}/g)
      .map((chunk) => chunk.trim())
      .filter(Boolean).length;
    if (paragraphCount > 4) {
      violations.push('Unverified mode should stay compact with fewer paragraphs');
    }
    if (sourceParagraphCount >= 3 && paragraphCount < 2 && output.length > 120) {
      violations.push('Unverified mode should keep short line breaks, not a single dense line');
    }

    const sourceHasMeaningfulQuote = /"[^"\n]{10,}"/.test(source);
    if (/"[^"\n]{10,}"/.test(output) && !sourceHasMeaningfulQuote) {
      violations.push('Unverified mode should avoid invented quoted examples');
    }

    if (/\b(one reply stood out|for example|for instance)\b/i.test(output)) {
      violations.push('Unverified mode should avoid examples and setup lines');
    }

    if (/\bmade me build\b/i.test(output)) {
      violations.push(
        'Unverified mode should avoid meta opener "made me build"; lead with trigger facts',
      );
    }

    if (/\bnow\s+(my|this)\s+(extension|tool)\b/i.test(output)) {
      violations.push('Unverified mode should avoid "now my extension" framing');
    }

    if (/(^|\n\n)\s*(someone|people|users)\b/i.test(output)) {
      violations.push('Unverified mode should avoid vague subject lines');
    }

    if (/^\s*(tired of|ever |what if|are you|do you)\b/i.test(output)) {
      violations.push('Unverified mode should avoid generic rhetorical hook openers');
    }

    if (/\b\d+\b/.test(source) && !/\b\d+\b/.test(output)) {
      violations.push('Unverified mode should keep one concrete numeric fact');
    }

    const sourceMentionsLinkedInCoded = /\blinkedin(?:-coded| formatted)\b/i.test(source);
    if (
      sourceMentionsLinkedInCoded &&
      !/\blinkedin(?:-coded| formatted)\b/i.test(output)
    ) {
      violations.push('Unverified mode should preserve the linkedin-coded trigger');
    }

    if (/almost didn'?t read/i.test(source) && !/almost didn'?t read/i.test(output)) {
      violations.push('Unverified mode should preserve the "almost didn’t read" trigger');
    }

    const postedActor = inferPostedActor(sourceText);
    if (postedActor && !new RegExp(`\\b${escapeRegExp(postedActor)}\\b`, 'i').test(output)) {
      violations.push('Unverified mode should keep the named actor for specificity');
    }

    const buildAnchor = inferBuildAnchor(source);
    if (buildAnchor) {
      const keyword = pickAnchorKeyword(buildAnchor);
      const firstTwoLines = output
        .split(/\n{2,}/g)
        .slice(0, 2)
        .join(' ')
        .toLowerCase();
      if (keyword && !firstTwoLines.includes(keyword)) {
        violations.push(
          `What was built should appear in the first two lines (missing: ${keyword})`,
        );
      }
    }

    const { triggerIndex, buildIndex } = getUnverifiedTriggerBuildIndices(output);
    if (triggerIndex >= 0 && buildIndex >= 0 && triggerIndex < buildIndex) {
      violations.push('For unverified mode, put what was built before trigger/observation');
    }
  }

  return violations;
}

function detectUnsupportedClaims(sourceText: string, outputText: string): string[] {
  const source = normalize(sourceText).toLowerCase();
  const output = normalize(outputText).toLowerCase();
  if (!source || !output) {
    return [];
  }

  const checks: Array<{ label: string; outputPattern: RegExp; sourcePattern: RegExp }> = [
    {
      label: 'test/experiment claim not present in source',
      outputPattern: /\b(tested|test|experiment|pilot|validated|validation|case study)\b/i,
      sourcePattern: /\b(tested|test|experiment|pilot|validated|validation|case study)\b/i,
    },
    {
      label: 'launch timing claim not present in source',
      outputPattern: /\b(launched today|just launched|went live today)\b/i,
      sourcePattern: /\b(launched today|just launched|went live today)\b/i,
    },
  ];

  const violations: string[] = [];
  for (const check of checks) {
    if (check.outputPattern.test(output) && !check.sourcePattern.test(source)) {
      violations.push(check.label);
    }
  }

  return violations;
}

function detectRewriteSimilarityViolation(
  currentPostText: string,
  outputText: string,
  isRewriteContext: boolean,
): string[] {
  if (!isRewriteContext) {
    return [];
  }

  const current = normalize(currentPostText);
  const output = normalize(outputText);
  if (!current || !output) {
    return [];
  }

  if (current.toLowerCase() === output.toLowerCase()) {
    return ['Rewrite output is identical to current post'];
  }

  const tokenDistance = computeTokenDistance(current, output);
  if (tokenDistance < 0.16) {
    return ['Rewrite output is too similar to current post'];
  }

  return [];
}

function enforceSourceClaimGuard(sourceText: string, outputText: string): string {
  const source = normalize(sourceText).toLowerCase();
  const output = normalize(outputText);
  if (!source || !output) {
    return output;
  }

  const sourceHasTestClaims =
    /\b(tested|test|experiment|pilot|validated|validation|case study)\b/i.test(source);
  if (sourceHasTestClaims) {
    return output;
  }

  const lines = output
    .split(/\n{2,}/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/\b(tested|test|experiment|pilot|validated|validation|case study)\b/i.test(line),
    );

  return normalize(lines.join('\n\n'));
}

function truncateAtNaturalBoundary(text: string, maxChars: number): string {
  const normalized = normalize(text).trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const hardLimit = Math.max(80, maxChars);
  const minAcceptable = Math.max(60, Math.floor(hardLimit * 0.62));
  const sliced = normalized.slice(0, hardLimit + 1);

  const paragraphBreak = sliced.lastIndexOf('\n\n');
  if (paragraphBreak >= minAcceptable) {
    return sliced.slice(0, paragraphBreak).trim();
  }

  for (let index = hardLimit; index >= minAcceptable; index -= 1) {
    const char = sliced[index];
    if (char === '.' || char === '!' || char === '?' || char === '\n') {
      return sliced.slice(0, index + 1).trim();
    }
  }

  return sliced.slice(0, hardLimit).trimEnd();
}

function enforceOutputShape(text: string, maxChars = MAX_X_OUTPUT_CHARS): string {
  let output = normalize(text);
  output = output.replace(/[ \t]+\n/g, '\n');
  output = output.replace(/\n{3,}/g, '\n\n');
  output = output.replace(/[🎉🔥🚀✨💯😊😅👏🙏]/g, '');
  output = output.replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, '$1');
  output = output.replace(
    /(^|\n)\s*(the problem|how it works|why this matters)\s*:\s*/gi,
    '$1',
  );
  output = output.replace(
    /\b(if you'?re [^.!\n]*this is for you)\b\.?/gi,
    '',
  );
  output = output.replace(
    /\b(excited|thrilled|grateful|humbled|honored|blessed|delighted)\b/gi,
    '',
  );
  output = output.replace(/[ \t]{2,}/g, ' ');
  output = output
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•→]+|\d+[.)])\s+/g, '')
        .replace(/^>\s+/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');

  const nonEmptyLines = output.split('\n').filter(Boolean);

  if (nonEmptyLines.length > 1) {
    output = nonEmptyLines.join('\n\n');
  } else {
    const sentenceChunks = output
      .split(/(?<=[.!?])\s+(?=[A-Za-z0-9"'])/g)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    if (sentenceChunks.length > 1) {
      output = sentenceChunks.join('\n\n');
    }
  }

  output = normalizeDashCharacters(output);
  output = normalizePunctuationSpacing(output);
  return truncateAtNaturalBoundary(output, maxChars);
}

function normalizeDashCharacters(text: string): string {
  let output = normalize(text);
  // Strip typographic dashes to avoid LinkedIn-style punctuation in X output.
  output = output.replace(/\s*[—–]+\s*/g, ' - ');
  output = output.replace(/[ \t]{2,}/g, ' ');
  return normalize(output);
}

function normalizePunctuationSpacing(text: string): string {
  let output = normalize(text);
  output = output.replace(/\s+([,.;!?])/g, '$1');
  output = output.replace(/\s+([)\]}])/g, '$1');
  output = output.replace(/([([{])\s+/g, '$1');
  output = output.replace(/([.!?]["'”’])\s*[.!?]+/g, '$1');
  output = output.replace(/([.!?])\s+([,.;!?])/g, '$1');
  return normalize(output);
}

function normalizeSentenceCapitalization(text: string): string {
  const normalizedText = normalize(text);
  if (!normalizedText) {
    return '';
  }

  const chars = [...normalizedText];
  let capitalizeNext = true;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];

    if (capitalizeNext && /[a-z]/.test(char)) {
      chars[index] = char.toUpperCase();
      capitalizeNext = false;
      continue;
    }

    if (/[A-Za-z]/.test(char)) {
      capitalizeNext = false;
      continue;
    }

    if (char === '\n' || char === '!' || char === '?' || char === '.') {
      capitalizeNext = true;
    }
  }

  return chars.join('').replace(/\bi\b/g, 'I');
}

function applyCasePreference(text: string, lowercaseOnly: boolean): string {
  const normalized = normalize(text);
  if (!lowercaseOnly) {
    return normalizeSentenceCapitalization(normalized);
  }
  return normalized.toLowerCase();
}

function toModeFromLimit(xCharacterLimit: number): XMode {
  return xCharacterLimit <= X_STANDARD_CHAR_LIMIT ? 'unverified' : 'verified';
}

function trimToSingleInsightForUnverified(text: string, hardLimit: number): string {
  const normalized = normalize(text);
  if (!normalized) {
    return '';
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return '';
  }

  const triggerIndex = lines.findIndex((line) => UNVERIFIED_TRIGGER_PATTERN.test(line));
  const buildIndex = lines.findIndex((line) => UNVERIFIED_BUILD_PATTERN.test(line));

  const prioritized: string[] = [];
  if (buildIndex >= 0 && buildIndex !== triggerIndex) {
    prioritized.push(lines[buildIndex]);
  }
  if (triggerIndex >= 0) {
    prioritized.push(lines[triggerIndex]);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (prioritized.includes(line)) {
      continue;
    }
    prioritized.push(line);
  }

  const compactTarget = Math.min(240, hardLimit);
  let working = prioritized.slice(0, 3);
  let current = working.join('\n\n');

  while (working.length > 2 && current.length > compactTarget) {
    working.pop();
    current = working.join('\n\n');
  }

  while (working.length > 2 && current.length > hardLimit) {
    working.pop();
    current = working.join('\n\n');
  }

  if (current.length > hardLimit && working.length > 1) {
    const twoLine = working.slice(0, 2).join('\n\n');
    if (twoLine.length <= hardLimit) {
      current = twoLine;
    }
  }

  if (current.length > hardLimit) {
    current = truncateAtNaturalBoundary(current, hardLimit);
  }

  return normalize(current);
}

function reorderUnverifiedBuildBeforeTrigger(text: string): string {
  const lines = splitXParagraphLines(text);
  if (lines.length < 2) {
    return normalize(text);
  }

  const triggerIndex = lines.findIndex((line) => UNVERIFIED_TRIGGER_PATTERN.test(line));
  const buildIndex = lines.findIndex((line) => UNVERIFIED_BUILD_PATTERN.test(line));

  if (
    triggerIndex < 0 ||
    buildIndex < 0 ||
    triggerIndex === buildIndex ||
    buildIndex < triggerIndex
  ) {
    return normalize(lines.join('\n\n'));
  }

  const reordered = [
    lines[buildIndex],
    lines[triggerIndex],
    ...lines.filter((_, index) => index !== triggerIndex && index !== buildIndex),
  ];
  return normalize(reordered.join('\n\n'));
}

function sanitizeXOutputText(
  text: string,
  mode: XMode,
  xCharacterLimit: number,
  styleProfile: WritingStyleProfile,
  lowercaseOnly: boolean,
): string {
  let output = enforceOutputShape(text, xCharacterLimit);
  output = output.replace(/[ \t]{2,}/g, ' ').trim();

  if (styleProfile !== 'value_operator' || mode === 'unverified') {
    output = output
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•→]+|\d+[.)])\s+/g, '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  output = output.replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, '$1').trim();
  output = applyCasePreference(output, lowercaseOnly);
  output = normalizePunctuationSpacing(output);

  if (mode === 'unverified') {
    output = reorderUnverifiedBuildBeforeTrigger(output);
    output = trimToSingleInsightForUnverified(output, xCharacterLimit);
    if (output.length > xCharacterLimit) {
      output = truncateAtNaturalBoundary(output, xCharacterLimit);
    }
  }

  if (output.length > xCharacterLimit) {
    output = truncateAtNaturalBoundary(output, xCharacterLimit);
  }

  return normalize(output);
}

function stripCodeFence(text: string): string {
  const normalized = normalize(text).trim();
  if (!normalized) {
    return '';
  }
  return normalized.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseLlmTransformOutput(raw: string): LlmTransformOutput | null {
  const cleaned = stripCodeFence(raw);
  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<LlmTransformOutput>;
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      if (typeof parsed.x_post !== 'string') {
        continue;
      }

      const mode = parsed.mode === 'verified' ? 'verified' : 'unverified';
      const archetype = parseStyleProfile(parsed.archetype) ?? null;
      if (!archetype) {
        continue;
      }

      const bannedPhrasesFound = Array.isArray(parsed.banned_phrases_found)
        ? parsed.banned_phrases_found
            .filter((item): item is string => typeof item === 'string')
            .map((item) => normalize(item).trim())
            .filter(Boolean)
        : [];
      const editNotes = Array.isArray(parsed.edit_notes)
        ? parsed.edit_notes
            .filter((item): item is string => typeof item === 'string')
            .map((item) => normalize(item).trim())
            .filter(Boolean)
        : [];

      return {
        x_post: normalize(parsed.x_post),
        char_count:
          typeof parsed.char_count === 'number' && Number.isFinite(parsed.char_count)
            ? Math.max(0, Math.floor(parsed.char_count))
            : normalize(parsed.x_post).length,
        mode,
        archetype,
        structure_used:
          typeof parsed.structure_used === 'string'
            ? normalize(parsed.structure_used).trim()
            : getStructureBlueprint(archetype),
        banned_phrases_found: bannedPhrasesFound,
        edit_notes: editNotes,
      };
    } catch {
      // continue
    }
  }
  return null;
}

async function callGroq(
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
  },
): Promise<string> {
  const payloadBody: Record<string, unknown> = {
    model: GROQ_MODEL,
    temperature: 0.2,
    top_p: 0.9,
    messages,
  };

  if (typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens)) {
    payloadBody.max_tokens = Math.max(80, Math.floor(options.maxTokens));
  }

  const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify(payloadBody),
  });

  const payload = (await response.json()) as {
    error?: { message?: string };
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: string } | string>;
      };
    }>;
  };

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message || `Groq request failed (${response.status})`;
    throw new Error(errorMessage);
  }

  const messageContent = payload?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string' && messageContent.trim()) {
    return normalize(messageContent);
  }

  if (Array.isArray(messageContent)) {
    const text = messageContent
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
    if (text.trim()) {
      return normalize(text);
    }
  }

  throw new Error('Groq response did not include generated text');
}

async function extractFactsWithGroq(sourceText: string): Promise<string> {
  const heuristicFacts = extractFactCandidates(sourceText);
  const heuristicFactsBlock = formatFactsBlock(heuristicFacts);
  return heuristicFactsBlock || normalize(sourceText);
}

async function generateXDraftWithGroq(
  sourceText: string,
  referenceText: string,
  rewriteInstructions: string,
  styleProfile: WritingStyleProfile,
  isXVerified: boolean,
  xCharacterLimit: number,
  lowercaseOnly: boolean,
): Promise<string> {
  const currentPostText = normalize(sourceText);
  const groundingText = normalize(referenceText) || currentPostText;
  const isRewriteContext = currentPostText !== groundingText;
  const effectiveRewriteInstructions = rewriteInstructions.trim()
    ? rewriteInstructions
    : isRewriteContext
      ? 'Do a complete rewrite of current_post_text with fresh wording and structure. Keep facts grounded in original_linkedin_text. Do not return a near-duplicate of current_post_text.'
      : '';
  const mode: XMode = isXVerified ? 'verified' : 'unverified';
  const effectiveMaxOutputChars = Math.max(
    mode === 'unverified' ? 120 : 320,
    Math.min(xCharacterLimit, X_VERIFIED_CHAR_LIMIT),
  );
  const profileHint = getStyleProfileConfig(styleProfile);
  const fewShotMessages = getFewShotMessages(styleProfile);
  const factsBlock = await extractFactsWithGroq(groundingText);
  const structureBlueprint = getStructureBlueprint(styleProfile);
  const caseDirective = lowercaseOnly
    ? 'Lowercase-only mode is ON. Force full lowercase in x_post.'
    : 'Lowercase-only mode is OFF. Use normal capitalization unless archetype implies lowercase.';

  if (!GROQ_API_KEY) {
    const mock = createMockXDraft(
      currentPostText,
      effectiveRewriteInstructions,
      styleProfile,
      effectiveMaxOutputChars,
    );
    return sanitizeXOutputText(mock, mode, effectiveMaxOutputChars, styleProfile, lowercaseOnly);
  }

  const archetypeList = [
    'cracked_engineer',
    'value_operator',
    'builder_in_public',
    'community_builder',
    'thought_leader',
    'story_snap',
    'relatable',
    'signal_flex',
  ].join(' | ');

  const systemPrompt = [
    'You are an expert X (Twitter) native writer and cultural adapter.',
    'Your job is NOT to summarize LinkedIn posts.',
    'Your job is to transform long-form LinkedIn content into X-native posts that match platform culture and posting limits.',
    'Pipeline (must follow in order):',
    'Step 1 Infer Intent: classify into exactly one archetype.',
    `Allowed archetypes: ${archetypeList}.`,
    'Step 2 Apply Archetype Structure using exact structure blocks.',
    'cracked_engineer: all lowercase, 2-5 short lines, [sharp insight] [specific proof] [implied lesson].',
    'value_operator: [bold claim] - point - point - point [punchline] [engagement question].',
    'builder_in_public: [what happened] [metric] [lesson] [next step].',
    'community_builder: [community statement] [specific group or win] [shared mission] [open CTA].',
    'thought_leader: [strong POV] [why it matters] [conclusion].',
    'story_snap: [moment] [turning point] [lesson].',
    'relatable: [struggle] [honesty] [question].',
    'signal_flex: [result] [how it happened] [implication].',
    'Step 3 Length Mode:',
    'mode unverified: MUST be <= 280 chars, target <= 240, ultra concise, one main insight only.',
    'For unverified, prefer two-part causal flow: line 1 what you built/solution, line 2 trigger evidence.',
    'If trigger and build both exist, do build first, then trigger.',
    'Avoid long setup before saying what was built.',
    'Do not use opener pattern "I saw a comment that made me build...".',
    'Avoid "Now my extension..." framing.',
    'For unverified, preserve one concrete specific from source (named actor and/or number when present).',
    'Avoid vague openers like "someone", "people", or "users" when source provides specifics.',
    'mode verified: may exceed 280 chars, allow more bullets and depth but still X-native.',
    'When both original_linkedin_text and current_post_text are present, treat current_post_text as rewrite base and original_linkedin_text as facts authority.',
    'Step 4 Cultural Constraints (always enforce):',
    'Factuality is non-negotiable: never invent events, tests, experiments, launch claims, outcomes, or usage claims not present in linkedin_text.',
    'Do not use words like tested, experiment, validated, pilot unless the source explicitly contains that claim.',
    'No corporate language. No LinkedIn phrases. No hashtags. No motivational fluff.',
    'Do not use em dashes or en dashes.',
    'Avoid: excited to share, grateful, journey, lessons learned, thrilled, game changer.',
    'Use short lines, sharp POV, one clear idea, native X voice.',
    'Step 5 Compression Rules (if too long): delete backstory first, keep one metric/example, remove weakest line usually CTA, never remove main insight.',
    'Output JSON only with this schema:',
    '{ "x_post": "string", "char_count": number, "mode": "unverified | verified", "archetype": "...", "structure_used": "string", "banned_phrases_found": ["string"], "edit_notes": ["string"] }',
    'Always compute accurate char_count from x_post.',
    `Hard output cap: ${effectiveMaxOutputChars} chars for x_post.`,
    caseDirective,
    `Archetype hint from classifier: ${styleProfile}. Structure hint: ${structureBlueprint}.`,
    `Profile hint details: ${profileHint.profilePrompt}`,
    'Return valid JSON only. No markdown fences.',
  ].join(' ');

  const inputPayload = {
    original_linkedin_text: groundingText,
    current_post_text: currentPostText,
    mode,
  };

  const userPrompt = [
    'Input JSON:',
    JSON.stringify(inputPayload, null, 2),
    referenceText && normalize(referenceText) !== normalize(sourceText)
      ? `Reference source (facts authority):\n${groundingText}`
      : 'Reference source (facts authority):\n(same as input)',
    `Facts to preserve:\n${factsBlock || '(none)'}`,
    effectiveRewriteInstructions
      ? `Additional rewrite instructions:\n${effectiveRewriteInstructions}`
      : 'Additional rewrite instructions:\n(none)',
    'Now transform the input.',
  ].join('\n\n');

  const maxOutputTokens =
    mode === 'unverified'
      ? 260
      : Math.min(2200, Math.max(500, Math.ceil(effectiveMaxOutputChars / 2.8)));

  let bestCandidate = '';
  let bestArchetype: WritingStyleProfile = styleProfile;
  let lastViolations: string[] = [];

  for (let attempt = 0; attempt < MAX_STYLE_RETRIES + 1; attempt += 1) {
    const isRetry = attempt > 0;
    const retryMessages: ChatMessage[] = isRetry
      ? [
          {
            role: 'system',
            content: systemPrompt,
          },
          ...fewShotMessages,
          {
            role: 'user',
            content: [
              userPrompt,
              `Current candidate JSON:\n${bestCandidate || '(none)'}`,
              `Violations to fix:\n${
                lastViolations.length
                  ? lastViolations.map((v, idx) => `${idx + 1}. ${v}`).join('\n')
                  : '1. Return valid JSON with required schema.'
              }`,
              'Rewrite and return corrected JSON only.',
            ].join('\n\n'),
          },
        ]
      : [
          {
            role: 'system',
            content: systemPrompt,
          },
          ...fewShotMessages,
          {
            role: 'user',
            content: userPrompt,
          },
        ];

    const raw = await callGroq(retryMessages, {
      maxTokens: maxOutputTokens,
    });
    const parsed = parseLlmTransformOutput(raw);
    if (!parsed) {
      bestCandidate = raw;
      lastViolations = ['Model output was not valid JSON'];
      continue;
    }

    const parsedArchetype = parsed.archetype || styleProfile;
    let sanitizedPost = sanitizeXOutputText(
      parsed.x_post,
      mode,
      effectiveMaxOutputChars,
      parsedArchetype,
      lowercaseOnly,
    );
    sanitizedPost = enforceSourceClaimGuard(groundingText, sanitizedPost);
    const bannedPhrasesFound = detectBannedPhrases(sanitizedPost);
    const charCount = sanitizedPost.length;

    const output: LlmTransformOutput = {
      x_post: sanitizedPost,
      char_count: charCount,
      mode,
      archetype: parsedArchetype,
      structure_used: parsed.structure_used || getStructureBlueprint(parsedArchetype),
      banned_phrases_found: bannedPhrasesFound,
      edit_notes: parsed.edit_notes || [],
    };

    const violations = [
      ...detectStyleViolations(output.x_post, output.archetype, mode),
      ...detectNarrativeViolations(
        groundingText,
        output.x_post,
        output.archetype,
        effectiveMaxOutputChars,
      ),
      ...detectUnsupportedClaims(groundingText, output.x_post),
      ...detectRewriteSimilarityViolation(currentPostText, output.x_post, isRewriteContext),
    ];

    if (mode === 'unverified' && output.char_count > X_STANDARD_CHAR_LIMIT) {
      violations.push('Unverified output exceeded 280 characters');
    }
    if (mode === 'unverified' && output.char_count > 260 && !lowercaseOnly) {
      violations.push('Unverified output exceeded compact target length');
    }
    if (mode === 'verified' && output.char_count > X_VERIFIED_CHAR_LIMIT) {
      violations.push('Verified output exceeded 25k characters');
    }
    if (output.banned_phrases_found.length > 0) {
      violations.push(
        `Banned phrases found: ${output.banned_phrases_found.join(', ')}`,
      );
    }

    bestCandidate = JSON.stringify(output);
    bestArchetype = output.archetype;
    lastViolations = violations;

    if (!violations.length) {
      return output.x_post;
    }
  }

  const fallbackRaw = parseLlmTransformOutput(bestCandidate)?.x_post || sourceText;
  const fallback = sanitizeXOutputText(
    fallbackRaw,
    mode,
    effectiveMaxOutputChars,
    bestArchetype,
    lowercaseOnly,
  );
  const guardedFallback = enforceSourceClaimGuard(groundingText, fallback);
  if (mode === 'unverified') {
    const deterministic = buildDeterministicUnverifiedDraft(
      groundingText,
      effectiveMaxOutputChars,
      lowercaseOnly,
    );
    if (deterministic) {
      return deterministic;
    }
  }
  return guardedFallback;
}

function json(res: ServerResponse, statusCode: number, payload: XDraftResponse): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<XDraftRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    req.on('data', (chunk: unknown) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const parsed = raw ? (JSON.parse(raw) as XDraftRequestBody) : {};
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sanitizeSourceText(sourceText: string): string {
  return normalize(sourceText).slice(0, MAX_SOURCE_CHARS);
}

function sanitizeRewriteInstructions(value: string): string {
  return normalize(value).trim().slice(0, 600);
}

function sanitizeXCharacterLimit(
  value: unknown,
  isXVerified: boolean,
): number {
  const tierMax = isXVerified ? X_VERIFIED_CHAR_LIMIT : X_STANDARD_CHAR_LIMIT;
  const fallback = tierMax;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return fallback;
  }
  return Math.min(tierMax, rounded);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/x-draft') {
    json(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const body = await readJsonBody(req);

    const threadId =
      typeof body.threadId === 'string' && body.threadId.trim()
        ? body.threadId.trim()
        : 'unknown-thread';
    const sourceText = sanitizeSourceText(
      typeof body.sourceText === 'string' ? body.sourceText : '',
    );
    const referenceText = sanitizeSourceText(
      typeof body.referenceText === 'string' ? body.referenceText : '',
    );
    const groundingText = referenceText.trim() ? referenceText : sourceText;
    const rewriteInstructions = sanitizeRewriteInstructions(
      typeof body.rewriteInstructions === 'string' ? body.rewriteInstructions : '',
    );
    const isXVerified = Boolean(body.isXVerified);
    const lowercaseOnly = Boolean(body.lowercaseOnly);
    const bypassHashCache = Boolean(body.bypassHashCache);
    const xCharacterLimit = sanitizeXCharacterLimit(
      body.xCharacterLimit,
      isXVerified,
    );
    const requestedStyleProfile = parseStyleProfile(body.styleProfile);
    const styleProfile = resolveStyleProfile(
      requestedStyleProfile,
      groundingText,
      rewriteInstructions,
    );
    const force = Boolean(body.force);

    if (!sourceText.trim()) {
      json(res, 400, {
        ok: false,
        error: 'sourceText is required',
      });
      return;
    }

    const sourceHash =
      typeof body.sourceHash === 'string' && body.sourceHash.trim()
        ? body.sourceHash.trim()
        : sha256(sourceText);
    const rewriteHash = rewriteInstructions
      ? sha256(rewriteInstructions)
      : 'no-rewrite';
    const styleHash = sha256(styleProfile);
    const groundingHash = sha256(groundingText);
    const limitHash = sha256(`${isXVerified ? 'verified' : 'unverified'}:${xCharacterLimit}`);
    const caseHash = sha256(lowercaseOnly ? 'lowercase_only' : 'normal_caps');

    const cacheKey = `${threadId}:${sourceHash}:${groundingHash}:${rewriteHash}:${styleHash}:${limitHash}:${caseHash}:${GENERATION_PROMPT_VERSION}`;
    const cachedRecord = cacheByThreadAndHash.get(cacheKey);
    if (cachedRecord && !bypassHashCache) {
      json(res, 200, {
        ok: true,
        xText: cachedRecord.xText,
        sourceHash,
        cached: true,
        skipped: false,
        reason: `hash_cache_hit:${styleProfile}:${xCharacterLimit}`,
      });
      return;
    }

    const latestKey = `${threadId}:${groundingHash}:${rewriteHash}:${styleHash}:${limitHash}:${caseHash}:${GENERATION_PROMPT_VERSION}`;
    const lastRecord = latestByThreadAndRewrite.get(latestKey);
    if (
      !force &&
      lastRecord &&
      !isSignificantChange(lastRecord.sourceText, sourceText)
    ) {
      json(res, 200, {
        ok: true,
        xText: lastRecord.xText,
        sourceHash: lastRecord.sourceHash,
        cached: true,
        skipped: true,
        reason: `not_significant_change:${styleProfile}:${xCharacterLimit}`,
      });
      return;
    }

    const generatedXText = await generateXDraftWithGroq(
      sourceText,
      groundingText,
      rewriteInstructions,
      styleProfile,
      isXVerified,
      xCharacterLimit,
      lowercaseOnly,
    );
    const xText = applyCasePreference(
      enforceOutputShape(generatedXText, xCharacterLimit),
      lowercaseOnly,
    );
    const generatedAt = Date.now();
    const record: GenerationRecord = {
      threadId,
      sourceHash,
      sourceText,
      referenceText: groundingText,
      styleProfile,
      isXVerified,
      xCharacterLimit,
      lowercaseOnly,
      rewriteInstructions,
      xText,
      generatedAt,
    };

    cacheByThreadAndHash.set(cacheKey, record);
    latestByThreadAndRewrite.set(latestKey, record);

    json(res, 200, {
      ok: true,
      xText,
      sourceHash,
      cached: false,
      skipped: false,
      reason: GROQ_API_KEY
        ? `generated_with_groq:${styleProfile}:${xCharacterLimit}:${GENERATION_PROMPT_VERSION}`
        : `generated_mock_mode:${styleProfile}:${xCharacterLimit}:${GENERATION_PROMPT_VERSION}`,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unexpected backend error';
    json(res, 500, { ok: false, error: errorMessage });
  }
});

server.listen(PORT, () => {
  console.log(`[Stanley-X backend] listening on http://localhost:${PORT}`);
  if (!GROQ_API_KEY) {
    console.log(
      '[Stanley-X backend] GROQ_API_KEY is not set; running in mock generation mode.',
    );
  }
});

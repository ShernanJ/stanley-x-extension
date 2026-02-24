import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type WritingStyleProfile = 'cracked_engineer' | 'value_operator' | 'community';

type XDraftRequestBody = {
  threadId?: unknown;
  sourceText?: unknown;
  sourceHash?: unknown;
  styleProfile?: unknown;
  rewriteInstructions?: unknown;
  isXVerified?: unknown;
  xCharacterLimit?: unknown;
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
  styleProfile: WritingStyleProfile;
  isXVerified: boolean;
  xCharacterLimit: number;
  rewriteInstructions: string;
  xText: string;
  generatedAt: number;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
        'Tested LinkedIn-to-X rewriting.',
        '',
        'Same core message. Different delivery.',
        '',
        'The old draft sounded corporate.',
        '',
        'The new draft is tighter and lands better on X.',
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
        'Style profile: cracked engineer.',
        'Builder-first voice. Slightly irreverent. No corporate tone.',
        'Usually concise. Keep punchy lines.',
        'Lowercase style is preferred but not mandatory.',
      ].join(' '),
    minOutputChars: 180,
    minParagraphs: 3,
    maxParagraphs: 6,
    maxOutputChars: 700,
    preferLowercase: true,
  },
  value_operator: {
    id: 'value_operator',
    label: 'Value Operator',
    profilePrompt:
      [
        'Style profile: value operator.',
        'Keep practical depth and credible specifics.',
        'Explain what works and why in a tactical way.',
        'This profile can run longer than cracked engineer style.',
      ].join(' '),
    minOutputChars: 360,
    minParagraphs: 6,
    maxParagraphs: 10,
    maxOutputChars: 1100,
    requireTacticalDensity: true,
  },
  community: {
    id: 'community',
    label: 'Community',
    profilePrompt:
      [
        'Style profile: community.',
        'Friendly, collaborative, human voice.',
        'Still concise and direct, but warmer than value operator.',
      ].join(' '),
    minOutputChars: 250,
    minParagraphs: 4,
    maxParagraphs: 7,
    maxOutputChars: 900,
    preferFriendlyTone: true,
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
          'we tested a growth workflow and it worked.',
          '',
          'how it works:',
          '1) qualify users',
          '2) tighten activation',
          '3) retarget intent',
        ].join('\n'),
      target:
        [
          'Tested one growth workflow and kept the winning version.',
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
  community: [
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
  if (value === 'community') {
    return 'community';
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

  const crackedHints = [
    'cracked',
    'lower case',
    'lowercase',
    'operator mode',
    'shorter',
    'more concise',
    'tighter',
  ];
  const valueHints = [
    'value',
    'playbook',
    'framework',
    'tactical',
    'strategy',
    'operators',
    'informational',
  ];
  const communityHints = [
    'community',
    'friendly',
    'warmer',
    'relatable',
    'human',
    'conversational',
  ];

  if (crackedHints.some((hint) => normalized.includes(hint))) {
    return 'cracked_engineer';
  }
  if (communityHints.some((hint) => normalized.includes(hint))) {
    return 'community';
  }
  if (valueHints.some((hint) => normalized.includes(hint))) {
    return 'value_operator';
  }

  return null;
}

function inferStyleProfileFromSource(sourceText: string): WritingStyleProfile {
  const normalized = normalize(sourceText);
  const lowered = normalized.toLowerCase();
  const sourceLength = normalized.length;

  const metricsCount = (normalized.match(/\b\d+(?:\.\d+)?%?\b/g) || []).length;
  const tacticalCount = (
    lowered.match(
      /\b(playbook|framework|checklist|template|system|process|tactical|strategy|operators?)\b/g,
    ) || []
  ).length;
  const casualCount = (
    lowered.match(
      /\b(lol|lmao|ngl|idk|shipped|buildinpublic|vibe|wild|kinda|lowkey|highkey)\b/g,
    ) || []
  ).length;
  const communityCount = (
    lowered.match(
      /\b(community|people|friends|together|we|you|your|us|helping|support)\b/g,
    ) || []
  ).length;
  const emojiCount = (normalized.match(/[🎉🔥🚀✨💯😊😅👏🙏🛠️👀]/g) || []).length;

  const letters = normalized.replace(/[^A-Za-z]/g, '');
  const uppercaseCount = (letters.match(/[A-Z]/g) || []).length;
  const lowercaseRatio =
    letters.length > 0 ? (letters.length - uppercaseCount) / letters.length : 0.5;

  let crackedScore = 0;
  let valueScore = 0;
  let communityScore = 0;

  crackedScore += casualCount * 2;
  crackedScore += emojiCount > 0 ? 1 : 0;
  crackedScore += lowercaseRatio > 0.72 ? 1 : 0;
  crackedScore += sourceLength < 700 ? 1 : 0;

  valueScore += tacticalCount * 2;
  valueScore += metricsCount >= 2 ? 2 : metricsCount > 0 ? 1 : 0;
  valueScore += sourceLength > 700 ? 2 : 0;
  valueScore += /(how it works|why this matters|the problem)/i.test(normalized)
    ? 1
    : 0;

  communityScore += communityCount > 6 ? 2 : communityCount > 2 ? 1 : 0;
  communityScore += /(community|founders|builders|creators)/i.test(normalized) ? 1 : 0;

  if (valueScore >= crackedScore && valueScore >= communityScore) {
    return 'value_operator';
  }
  if (crackedScore >= communityScore) {
    return 'cracked_engineer';
  }
  return 'community';
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

  const linkedinisms = [
    /\b(excited|thrilled|grateful|humbled|honored|blessed|delighted)\b/,
    /\b(i'd love|would love|so proud|super excited)\b/,
    /\b(journey|incredible|amazing|game[- ]changer)\b/,
    /\b(why this matters|how it works|the problem)\b/,
    /\b(if you'?re .* this is for you)\b/,
    /[🎉🔥🚀✨💯😊😅👏🙏]/,
  ];

  return linkedinisms.some((pattern) => pattern.test(normalized));
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

function detectStyleViolations(text: string): string[] {
  const normalized = normalize(text);
  const violations: string[] = [];

  if (needsToneRetry(normalized)) {
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
  if (/(^|\n)\s*(?:[-*•→]+|\d+[.)])\s+/u.test(normalized)) {
    violations.push('Bullet or numbered list marker detected');
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
      ? 0.3
      : profileConfig.id === 'community'
        ? 0.36
        : 0.44;

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

function detectNarrativeViolations(
  sourceText: string,
  outputText: string,
  styleProfile: WritingStyleProfile,
): string[] {
  const source = normalize(sourceText);
  const output = normalize(outputText);
  const profileConfig = getStyleProfileConfig(styleProfile);
  const violations: string[] = [];
  const minOutputChars = getDynamicMinOutputChars(source, profileConfig);
  const paragraphBounds = getDynamicParagraphBounds(source, profileConfig);

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

  const anchors = extractImportantAnchors(source);
  const missingAnchors = anchors.filter((anchor) => {
    return !new RegExp(escapeRegExp(anchor), 'i').test(output);
  });
  if (missingAnchors.length >= 3) {
    violations.push(
      `Missing key specifics: ${missingAnchors.slice(0, 4).join(', ')}`,
    );
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

  if (profileConfig.requireTacticalDensity) {
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

  return violations;
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
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/g)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    if (sentenceChunks.length > 1) {
      output = sentenceChunks.join('\n\n');
    }
  }

  return truncateAtNaturalBoundary(output, maxChars);
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

  if (!GROQ_API_KEY) {
    return heuristicFactsBlock || normalize(sourceText);
  }

  try {
    const extracted = await callGroq([
      {
        role: 'system',
        content:
          [
            'Extract hard facts from a LinkedIn draft.',
            'Return plain text only.',
            'One fact per line.',
            `Max ${MAX_FACT_LINES} lines.`,
            'No bullets, no numbering, no hashtags, no emojis.',
            'No tone, no hype, no commentary.',
            'Keep specific names, numbers, and quoted lines if present.',
          ].join(' '),
      },
      {
        role: 'user',
        content: sourceText,
      },
    ]);

    const cleaned = extractFactCandidates(extracted);
    if (cleaned.length) {
      return formatFactsBlock(cleaned);
    }
  } catch {
    // Fall back to heuristic extraction.
  }

  return heuristicFactsBlock || normalize(sourceText);
}

async function generateXDraftWithGroq(
  sourceText: string,
  rewriteInstructions: string,
  styleProfile: WritingStyleProfile,
  isXVerified: boolean,
  xCharacterLimit: number,
): Promise<string> {
  const profileConfig = getStyleProfileConfig(styleProfile);
  const effectiveMaxOutputChars = Math.max(
    120,
    Math.min(xCharacterLimit, X_VERIFIED_CHAR_LIMIT),
  );
  const minOutputChars = Math.max(
    80,
    Math.min(
      getDynamicMinOutputChars(sourceText, profileConfig),
      Math.max(100, effectiveMaxOutputChars - 40),
    ),
  );
  const paragraphBounds = getDynamicParagraphBounds(sourceText, profileConfig);
  const maxOutputTokens = Math.max(
    180,
    Math.min(2000, Math.ceil(effectiveMaxOutputChars / 3.2)),
  );

  if (!GROQ_API_KEY) {
    return createMockXDraft(
      sourceText,
      rewriteInstructions,
      styleProfile,
      effectiveMaxOutputChars,
    );
  }

  const factsBlock = await extractFactsWithGroq(sourceText);
  const rewriteClause = rewriteInstructions
    ? `User rewrite instructions (highest priority): ${rewriteInstructions}`
    : 'No additional rewrite instructions were provided.';
  const strictFormatClause =
    [
      'Strict output format:',
      'Plain text only.',
      'No hashtags and no emojis.',
      'No bullets, numbered lists, or markdown markers.',
      `Use ${paragraphBounds.min}-${paragraphBounds.max} short paragraphs.`,
      'Each paragraph should be 1-2 sentences.',
      'Put a blank line between paragraphs.',
      `Target ${minOutputChars}-${effectiveMaxOutputChars} chars.`,
      'If close to the character limit, end early on a full sentence.',
      'Keep it tight, but do not collapse into a dry summary.',
    ].join(' ');
  const styleGuardClause =
    [
      'Never use LinkedIn scaffolding phrases like "How it works",',
      '"Why this matters", or "The problem".',
      'Never use motivational or celebratory voice.',
      `Account tier: ${isXVerified ? 'verified' : 'unverified'}.`,
      `Hard cap: ${effectiveMaxOutputChars} characters. Never exceed it.`,
    ].join(' ');
  const profileClause = profileConfig.profilePrompt;
  const narrativeArcClause =
    [
      'Keep a clear narrative arc:',
      '1) hook',
      '2) trigger or observation',
      '3) core problem',
      '4) what you built',
      '5) why it matters.',
      'Preserve concrete specifics from the source.',
    ].join(' ');
  const fewShotMessages = getFewShotMessages(styleProfile);
  const importantAnchors = extractImportantAnchors(sourceText);

  const primaryDraft = await callGroq([
    {
      role: 'system',
      content:
        [
          'You convert LinkedIn drafts into X-native writing using facts-first transformation.',
          'Tone target: serious, direct, stern, high-conviction.',
          'Use short declarative sentences and active voice.',
          'Start from the facts block. Keep intent and core facts. Remove LinkedIn framing.',
          profileClause,
          narrativeArcClause,
          styleGuardClause,
          strictFormatClause,
          'Do not compress this into generic statements.',
          'Keep the concrete setup, observation, and what was built.',
          `Keep output <= ${effectiveMaxOutputChars} characters.`,
          rewriteClause,
          'Return plain text only.',
        ].join(' '),
    },
    ...fewShotMessages,
    {
      role: 'user',
      content:
        [
          `FACTS:\n${factsBlock || '(none)'}`,
          `MUST_KEEP_SPECIFICS:\n${
            importantAnchors.length ? importantAnchors.join('\n') : '(none)'
          }`,
          `ORIGINAL_DRAFT:\n${sourceText}`,
          `REWRITE_INSTRUCTIONS:\n${rewriteInstructions || '(none)'}`,
        ].join('\n\n'),
    },
  ], {
    maxTokens: maxOutputTokens,
  });

  let candidate = enforceOutputShape(primaryDraft, effectiveMaxOutputChars);

  for (let attempt = 0; attempt < MAX_STYLE_RETRIES; attempt += 1) {
    const violations = [
      ...detectStyleViolations(candidate),
      ...detectNarrativeViolations(sourceText, candidate, styleProfile),
    ];
    if (!violations.length) {
      return candidate;
    }

    const retryDraft = await callGroq([
      {
        role: 'system',
        content:
          [
            'You are fixing an X draft that still sounds LinkedIn-coded.',
            'Rewrite with hard constraints and remove all listed violations.',
            'Keep only core facts and intent.',
            profileClause,
            narrativeArcClause,
            styleGuardClause,
            strictFormatClause,
            rewriteClause,
            `Keep output <= ${effectiveMaxOutputChars} characters.`,
            'Return plain text only.',
          ].join(' '),
      },
      ...fewShotMessages,
      {
        role: 'user',
        content:
          [
            `FACTS:\n${factsBlock || '(none)'}`,
            `MUST_KEEP_SPECIFICS:\n${
              importantAnchors.length ? importantAnchors.join('\n') : '(none)'
            }`,
            `ORIGINAL_DRAFT:\n${sourceText}`,
            `CURRENT_DRAFT_TO_FIX:\n${candidate}`,
            `VIOLATIONS_TO_REMOVE:\n${violations
              .map((item, index) => `${index + 1}. ${item}`)
              .join('\n')}`,
            `REWRITE_INSTRUCTIONS:\n${rewriteInstructions || '(none)'}`,
          ].join('\n\n'),
      },
    ], {
      maxTokens: maxOutputTokens,
    });

    candidate = enforceOutputShape(retryDraft, effectiveMaxOutputChars);
  }

  return candidate;
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
    const rewriteInstructions = sanitizeRewriteInstructions(
      typeof body.rewriteInstructions === 'string' ? body.rewriteInstructions : '',
    );
    const isXVerified = Boolean(body.isXVerified);
    const xCharacterLimit = sanitizeXCharacterLimit(
      body.xCharacterLimit,
      isXVerified,
    );
    const requestedStyleProfile = parseStyleProfile(body.styleProfile);
    const styleProfile = resolveStyleProfile(
      requestedStyleProfile,
      sourceText,
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
    const limitHash = sha256(`${isXVerified ? 'verified' : 'unverified'}:${xCharacterLimit}`);

    const cacheKey = `${threadId}:${sourceHash}:${rewriteHash}:${styleHash}:${limitHash}`;
    const cachedRecord = cacheByThreadAndHash.get(cacheKey);
    if (cachedRecord) {
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

    const latestKey = `${threadId}:${rewriteHash}:${styleHash}:${limitHash}`;
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

    const xText = await generateXDraftWithGroq(
      sourceText,
      rewriteInstructions,
      styleProfile,
      isXVerified,
      xCharacterLimit,
    );
    const generatedAt = Date.now();
    const record: GenerationRecord = {
      threadId,
      sourceHash,
      sourceText,
      styleProfile,
      isXVerified,
      xCharacterLimit,
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
        ? `generated_with_groq:${styleProfile}:${xCharacterLimit}`
        : `generated_mock_mode:${styleProfile}:${xCharacterLimit}`,
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

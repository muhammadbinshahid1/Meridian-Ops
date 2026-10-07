/**
 * Provider abstraction for draft generation. Switches on AI_PROVIDER so the
 * client's requested move to Claude is an env change, not a rewrite.
 *
 * Both providers are called over plain fetch, not their SDKs, so retry logic
 * can branch on a real HTTP status code rather than an unverified SDK error
 * shape.
 */

export class AIError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AIError';
    this.status = status;
  }
}

type Draft = { subject: string; body: string };

type TemplateContext = {
  name?: string | null;
  title?: string | null;
  company?: string | null;
  notes?: string | null;
  relationship?: string | null;
  match_note?: string | null;
};

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = ctx[key as keyof TemplateContext];
    return value ?? '';
  });
}

const DEFAULT_SUBJECT = 'Partnership inquiry';

/**
 * Parses the model's JSON reply, stripping markdown fences first. If the
 * model didn't return valid JSON, the whole response becomes the body with a
 * default subject — a formatting slip degrades instead of failing outright.
 */
function parseDraft(text: string): Draft {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
      const subject =
        typeof parsed.subject === 'string' && parsed.subject.trim()
          ? parsed.subject.trim()
          : DEFAULT_SUBJECT;
      return { subject, body: parsed.body.trim() };
    }
  } catch {
    // Not valid JSON — fall through and treat the raw text as the body.
  }

  return { subject: DEFAULT_SUBJECT, body: stripped };
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFFS_MS = [500, 1000, 2000];
const TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function describeErrorResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message || json?.message;
    if (message) return `${res.status}: ${message}`;
  } catch {
    // Not JSON — fall through to raw text.
  }
  return `${res.status}: ${text.slice(0, 300) || res.statusText}`;
}

/**
 * Fetches with a per-attempt timeout and bounded retry. Retries only on
 * 408/429/500/502/503/504, up to 3 attempts total, with exponential backoff
 * (500ms / 1s / 2s) plus jitter. 400 and 401 never retry.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: AIError = new AIError('The AI provider could not be reached.');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) return res;

      const message = await describeErrorResponse(res);
      const error = new AIError(message, res.status);

      if (res.status === 400 || res.status === 401 || !RETRYABLE_STATUSES.has(res.status)) {
        throw error;
      }
      lastError = error;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AIError) {
        if (err.status === 400 || err.status === 401 || (err.status !== undefined && !RETRYABLE_STATUSES.has(err.status))) {
          throw err;
        }
        lastError = err;
      } else if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = new AIError('The request to the AI provider timed out.');
      } else {
        throw err;
      }
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(BACKOFFS_MS[attempt] + Math.random() * 250);
    }
  }

  throw lastError;
}

/**
 * *-latest aliases hot-swap the underlying model without notice — do not use
 * one of these as a default before a client demo.
 */
async function callGemini(prompt: string): Promise<Draft> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AIError('GEMINI_API_KEY is not set.');
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p: { text?: string }) => p?.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new AIError(
      `Gemini returned an empty response (finishReason: ${candidate?.finishReason ?? 'unknown'}).`
    );
  }

  return parseDraft(text);
}

async function callAnthropic(prompt: string): Promise<Draft> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIError('ANTHROPIC_API_KEY is not set.');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const json = await res.json();
  const text = (json?.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('')
    .trim();

  if (!text) {
    throw new AIError(
      `Claude returned an empty response (stop_reason: ${json?.stop_reason ?? 'unknown'}).`
    );
  }

  return parseDraft(text);
}

export async function generateDraft(prompt: string): Promise<Draft> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

  if (provider === 'anthropic') return callAnthropic(prompt);
  if (provider === 'gemini') return callGemini(prompt);

  throw new AIError(`Unknown AI_PROVIDER "${provider}". Use "gemini" or "anthropic".`);
}

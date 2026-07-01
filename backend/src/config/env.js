import 'dotenv/config';
import { isValidPort, isOneOf, isNonEmptyString } from '../shared/validators/common.validator.js';

// Reads environment variables, validates them, and exports a single config
// object. Fails fast with a clear message if anything is invalid, so the app
// never starts in a misconfigured state. No secrets are hardcoded here.

const VALID_ENVIRONMENTS = ['development', 'production', 'test'];
const VALID_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const VALID_CHAT_MODES = ['groq_first', 'retrieval_only'];

const DEFAULT_WIDGET_ORIGINS =
  'http://localhost:3000,http://localhost:5173,http://127.0.0.1:5500,https://easepetvet.com,https://www.easepetvet.com';

// Resolves embedding model/dimension/baseUrl/apiKey from the active provider.
// OpenAI is the active provider; Gemini stays supported as legacy.
function loadEmbeddingProviderConfig(provider) {
  if (provider === 'openai') {
    return {
      model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      dimension: process.env.OPENAI_EMBEDDING_DIMENSIONS ?? '768',
      baseUrl: process.env.OPENAI_EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    };
  }
  if (provider === 'gemini') {
    return {
      model: process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001',
      dimension: process.env.EMBEDDING_DIMENSION ?? '768',
      baseUrl: process.env.EMBEDDING_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: process.env.GEMINI_API_KEY ?? '',
    };
  }
  return {
    model: process.env.EMBEDDING_MODEL ?? '',
    dimension: process.env.EMBEDDING_DIMENSION ?? '768',
    baseUrl: process.env.EMBEDDING_BASE_URL ?? '',
    apiKey: '',
  };
}

function loadConfig() {
  const port = process.env.PORT ?? '3000';
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const logLevel = process.env.LOG_LEVEL ?? 'info';

  const pgHost = process.env.PGHOST;
  const pgPort = process.env.PGPORT ?? '5432';
  const pgUser = process.env.PGUSER;
  const pgPassword = process.env.PGPASSWORD;
  const pgDatabase = process.env.PGDATABASE;

  const crawlDelayMs = process.env.CRAWL_DELAY_MS ?? '10000';
  const crawlTimeoutMs = process.env.CRAWL_TIMEOUT_MS ?? '15000';
  const crawlUserAgent = process.env.CRAWL_USER_AGENT ?? 'EasePetVetBot/0.1';

  // Embedding config. Provider-aware. The API key is intentionally NOT required
  // here so the backend and full-text retrieval keep working without it; the
  // provider validates the key only when embeddings are actually used.
  const embeddingProvider = process.env.EMBEDDING_PROVIDER ?? 'openai';
  const embeddingTimeoutMs = process.env.EMBEDDING_TIMEOUT_MS ?? '20000';
  const providerCfg = loadEmbeddingProviderConfig(embeddingProvider);
  const embeddingModel = providerCfg.model;
  const embeddingDimension = providerCfg.dimension;
  const embeddingBaseUrl = providerCfg.baseUrl;
  const embeddingApiKey = providerCfg.apiKey;
  const embeddingBatchSize = process.env.EMBEDDING_BATCH_SIZE ?? '10';
  const embeddingMaxRetries = process.env.EMBEDDING_MAX_RETRIES ?? '3';
  const embeddingBatchDelayMs = process.env.EMBEDDING_BATCH_DELAY_MS ?? '5000';
  const embeddingMinCoverage = process.env.EMBEDDING_MIN_COVERAGE ?? '0.95';
  const embeddingMinScore = process.env.EMBEDDING_MIN_SCORE ?? '0.65';

  // Chat config. retrieval_only disables the AI chain; otherwise the hardcoded
  // provider chain (groq -> gemini -> openrouter -> ollama) is tried in order.
  // Every provider key is optional; providers without a key are skipped.
  const chatAnswerMode = process.env.CHAT_ANSWER_MODE ?? 'groq_first';
  // Shared generation params (CHAT_* with GROQ_* fallback for compatibility).
  const chatMaxTokens = process.env.CHAT_MAX_COMPLETION_TOKENS ?? process.env.GROQ_MAX_COMPLETION_TOKENS ?? '400';
  const chatTemperature = process.env.CHAT_TEMPERATURE ?? process.env.GROQ_TEMPERATURE ?? '0.2';
  const chatTimeoutMs = process.env.CHAT_TIMEOUT_MS ?? process.env.GROQ_TIMEOUT_MS ?? '20000';
  const chatProviders = {
    groq: {
      apiKey: process.env.GROQ_API_KEY ?? '',
      baseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      model: process.env.GROQ_CHAT_MODEL ?? 'llama-3.3-70b-versatile',
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY ?? '',
      baseUrl: process.env.GEMINI_CHAT_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      // gemini-2.5-flash: gemini-2.0-flash lost free-tier quota (returns 429
      // limit:0), while 2.5-flash still has a free daily allowance.
      model: process.env.GEMINI_CHAT_MODEL ?? 'gemini-2.5-flash',
    },
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_CHAT_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free',
    },
    ollama: {
      apiKey: process.env.OLLAMA_API_KEY ?? '',
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'https://ollama.com/v1',
      model: process.env.OLLAMA_CHAT_MODEL ?? 'gpt-oss:20b',
    },
  };
  const widgetAllowedOrigins = (process.env.CHAT_WIDGET_ALLOWED_ORIGINS ?? DEFAULT_WIDGET_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const errors = [];

  if (!isValidPort(port)) {
    errors.push(`PORT must be an integer between 1 and 65535 (received "${port}")`);
  }
  if (!isOneOf(nodeEnv, VALID_ENVIRONMENTS)) {
    errors.push(`NODE_ENV must be one of ${VALID_ENVIRONMENTS.join(', ')} (received "${nodeEnv}")`);
  }
  if (!isOneOf(logLevel, VALID_LOG_LEVELS)) {
    errors.push(`LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(', ')} (received "${logLevel}")`);
  }
  // A single DATABASE_URL (e.g. Render/managed Postgres) is an accepted
  // alternative to the individual PG* vars. Only require PG* when it's absent.
  const hasDatabaseUrl = isNonEmptyString(process.env.DATABASE_URL);
  if (!hasDatabaseUrl) {
    if (!isNonEmptyString(pgHost)) {
      errors.push('PGHOST is required (or set DATABASE_URL)');
    }
    if (!isValidPort(pgPort)) {
      errors.push(`PGPORT must be an integer between 1 and 65535 (received "${pgPort}")`);
    }
    if (!isNonEmptyString(pgUser)) {
      errors.push('PGUSER is required (or set DATABASE_URL)');
    }
    if (!isNonEmptyString(pgPassword)) {
      errors.push('PGPASSWORD is required (or set DATABASE_URL)');
    }
    if (!isNonEmptyString(pgDatabase)) {
      errors.push('PGDATABASE is required (or set DATABASE_URL)');
    }
  }
  if (!Number.isInteger(Number(crawlDelayMs)) || Number(crawlDelayMs) < 0) {
    errors.push(`CRAWL_DELAY_MS must be an integer >= 0 (received "${crawlDelayMs}")`);
  }
  if (!Number.isInteger(Number(crawlTimeoutMs)) || Number(crawlTimeoutMs) <= 0) {
    errors.push(`CRAWL_TIMEOUT_MS must be an integer > 0 (received "${crawlTimeoutMs}")`);
  }
  if (!isNonEmptyString(crawlUserAgent)) {
    errors.push('CRAWL_USER_AGENT must be a non-empty string');
  }
  if (!isNonEmptyString(embeddingProvider)) {
    errors.push('EMBEDDING_PROVIDER must be a non-empty string');
  }
  if (!isNonEmptyString(embeddingModel)) {
    errors.push(`Embedding model is required for provider "${embeddingProvider}"`);
  }
  if (!Number.isInteger(Number(embeddingDimension)) || Number(embeddingDimension) <= 0) {
    errors.push(`Embedding dimension must be an integer > 0 (received "${embeddingDimension}")`);
  }
  if (!isNonEmptyString(embeddingBaseUrl)) {
    errors.push(`Embedding base URL is required for provider "${embeddingProvider}"`);
  }
  if (!Number.isInteger(Number(embeddingTimeoutMs)) || Number(embeddingTimeoutMs) <= 0) {
    errors.push(`EMBEDDING_TIMEOUT_MS must be an integer > 0 (received "${embeddingTimeoutMs}")`);
  }
  if (!Number.isInteger(Number(embeddingBatchSize)) || Number(embeddingBatchSize) < 1) {
    errors.push(`EMBEDDING_BATCH_SIZE must be an integer >= 1 (received "${embeddingBatchSize}")`);
  }
  if (!Number.isInteger(Number(embeddingMaxRetries)) || Number(embeddingMaxRetries) < 0) {
    errors.push(`EMBEDDING_MAX_RETRIES must be an integer >= 0 (received "${embeddingMaxRetries}")`);
  }
  if (!Number.isInteger(Number(embeddingBatchDelayMs)) || Number(embeddingBatchDelayMs) < 0) {
    errors.push(`EMBEDDING_BATCH_DELAY_MS must be an integer >= 0 (received "${embeddingBatchDelayMs}")`);
  }
  if (!Number.isFinite(Number(embeddingMinCoverage)) || Number(embeddingMinCoverage) < 0 || Number(embeddingMinCoverage) > 1) {
    errors.push(`EMBEDDING_MIN_COVERAGE must be a number between 0 and 1 (received "${embeddingMinCoverage}")`);
  }
  if (!Number.isFinite(Number(embeddingMinScore)) || Number(embeddingMinScore) < 0 || Number(embeddingMinScore) > 1) {
    errors.push(`EMBEDDING_MIN_SCORE must be a number between 0 and 1 (received "${embeddingMinScore}")`);
  }
  if (!isOneOf(chatAnswerMode, VALID_CHAT_MODES)) {
    errors.push(`CHAT_ANSWER_MODE must be one of ${VALID_CHAT_MODES.join(', ')} (received "${chatAnswerMode}")`);
  }
  if (!Number.isInteger(Number(chatMaxTokens)) || Number(chatMaxTokens) <= 0) {
    errors.push(`CHAT max completion tokens must be an integer > 0 (received "${chatMaxTokens}")`);
  }
  if (!Number.isFinite(Number(chatTemperature)) || Number(chatTemperature) < 0 || Number(chatTemperature) > 2) {
    errors.push(`CHAT temperature must be a number between 0 and 2 (received "${chatTemperature}")`);
  }
  if (!Number.isInteger(Number(chatTimeoutMs)) || Number(chatTimeoutMs) <= 0) {
    errors.push(`CHAT timeout must be an integer > 0 (received "${chatTimeoutMs}")`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return {
    port: Number(port),
    nodeEnv,
    logLevel,
    db: {
      host: pgHost,
      port: Number(pgPort),
      user: pgUser,
      password: pgPassword,
      database: pgDatabase,
    },
    crawl: {
      delayMs: Number(crawlDelayMs),
      timeoutMs: Number(crawlTimeoutMs),
      userAgent: crawlUserAgent,
    },
    embedding: {
      provider: embeddingProvider,
      model: embeddingModel,
      dimension: Number(embeddingDimension),
      baseUrl: embeddingBaseUrl,
      apiKey: embeddingApiKey,
      timeoutMs: Number(embeddingTimeoutMs),
      batchSize: Number(embeddingBatchSize),
      maxRetries: Number(embeddingMaxRetries),
      batchDelayMs: Number(embeddingBatchDelayMs),
      minCoverage: Number(embeddingMinCoverage),
      minScore: Number(embeddingMinScore),
    },
    chat: {
      answerMode: chatAnswerMode,
      maxTokens: Number(chatMaxTokens),
      temperature: Number(chatTemperature),
      timeoutMs: Number(chatTimeoutMs),
      providers: chatProviders,
      widgetAllowedOrigins,
      // Per-conversation message limits + optional in-chat email prompt cadence.
      maxMessageChars: Number(process.env.CHAT_MAX_MESSAGE_CHARS ?? '800'),
      maxMessageWords: Number(process.env.CHAT_MAX_MESSAGE_WORDS ?? '120'),
      conversationMessageLimit: Number(process.env.CHAT_CONVERSATION_MESSAGE_LIMIT ?? '20'),
      limitWarningAt: Number(process.env.CHAT_LIMIT_WARNING_AT ?? '3'),
      emailPromptAfterFirst: (process.env.CHAT_EMAIL_PROMPT_AFTER_FIRST ?? 'true').toLowerCase() === 'true',
      emailPromptInterval: Number(process.env.CHAT_EMAIL_PROMPT_INTERVAL ?? '5'),
      supportEmail: process.env.CHAT_SUPPORT_EMAIL ?? 'support@easepetvet.com',
      // Recent conversation turns passed to retrieval + the LLM as memory. 0
      // disables memory (single-turn behaviour). Capped at 20 in the repository.
      historyTurns: Number(process.env.CHAT_HISTORY_TURNS ?? '8'),
    },
    // Admin dashboard. All optional: a missing token simply leaves the admin
    // dashboard "not configured" (routes return 503) without affecting startup.
    admin: {
      token: process.env.ADMIN_DASHBOARD_TOKEN ?? '',
      timezone: process.env.ADMIN_DASHBOARD_TIMEZONE ?? 'America/Chicago',
      sync: {
        autoEnabled: (process.env.ADMIN_SYNC_AUTO_ENABLED ?? 'false').toLowerCase() === 'true',
        intervalDays: Number(process.env.ADMIN_SYNC_INTERVAL_DAYS ?? '30'),
        runHour: Number(process.env.ADMIN_SYNC_RUN_HOUR ?? '2'),
        runMinute: Number(process.env.ADMIN_SYNC_RUN_MINUTE ?? '0'),
      },
    },
  };
}

export const config = loadConfig();

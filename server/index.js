#!/usr/bin/env node

/**
 * Forvo Pronunciation MCP Server
 *
 * Exposes the Forvo pronunciation API as MCP tools.
 * Provides native speaker pronunciations for words in 430+ languages.
 * Designed for integration with Anki flashcard workflows.
 *
 * Environment:
 *   FORVO_API_KEY — your Forvo API key (required)
 *
 * Transport: stdio (MCPB standard)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "node:https";
import http from "node:http";

// ── Configuration ──────────────────────────────────────────────

const FORVO_API_KEY = process.env.FORVO_API_KEY || "";
const FORVO_BASE_URL = "https://apifree.forvo.com";
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || "ja";
const HTTP_TIMEOUT_MS = 15_000;

// ── Logging ────────────────────────────────────────────────────

function log(level, message, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined && { data }),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ── HTTP helpers ───────────────────────────────────────────────

/**
 * Build a Forvo REST-style URL from action and key-value params.
 */
function buildUrl(action, params = {}) {
  if (!FORVO_API_KEY) {
    throw new Error(
      "FORVO_API_KEY environment variable is not set. " +
        "Get your key at https://api.forvo.com/plans-and-pricing/"
    );
  }
  const parts = [
    FORVO_BASE_URL,
    `key/${FORVO_API_KEY}`,
    "format/json",
    `action/${action}`,
  ];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      parts.push(`${k}/${v}`);
    }
  }
  return parts.join("/");
}

/**
 * Raw HTTPS GET request — bypasses fetch() which in Claude Desktop's runtime
 * sends Referer/Origin headers that Forvo rejects as "incorrect domain".
 * Using node:https gives us full control over headers.
 */
function rawGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "Accept": "application/json" } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        rawGet(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, statusMessage: res.statusMessage, buffer });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
  });
}

/**
 * Make a GET request to the Forvo API with timeout and error handling.
 */
async function forvoRequest(action, params = {}) {
  const url = buildUrl(action, params);
  log("debug", `Forvo API request: ${action}`, { params });

  const { status, statusMessage, buffer } = await rawGet(url);
  const body = buffer.toString("utf-8");

  if (status < 200 || status >= 300) {
    throw new Error(
      `Forvo API error: ${status} ${statusMessage}${body ? ` — ${body}` : ""}`
    );
  }

  return JSON.parse(body);
}

/**
 * Download audio from a URL and return as Buffer.
 */
async function downloadAudio(url) {
  const { status, buffer } = await rawGet(url);
  if (status < 200 || status >= 300) {
    throw new Error(`Audio download failed: ${status}`);
  }
  return buffer;
}

// ── Input validation ───────────────────────────────────────────

function validateString(value, name, { minLen = 1, maxLen = 200 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    throw new Error(
      `${name} must be between ${minLen} and ${maxLen} characters`
    );
  }
  return trimmed;
}

function validateLanguage(value) {
  if (value === undefined || value === null) return DEFAULT_LANGUAGE;
  const lang = String(value).trim();
  if (lang.length < 2 || lang.length > 5) {
    throw new Error("language must be a 2-5 character code (e.g. 'ja', 'en')");
  }
  return lang;
}

function validateSex(value) {
  if (value === undefined || value === null) return undefined;
  if (value !== "m" && value !== "f") {
    throw new Error("sex must be 'm' or 'f'");
  }
  return value;
}

function validateOrder(value, allowed) {
  if (value === undefined || value === null) return allowed[0];
  if (!allowed.includes(value)) {
    throw new Error(`order must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function validateInt(value, name, { min = 1, max = 50, defaultVal } = {}) {
  if (value === undefined || value === null) return defaultVal;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
  {
    name: "forvo_word_pronunciations",
    description:
      "Get all available pronunciations for a word from Forvo. " +
      "Returns a list of pronunciations with metadata (speaker, country, sex, rating, audio URLs). " +
      "Audio URLs are valid for ~2 hours.",
    inputSchema: {
      type: "object",
      properties: {
        word: {
          type: "string",
          description: "The word to get pronunciations for",
          minLength: 1,
          maxLength: 200,
        },
        language: {
          type: "string",
          description:
            "Language code (e.g. 'ja' for Japanese, 'en' for English, 'ru' for Russian). Defaults to '" +
            DEFAULT_LANGUAGE +
            "'",
          minLength: 2,
          maxLength: 5,
        },
        country: {
          type: "string",
          description:
            "ISO 3166-1 Alpha-3 country code to filter by (e.g. 'JPN', 'USA')",
          minLength: 3,
          maxLength: 3,
        },
        sex: {
          type: "string",
          description: "Filter by sex: 'm' for male, 'f' for female",
          enum: ["m", "f"],
        },
        min_rate: {
          type: "integer",
          description: "Minimum rating (0-5) to filter pronunciations",
          minimum: 0,
          maximum: 5,
        },
        order: {
          type: "string",
          description: "Sort order",
          enum: ["rate-desc", "rate-asc", "date-desc", "date-asc"],
          default: "rate-desc",
        },
        limit: {
          type: "integer",
          description: "Maximum number of pronunciations to return (1-50)",
          minimum: 1,
          maximum: 50,
          default: 5,
        },
      },
      required: ["word"],
    },
  },
  {
    name: "forvo_standard_pronunciation",
    description:
      "Get the single best (top-rated) pronunciation for a word from Forvo. " +
      "Returns the highest-rated pronunciation with audio URLs.",
    inputSchema: {
      type: "object",
      properties: {
        word: {
          type: "string",
          description: "The word to get the best pronunciation for",
          minLength: 1,
          maxLength: 200,
        },
        language: {
          type: "string",
          description: "Language code (e.g. 'ja', 'en', 'ru')",
          minLength: 2,
          maxLength: 5,
        },
      },
      required: ["word"],
    },
  },
  {
    name: "forvo_download_pronunciation",
    description:
      "Download the best pronunciation audio for a word as base64-encoded MP3. " +
      "Returns base64 audio data that can be directly used with Anki's store_media_file tool.",
    inputSchema: {
      type: "object",
      properties: {
        word: {
          type: "string",
          description: "The word to download pronunciation for",
          minLength: 1,
          maxLength: 200,
        },
        language: {
          type: "string",
          description: "Language code (e.g. 'ja', 'en', 'ru')",
          minLength: 2,
          maxLength: 5,
        },
        sex: {
          type: "string",
          description: "Preferred sex: 'm' for male, 'f' for female",
          enum: ["m", "f"],
        },
      },
      required: ["word"],
    },
  },
  {
    name: "forvo_search_words",
    description:
      "Search for words that have been pronounced on Forvo. " +
      "Useful for checking if a word exists before requesting its pronunciation.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Search query",
          minLength: 1,
          maxLength: 200,
        },
        language: {
          type: "string",
          description: "Language code to filter results",
          minLength: 2,
          maxLength: 5,
        },
        limit: {
          type: "integer",
          description: "Maximum number of results (1-50)",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ["search"],
    },
  },
  {
    name: "forvo_language_list",
    description:
      "Get a list of languages available on Forvo with pronunciation counts.",
    inputSchema: {
      type: "object",
      properties: {
        min_pronunciations: {
          type: "integer",
          description:
            "Minimum pronunciations a language must have to be listed",
          minimum: 0,
          default: 100,
        },
        order: {
          type: "string",
          description: "Sort by: 'name' or 'code'",
          enum: ["name", "code"],
          default: "name",
        },
      },
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────

async function handleWordPronunciations(args) {
  const word = validateString(args.word, "word");
  const language = validateLanguage(args.language);
  const sex = validateSex(args.sex);
  const order = validateOrder(args.order, [
    "rate-desc",
    "rate-asc",
    "date-desc",
    "date-asc",
  ]);
  const limit = validateInt(args.limit, "limit", {
    min: 1,
    max: 50,
    defaultVal: 5,
  });
  const minRate = validateInt(args.min_rate, "min_rate", {
    min: 0,
    max: 5,
    defaultVal: undefined,
  });

  const params = { word, language, order, limit };
  if (args.country) {
    const country = validateString(args.country, "country", {
      minLen: 3,
      maxLen: 3,
    });
    params.country = country;
  }
  if (sex) params.sex = sex;
  if (minRate !== undefined) params.rate = minRate;

  const data = await forvoRequest("word-pronunciations", params);
  const items = data.items || [];

  if (items.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No pronunciations found for '${word}' in language '${language}'`,
        },
      ],
    };
  }

  const results = items.map((item) => ({
    id: item.id,
    word: item.original || word,
    username: item.username,
    sex: item.sex,
    country: item.country,
    pathmp3: item.pathmp3,
    pathogg: item.pathogg,
    rate: item.rate,
    num_votes: item.num_votes,
    num_positive_votes: item.num_positive_votes,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { word, language, count: results.length, items: results },
          null,
          2
        ),
      },
    ],
  };
}

async function handleStandardPronunciation(args) {
  const word = validateString(args.word, "word");
  const language = validateLanguage(args.language);

  const data = await forvoRequest("standard-pronunciation", { word, language });
  const items = data.items || [];

  if (items.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No standard pronunciation found for '${word}' in '${language}'`,
        },
      ],
    };
  }

  const best = items[0];
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            word,
            language,
            username: best.username,
            sex: best.sex,
            country: best.country,
            pathmp3: best.pathmp3,
            pathogg: best.pathogg,
            rate: best.rate,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleDownloadPronunciation(args) {
  const word = validateString(args.word, "word");
  const language = validateLanguage(args.language);
  const sex = validateSex(args.sex);

  // Get pronunciations sorted by rating
  const params = { word, language, order: "rate-desc", limit: 5 };
  const data = await forvoRequest("word-pronunciations", params);

  let items = data.items || [];
  if (items.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No pronunciations found for '${word}' in '${language}'`,
        },
      ],
    };
  }

  // Filter by sex if specified
  if (sex) {
    const filtered = items.filter((i) => i.sex === sex);
    if (filtered.length > 0) items = filtered;
  }

  const best = items[0];
  const audioUrl = best.pathmp3 || best.pathogg;

  if (!audioUrl) {
    return {
      content: [
        {
          type: "text",
          text: `No audio URL available for '${word}'`,
        },
      ],
    };
  }

  // Download the audio
  const audioBuffer = await downloadAudio(audioUrl);
  const audioBase64 = audioBuffer.toString("base64");
  const format = audioUrl.includes("mp3") ? "mp3" : "ogg";

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            word,
            language,
            audio_base64: audioBase64,
            format,
            size_bytes: audioBuffer.length,
            username: best.username,
            sex: best.sex,
            country: best.country,
            rate: best.rate,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleSearchWords(args) {
  const search = validateString(args.search, "search");
  const language = validateLanguage(args.language);
  const limit = validateInt(args.limit, "limit", {
    min: 1,
    max: 50,
    defaultVal: 10,
  });

  const data = await forvoRequest("pronounced-words-search", {
    search,
    language,
    limit,
  });
  const items = data.items || [];

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            search,
            language,
            count: items.length,
            items: items.map((item) => ({
              word: item.original || item.word || "",
              language: item.language,
              num_pronunciations: item.num_pronunciations,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleLanguageList(args) {
  const order = validateOrder(args.order, ["name", "code"]);
  const minPronunciations = validateInt(
    args.min_pronunciations,
    "min_pronunciations",
    { min: 0, max: 999999, defaultVal: 100 }
  );

  const params = { order };
  if (minPronunciations !== undefined) {
    params["min-pronunciations"] = minPronunciations;
  }

  const data = await forvoRequest("language-list", params);
  const items = data.items || [];

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total: items.length,
            items: items.map((item) => ({
              code: item.code,
              name: item.en,
              pronunciations: item.pronunciations,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

// ── Tool dispatch ──────────────────────────────────────────────

const TOOL_HANDLERS = {
  forvo_word_pronunciations: handleWordPronunciations,
  forvo_standard_pronunciation: handleStandardPronunciation,
  forvo_download_pronunciation: handleDownloadPronunciation,
  forvo_search_words: handleSearchWords,
  forvo_language_list: handleLanguageList,
};

// ── Server setup ───────────────────────────────────────────────

const server = new Server(
  {
    name: "forvo-pronunciation",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    return await handler(args);
  } catch (err) {
    log("error", `Tool ${name} failed`, { error: err.message });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: err.message, tool: name },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// ── Start ──────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "Forvo Pronunciation MCP server running on stdio", {
  api_key_set: !!FORVO_API_KEY,
  api_key_prefix: FORVO_API_KEY ? FORVO_API_KEY.slice(0, 6) + "..." : "MISSING",
  base_url: FORVO_BASE_URL,
});
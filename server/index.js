#!/usr/bin/env node

/**
 * Japanese Audio MCP Server
 *
 * Downloads native speaker pronunciation audio from JapanesePod101.
 * No API key required. Returns base64-encoded MP3 for Anki integration.
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

// ── Configuration ──────────────────────────────────────────────

const AUDIO_BASE_URL =
  "https://assets.languagepod101.com/dictionary/japanese/audiomp3.php";
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

// ── HTTP helper ────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) });
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
 * Download audio for a single word. Returns { audio_base64, size_bytes } or throws.
 */
async function fetchAudio(kanji, kana) {
  const params = new URLSearchParams({ kanji, kana });
  const url = `${AUDIO_BASE_URL}?${params}`;

  log("debug", "Downloading audio", { kanji, kana, url });

  const { status, buffer } = await httpsGet(url);

  if (status < 200 || status >= 300) {
    throw new Error(`Audio download failed: HTTP ${status}`);
  }

  // JapanesePod101 returns a small silent file when word is not found
  if (buffer.length < 1000) {
    throw new Error(
      `No audio found for '${kanji}' (${kana}) — file too small (${buffer.length} bytes)`
    );
  }

  return {
    audio_base64: buffer.toString("base64"),
    size_bytes: buffer.length,
  };
}

// ── Input validation ───────────────────────────────────────────

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return value.trim();
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
  {
    name: "download_audio",
    description:
      "Download Japanese word pronunciation audio as base64-encoded MP3. " +
      "Returns base64 data ready for Anki's store_media_file. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        kanji: {
          type: "string",
          description: "The word in kanji (e.g. '掲示板')",
        },
        kana: {
          type: "string",
          description: "The word reading in kana (e.g. 'けいじばん')",
        },
      },
      required: ["kanji", "kana"],
    },
  },
  {
    name: "batch_download_audio",
    description:
      "Download pronunciation audio for multiple Japanese words at once. " +
      "Each item needs kanji and kana. Returns an array of results with base64 MP3 data.",
    inputSchema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          description: "Array of words to download audio for",
          items: {
            type: "object",
            properties: {
              kanji: {
                type: "string",
                description: "The word in kanji",
              },
              kana: {
                type: "string",
                description: "The word reading in kana",
              },
            },
            required: ["kanji", "kana"],
          },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ["words"],
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────

async function handleDownloadAudio(args) {
  const kanji = requireString(args.kanji, "kanji");
  const kana = requireString(args.kana, "kana");

  const result = await fetchAudio(kanji, kana);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            kanji,
            kana,
            format: "mp3",
            ...result,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleBatchDownloadAudio(args) {
  if (!Array.isArray(args.words) || args.words.length === 0) {
    throw new Error("words must be a non-empty array");
  }
  if (args.words.length > 50) {
    throw new Error("Maximum 50 words per batch");
  }

  const results = await Promise.allSettled(
    args.words.map(async (w) => {
      const kanji = requireString(w.kanji, "kanji");
      const kana = requireString(w.kana, "kana");
      const audio = await fetchAudio(kanji, kana);
      return { kanji, kana, format: "mp3", ...audio };
    })
  );

  const items = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      kanji: args.words[i].kanji,
      kana: args.words[i].kana,
      error: r.reason.message,
    };
  });

  const succeeded = items.filter((i) => !i.error).length;
  const failed = items.filter((i) => i.error).length;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { total: items.length, succeeded, failed, items },
          null,
          2
        ),
      },
    ],
  };
}

// ── Tool dispatch ──────────────────────────────────────────────

const TOOL_HANDLERS = {
  download_audio: handleDownloadAudio,
  batch_download_audio: handleBatchDownloadAudio,
};

// ── Server setup ───────────────────────────────────────────────

const server = new Server(
  {
    name: "japanese-audio",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

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
          text: JSON.stringify({ error: err.message, tool: name }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ── Start ──────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "Japanese Audio MCP server running on stdio");
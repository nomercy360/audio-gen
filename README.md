# Forvo Pronunciation — MCP Bundle (MCPB)

MCP Bundle that exposes [Forvo](https://forvo.com) pronunciation API — 6M+ native speaker audio recordings in 430+ languages.

Built as an MCPB (MCP Bundle) for single-click installation in Claude Desktop and compatible hosts.

## Bundle Structure

```
forvo-pronunciation.mcpb (ZIP)
├── manifest.json          # MCPB v0.3 manifest
├── package.json           # Node.js package definition
├── server/
│   └── index.js           # MCP server (Node.js, stdio transport)
├── node_modules/          # Bundled dependencies
└── README.md
```

## Quick Start

### Option A: Install as MCPB bundle

```bash
# Pack the bundle
npx @anthropic-ai/mcpb pack

# Open the .mcpb file with Claude Desktop for single-click install
```

### Option B: Manual Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forvo": {
      "command": "node",
      "args": ["/path/to/audio-gen/server/index.js"],
      "env": {
        "FORVO_API_KEY": "your_key_here"
      }
    }
  }
}
```

### Option C: Run standalone for development

```bash
npm install
FORVO_API_KEY=your_key node server/index.js
```

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `forvo_api_key` | string (sensitive) | Yes | Forvo API key ([get one here](https://api.forvo.com/plans-and-pricing/)) |
| `default_language` | string | No | Default language code (default: `ja`) |

## Available Tools

| Tool | Description |
|------|-------------|
| `forvo_word_pronunciations` | Get all pronunciations for a word (filters: language, sex, country, rating) |
| `forvo_standard_pronunciation` | Get the single best-rated pronunciation |
| `forvo_download_pronunciation` | Download pronunciation audio as base64 MP3 (ready for Anki) |
| `forvo_search_words` | Search for words that have pronunciations |
| `forvo_language_list` | List available languages with pronunciation counts |

## Anki Integration Workflow

1. Use `forvo_download_pronunciation` to get base64 audio for a word
2. Use Anki MCP's `store_media_file` to save it to Anki's media folder
3. Use Anki MCP's `add_note` or `update_note_fields` to attach `[sound:filename.mp3]` to a card

Example flow (via Claude):
```
"Download pronunciation for 猫 and add it to my Anki card"
→ forvo_download_pronunciation(word="猫", language="ja")
→ Anki store_media_file(filename="forvo_猫.mp3", data=<base64>)
→ Anki update_note_fields(note_id=123, fields={"Audio": "[sound:forvo_猫.mp3]"})
```

## Notes

- Audio URLs from Forvo are temporary (~2 hours) — use `forvo_download_pronunciation` for persistent base64 data
- Free plan: 500 API requests/day
- Default language is Japanese (`ja`), configurable via user_config or per-request
- Node.js >= 18 required (ships with Claude Desktop)
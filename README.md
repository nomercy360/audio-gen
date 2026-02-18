# Japanese Audio — MCP Bundle (MCPB)

MCP Bundle that downloads Japanese word pronunciation audio from [JapanesePod101](https://www.japanesepod101.com/). No API key required.

## Tools

| Tool | Description |
|------|-------------|
| `download_audio` | Download pronunciation for a single word as base64 MP3 |
| `batch_download_audio` | Download pronunciation for multiple words at once |

## Quick Start

### Install as MCPB bundle

```bash
npx @anthropic-ai/mcpb pack
# Open the .mcpb file with Claude Desktop
```

### Manual Claude Desktop config

```json
{
  "mcpServers": {
    "japanese-audio": {
      "command": "node",
      "args": ["/path/to/audio-gen/server/index.js"]
    }
  }
}
```

### Development

```bash
npm install
node server/index.js
```

## Anki Workflow

```
"Download audio for 掲示板 and add it to my Anki card"
→ download_audio(kanji="掲示板", kana="けいじばん")
→ Anki store_media_file(filename="掲示板.mp3", data=<base64>)
→ Anki update_note_fields(note_id=123, fields={"Audio": "[sound:掲示板.mp3]"})
```

Batch example:
```
"Download audio for these words: 先着(せんちゃく), 協会(きょうかい), 金額(きんがく)"
→ batch_download_audio(words=[...])
→ Returns all audio files in one call
```
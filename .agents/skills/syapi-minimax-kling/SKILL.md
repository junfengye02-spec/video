---
name: syapi-minimax-kling
description: Use SYAPI MiniMax speech synthesis and Kling custom voice / advanced lip-sync endpoints for Chinese dubbing samples.
---

# SYAPI MiniMax + Kling Dubbing

Use this path only when the user explicitly approves the SYAPI models involved. Announce each paid model call before submission and generate one hero sample before any batch.

## MiniMax speech-2.8-hd

- Endpoint: `POST /minimax/v1/t2a_v2`.
- Keep `stream=false` for file output.
- For a mature Mandarin woman, start with preset `female-chengshu`; keep speed near `0.9-1.0`, volume `1.0`, pitch near `0`, and avoid exaggerated emotion.
- MiniMax output commonly returns encoded audio in `data.audio`; accept hex or base64 and measure the decoded file duration before lip sync.
- A Kling custom voice ID is not interchangeable with a MiniMax `voice_id`.

## Kling custom voice

- Endpoint: `POST /kling/v1/general/custom-voices` and query with `GET /kling/v1/general/custom-voices/{id}`.
- Keep `voice_name` at 20 characters or fewer; the live API enforces this even though the
  current Apifox field description omits the limit.
- `voice_url` supports MP3, WAV, MP4, and MOV.
- The documented temporary upload endpoint currently rejects local MP3/WAV files. Upload a
  local MP4/MOV reference there, or provide an already-public `voice_url` for audio references.
- The reference must contain exactly one clean speaker and be between 5 and 30 seconds.
- Treat voice creation as a separate identity test unless Kling TTS is also explicitly approved. Creating a voice ID alone does not prove its playback quality.

## Kling advanced lip sync

- Recognize first with `POST /kling/v1/videos/identify-face`. The Apifox sidebar currently
  labels this resource as `/image-recognize`, but its executable request sample uses
  `/identify-face`; the latter is the working lip-sync face endpoint.
- Submit with `POST /kling/v1/videos/advanced-lip-sync` and query with `GET /kling/v1/videos/advanced-lip-sync/{id}`.
- Source video must be MP4/MOV, 2-60 seconds, at most 100 MB, 720p or 1080p, and each dimension 512-2160 pixels.
- `sound_file` accepts an accessible URL or base64 for MP3/WAV/M4A, 2-60 seconds, at most 5 MB.
- Use only one selected face. Keep inserted audio inside the video duration and mute original audio when judging the replacement voice.

## Sources

- https://syapi.apifox.cn/api-406014230
- https://syapi.apifox.cn/api-406014227
- https://syapi.apifox.cn/api-406014228
- https://syapi.apifox.cn/api-406014229
- https://syapi.apifox.cn/api-406014292
- https://u1.syapi.cn/pricing

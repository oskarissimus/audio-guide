# Tour Guide v2 (mobile web)

- v1 code moved to `v1/` (original single-card UI with loop)
- v2 at repo root: map-first mobile web app showing nearby attractions; tap a marker to generate a short script, synthesize audio (ElevenLabs), and play inline (iOS supported)

## Dev

```bash
npm install
npm run dev
```

Build and preview:

```bash
npm run build
npm run preview
```

## Environment variables (build time)

- `VITE_OPENAI_API_KEY`
- `VITE_ELEVENLABS_API_KEY`

These are embedded client-side. Do not use production secrets you cannot expose publicly.

## Deployment

The existing GitHub Actions workflow builds the repo root. v2 is now the deployed app. v1 remains in `v1/` for reference/manual use.

## iOS notes

- First user tap is used to unlock audio on iOS via a muted play/pause.
- `<audio playsinline>` is used for inline playback.
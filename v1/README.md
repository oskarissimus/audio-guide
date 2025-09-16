# Audio przewodnik (Vite + TypeScript)

## Uruchomienie lokalne

```bash
npm install
npm run dev
```

Build i podgląd:

```bash
npm run build
npm run preview
```

## Wymagane sekrety środowiskowe (czas budowania)

- `VITE_OPENAI_API_KEY`
- `VITE_ELEVENLABS_API_KEY`

W GitHub Actions sekrety są przekazywane jako zmienne środowiskowe w kroku „Build” i zostają osadzone w wynikowym JS (uwaga: aplikacja jest w 100% front‑endowa, więc klucze będą widoczne w przeglądarce).

## Działanie aplikacji

Aplikacja działa w nieskończonej pętli i wykonuje kroki sekwencyjnie, pokazując bieżący etap na ekranie:

1. Pobieranie lokalizacji (HTML5 Geolocation, wysoka dokładność)
2. Wyszukiwanie najbliższej atrakcji (Wikipedia pl: geosearch + ekstrakt wstępu)
3. Generowanie 3‑zdaniowego skryptu po polsku (OpenAI `gpt-4o-mini`)
4. Generowanie audio (ElevenLabs `eleven_multilingual_v2`, głos Bella)
5. Odtwarzanie audio, następnie 10 s przerwy

Wszelkie błędy są wyświetlane z maksymalnie szczegółowym opisem (HTTP status, fragment odpowiedzi, stack), aby ułatwić debugowanie.

## Deploy na GitHub Pages

Workflow `.github/workflows/deploy.yml` uruchamia się na każdy `push` do dowolnego brancha oraz manualnie (`workflow_dispatch`).
Kroki: checkout → install → build (z sekretami) → upload artefaktu → deploy na Pages.

Adres bazowy (`base`) Vite jest ustawiany automatycznie na `/<NazwaRepozytorium>/` w CI, co umożliwia poprawne ładowanie zasobów na Pages. Lokalnie `base` to `/`.

## iOS (iPhone SE / Chrome)

- Pierwsze naciśnięcie „Start” odblokowuje audio (wymóg iOS).
- Musisz zezwolić na dostęp do lokalizacji.
- Odtwarzanie audio odbywa się elementem `<audio playsinline>`.

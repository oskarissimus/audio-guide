type Stage =
  | 'Bezczynny'
  | 'Pobieranie lokalizacji'
  | 'Wyszukiwanie atrakcji'
  | 'Generowanie skryptu'
  | 'Generowanie audio'
  | 'Odtwarzanie'
  | 'Oczekiwanie';

type GeoPosition = { lat: number; lon: number };

type Attraction = {
  pageId: number;
  title: string;
  extract: string;
  distanceMeters: number;
};

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
const ELEVENLABS_API_KEY = import.meta.env.VITE_ELEVENLABS_API_KEY as string | undefined;

const ELEVENLABS_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Bella (multilingual)
const ELEVENLABS_MODEL = 'eleven_multilingual_v2';

const stageEl = document.getElementById('stage') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const audioEl = document.getElementById('player') as HTMLAudioElement;

let running = false;
let currentStage: Stage = 'Bezczynny';

function setStage(stage: Stage) {
  currentStage = stage;
  stageEl.textContent = stage;
}

function appendStatus(message: string, isError = false) {
  const prefix = isError ? '❌ ' : '• ';
  statusEl.innerText = `${statusEl.innerText}\n${prefix}${message}`.trim();
  if (isError) {
    statusEl.classList.add('error');
  }
}

function resetStatus(text: string) {
  statusEl.classList.remove('error');
  statusEl.innerText = text;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureEnvOrThrow() {
  const missing: string[] = [];
  if (!OPENAI_API_KEY) missing.push('VITE_OPENAI_API_KEY');
  if (!ELEVENLABS_API_KEY) missing.push('VITE_ELEVENLABS_API_KEY');
  if (missing.length) {
    const msg = `Brak zmiennych środowiskowych: ${missing.join(', ')}. Upewnij się, że sekrety repozytorium są ustawione i przekazywane do kompilacji.`;
    throw new Error(msg);
  }
}

async function getLocation(): Promise<GeoPosition> {
  setStage('Pobieranie lokalizacji');
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolokalizacja nie jest obsługiwana przez tę przeglądarkę.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      (err) => {
        const details = `code=${err.code}, message=${err.message}`;
        reject(new Error(`Nie udało się pobrać lokalizacji. Szczegóły: ${details}`));
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
    );
  });
}

async function fetchNearestAttraction(position: GeoPosition): Promise<Attraction> {
  setStage('Wyszukiwanie atrakcji');
  // 1) Geosearch near coordinates (Polish Wikipedia)
  const geoUrl = new URL('https://pl.wikipedia.org/w/api.php');
  geoUrl.searchParams.set('format', 'json');
  geoUrl.searchParams.set('origin', '*');
  geoUrl.searchParams.set('action', 'query');
  geoUrl.searchParams.set('list', 'geosearch');
  geoUrl.searchParams.set('gscoord', `${position.lat}|${position.lon}`);
  geoUrl.searchParams.set('gsradius', '1500'); // meters
  geoUrl.searchParams.set('gslimit', '10');

  const geoResp = await fetch(geoUrl.toString(), { mode: 'cors' });
  if (!geoResp.ok) {
    throw new Error(`Błąd zapytania geosearch Wikipedia: HTTP ${geoResp.status}`);
  }
  const geoData = await geoResp.json();
  const results = geoData?.query?.geosearch as Array<any> | undefined;
  if (!results || results.length === 0) {
    throw new Error('Nie znaleziono żadnych atrakcji w pobliżu (Wikipedia geosearch).');
  }
  const best = results[0];
  const pageId = best.pageid as number;
  const title = best.title as string;
  const distance = best.dist as number;

  // 2) Fetch intro extract for page
  const extractUrl = new URL('https://pl.wikipedia.org/w/api.php');
  extractUrl.searchParams.set('format', 'json');
  extractUrl.searchParams.set('origin', '*');
  extractUrl.searchParams.set('action', 'query');
  extractUrl.searchParams.set('prop', 'extracts');
  extractUrl.searchParams.set('exintro', '');
  extractUrl.searchParams.set('explaintext', '');
  extractUrl.searchParams.set('redirects', '1');
  extractUrl.searchParams.set('pageids', String(pageId));

  const extResp = await fetch(extractUrl.toString(), { mode: 'cors' });
  if (!extResp.ok) {
    throw new Error(`Błąd pobierania opisu z Wikipedii: HTTP ${extResp.status}`);
  }
  const extData = await extResp.json();
  const page = extData?.query?.pages?.[pageId];
  const extract = (page?.extract as string | undefined) ?? '';

  return {
    pageId,
    title,
    extract,
    distanceMeters: distance ?? NaN,
  };
}

async function generatePolishGuideText(attraction: Attraction): Promise<string> {
  setStage('Generowanie skryptu');

  ensureEnvOrThrow();
  const system =
    'Jesteś lokalnym przewodnikiem turystycznym. Tworzysz zwięzłe, przyjazne i naturalne opisy atrakcji w języku polskim.';
  const user = `
Atrakcja: ${attraction.title}
Odległość: ${isFinite(attraction.distanceMeters) ? Math.round(attraction.distanceMeters) + ' m' : 'nieznana'}
Opis (skrót z Wikipedii, może być niepełny): ${attraction.extract || 'brak'}

Zadanie: Napisz dokładnie 3 zdania po polsku o najbliższej atrakcji dla audio przewodnika.
Zasady:
- Zaczynaj od krótkiego przedstawienia miejsca i jego znaczenia.
- Używaj naturalnego języka mówionego, unikaj nawiasów, skrótów i przypisów.
- Dodaj jedną ciekawostkę lub kontekst historyczny, jeśli to możliwe.
- Nie wspominaj o Wikipedii ani o źródłach.
- Maksymalnie ~60 słów łącznie.
`;

  const body = {
    model: 'gpt-4o-mini',
    temperature: 0.7,
    max_tokens: 300,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI API błąd: HTTP ${resp.status}. Odpowiedź: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) {
    throw new Error('OpenAI nie zwrócił treści. Sprawdź limity i klucz API.');
  }
  // Sanitize minimal
  return content.replace(/\n+/g, ' ').trim();
}

async function synthesizeAudioPolish(text: string): Promise<Blob> {
  setStage('Generowanie audio');
  ensureEnvOrThrow();

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    ELEVENLABS_DEFAULT_VOICE
  )}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

  const body = {
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.5,
      style: 0.2,
      use_speaker_boost: true,
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      'xi-api-key': ELEVENLABS_API_KEY!,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const textResp = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs API błąd: HTTP ${resp.status}. Odpowiedź: ${textResp.slice(0, 500)}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return new Blob([arrayBuffer], { type: 'audio/mpeg' });
}

async function playAudioBlob(blob: Blob): Promise<void> {
  setStage('Odtwarzanie');
  if (audioEl.src) {
    try { URL.revokeObjectURL(audioEl.src); } catch {}
  }
  const objectUrl = URL.createObjectURL(blob);
  audioEl.src = objectUrl;
  audioEl.load();
  try {
    await audioEl.play();
  } catch (err) {
    const e = err as Error;
    throw new Error(
      `Nie udało się odtworzyć audio. iOS wymaga interakcji użytkownika. Spróbuj ponownie nacisnąć Start. Szczegóły: ${e.message}`
    );
  }

  // Wait until playback ends or the loop is stopped (pause)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      audioEl.removeEventListener('ended', onEnded);
      audioEl.removeEventListener('pause', onPause);
      audioEl.removeEventListener('error', onError);
      audioEl.removeEventListener('abort', onAbort);
      try { URL.revokeObjectURL(objectUrl); } catch {}
    };
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onPause = () => {
      // If user stopped the loop, treat as resolved to allow clean exit
      if (!running) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      const mediaError = audioEl.error?.message || 'nieznany błąd mediów';
      cleanup();
      reject(new Error(`Błąd odtwarzania audio: ${mediaError}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Odtwarzanie przerwane.'));
    };

    audioEl.addEventListener('ended', onEnded, { once: true });
    audioEl.addEventListener('pause', onPause);
    audioEl.addEventListener('error', onError, { once: true });
    audioEl.addEventListener('abort', onAbort, { once: true });
  });
}

async function loopOnce(): Promise<void> {
  resetStatus('');
  appendStatus('Start iteracji…');
  const pos = await getLocation();
  appendStatus(`Lokalizacja: lat=${pos.lat.toFixed(5)}, lon=${pos.lon.toFixed(5)}`);

  const attraction = await fetchNearestAttraction(pos);
  appendStatus(`Najbliższa atrakcja: ${attraction.title} (${isFinite(attraction.distanceMeters) ? Math.round(attraction.distanceMeters) + ' m' : '—'})`);

  const text = await generatePolishGuideText(attraction);
  appendStatus('Wygenerowano skrypt.');

  const audioBlob = await synthesizeAudioPolish(text);
  appendStatus('Audio gotowe. Odtwarzanie…');

  await playAudioBlob(audioBlob);
  appendStatus('Odtwarzanie zakończone.');

  if (!running) return;
  setStage('Oczekiwanie');
  appendStatus('Czekam 10 sekund…');
  await wait(10_000);
}

async function mainLoop() {
  try {
    ensureEnvOrThrow();
  } catch (e) {
    const err = e as Error;
    setStage('Bezczynny');
    resetStatus('');
    appendStatus(err.message, true);
    return;
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  while (running) {
    try {
      await loopOnce();
    } catch (e) {
      const err = e as Error;
      appendStatus(`Błąd w etapie „${currentStage}”: ${err.message}` + (err.stack ? `\nStack: ${err.stack}` : ''), true);
      setStage('Oczekiwanie');
      appendStatus('Odczekuję 10 sekund i spróbuję ponownie…');
      await wait(10_000);
    }
  }

  setStage('Bezczynny');
  startBtn.disabled = false;
  stopBtn.disabled = true;
  appendStatus('Zatrzymano pętlę.');
}

function stopLoop() {
  running = false;
  try { audioEl.pause(); } catch {}
}

function unlockAudio() {
  // Attempt to unlock audio on iOS by playing a silent buffer via the <audio> element
  // We rely on the user gesture on Start to allow playback later.
  audioEl.muted = true;
  audioEl.play().catch(() => {}).finally(() => {
    audioEl.pause();
    audioEl.muted = false;
    audioEl.removeAttribute('muted');
  });
}

startBtn.addEventListener('click', async () => {
  resetStatus('Uruchamianie…');
  unlockAudio();
  await mainLoop();
});

stopBtn.addEventListener('click', () => {
  appendStatus('Żądanie zatrzymania…');
  stopLoop();
});

// Initial status with environment check feedback
(() => {
  const haveOpenAI = Boolean(OPENAI_API_KEY);
  const have11 = Boolean(ELEVENLABS_API_KEY);
  const notes: string[] = [];
  notes.push(`OpenAI klucz: ${haveOpenAI ? 'OK' : 'BRAK'}`);
  notes.push(`ElevenLabs klucz: ${have11 ? 'OK' : 'BRAK'}`);
  appendStatus(notes.join(' | '));
})();


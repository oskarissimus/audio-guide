import L from 'leaflet';

type Stage = 'Idle' | 'Locating' | 'Searching attractions' | 'Generating script' | 'Generating audio' | 'Play' | 'Waiting';
type Lang = 'pl' | 'en';

type GeoPosition = { lat: number; lon: number };
type Attraction = {
  pageId: number;
  title: string;
  extract: string;
  lat: number;
  lon: number;
  distanceMeters: number;
};

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
const ELEVENLABS_API_KEY = import.meta.env.VITE_ELEVENLABS_API_KEY as string | undefined;

const ELEVENLABS_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';
const ELEVENLABS_MODEL = 'eleven_multilingual_v2';

const stageEl = document.getElementById('stage') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const audioEl = document.getElementById('player') as HTMLAudioElement;

let currentStage: Stage = 'Idle';
let runningInteraction = false;
let audioUnlocked = false;

function setStage(stage: Stage) {
  currentStage = stage;
  stageEl.textContent = stage;
}

function setStatus(message: string) {
  statusEl.textContent = message;
}

function ensureEnvOrThrow() {
  const missing: string[] = [];
  if (!OPENAI_API_KEY) missing.push('VITE_OPENAI_API_KEY');
  if (!ELEVENLABS_API_KEY) missing.push('VITE_ELEVENLABS_API_KEY');
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(', ')}`);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLocation(): Promise<GeoPosition> {
  setStage('Locating');
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(`Geolocation failed: code=${err.code} ${err.message}`)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function fetchNearbyAttractions(position: GeoPosition, lang: Lang): Promise<Attraction[]> {
  setStage('Searching attractions');
  const wikiHost = lang === 'en' ? 'https://en.wikipedia.org' : 'https://pl.wikipedia.org';
  const geoUrl = new URL(wikiHost + '/w/api.php');
  geoUrl.searchParams.set('format', 'json');
  geoUrl.searchParams.set('origin', '*');
  geoUrl.searchParams.set('action', 'query');
  geoUrl.searchParams.set('list', 'geosearch');
  geoUrl.searchParams.set('gscoord', `${position.lat}|${position.lon}`);
  geoUrl.searchParams.set('gsradius', '1500');
  geoUrl.searchParams.set('gslimit', '20');

  const geoResp = await fetch(geoUrl.toString(), { mode: 'cors' });
  if (!geoResp.ok) throw new Error(`Wikipedia geosearch HTTP ${geoResp.status}`);
  const geoData = await geoResp.json();
  const results = (geoData?.query?.geosearch ?? []) as Array<any>;

  const pageIds = results.map((r) => r.pageid).join('|');
  const extractUrl = new URL(wikiHost + '/w/api.php');
  extractUrl.searchParams.set('format', 'json');
  extractUrl.searchParams.set('origin', '*');
  extractUrl.searchParams.set('action', 'query');
  extractUrl.searchParams.set('prop', 'extracts');
  extractUrl.searchParams.set('exintro', '');
  extractUrl.searchParams.set('explaintext', '');
  extractUrl.searchParams.set('redirects', '1');
  extractUrl.searchParams.set('pageids', pageIds);

  const extResp = await fetch(extractUrl.toString(), { mode: 'cors' });
  if (!extResp.ok) throw new Error(`Wikipedia extract HTTP ${extResp.status}`);
  const extData = await extResp.json();
  const pages = extData?.query?.pages ?? {};

  const attractions: Attraction[] = results.map((r: any) => {
    const p = pages?.[r.pageid];
    return {
      pageId: r.pageid,
      title: r.title,
      extract: (p?.extract as string | undefined) ?? '',
      lat: r.lat,
      lon: r.lon,
      distanceMeters: r.dist ?? NaN,
    };
  });
  return attractions;
}

async function generateAgenticScript(attraction: Attraction, lang: Lang): Promise<string> {
  setStage('Generating script');
  ensureEnvOrThrow();

  const isPl = lang === 'pl';
  const wikiLink = (lang === 'en' ? `https://en.wikipedia.org/?curid=${attraction.pageId}` : `https://pl.wikipedia.org/?curid=${attraction.pageId}`);
  const system = isPl
    ? 'Jesteś przewodnikiem z dostępem do narzędzi. Najpierw przeszukujesz źródła, potem tworzysz mówiony skrypt.'
    : 'You are a tour guide with tool-use. First research the topic, then write a spoken script.';

  const distance = isFinite(attraction.distanceMeters)
    ? `${Math.round(attraction.distanceMeters)} m`
    : (isPl ? 'nieznana' : 'unknown');
  const summary = attraction.extract || (isPl ? 'brak' : 'none');

  // Ask the model to research using provided context, then write
  const user = isPl
    ? `Najpierw przeprowadź krótkie rozeznanie na podstawie danych i linku poniżej, a potem przygotuj skrypt audio.
Tytuł: ${attraction.title}
Odległość: ${distance}
Streszczenie (Wikipedii, może być niepełne): ${summary}
Źródło: ${wikiLink}

Zasady:
- 3–4 zdania, naturalny język mówiony.
- ~60–80 słów.
- Nie wspominaj o źródłach ani linkach.`
    : `First, research briefly using the data and link below, then write the audio script.
Title: ${attraction.title}
Distance: ${distance}
Summary (from Wikipedia, may be incomplete): ${summary}
Source: ${wikiLink}

Guidelines:
- 3–4 sentences, natural spoken English.
- ~60–80 words.
- Do not mention sources or links.`;

  const body = {
    model: 'gpt-4o-mini',
    temperature: 0.6,
    max_tokens: 350,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  } as const;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error('Empty completion');
  return content.replace(/\n+/g, ' ').trim();
}

async function synthesizeAudio(text: string, _lang: Lang): Promise<Blob> {
  setStage('Generating audio');
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
  } as const;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
      'xi-api-key': ELEVENLABS_API_KEY!,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`ElevenLabs HTTP ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return new Blob([arrayBuffer], { type: 'audio/mpeg' });
}

async function playAudioBlob(blob: Blob): Promise<void> {
  setStage('Play');
  if (audioEl.src) {
    try { URL.revokeObjectURL(audioEl.src); } catch {}
  }
  const objectUrl = URL.createObjectURL(blob);
  audioEl.src = objectUrl;
  audioEl.load();
  try {
    await audioEl.play();
  } catch (e) {
    throw new Error('Playback failed. On iOS, tap again to allow audio.');
  }
}

function unlockAudio() {
  audioEl.muted = true;
  audioEl.play().catch(() => {}).finally(() => {
    audioEl.pause();
    audioEl.muted = false;
    audioEl.removeAttribute('muted');
  });
}

function setupAudioUnlockGesture() {
  if (audioUnlocked) return;
  const onGesture = () => {
    try { unlockAudio(); } finally {
      audioUnlocked = true;
      window.removeEventListener('touchend', onGesture);
      window.removeEventListener('click', onGesture);
    }
  };
  window.addEventListener('touchend', onGesture, { once: true });
  window.addEventListener('click', onGesture, { once: true });
}

function createSpinnerIcon() {
  const div = L.divIcon({
    className: 'spinner-icon',
    html: '<div class="spinner" style="width:22px;height:22px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  const style = document.createElement('style');
  style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  return div;
}

async function handleAttractionClick(attraction: Attraction, marker: L.Marker, lang: Lang) {
  if (runningInteraction) return;
  runningInteraction = true;
  const originalIcon = marker.getIcon();
  marker.setIcon(createSpinnerIcon());
  setStatus('Generating script…');

  try {
    const script = await generateAgenticScript(attraction, lang);
    setStatus('Generating audio…');
    const audioBlob = await synthesizeAudio(script, lang);
    setStatus('Play');
    await playAudioBlob(audioBlob);
    setStatus('Done');
  } catch (e) {
    const err = e as Error;
    setStatus('Error: ' + err.message);
  } finally {
    marker.setIcon(originalIcon);
    runningInteraction = false;
  }
}

async function main() {
  ensureEnvOrThrow();
  setStatus('Checking environment…');
  setupAudioUnlockGesture();

  const lang: Lang = (navigator.language?.startsWith('pl') ? 'pl' : 'en');
  let pos: GeoPosition;
  try {
    pos = await getLocation();
  } catch (e) {
    setStatus('Geolocation error. Using fallback location.');
    pos = { lat: 52.2297, lon: 21.0122 }; // Warsaw fallback
  }

  const map = L.map('map', { zoomControl: true });
  const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  });
  tiles.addTo(map);
  map.setView([pos.lat, pos.lon], 15);
  L.marker([pos.lat, pos.lon]).addTo(map).bindPopup(lang === 'pl' ? 'Twoja lokalizacja' : 'You are here');

  setStatus('Loading attractions…');
  let attractions: Attraction[] = [];
  try {
    attractions = await fetchNearbyAttractions(pos, lang);
  } catch (e) {
    setStatus('Failed to load attractions');
  }

  const defaultIcon = L.icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
  });
  (L.Marker.prototype as any).options.icon = defaultIcon;

  attractions.forEach((a) => {
    const marker = L.marker([a.lat, a.lon]).addTo(map);
    const distance = isFinite(a.distanceMeters) ? `${Math.round(a.distanceMeters)} m` : '';
    marker.bindPopup(`<strong>${a.title}</strong><br/>${distance}`);
    marker.on('click', () => handleAttractionClick(a, marker, lang));
  });

  setStatus('Ready. Tap a marker.');
}

main().catch((e) => {
  const err = e as Error;
  setStatus('Startup error: ' + err.message);
});


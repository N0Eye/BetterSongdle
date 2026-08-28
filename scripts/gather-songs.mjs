// One-time/occasional build script: pulls candidate songs from Spotify Search,
// verifies popularity + gets a playable video via YouTube, and appends results
// to data/songs.json. Safe to stop and re-run — progress is checkpointed in
// data/.gather-state.json so it never re-spends YouTube quota on a song it
// already checked.
//
// Usage: npm run gather

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !YOUTUBE_API_KEY) {
  console.error(
    'Missing credentials. Copy .env.example to .env and fill in SPOTIFY_CLIENT_ID, ' +
    'SPOTIFY_CLIENT_SECRET, and YOUTUBE_API_KEY.'
  );
  process.exit(1);
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SONGS_PATH = path.join(DATA_DIR, 'songs.json');
const STATE_PATH = path.join(DATA_DIR, '.gather-state.json');

// Dataset scope: 2010 onward, one year per Spotify search query.
const START_YEAR = 2010;
const END_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, i) => START_YEAR + i);

// Popularity tiers, by YouTube view count on the matched video.
const TIERS = [
  { name: 'Easy', minViews: 500_000_000 },
  { name: 'Medium', minViews: 200_000_000 },
  { name: 'Hard', minViews: 75_000_000 },
  { name: 'Expert', minViews: 25_000_000 },
  { name: 'Impossible', minViews: 5_000_000 },
];

function tierFor(viewCount) {
  for (const tier of TIERS) {
    if (viewCount >= tier.minViews) return tier.name;
  }
  return null;
}

// YouTube search.list costs 100 quota units, videos.list costs 1. Free daily
// quota is 10,000 units, so stay well under ~99 lookups/day by default.
const MAX_YOUTUBE_LOOKUPS = Number(process.env.MAX_YOUTUBE_LOOKUPS || 90);
// New/dev-mode Spotify apps are capped at limit=10 on search (used to allow up to 50).
const SPOTIFY_PAGE_SIZE = 10;

async function loadJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function saveJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function getSpotifyToken() {
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`Spotify auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - 30_000 };
}

async function spotifySearchYear(token, year, offset) {
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', `year:${year}`);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', String(SPOTIFY_PAGE_SIZE));
  url.searchParams.set('offset', String(offset));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Spotify search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.tracks;
}

class QuotaExceededError extends Error {}

async function youtubeFindVideo(query) {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'video');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('maxResults', '1');
  url.searchParams.set('key', YOUTUBE_API_KEY);

  const res = await fetch(url);
  if (res.status === 403) {
    const body = await res.text();
    if (body.includes('quotaExceeded')) throw new QuotaExceededError('YouTube quota exceeded');
    throw new Error(`YouTube search failed: 403 ${body}`);
  }
  if (!res.ok) {
    throw new Error(`YouTube search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.items?.[0]?.id?.videoId ?? null;
}

async function youtubeGetViewCount(videoId) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', YOUTUBE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`YouTube videos.list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const stats = data.items?.[0]?.statistics;
  if (!stats?.viewCount) return null;
  return Number(stats.viewCount);
}

async function main() {
  const songsData = await loadJson(SONGS_PATH, { generatedAt: null, songs: [] });
  const state = await loadJson(STATE_PATH, { processedTrackIds: [], yearOffsets: {} });
  const processedTrackIds = new Set(state.processedTrackIds);
  const knownVideoIds = new Set(songsData.songs.map((s) => s.videoId));

  let { token, expiresAt } = await getSpotifyToken();
  let youtubeLookups = 0;
  let accepted = 0;
  let stopped = false;

  console.log(`Starting gather run. Budget: ${MAX_YOUTUBE_LOOKUPS} YouTube lookups.`);

  yearLoop:
  for (const year of YEARS) {
    let offset = state.yearOffsets[year] ?? 0;

    while (offset < 1000) {
      if (Date.now() > expiresAt) {
        ({ token, expiresAt } = await getSpotifyToken());
      }

      const page = await spotifySearchYear(token, year, offset);
      const items = page.items ?? [];
      if (items.length === 0) break; // exhausted this year

      for (const track of items) {
        if (youtubeLookups >= MAX_YOUTUBE_LOOKUPS) {
          stopped = true;
          break yearLoop;
        }
        if (processedTrackIds.has(track.id)) continue;

        const artist = track.artists?.[0]?.name;
        const title = track.name;
        if (!artist || !title) {
          processedTrackIds.add(track.id);
          continue;
        }

        try {
          const videoId = await youtubeFindVideo(`${artist} ${title} official audio`);
          youtubeLookups += 1;

          if (!videoId || knownVideoIds.has(videoId)) {
            processedTrackIds.add(track.id);
            continue;
          }

          const viewCount = await youtubeGetViewCount(videoId);
          processedTrackIds.add(track.id);

          if (viewCount == null) continue;
          const tier = tierFor(viewCount);
          if (!tier) continue; // below the Impossible floor, skip

          songsData.songs.push({
            id: track.id,
            artist,
            title,
            year,
            videoId,
            viewCount,
            tier,
          });
          knownVideoIds.add(videoId);
          accepted += 1;
          console.log(`[${tier}] ${artist} - ${title} (${year}, ${viewCount.toLocaleString()} views)`);
        } catch (err) {
          if (err instanceof QuotaExceededError) {
            console.log('YouTube quota exceeded for today — stopping cleanly.');
            stopped = true;
            break yearLoop;
          }
          throw err;
        }
      }

      offset += SPOTIFY_PAGE_SIZE;
      state.yearOffsets[year] = offset;
    }
  }

  state.processedTrackIds = [...processedTrackIds];
  songsData.generatedAt = new Date().toISOString();

  await saveJson(SONGS_PATH, songsData);
  await saveJson(STATE_PATH, state);

  console.log(`\nDone. Accepted ${accepted} new song(s) this run. Total in dataset: ${songsData.songs.length}.`);
  if (stopped) console.log('Run stopped early (quota/budget limit) — just run "npm run gather" again to continue.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

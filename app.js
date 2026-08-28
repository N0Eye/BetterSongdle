const REVEAL_DURATIONS = [0.5, 1, 2, 4, 8, 16]; // seconds, cumulative snippet length per attempt
const TIER_ORDER = ['Easy', 'Medium', 'Hard', 'Expert', 'Impossible'];

const TIER_STYLES = {
  Easy: { accent: '#19df70', bright: '#39e887', soft: 'rgba(25, 223, 112, 0.11)', glow: 'rgba(25, 223, 112, 0.38)', text: '#04160b' },
  Medium: { accent: '#ffca12', bright: '#ffd234', soft: 'rgba(255, 202, 18, 0.11)', glow: 'rgba(255, 202, 18, 0.38)', text: '#231a00' },
  Hard: { accent: '#ff7517', bright: '#ff8631', soft: 'rgba(255, 117, 23, 0.11)', glow: 'rgba(255, 117, 23, 0.38)', text: '#240d00' },
  Expert: { accent: '#f04444', bright: '#f66464', soft: 'rgba(240, 68, 68, 0.11)', glow: 'rgba(240, 68, 68, 0.38)', text: '#250202' },
  Impossible: { accent: '#9748dd', bright: '#ae67ed', soft: 'rgba(151, 72, 221, 0.11)', glow: 'rgba(151, 72, 221, 0.38)', text: '#190226' },
};

function applyAccent(tier) {
  const style = TIER_STYLES[tier];
  const root = document.documentElement.style;
  root.setProperty('--accent', style.accent);
  root.setProperty('--accent-bright', style.bright);
  root.setProperty('--accent-soft', style.soft);
  root.setProperty('--accent-glow', style.glow);
  root.setProperty('--accent-text', style.text);
}

const MAX_SUGGESTIONS = 8;

let allSongs = [];
let currentTier = null;
let currentPool = [];
let currentSong = null;
let attemptIndex = 0;
let ended = false;

let player = null;
let playerReady = false;
let pendingVideoId = null;
let pendingVolume = null;
let snippetTimer = null;
let playStartTime = null;
let playbackArmed = false; // true from click until YouTube confirms playback actually started
let audioPlaying = false; // true only once real playback has started and the reveal timer is running
let warmingUp = false; // true while silently pre-buffering a freshly-cued video
let pendingWarmUp = false; // true after cueing, until CUED confirms it's ready to warm up
let warmUpComplete = false; // true once warm-up has already parked the player at startOffset

const difficultyList = document.getElementById('difficultyList');
const pillRow = document.getElementById('pillRow');
const datasetStatus = document.getElementById('datasetStatus');
const snippetWrap = document.getElementById('snippetWrap');
const playWrap = document.getElementById('playWrap');
const snippetFill = document.getElementById('snippetFill');
const snippetTicks = document.getElementById('snippetTicks');
const snippetMarker = document.getElementById('snippetMarker');
const markerLength = document.getElementById('markerLength');
const playBtn = document.getElementById('playBtn');
const snippetLength = document.getElementById('snippetLength');
const guessInput = document.getElementById('guessInput');
const suggestionsList = document.getElementById('suggestionsList');
const submitGuessBtn = document.getElementById('submitGuessBtn');
const skipBtn = document.getElementById('skipBtn');
const resultPanel = document.getElementById('resultPanel');
const resultThumb = document.getElementById('resultThumb');
const resultThumbLink = document.getElementById('resultThumbLink');
const resultTitle = document.getElementById('resultTitle');
const resultSubtitle = document.getElementById('resultSubtitle');
const resultPill = document.getElementById('resultPill');
const playAgainBtn = document.getElementById('playAgainBtn');
const rerollBtn = document.getElementById('rerollBtn');
const durationGrid = document.getElementById('durationGrid');
const volumeSlider = document.getElementById('volumeSlider');

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    .replace(/feat\.?.*/g, ' ')
    .replace(/ft\.?.*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - levenshtein(a, b) / maxLen;
}

function isCorrectGuess(rawGuess, song) {
  const guess = normalize(rawGuess);
  if (!guess) return false;
  const candidates = [normalize(song.title), normalize(`${song.artist} ${song.title}`)];
  return candidates.some((candidate) => {
    if (guess === candidate) return true;
    if (candidate.includes(guess) && guess.length >= Math.max(4, candidate.length * 0.5)) return true;
    return similarity(guess, candidate) >= 0.8;
  });
}

// Scores how well a candidate string matches the typed query: exact/prefix
// matches rank highest, substring matches next, and a fuzzy fallback catches
// typos. 0 means "not a match" and gets filtered out entirely.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function scoreMatch(query, text) {
  if (!query || !text) return 0;
  if (text === query) return 100;
  if (text.startsWith(query)) return 90 - (text.length - query.length) * 0.05;
  if (text.includes(query)) return 60 - text.indexOf(query) * 0.5;
  const sim = similarity(query, text);
  return sim > 0.55 ? sim * 40 : 0;
}

function bestScoreForSong(query, song) {
  const title = normalize(song.title);
  const artist = normalize(song.artist);
  const combined = normalize(`${song.artist} ${song.title}`);
  return Math.max(scoreMatch(query, title), scoreMatch(query, artist), scoreMatch(query, combined));
}

function renderSuggestions() {
  const query = normalize(guessInput.value);
  suggestionsList.innerHTML = '';

  if (!query) {
    suggestionsList.classList.add('hidden');
    return;
  }

  const matches = currentPool
    .map((song) => ({ song, score: bestScoreForSong(query, song) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS);

  if (matches.length === 0) {
    suggestionsList.classList.add('hidden');
    return;
  }

  for (const { song } of matches) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'suggestion-item';
    item.innerHTML = `
      <div class="suggestion-title">${escapeHtml(song.title)}</div>
      <div class="suggestion-artist">${escapeHtml(song.artist)}</div>
    `;
    // mousedown (not click) fires before the input's blur, so the guess
    // still registers even though clicking briefly steals focus.
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      suggestionsList.classList.add('hidden');
      submitGuess(`${song.artist} ${song.title}`);
    });
    suggestionsList.appendChild(item);
  }

  suggestionsList.classList.remove('hidden');
}

function buildSnippetTicks() {
  const max = REVEAL_DURATIONS[REVEAL_DURATIONS.length - 1];
  snippetTicks.innerHTML = '';
  for (const d of REVEAL_DURATIONS.slice(0, -1)) {
    const tick = document.createElement('div');
    tick.className = 'snippet-tick';
    tick.style.left = `${(d / max) * 100}%`;
    snippetTicks.appendChild(tick);
  }
}

function buildDurationGrid() {
  durationGrid.innerHTML = '';
  for (const d of REVEAL_DURATIONS) {
    const chip = document.createElement('span');
    chip.className = 'duration-chip';
    chip.textContent = `${d}s`;
    chip.dataset.duration = d;
    durationGrid.appendChild(chip);
  }
}

function updateDurationGrid() {
  const chips = durationGrid.querySelectorAll('.duration-chip');
  chips.forEach((chip, i) => {
    chip.classList.toggle('used', i < attemptIndex);
    chip.classList.toggle('current', i === attemptIndex);
  });
}

async function loadSongs() {
  const res = await fetch('data/songs.json');
  const data = await res.json();
  allSongs = data.songs || [];

  datasetStatus.textContent = allSongs.length === 0
    ? 'No songs in the dataset yet — run "npm run gather" first.'
    : `${allSongs.length} songs loaded.`;

  let firstAvailable = null;
  for (const tier of TIER_ORDER) {
    const count = allSongs.filter((s) => s.tier === tier).length;
    const disabled = count === 0;
    document.querySelectorAll(`[data-tier="${tier}"]`).forEach((btn) => {
      btn.disabled = disabled;
      btn.title = `${count} song(s)`;
    });
    if (!disabled && !firstAvailable) firstAvailable = tier;
  }

  if (firstAvailable) selectTier(firstAvailable);
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  player = new YT.Player('ytPlayer', {
    height: '1',
    width: '1',
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        player.setVolume(pendingVolume ?? Number(volumeSlider.value));
        if (pendingVideoId) {
          player.cueVideoById(pendingVideoId);
          pendingVideoId = null;
          pendingWarmUp = true;
        }
      },
      onStateChange: (event) => {
        // Calling playVideo() immediately after cueVideoById(), in the same
        // tick, gets silently dropped by the IFrame API — the player just
        // sits at CUED forever. So the warm-up waits for CUED to actually
        // land before triggering the muted play that pre-buffers the stream.
        if (event.data === YT.PlayerState.CUED && pendingWarmUp) {
          pendingWarmUp = false;
          warmingUp = true;
          player.mute();
          player.playVideo();
          return;
        }

        if (event.data !== YT.PlayerState.PLAYING) return;

        // Silently pre-buffered a freshly-cued video — once it's actually
        // flowing, immediately mute-pause-rewind so the player is primed
        // and ready for the real, user-triggered play.
        if (warmingUp) {
          warmingUp = false;
          player.pauseVideo();
          player.seekTo(currentSong?.startOffset || 0, true);
          player.unMute();
          warmUpComplete = true;
          return;
        }

        // playVideo() doesn't guarantee audio starts immediately — a freshly
        // cued video often needs to buffer first, especially on the very
        // first play. Only start the reveal timer once YouTube confirms
        // playback has actually begun, instead of assuming it's instant.
        if (playbackArmed) {
          playbackArmed = false;
          beginSnippetTimer();
        }
      },
    },
  });
};

function setActiveTierButtons(tier) {
  document.querySelectorAll('.difficulty-btn, .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tier === tier);
  });
}

function selectTier(tier) {
  currentTier = tier;
  setActiveTierButtons(tier);
  applyAccent(tier);
  newRound();
}

function newRound() {
  currentPool = allSongs.filter((s) => s.tier === currentTier);
  if (currentPool.length === 0) return;
  currentSong = currentPool[Math.floor(Math.random() * currentPool.length)];
  attemptIndex = 0;
  ended = false;
  clearTimeout(snippetTimer);
  playBtn.classList.remove('playing');
  playbackArmed = false;
  audioPlaying = false;
  warmingUp = false;
  pendingWarmUp = false;
  warmUpComplete = false;
  playStartTime = null;
  if (playerReady) player.pauseVideo();
  guessInput.value = '';
  suggestionsList.classList.add('hidden');

  resultPanel.classList.add('hidden');
  document.querySelector('.guess-row').classList.remove('hidden');
  snippetWrap.classList.remove('hidden');
  playWrap.classList.remove('hidden');

  if (playerReady) {
    player.cueVideoById(currentSong.videoId);
    pendingWarmUp = true;
  } else {
    pendingVideoId = currentSong.videoId;
  }

  updateSnippetUI();
}

function currentAttemptStats() {
  const duration = REVEAL_DURATIONS[Math.min(attemptIndex, REVEAL_DURATIONS.length - 1)];
  const pct = (duration / REVEAL_DURATIONS[REVEAL_DURATIONS.length - 1]) * 100;
  return { duration, pct };
}

function updateAttemptIndicators() {
  const { duration, pct } = currentAttemptStats();
  snippetLength.textContent = duration;
  markerLength.textContent = duration;
  snippetMarker.style.left = `${pct}%`;
  updateDurationGrid();
  return { duration, pct };
}

function updateSnippetUI() {
  const { pct } = updateAttemptIndicators();
  snippetFill.style.transition = 'none';
  snippetFill.style.width = `${pct}%`;
}

function playSnippet() {
  if (!playerReady || !currentSong || ended) return;
  clearTimeout(snippetTimer);

  // A real click always takes priority over an in-flight background
  // warm-up — cancel it so the upcoming PLAYING event isn't misrouted into
  // the warm-up's mute-pause-rewind cleanup instead of actually starting.
  pendingWarmUp = false;
  if (warmingUp) {
    warmingUp = false;
    player.unMute();
  }

  // Skip the redundant seek if warm-up already parked the player exactly
  // here — re-seeking to the same spot can force YouTube to re-buffer,
  // undoing the whole point of warming it up in the background. Only
  // applies to this one play — once playback moves the position, later
  // clicks (a second attempt, replaying after a manual stop) need the
  // real seek again.
  if (!warmUpComplete) {
    player.seekTo(currentSong.startOffset || 0, true);
  }
  warmUpComplete = false;
  player.playVideo();
  playBtn.classList.add('playing');
  playbackArmed = true; // beginSnippetTimer() fires once PLAYING is confirmed
  audioPlaying = false;
  playStartTime = null;

  snippetFill.style.transition = 'none';
  snippetFill.style.width = '0%';
}

// Called once YouTube's onStateChange confirms audio is actually flowing
// (not just requested) — only then do we know "duration seconds from now"
// means something real, so the reveal timer starts here, not at click time.
function beginSnippetTimer() {
  const { duration, pct } = currentAttemptStats();
  audioPlaying = true;
  playStartTime = Date.now();

  // Grow the fill live from 0 to this attempt's threshold over the snippet's
  // real duration, so it visually tracks actual playback and stops exactly
  // when the snippet cuts off.
  snippetFill.style.transition = 'none';
  snippetFill.style.width = '0%';
  void snippetFill.offsetWidth; // force reflow so the transition below re-triggers
  snippetFill.style.transition = `width ${duration}s linear`;
  snippetFill.style.width = `${pct}%`;

  snippetTimer = setTimeout(() => {
    player.pauseVideo();
    playBtn.classList.remove('playing');
    audioPlaying = false;
  }, duration * 1000);
}

// Manually stopping mid-playback (clicking the button again while it shows
// a pause icon) cancels the snippet and resets the progress back to 0,
// rather than just pausing wherever it happened to be.
function stopSnippet() {
  clearTimeout(snippetTimer);
  if (playerReady) {
    player.pauseVideo();
    player.seekTo(currentSong?.startOffset || 0, true);
  }
  playBtn.classList.remove('playing');
  playbackArmed = false;
  audioPlaying = false;
  playStartTime = null;

  snippetFill.style.transition = 'none';
  snippetFill.style.width = '0%';
}

// Called when the threshold moves (wrong guess/skip) while audio is still
// playing — extends the same continuous playback to the new cutoff instead
// of cutting it off at the old one or restarting it. If playback hasn't
// actually started yet (still buffering), there's nothing to extend —
// beginSnippetTimer() will pick up the new, already-updated duration
// whenever PLAYING does fire.
function extendSnippetPlayback() {
  if (!audioPlaying) {
    updateAttemptIndicators();
    return;
  }

  const maxDuration = REVEAL_DURATIONS[REVEAL_DURATIONS.length - 1];
  const { duration: newDuration, pct: newPct } = updateAttemptIndicators();
  const elapsed = (Date.now() - playStartTime) / 1000;
  const remaining = newDuration - elapsed;
  const currentPct = Math.min(100, (elapsed / maxDuration) * 100);

  clearTimeout(snippetTimer);
  snippetFill.style.transition = 'none';
  snippetFill.style.width = `${currentPct}%`;
  void snippetFill.offsetWidth;

  if (remaining <= 0) {
    player.pauseVideo();
    playBtn.classList.remove('playing');
    audioPlaying = false;
    snippetFill.style.width = `${newPct}%`;
    return;
  }

  snippetFill.style.transition = `width ${remaining}s linear`;
  snippetFill.style.width = `${newPct}%`;
  snippetTimer = setTimeout(() => {
    player.pauseVideo();
    playBtn.classList.remove('playing');
    audioPlaying = false;
  }, remaining * 1000);
}

function submitGuess(rawGuess) {
  if (ended || !currentSong) return;
  suggestionsList.classList.add('hidden');

  if (isCorrectGuess(rawGuess, currentSong)) {
    endRound(true);
    return;
  }

  attemptIndex += 1;
  guessInput.value = '';
  if (attemptIndex >= REVEAL_DURATIONS.length) {
    endRound(false);
    return;
  }

  if (playBtn.classList.contains('playing')) {
    extendSnippetPlayback();
  } else {
    updateSnippetUI();
  }
}

function endRound(success) {
  ended = true;
  clearTimeout(snippetTimer);
  playBtn.classList.remove('playing');
  playbackArmed = false;
  audioPlaying = false;
  playStartTime = null;
  if (playerReady) player.pauseVideo();

  document.querySelector('.guess-row').classList.add('hidden');
  snippetWrap.classList.add('hidden');
  playWrap.classList.add('hidden');
  resultPanel.classList.remove('hidden');
  resultPanel.classList.toggle('won', success);
  resultPanel.classList.toggle('lost', !success);

  resultThumb.src = `https://img.youtube.com/vi/${currentSong.videoId}/hqdefault.jpg`;
  resultThumbLink.href = `https://youtu.be/${currentSong.videoId}`;
  resultTitle.textContent = currentSong.title;
  resultSubtitle.textContent = `${currentSong.artist} · ${currentSong.title}`;
  resultPill.textContent = success ? 'GOT IT!' : 'LOST!';
}

playBtn.addEventListener('click', () => {
  if (playBtn.classList.contains('playing')) {
    stopSnippet();
  } else {
    playSnippet();
  }
});
submitGuessBtn.addEventListener('click', () => submitGuess(guessInput.value.trim()));
guessInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitGuess(guessInput.value.trim());
  if (e.key === 'Escape') suggestionsList.classList.add('hidden');
});
guessInput.addEventListener('input', renderSuggestions);
guessInput.addEventListener('focus', renderSuggestions);
guessInput.addEventListener('blur', () => suggestionsList.classList.add('hidden'));
skipBtn.addEventListener('click', () => submitGuess(''));
playAgainBtn.addEventListener('click', newRound);
rerollBtn.addEventListener('click', newRound);

volumeSlider.addEventListener('input', () => {
  const vol = Number(volumeSlider.value);
  pendingVolume = vol;
  if (playerReady) player.setVolume(vol);
});

document.querySelectorAll('.difficulty-btn, .pill').forEach((btn) => {
  btn.addEventListener('click', () => selectTier(btn.dataset.tier));
});

buildSnippetTicks();
buildDurationGrid();
loadSongs();


'use strict';

const CLIENT_ID    = (typeof CONFIG !== 'undefined' && CONFIG.GOOGLE_CLIENT_ID) || '';
const PLAYLIST_KEY = 'sakura_playlist_v4';
const OAUTH_KEY    = 'sakura_oauth_v2';
const USER_KEY     = 'sakura_user_v1';
const YT_SCOPE     = 'https://www.googleapis.com/auth/youtube.readonly profile';
const YT_API       = 'https://www.googleapis.com/youtube/v3/search';
const USERINFO_API = 'https://www.googleapis.com/oauth2/v3/userinfo';

const GENRES = [
  { label: 'Pop',        query: 'pop hits 2024',            bg: '#e91e8c' },
  { label: 'Hip-Hop',    query: 'hip hop music 2024',       bg: '#ff5722' },
  { label: 'Electronic', query: 'electronic music 2024',    bg: '#00bcd4' },
  { label: 'Rock',       query: 'rock songs 2024',          bg: '#b71c1c' },
  { label: 'R&B',        query: 'rnb soul music 2024',      bg: '#7b1fa2' },
  { label: 'Jazz',       query: 'jazz chill music',         bg: '#00695c' },
  { label: 'Classical',  query: 'classical music relaxing', bg: '#4e342e' },
  { label: 'Lofi',       query: 'lofi hip hop beats',       bg: '#283593' },
  { label: 'K-Pop',      query: 'kpop music 2024',          bg: '#c2185b' },
  { label: 'Workout',    query: 'gym workout music',        bg: '#e65100' },
  { label: 'Sleep',      query: 'relaxing sleep music',     bg: '#1a237e' },
  { label: 'Focus',      query: 'focus study beats',        bg: '#1b5e20' },
];

let accessToken   = null;
let tokenExpiry   = 0;
let tokenClient   = null;
let pendingSearch = null;
let isLoggedIn    = false;

let ytPlayer, playerReady = false;
let pendingPlay  = null;
let isPlaying    = false;
let currentTrack = null;
let currentIndex = -1;
let playlist     = [];
let searchResults = [];
let shuffleOn     = false;
let repeatOn      = false;
let volume        = 70;
let progressInterval;
let wakeLock      = null;

let badVideos     = new Set();   
let skipBusy      = false;       
let autoSkipTimer = null;

const searchCache = new Map();   
const CACHE_MAX   = 30;

let recommendationQueue = [];  
let playHistory = [];          
const HISTORY_MAX = 30;
let recommendationFetching = false;
const LISTEN_HISTORY_KEY = 'sakura_listen_history_v1';
const HOME_CACHE_KEY     = 'sakura_home_cache_v1';

try { playlist = JSON.parse(localStorage.getItem(PLAYLIST_KEY)) || []; } catch(e) { playlist = []; }
try { playHistory = JSON.parse(localStorage.getItem(LISTEN_HISTORY_KEY)) || []; } catch(e) { playHistory = []; }


function saveOAuthData(resp) {
  const data = {
    access_token: resp.access_token,
    expiry: Date.now() + (resp.expires_in - 60) * 1000,
  };
  try { localStorage.setItem(OAUTH_KEY, JSON.stringify(data)); } catch(e) {}
  accessToken = data.access_token;
  tokenExpiry = data.expiry;
}

function loadStoredToken() {
  try {
    const data = JSON.parse(localStorage.getItem(OAUTH_KEY));
    if (data?.access_token && Date.now() < data.expiry) {
      accessToken = data.access_token;
      tokenExpiry = data.expiry;
      return true;
    }
  } catch(e) {}
  return false;
}

function clearAuthData() {
  accessToken = null; tokenExpiry = 0; isLoggedIn = false;
  try { localStorage.removeItem(OAUTH_KEY); localStorage.removeItem(USER_KEY); } catch(e) {}
}


function loadStoredUserInfo() {
  try {
    const user = JSON.parse(localStorage.getItem(USER_KEY));
    if (user) { updateUserUI(user); return true; }
  } catch(e) {}
  return false;
}

async function fetchAndCacheUserInfo() {
  try {
    const res  = await fetch(USERINFO_API, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) return;
    const data = await res.json();
    const user = {
      name:     data.name    || data.email || 'User',
      avatar:   data.picture || '',
      initials: (data.name || 'U').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase(),
    };
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch(e) {}
    updateUserUI(user);
  } catch(e) { console.warn('User info fetch failed:', e); }
}

function updateUserUI(user) {
  isLoggedIn = true;
  const avatarHTML = user.avatar
    ? `<img src="${escHtml(user.avatar)}" alt="${escHtml(user.initials || 'U')}">`
    : (user.initials || 'U');

  const loggedOut = document.getElementById('userLoggedOut');
  const loggedIn  = document.getElementById('userLoggedIn');
  const avatar    = document.getElementById('userAvatar');
  const name      = document.getElementById('userName');
  if (loggedOut) loggedOut.style.display = 'none';
  if (loggedIn)  loggedIn.style.display  = 'flex';
  if (avatar)    avatar.innerHTML = avatarHTML;
  if (name)      name.textContent = user.name;

  const grid = document.getElementById('tracksGrid');
  if (grid?.querySelector('.login-prompt-main')) renderBrowse();
}

function resetToLoggedOut() {
  const loggedOut = document.getElementById('userLoggedOut');
  const loggedIn  = document.getElementById('userLoggedIn');
  if (loggedOut) loggedOut.style.display = '';
  if (loggedIn)  loggedIn.style.display  = 'none';
  renderBrowse();
}


let toastTimer;
function showToast(msg, dur = 2800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}


function injectSidebarUserSection() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  const logo    = sidebar.querySelector('.logo');
  const userDiv = document.createElement('div');
  userDiv.className = 'user-section';
  userDiv.innerHTML = `
    <div class="user-logged-out" id="userLoggedOut">
      <button class="login-btn" id="loginBtn">
        ${googleSVG(18)} Sign in with Google
      </button>
    </div>
    <div class="user-logged-in" id="userLoggedIn">
      <div class="user-avatar" id="userAvatar">?</div>
      <div class="user-info">
        <div class="user-name" id="userName">Loading…</div>
        <button class="sign-out-btn" id="signOutBtn">Sign out</button>
      </div>
    </div>`;
  logo.after(userDiv);

  const oldLabel = sidebar.querySelector('.sidebar-label');
  if (oldLabel) {
    const header = document.createElement('div');
    header.className = 'sidebar-library-header';
    header.innerHTML = `
      <span class="sidebar-label">Your Library</span>
      <span class="sidebar-count" id="sidebarCount">0</span>`;
    oldLabel.replaceWith(header);
  }

  document.getElementById('loginBtn')?.addEventListener('click', triggerLogin);
  document.getElementById('signOutBtn')?.addEventListener('click', signOut);
}

function injectMobileLibraryUserSection() {
  const lv = document.getElementById('libraryView');
  if (!lv) return;
  const oldLabel = lv.querySelector('.sidebar-label');
  if (oldLabel) {
    const header = document.createElement('div');
    header.className = 'library-mobile-header';
    header.textContent = 'Your Library';
    oldLabel.replaceWith(header);
  }
}

function googleSVG(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>`;
}


function initGIS() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope:     YT_SCOPE,
    callback:  onTokenResponse,
  });

  if (loadStoredToken()) {
    loadStoredUserInfo();
    isLoggedIn = true;
    scheduleSilentRefresh();
  }
}

function onTokenResponse(resp) {
  if (resp.error) {
    if (resp.error !== 'access_denied') showToast('Sign-in failed: ' + resp.error);
    return;
  }
  saveOAuthData(resp);
  isLoggedIn = true;
  showToast('Signed in! 🎵');
  fetchAndCacheUserInfo();
  scheduleSilentRefresh();

  if (pendingSearch) {
    const q = pendingSearch; pendingSearch = null;
    searchYouTube(q);
  } else {
    const grid = document.getElementById('tracksGrid');
    if (grid?.querySelector('.login-prompt-main')) renderBrowse();
  }
}

function triggerLogin() {
  if (!tokenClient) { showToast('Auth not ready, please try again.'); return; }
  tokenClient.requestAccessToken({ prompt: '' });
}

function signOut() {
  clearAuthData();
  if (typeof google !== 'undefined' && google.accounts?.oauth2 && accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  resetToLoggedOut();
  showToast('Signed out');
}

function ensureToken(query) {
  if (accessToken && Date.now() < tokenExpiry) return true;
  pendingSearch = query;
  triggerLogin();
  return false;
}

function scheduleSilentRefresh() {
  const ms = tokenExpiry - Date.now() - 5 * 60 * 1000;
  if (ms <= 0) return;
  setTimeout(() => tokenClient?.requestAccessToken({ prompt: '' }), ms);
}

window.addEventListener('load', () => {
  const tryInit = () => {
    if (typeof google !== 'undefined' && google.accounts?.oauth2) initGIS();
    else setTimeout(tryInit, 200);
  };
  tryInit();
});


function renderShimmer(count = 12) {
  const grid = document.getElementById('tracksGrid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-thumb shimmer"></div>
      <div class="skeleton-line shimmer"></div>
      <div class="skeleton-line short shimmer"></div>
      <div class="skeleton-line shorter shimmer"></div>
    </div>`).join('');
}


function renderBrowse() {
  const grid  = document.getElementById('tracksGrid');
  const title = document.getElementById('sectionTitle');
  if (!grid) return;

  grid.classList.add('home-mode');

  if (!isLoggedIn) {
    if (title) title.textContent = 'Welcome to Sakura';
    grid.innerHTML = `
      <div class="login-prompt-main">
        <div class="lpm-icon">🎵</div>
        <h2>Your music, everywhere</h2>
        <p>Sign in with Google to search YouTube Music and build your personal library of favourites.</p>
        <button class="login-btn-main" id="loginBtnMain">
          ${googleSVG(20)} Sign in with Google
        </button>
      </div>`;
    document.getElementById('loginBtnMain')?.addEventListener('click', triggerLogin);
    return;
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const userName = document.getElementById('userName')?.textContent || '';
  if (title) title.textContent = userName ? `${greeting}, ${userName.split(' ')[0]}` : greeting;

  let html = '';

  if (playlist.length > 0) {
    const recent = playlist.slice(-6).reverse();
    html += `<div class="home-section">
      <div class="home-section-title">Recently Saved</div>
      <div class="home-row">${recent.map(t => homeTrackCard(t)).join('')}</div>
    </div>`;
  }

  html += `<div class="home-section">
    <div class="home-section-title">Browse All</div>
    <div class="browse-grid">${
      GENRES.map(g => `
        <div class="genre-card" data-query="${escHtml(g.query)}" style="background:${g.bg}">
          <span class="genre-label">${escHtml(g.label)}</span>
        </div>`).join('')
    }</div>
  </div>`;

  if (playlist.length >= 2) {
    const artists = extractTopArtists(playlist, 4);
    if (artists.length > 0) {
      html += `<div class="home-section">
        <div class="home-section-title">Made For You</div>
        <div class="home-artist-row">${artists.map(a => `
          <div class="home-artist-card" data-query="${escHtml(a.name + ' songs')}">
            <div class="home-artist-art">${a.thumb ? `<img src="${escHtml(a.thumb)}" alt="">` : `<div class="home-artist-initial">${escHtml(a.name[0])}</div>`}</div>
            <div class="home-artist-name">${escHtml(a.name)}</div>
            <div class="home-artist-sub">Artist</div>
          </div>`).join('')}
        </div>
      </div>`;
    }
  }

  const mixQueries = buildPersonalMixes();
  if (mixQueries.length > 0) {
    html += `<div class="home-section">
      <div class="home-section-title">Your Mixes</div>
      <div class="home-mix-row">${mixQueries.map((m, i) => `
        <div class="home-mix-card" data-query="${escHtml(m.query)}" style="--mix-hue:${(i * 60 + 140) % 360}">
          <div class="home-mix-art">${m.emoji}</div>
          <div class="home-mix-title">${escHtml(m.label)}</div>
          <div class="home-mix-desc">${escHtml(m.desc)}</div>
        </div>`).join('')}
      </div>
    </div>`;
  }

  grid.innerHTML = html || '<div class="status-msg">Search for your favourite music 🌸</div>';

  grid.querySelectorAll('.genre-card').forEach(card => {
    card.addEventListener('click', () => {
      const q = card.dataset.query;
      const input = document.getElementById('searchInput');
      const label = GENRES.find(g => g.query === q)?.label || q;
      if (input) input.value = label;
      searchYouTube(q);
    });
  });

  grid.querySelectorAll('.home-track-card').forEach(card => {
    card.addEventListener('click', () => {
      const t = playlist.find(x => x.videoId === card.dataset.videoid);
      if (t) playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
    });
  });

  grid.querySelectorAll('.home-artist-card, .home-mix-card').forEach(card => {
    card.addEventListener('click', () => {
      const q = card.dataset.query;
      const input = document.getElementById('searchInput');
      if (input) input.value = q;
      searchYouTube(q);
    });
  });

  if (playlist.length > 0 && accessToken) {
    loadPersonalizedSection(grid);
  }
}

function homeTrackCard(t) {
  const thumb = t.thumbUrl ? `<img src="${escHtml(t.thumbUrl)}" alt="" loading="lazy">` : '🎵';
  const active = currentTrack?.videoId === t.videoId;
  return `<div class="home-track-card${active ? ' active' : ''}" data-videoid="${t.videoId}">
    <div class="home-track-art">${thumb}</div>
    <div class="home-track-info">
      <div class="home-track-title">${escHtml(t.title)}</div>
      <div class="home-track-ch">${escHtml(t.channel)}</div>
    </div>
  </div>`;
}

function extractTopArtists(tracks, max = 4) {
  const map = new Map();
  tracks.forEach(t => {
    const name = t.channel.replace(/\s*-\s*Topic$/i,'').replace(/VEVO$/i,'').replace(/Official$/i,'').trim();
    if (!map.has(name)) {
      map.set(name, { name, thumb: t.thumbUrl, count: 1 });
    } else {
      map.get(name).count++;
    }
  });
  return [...map.values()].sort((a,b) => b.count - a.count).slice(0, max);
}

function buildPersonalMixes() {
  if (playlist.length < 2) return [];
  const artists = extractTopArtists(playlist, 6);
  const mixes = [];
  if (artists[0]) mixes.push({ query: `${artists[0].name} mix songs`, label: `${artists[0].name} Mix`, desc: artists.slice(0,3).map(a=>a.name).join(', '), emoji: '💿' });
  if (artists[1]) mixes.push({ query: `${artists[1].name} similar artists`, label: `Discover Mix`, desc: 'Based on your taste', emoji: '🎧' });
  mixes.push({ query: 'trending music 2024 hits', label: 'Trending Now', desc: 'What\'s hot right now', emoji: '🔥' });
  mixes.push({ query: 'chill vibes lofi relax', label: 'Chill Mix', desc: 'Relax & unwind', emoji: '🌙' });
  return mixes;
}

async function loadPersonalizedSection(grid) {
  if (!accessToken || playlist.length === 0) return;

  const artists = extractTopArtists(playlist, 3);
  if (!artists.length) return;
  const pick = artists[Math.floor(Math.random() * artists.length)];
  const query = `${pick.name} songs similar`;

  try {
    const params = new URLSearchParams({
      part: 'snippet', maxResults: '8', type: 'video',
      q: query, videoCategoryId: '10',
    });
    const res = await fetch(`${YT_API}?${params}`, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!res.ok) return;
    const data = await res.json();
    const items = (data.items || []).map(item => ({
      videoId:  item.id.videoId,
      title:    item.snippet.title,
      channel:  item.snippet.channelTitle,
      thumbUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    })).filter(t => !playlist.some(p => p.videoId === t.videoId));

    if (items.length < 2) return;

    const browseSection = grid.querySelector('.browse-grid')?.closest('.home-section');
    if (!browseSection) return;

    const recDiv = document.createElement('div');
    recDiv.className = 'home-section home-section-animated';
    recDiv.innerHTML = `
      <div class="home-section-title">Recommended For You</div>
      <div class="home-row">${items.slice(0,6).map(t => `
        <div class="home-track-card" data-videoid="${t.videoId}">
          <div class="home-track-art">${t.thumbUrl ? `<img src="${escHtml(t.thumbUrl)}" alt="" loading="lazy">` : '🎵'}</div>
          <div class="home-track-info">
            <div class="home-track-title">${escHtml(t.title)}</div>
            <div class="home-track-ch">${escHtml(t.channel)}</div>
          </div>
        </div>`).join('')}
      </div>`;

    browseSection.before(recDiv);

    recDiv.querySelectorAll('.home-track-card').forEach(card => {
      card.addEventListener('click', () => {
        const t = items.find(x => x.videoId === card.dataset.videoid);
        if (t) playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
      });
    });

    recommendationQueue.push(...items.filter(t => !recommendationQueue.some(q => q.videoId === t.videoId)).slice(0, 4));
  } catch(e) { console.warn('Personalized section failed:', e); }
}


async function searchYouTube(query) {
  if (!ensureToken(query)) return;

  const grid  = document.getElementById('tracksGrid');
  const title = document.getElementById('sectionTitle');
  if (!grid) return;

  grid.classList.remove('home-mode');

  hideSuggestions();
  if (title) title.textContent = `"${query}"`;

  const cacheKey = query.toLowerCase().trim();
  if (searchCache.has(cacheKey)) {
    searchResults = searchCache.get(cacheKey);
    badVideos = new Set();
    renderGrid(searchResults);
    return;
  }

  renderShimmer(12);
  badVideos = new Set();

  try {
    const params = new URLSearchParams({
      part:       'snippet',
      maxResults: '24',
      type:       'video',
      q:          query,
    });

    const res = await fetch(`${YT_API}?${params}`, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });

    if (res.status === 401) {
      accessToken = null; tokenExpiry = 0;
      try { localStorage.removeItem(OAUTH_KEY); } catch(e) {}
      pendingSearch = query;
      grid.innerHTML = `<div class="status-msg loading">Reconnecting…</div>`;
      triggerLogin();
      return;
    }

    const data = await res.json();

    if (data.error) {
      const msg  = data.error.message || 'Unknown error';
      const code = data.error.code    || 0;
      grid.innerHTML = code === 403
        ? `<div class="status-msg">⚠️ YouTube quota reached — try again later.<br><small style="color:#555;">${escHtml(msg)}</small></div>`
        : `<div class="status-msg">Search error: ${escHtml(msg)}</div>`;
      return;
    }

    searchResults = (data.items || []).map(item => ({
      videoId:  item.id.videoId,
      title:    item.snippet.title,
      channel:  item.snippet.channelTitle,
      thumbUrl: item.snippet.thumbnails?.medium?.url
                  || item.snippet.thumbnails?.default?.url || '',
    }));

    if (!searchResults.length) {
      grid.innerHTML = '<div class="status-msg">No results found. Try a different search.</div>';
      return;
    }

    if (searchCache.size >= CACHE_MAX) {
      searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(cacheKey, searchResults);

    renderGrid(searchResults);

  } catch(err) {
    console.error('Search error:', err);
    grid.innerHTML = `<div class="status-msg">Network error — check your connection and try again.</div>`;
  }
}


function renderGrid(tracks) {
  const grid = document.getElementById('tracksGrid');
  if (!grid) return;
  if (!tracks.length) {
    grid.innerHTML = '<div class="status-msg">No results found.</div>';
    return;
  }

  grid.innerHTML = tracks.map(t => {
    const saved      = playlist.some(x => x.videoId === t.videoId);
    const nowPlaying = currentTrack?.videoId === t.videoId;
    const isBad      = badVideos.has(t.videoId);
    const thumbHTML  = t.thumbUrl
      ? `<img src="${escHtml(t.thumbUrl)}" alt="" loading="lazy">`
      : `<div class="tc-thumb-placeholder">🎵</div>`;

    return `
      <div class="track-card${nowPlaying ? ' now-playing' : ''}${isBad ? ' unplayable' : ''}"
           data-videoid="${t.videoId}">
        ${isBad ? '<div class="unplayable-badge">UNAVAILABLE</div>' : ''}
        <div class="tc-thumb">
          ${thumbHTML}
          <div class="play-overlay">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        </div>
        <div class="tc-title">${escHtml(t.title)}</div>
        <div class="tc-channel">${escHtml(t.channel)}</div>
        <div class="tc-actions">
          <div class="save-pill${saved ? ' saved' : ''}" data-videoid="${t.videoId}">
            ${saved ? '✓ Saved' : '+ Save'}
          </div>
          <div class="share-pill" data-videoid="${t.videoId}" data-title="${escHtml(t.title)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            Share
          </div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.track-card:not(.unplayable)').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.save-pill') || e.target.closest('.share-pill')) return;
      const t = tracks.find(x => x.videoId === card.dataset.videoid);
      if (t) playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
    });
  });

  grid.querySelectorAll('.save-pill').forEach(pill => {
    pill.addEventListener('click', e => {
      e.stopPropagation();
      const videoId = pill.dataset.videoid;
      const track   = tracks.find(x => x.videoId === videoId);
      if (!track) return;
      const idx = playlist.findIndex(x => x.videoId === videoId);
      if (idx >= 0) {
        playlist.splice(idx, 1);
        pill.textContent = '+ Save';
        pill.classList.remove('saved');
        showToast('Removed from library');
      } else {
        playlist.push({ ...track });
        pill.textContent = '✓ Saved';
        pill.classList.add('saved');
        showToast('Saved to library ✓');
      }
      currentIndex = playlist.findIndex(x => currentTrack && x.videoId === currentTrack.videoId);
      if (currentTrack?.videoId === videoId) setHeartState(idx < 0);
      savePlaylist();
    });
  });

  grid.querySelectorAll('.share-pill').forEach(pill => {
    pill.addEventListener('click', e => {
      e.stopPropagation();
      shareSong(pill.dataset.videoid, pill.dataset.title);
    });
  });
}


let suggestDebounce;
let currentSuggest = '';
const searchInput    = document.getElementById('searchInput');
const suggestionsBox = document.getElementById('suggestionsBox');

if (searchInput) {
  searchInput.addEventListener('input', () => {
    const val = searchInput.value.trim();
    currentSuggest = val;
    clearTimeout(suggestDebounce);
    if (val.length < 2) { hideSuggestions(); return; }
    suggestDebounce = setTimeout(() => fetchSuggestions(val), 280);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      hideSuggestions();
      const q = searchInput.value.trim();
      if (q) searchYouTube(q);
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });
}

document.addEventListener('click', e => {
  if (!e.target.closest('.search-container')) hideSuggestions();
});

function hideSuggestions() {
  if (!suggestionsBox) return;
  suggestionsBox.classList.remove('open');
  suggestionsBox.innerHTML = '';
}

function fetchSuggestions(query) {
  const cbName = `_yt_sg_${Date.now()}`;
  document.getElementById('suggest-script')?.remove();
  window[cbName] = data => {
    delete window[cbName];
    document.getElementById('suggest-script')?.remove();
    if (query !== currentSuggest) return;
    showSuggestions((data[1] || []).map(x => x[0]).slice(0, 7));
  };
  const script = document.createElement('script');
  script.id    = 'suggest-script';
  script.src   = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(query)}&callback=${cbName}`;
  script.onerror = () => { delete window[cbName]; };
  document.head.appendChild(script);
}

function showSuggestions(items) {
  if (!items.length || !suggestionsBox) { hideSuggestions(); return; }
  suggestionsBox.innerHTML = items.map(s => `
    <div class="suggestion-item" data-q="${escHtml(s)}" role="option">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <span>${escHtml(s)}</span>
    </div>`).join('');
  suggestionsBox.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      const q = el.dataset.q;
      if (searchInput) searchInput.value = q;
      hideSuggestions();
      searchYouTube(q);
    });
  });
  suggestionsBox.classList.add('open');
}

document.getElementById('searchBtn')?.addEventListener('click', () => {
  const q = searchInput?.value.trim();
  if (q) searchYouTube(q);
});


let playerInitRetries = 0;
const MAX_PLAYER_RETRIES = 3;

(function() {
  setTimeout(dismissLoadingOverlay, 800);
})();

function onYouTubeIframeAPIReady() {
  createPlayer();
}

function createPlayer() {
  try {
    const oldEl = document.getElementById('player');
    if (oldEl && oldEl.tagName === 'IFRAME') {
      const div = document.createElement('div');
      div.id = 'player';
      oldEl.replaceWith(div);
    }

    ytPlayer = new YT.Player('player', {
      height: '1', width: '1',
      playerVars: {
        autoplay: 1, controls: 0, rel: 0, modestbranding: 1,
        playsinline: 1, enablejsapi: 1, fs: 0, disablekb: 1,
        origin: location.origin || location.hostname || 'localhost',
      },
      events: {
        onReady:       onPlayerReady,
        onStateChange: onStateChange,
        onError:       onPlayerError,
      },
    });

    setTimeout(() => {
      if (!playerReady && playerInitRetries < MAX_PLAYER_RETRIES) {
        playerInitRetries++;
        console.warn('Player init timeout, retrying... attempt', playerInitRetries);
        createPlayer();
      }
    }, 10000);
  } catch(e) {
    console.error('Player creation failed:', e);
    if (playerInitRetries < MAX_PLAYER_RETRIES) {
      playerInitRetries++;
      setTimeout(createPlayer, 2000);
    }
  }
}

function onPlayerReady() {
  playerReady = true;
  if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
    try { ytPlayer.setVolume(volume); } catch(e) { console.warn("Failed to set volume on init:", e); }
  }
  dismissLoadingOverlay();

  if (pendingPlay) {
    const t = pendingPlay;
    pendingPlay = null;
    playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
  }
}

let waitPollTimer = null;
function waitForPlayerAndPlay() {
  clearInterval(waitPollTimer);
  let attempts = 0;
  const MAX_ATTEMPTS = 40; 
  waitPollTimer = setInterval(() => {
    attempts++;
    if (playerReady && ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
      clearInterval(waitPollTimer);
      if (pendingPlay) {
        const t = pendingPlay;
        pendingPlay = null;
        console.log('Player ready after wait, playing:', t.videoId);
        try {
          ytPlayer.loadVideoById({ videoId: t.videoId, startSeconds: 0 });
        } catch(e) {
          console.error('Retry play failed:', e);
        }
      }
    } else if (attempts >= MAX_ATTEMPTS) {
      clearInterval(waitPollTimer);
      if (playerInitRetries < MAX_PLAYER_RETRIES) {
        playerInitRetries++;
        createPlayer();
      } else {
        showToast('Could not load player. Please refresh.');
      }
    }
  }, 250);
}

function dismissLoadingOverlay() {
  const overlay = document.getElementById('playerLoadingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 500);
  }
}

function onPlayerError(e) {
  console.warn('YT player error:', e.data);
  if (skipBusy) return;
  skipBusy = true;

  if (currentTrack) {
    badVideos.add(currentTrack.videoId);
    markGridCardUnplayable(currentTrack.videoId);
  }

  clearTimeout(autoSkipTimer);
  autoSkipTimer = setTimeout(() => {
    skipBusy = false;
    autoSkipToNext();
  }, 600);
}

function markGridCardUnplayable(videoId) {
  document.querySelectorAll(`.track-card[data-videoid="${videoId}"]`).forEach(card => {
    card.classList.add('unplayable');
    if (!card.querySelector('.unplayable-badge')) {
      const badge = document.createElement('div');
      badge.className = 'unplayable-badge';
      badge.textContent = 'UNAVAILABLE';
      card.prepend(badge);
    }
  });
}

function autoSkipToNext() {
  if (playlist.length > 0 && currentIndex >= 0) {
    let tried = 0;
    let idx   = (currentIndex + 1) % playlist.length;
    while (tried < playlist.length) {
      if (!badVideos.has(playlist[idx].videoId)) {
        const t = playlist[idx];
        playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
        return;
      }
      idx = (idx + 1) % playlist.length;
      tried++;
    }
  }
  if (searchResults.length > 0) {
    const base = searchResults.findIndex(t => currentTrack && t.videoId === currentTrack.videoId);
    let idx    = (base + 1) % searchResults.length;
    let tried  = 0;
    while (tried < searchResults.length) {
      if (!badVideos.has(searchResults[idx].videoId)) {
        const t = searchResults[idx];
        playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
        return;
      }
      idx = (idx + 1) % searchResults.length;
      tried++;
    }
  }
  showToast('No playable tracks found');
}

function onStateChange(e) {
  const S = YT.PlayerState;
  switch (e.data) {
    case S.PLAYING:
      skipBusy = false;
      isPlaying = true;
      updateAllPlayBtns(true);
      startProgress();
      updateMediaSession(true);
      updateNpArtPlaying(true);
      requestWakeLock();
      break;
    case S.PAUSED:
      isPlaying = false;
      updateAllPlayBtns(false);
      stopProgress();
      updateMediaSession(false);
      updateNpArtPlaying(false);
      break;
    case S.ENDED:
      isPlaying = false;
      updateAllPlayBtns(false);
      stopProgress();
      updateNpArtPlaying(false);
      releaseWakeLock();
      onTrackEnd();
      break;
  }
}

function onTrackEnd() {
  if (repeatOn && currentTrack) { ytPlayer.seekTo(0); ytPlayer.playVideo(); return; }
  playNext();
}


function playTrack(videoId, title, channel, thumbUrl) {
  if (!videoId) return;
  if (badVideos.has(videoId)) {
    showToast('That track is unavailable, skipping…');
    autoSkipToNext();
    return;
  }

  currentTrack = { videoId, title, channel, thumbUrl };
  currentIndex = playlist.findIndex(t => t.videoId === videoId);

  playHistory = playHistory.filter(id => id !== videoId); 
  playHistory.unshift(videoId);
  if (playHistory.length > HISTORY_MAX) playHistory = playHistory.slice(0, HISTORY_MAX);
  try { localStorage.setItem(LISTEN_HISTORY_KEY, JSON.stringify(playHistory)); } catch(e) {}

  updateNowPlayingUI(title, channel, thumbUrl, videoId);
  setupMediaSession(currentTrack);
  renderPlaylistPanel();
  renderPlaylistPanelMobile();

  prefetchRecommendations(title, channel, videoId);

  if (!playerReady || !ytPlayer || typeof ytPlayer.loadVideoById !== 'function') {
    console.warn("Player not fully ready yet. Queueing track:", videoId);
    pendingPlay = { videoId, title, channel, thumbUrl };
    waitForPlayerAndPlay();
    return;
  }

  pendingPlay = null;

  try {
    ytPlayer.loadVideoById({ videoId, startSeconds: 0 });
  } catch(e) {
    console.error("loadVideoById failed, will retry:", e);
    pendingPlay = { videoId, title, channel, thumbUrl };
    waitForPlayerAndPlay();
  }
}

function updateNowPlayingUI(title, channel, thumbUrl, videoId) {
  const imgHTML = thumbUrl
    ? `<img src="${escHtml(thumbUrl)}" alt="" loading="lazy">`
    : '🎵';

  setEl('npArt',          imgHTML);
  setTxt('npTitle',       title);
  setTxt('npChannel',     channel);
  setEl('npArtBig',       imgHTML);
  setTxt('npMetaTitle',   title);
  setTxt('npMetaChannel', channel);
  setEl('miniArt',        imgHTML);
  setTxt('miniTitle',     title);
  setTxt('miniChannel',   channel);

  const mini = document.getElementById('miniPlayer');
  if (mini) mini.style.display = 'flex';

  setHeartState(playlist.some(t => t.videoId === videoId));
  highlightSidebarTrack(videoId);
  highlightGridCard(videoId);
  setProgress(0, 0, 0);

  if (thumbUrl) applyArtworkGradient(thumbUrl);
}

function setEl(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setTxt(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

function setHeartState(liked) {
  ['heartBtn','npHeartBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = liked ? '♥' : '♡';
    btn.classList.toggle('liked', liked);
  });
}

function highlightSidebarTrack(videoId) {
  document.querySelectorAll('.playlist-track').forEach(el =>
    el.classList.toggle('active', el.dataset.videoid === videoId));
}

function highlightGridCard(videoId) {
  document.querySelectorAll('.track-card').forEach(el =>
    el.classList.toggle('now-playing', el.dataset.videoid === videoId));
}

function updateAllPlayBtns(playing) {
  const pause = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const play  = '<polygon points="5 3 19 12 5 21 5 3"/>';
  ['playIcon','npPlayIcon','miniPlayIcon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = playing ? pause : play;
  });
}

function updateNpArtPlaying(playing) {
  document.getElementById('npArtBig')?.classList.toggle('playing', playing);
}


let gradientCanvas, gradientCtx;
function applyArtworkGradient(thumbUrl) {
  const sheet = document.getElementById('npSheet');
  if (!sheet) return;

  if (!gradientCanvas) {
    gradientCanvas = document.createElement('canvas');
    gradientCanvas.width  = 4;
    gradientCanvas.height = 4;
    gradientCtx = gradientCanvas.getContext('2d');
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      gradientCtx.drawImage(img, 0, 0, 4, 4);
      const d = gradientCtx.getImageData(0, 0, 4, 4).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < 32; i += 4) {  
        r += d[i]; g += d[i+1]; b += d[i+2]; count++;
      }
      r = Math.round(r/count); g = Math.round(g/count); b = Math.round(b/count);

      const dr = Math.round(r * 0.35);
      const dg = Math.round(g * 0.35);
      const db = Math.round(b * 0.35);

      sheet.style.background =
        `linear-gradient(180deg, rgb(${dr},${dg},${db}) 0%, #0a0a0a 55%, #000 100%)`;

      document.getElementById('npArtBig')?.style.setProperty(
        '--art-glow', `rgba(${r},${g},${b},0.3)`);
    } catch(e) {
      sheet.style.background = 'linear-gradient(180deg, #1a3020 0%, #0a0a0a 55%, #000 100%)';
    }
  };
  img.onerror = () => {
    sheet.style.background = 'linear-gradient(180deg, #1a3020 0%, #0a0a0a 55%, #000 100%)';
  };
  img.src = thumbUrl;
}


function startProgress() {
  stopProgress();
  progressInterval = setInterval(tickProgress, 500);
}
function stopProgress() { clearInterval(progressInterval); }

function tickProgress() {
  if (!ytPlayer || !playerReady) return;
  try {
    if (typeof ytPlayer.getCurrentTime !== 'function' || typeof ytPlayer.getDuration !== 'function') return;
    const cur = ytPlayer.getCurrentTime() || 0;
    const dur = ytPlayer.getDuration()    || 0;
    if (dur > 0) {
      const pct = (cur / dur) * 100;
      setProgress(pct, cur, dur);
      updateMediaSession(true);
      document.getElementById('playerBar')?.style.setProperty('--progress-pct', pct + '%');
    }
  } catch(e) {}
}

function setProgress(pct, cur, dur) {
  ['progressFill','npProgressFill'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = pct + '%';
  });
  setTxt('currentTime',   fmtTime(cur));
  setTxt('totalTime',     fmtTime(dur));
  setTxt('npCurrentTime', fmtTime(cur));
  setTxt('npTotalTime',   fmtTime(dur));
  const mini = document.getElementById('miniPlayer');
  if (mini) mini.style.setProperty('--progress', pct + '%');
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

function makeSeekable(barId, fillId) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  let dragging = false;
  const seek = e => {
    if (!ytPlayer || !playerReady || typeof ytPlayer.seekTo !== 'function' || typeof ytPlayer.getDuration !== 'function') return;
    const touch = e.touches ? e.touches[0] : e;
    const rect  = bar.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    try {
      ytPlayer.seekTo(pct * (ytPlayer.getDuration() || 0));
    } catch(err) { console.warn("seekTo failed:", err); }
    const fill = document.getElementById(fillId);
    if (fill) fill.style.width = (pct * 100) + '%';
  };
  bar.addEventListener('click', seek);
  bar.addEventListener('mousedown', e => { dragging = true; seek(e); });
  document.addEventListener('mousemove', e => { if (dragging) seek(e); });
  document.addEventListener('mouseup',   ()  => { dragging = false; });
  bar.addEventListener('touchstart', e => { dragging = true; seek(e); }, { passive: true });
  bar.addEventListener('touchmove',  e => { if (dragging) seek(e); },   { passive: true });
  bar.addEventListener('touchend',   ()  => { dragging = false; });
}
makeSeekable('progressBar',   'progressFill');
makeSeekable('npProgressBar', 'npProgressFill');

function makeVolume(barId) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  let dragging = false;
  const applyVol = e => {
    const touch = e.touches ? e.touches[0] : e;
    const rect = bar.getBoundingClientRect();
    volume = Math.round(Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width)) * 100);
    syncVolumeBars();
    updateVolIcon();
    if (playerReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
      try { ytPlayer.setVolume(volume); } catch(err) {}
    }
  };
  bar.addEventListener('mousedown', e => { dragging = true; applyVol(e); });
  document.addEventListener('mousemove', e => { if (dragging) applyVol(e); });
  document.addEventListener('mouseup', () => { dragging = false; });
  bar.addEventListener('click', applyVol);
  bar.addEventListener('touchstart', e => { dragging = true; applyVol(e); }, { passive: true });
  bar.addEventListener('touchmove', e => { if (dragging) applyVol(e); }, { passive: true });
  bar.addEventListener('touchend', () => { dragging = false; });
}

function updateVolIcon() {
  const icon = document.getElementById('volIcon');
  if (icon) icon.textContent = volume === 0 ? '🔇' : volume < 40 ? '🔈' : '🔊';
}

makeVolume('volBar');
makeVolume('npVolBar');

function syncVolumeBars() {
  ['volFill','npVolFill'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = volume + '%';
  });
}

const contentArea = document.getElementById('contentArea');
const topbar      = document.getElementById('topbar');
if (contentArea && topbar) {
  contentArea.addEventListener('scroll', () => {
    topbar.classList.toggle('scrolled', contentArea.scrollTop > 4);
  }, { passive: true });
}


function attachCtrl(id, fn) { document.getElementById(id)?.addEventListener('click', fn); }

attachCtrl('playPauseBtn', togglePlay);
attachCtrl('npPlayBtn',    togglePlay);
attachCtrl('miniPlayBtn', e => { e.stopPropagation(); togglePlay(); });

function togglePlay() {
  if (!currentTrack) { showToast('Search and play a track first!'); return; }
  if (!playerReady || !ytPlayer || typeof ytPlayer.pauseVideo !== 'function' || typeof ytPlayer.playVideo !== 'function') {
    if (isPlaying) {
      isPlaying = false;
      updateAllPlayBtns(false);
      pendingPlay = null;
    } else {
      isPlaying = true;
      updateAllPlayBtns(true);
      pendingPlay = { ...currentTrack };
      waitForPlayerAndPlay();
    }
    return;
  }
  try {
    if (isPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
  } catch(e) { console.warn("togglePlay failed:", e); }
}

attachCtrl('shuffleBtn',   toggleShuffle);
attachCtrl('npShuffleBtn', toggleShuffle);
function toggleShuffle() {
  shuffleOn = !shuffleOn;
  ['shuffleBtn','npShuffleBtn'].forEach(id =>
    document.getElementById(id)?.classList.toggle('active', shuffleOn));
  showToast(shuffleOn ? 'Shuffle on' : 'Shuffle off');
}

attachCtrl('repeatBtn',   toggleRepeat);
attachCtrl('npRepeatBtn', toggleRepeat);
function toggleRepeat() {
  repeatOn = !repeatOn;
  ['repeatBtn','npRepeatBtn'].forEach(id =>
    document.getElementById(id)?.classList.toggle('active', repeatOn));
  showToast(repeatOn ? 'Repeat on' : 'Repeat off');
}

attachCtrl('prevBtn',     playPrev);
attachCtrl('npPrevBtn',   playPrev);
attachCtrl('nextBtn',     playNext);
attachCtrl('npNextBtn',   playNext);
attachCtrl('miniPrevBtn', e => { e.stopPropagation(); playPrev(); });
attachCtrl('miniNextBtn', e => { e.stopPropagation(); playNext(); });

function playNext() {
  if (playlist.length > 0 && currentIndex >= 0) {
    let idx;
    if (shuffleOn) {
      const candidates = playlist.filter(t => 
        !badVideos.has(t.videoId) && !playHistory.slice(0, 5).includes(t.videoId)
      );
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        playTrack(pick.videoId, pick.title, pick.channel, pick.thumbUrl);
        return;
      }
    }
    idx = (currentIndex + 1) % playlist.length;
    let tried = 0;
    while (badVideos.has(playlist[idx].videoId) && tried < playlist.length) {
      idx = (idx + 1) % playlist.length; tried++;
    }
    if (tried < playlist.length) {
      const t = playlist[idx];
      playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
      return;
    }
  }

  if (searchResults.length > 0) {
    const curIdx = searchResults.findIndex(t => currentTrack && t.videoId === currentTrack.videoId);
    let next = (curIdx + 1) % searchResults.length;
    let tried = 0;
    while (tried < searchResults.length) {
      if (!badVideos.has(searchResults[next].videoId) && !playHistory.slice(0, 3).includes(searchResults[next].videoId)) {
        const t = searchResults[next];
        playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
        return;
      }
      next = (next + 1) % searchResults.length; tried++;
    }
    next = (curIdx + 1) % searchResults.length;
    tried = 0;
    while (badVideos.has(searchResults[next].videoId) && tried < searchResults.length) {
      next = (next + 1) % searchResults.length; tried++;
    }
    if (tried < searchResults.length) {
      const t = searchResults[next];
      playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
      return;
    }
  }

  if (recommendationQueue.length > 0) {
    const rec = recommendationQueue.shift();
    playTrack(rec.videoId, rec.title, rec.channel, rec.thumbUrl);
    return;
  }

  if (currentTrack && accessToken) {
    showToast('Finding similar tracks…');
    fetchSmartRecommendation(currentTrack).then(track => {
      if (track) playTrack(track.videoId, track.title, track.channel, track.thumbUrl);
      else showToast('No more tracks found');
    });
    return;
  }

  showToast('No more tracks to play');
}

function playPrev() {
  if (ytPlayer && playerReady && typeof ytPlayer.getCurrentTime === 'function' && typeof ytPlayer.seekTo === 'function') {
    try { if (ytPlayer.getCurrentTime() > 3) { ytPlayer.seekTo(0); return; } } catch(e) {}
  }
  if (playlist.length === 0) {
    if (!searchResults.length) return;
    const idx  = searchResults.findIndex(t => currentTrack && t.videoId === currentTrack.videoId);
    const prev = searchResults[(idx - 1 + searchResults.length) % searchResults.length];
    playTrack(prev.videoId, prev.title, prev.channel, prev.thumbUrl);
    return;
  }
  const idx = currentIndex >= 0
    ? (currentIndex - 1 + playlist.length) % playlist.length
    : playlist.length - 1;
  const t = playlist[idx];
  playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
}



function buildRecommendationQuery(track) {
  let cleanTitle = track.title
    .replace(/\(official\s*(music\s*)?video\)/gi, '')
    .replace(/\(official\s*audio\)/gi, '')
    .replace(/\(lyrics?\)/gi, '')
    .replace(/\[official\s*(music\s*)?video\]/gi, '')
    .replace(/\[lyrics?\]/gi, '')
    .replace(/\(audio\)/gi, '')
    .replace(/\[audio\]/gi, '')
    .replace(/\|.*/g, '')
    .replace(/ft\.?\s*.*/gi, '')
    .replace(/feat\.?\s*.*/gi, '')
    .trim();

  let artist = track.channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/Official$/i, '')
    .trim();

  const strategies = [
    `${artist} songs`,
    `songs like ${cleanTitle}`,
    `${artist} similar artists music`,
    `${cleanTitle.split(' ').slice(0, 3).join(' ')} music`,
    `${artist} top tracks`,
    `${artist} best songs`,
  ];

  const stratIdx = playHistory.length % strategies.length;
  return strategies[stratIdx];
}

async function prefetchRecommendations(title, channel, currentVideoId) {
  if (!accessToken || recommendationFetching) return;
  if (recommendationQueue.length >= 6) return; 

  recommendationFetching = true;
  const query = buildRecommendationQuery({ title, channel });

  try {
    const params = new URLSearchParams({
      part: 'snippet', maxResults: '15', type: 'video',
      q: query,
      videoCategoryId: '10', 
    });

    const res = await fetch(`${YT_API}?${params}`, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });

    if (!res.ok) { recommendationFetching = false; return; }
    const data = await res.json();
    const items = (data.items || []).map(item => ({
      videoId:  item.id.videoId,
      title:    item.snippet.title,
      channel:  item.snippet.channelTitle,
      thumbUrl: item.snippet.thumbnails?.medium?.url
                  || item.snippet.thumbnails?.default?.url || '',
    }));

    const filtered = items.filter(t =>
      t.videoId !== currentVideoId &&
      !badVideos.has(t.videoId) &&
      !playHistory.includes(t.videoId) &&
      !recommendationQueue.some(q => q.videoId === t.videoId)
    );

    for (let i = filtered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }

    recommendationQueue.push(...filtered.slice(0, 8));
  } catch(e) {
    console.warn('Recommendation prefetch failed:', e);
  }
  recommendationFetching = false;
}

async function fetchSmartRecommendation(track) {
  if (!accessToken) return null;
  const query = buildRecommendationQuery(track);

  try {
    const params = new URLSearchParams({
      part: 'snippet', maxResults: '10', type: 'video',
      q: query,
      videoCategoryId: '10',
    });

    const res = await fetch(`${YT_API}?${params}`, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const items = (data.items || []).map(item => ({
      videoId:  item.id.videoId,
      title:    item.snippet.title,
      channel:  item.snippet.channelTitle,
      thumbUrl: item.snippet.thumbnails?.medium?.url
                  || item.snippet.thumbnails?.default?.url || '',
    }));

    const pick = items.find(t =>
      t.videoId !== track.videoId &&
      !badVideos.has(t.videoId) &&
      !playHistory.includes(t.videoId)
    );

    if (pick) {
      const rest = items.filter(t =>
        t.videoId !== track.videoId &&
        t.videoId !== pick.videoId &&
        !badVideos.has(t.videoId) &&
        !playHistory.includes(t.videoId)
      );
      recommendationQueue.push(...rest.slice(0, 5));
    }

    return pick || null;
  } catch(e) {
    console.warn('Smart recommendation failed:', e);
    return null;
  }
}

attachCtrl('heartBtn',   toggleHeart);
attachCtrl('npHeartBtn', toggleHeart);
function toggleHeart() {
  if (!currentTrack) return;
  const idx = playlist.findIndex(t => t.videoId === currentTrack.videoId);
  if (idx >= 0) {
    playlist.splice(idx, 1); showToast('Removed from library');
  } else {
    playlist.push({ ...currentTrack }); showToast('Saved to library ✓');
  }
  currentIndex = playlist.findIndex(t => currentTrack && t.videoId === currentTrack.videoId);
  setHeartState(idx < 0);
  savePlaylist();
}

attachCtrl('shareBtn',   shareCurrent);
attachCtrl('npShareBtn', shareCurrent);

function shareCurrent() {
  if (!currentTrack) { showToast('No song playing'); return; }
  shareSong(currentTrack.videoId, currentTrack.title);
}

function shareSong(videoId, title) {
  if (!videoId) return;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const shareText = title ? `${title} — ${url}` : url;

  if (navigator.share) {
    navigator.share({
      title: title || 'Check out this song on Sakura',
      text: title || '',
      url: url,
    }).catch(() => {});
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link copied! Share it anywhere 🌸');
    }).catch(() => {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Link copied! Share it anywhere 🌸');
  } catch(e) {
    showToast('Could not copy link');
  }
  document.body.removeChild(ta);
}

attachCtrl('volIcon', () => {
  volume = volume > 0 ? 0 : 70;
  syncVolumeBars();
  const icon = document.getElementById('volIcon');
  if (icon) icon.textContent = volume === 0 ? '🔇' : '🔊';
  if (playerReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
    try { ytPlayer.setVolume(volume); } catch(e) {}
  }
});


let panelOpen = false;

attachCtrl('queueBtn', togglePanel);
attachCtrl('ppClose', () => {
  panelOpen = false;
  document.getElementById('playlistPanel')?.classList.remove('open');
  document.getElementById('queueBtn')?.classList.remove('active');
});

function togglePanel() {
  panelOpen = !panelOpen;
  document.getElementById('playlistPanel')?.classList.toggle('open', panelOpen);
  document.getElementById('queueBtn')?.classList.toggle('active', panelOpen);
  if (panelOpen) renderPlaylistPanel();
}

function renderPlaylistPanel() {
  const body = document.getElementById('ppBody');
  const cnt  = document.getElementById('ppCount');
  if (!body) return;
  if (cnt) cnt.textContent = `${playlist.length} track${playlist.length !== 1 ? 's' : ''}`;

  if (!playlist.length) {
    body.innerHTML = '<div class="pp-empty">No tracks saved yet.<br>Search and save songs to build your queue.</div>';
    return;
  }

  body.innerHTML = playlist.map((t, i) => {
    const active    = currentTrack?.videoId === t.videoId;
    const thumbHTML = t.thumbUrl ? `<img src="${escHtml(t.thumbUrl)}" alt="">` : '🎵';
    const numOrEq   = active && isPlaying
      ? `<div class="equalizer"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
      : `<div class="pp-track-num">${i + 1}</div>`;
    return `
      <div class="pp-track${active ? ' active' : ''}" data-videoid="${t.videoId}">
        ${numOrEq}
        <div class="pp-track-thumb">${thumbHTML}</div>
        <div class="pp-track-info">
          <div class="pp-track-title">${escHtml(t.title)}</div>
          <div class="pp-track-ch">${escHtml(t.channel)}</div>
        </div>
        <button class="pp-del" data-videoid="${t.videoId}" aria-label="Remove">✕</button>
      </div>`;
  }).join('');

  body.querySelectorAll('.pp-track').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.pp-del')) return;
      const t = playlist.find(x => x.videoId === el.dataset.videoid);
      if (t) playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
    });
  });
  body.querySelectorAll('.pp-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeFromPlaylist(btn.dataset.videoid);
    });
  });
}


attachCtrl('npQueueBtn', openPlaylistPanelMobile);
attachCtrl('ppmClose', () => document.getElementById('playlistPanelMobile')?.classList.remove('open'));

function openPlaylistPanelMobile() {
  renderPlaylistPanelMobile();
  document.getElementById('playlistPanelMobile')?.classList.add('open');
}

function renderPlaylistPanelMobile() {
  const body = document.getElementById('ppmBody');
  if (!body) return;

  if (!playlist.length) {
    body.innerHTML = '<div class="pp-empty">No tracks saved yet.</div>';
    return;
  }

  body.innerHTML = playlist.map((t, i) => {
    const active    = currentTrack?.videoId === t.videoId;
    const thumbHTML = t.thumbUrl ? `<img src="${escHtml(t.thumbUrl)}" alt="">` : '🎵';
    const numOrEq   = active && isPlaying
      ? `<div class="equalizer"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
      : `<div class="pp-track-num">${i + 1}</div>`;
    return `
      <div class="pp-track${active ? ' active' : ''}" data-videoid="${t.videoId}"
           style="padding:10px 16px;">
        ${numOrEq}
        <div class="pp-track-thumb">${thumbHTML}</div>
        <div class="pp-track-info">
          <div class="pp-track-title">${escHtml(t.title)}</div>
          <div class="pp-track-ch">${escHtml(t.channel)}</div>
        </div>
        <button class="pp-del" data-videoid="${t.videoId}" style="opacity:1;" aria-label="Remove">✕</button>
      </div>`;
  }).join('');

  body.querySelectorAll('.pp-track').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.pp-del')) return;
      const t = playlist.find(x => x.videoId === el.dataset.videoid);
      if (t) {
        playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
        document.getElementById('playlistPanelMobile')?.classList.remove('open');
      }
    });
  });
  body.querySelectorAll('.pp-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeFromPlaylist(btn.dataset.videoid);
      renderPlaylistPanelMobile();
    });
  });
}


function openNpSheet()  { document.getElementById('npSheet')?.classList.add('open'); }
function closeNpSheet() { document.getElementById('npSheet')?.classList.remove('open'); }

document.getElementById('miniPlayer')?.addEventListener('click', e => {
  if (e.target.closest('#miniPlayBtn') ||
      e.target.closest('#miniPrevBtn') ||
      e.target.closest('#miniNextBtn')) return;
  openNpSheet();
});
attachCtrl('npCloseBtn', closeNpSheet);

let touchStartY = 0;
const npSheet   = document.getElementById('npSheet');
if (npSheet) {
  npSheet.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
  npSheet.addEventListener('touchend',   e => {
    if (e.changedTouches[0].clientY - touchStartY > 80) closeNpSheet();
  }, { passive: true });
}


let activeTab = 'search';
function switchTab(tab) {
  activeTab = tab;
  const sv = document.getElementById('searchView');
  const lv = document.getElementById('libraryView');
  const ts = document.getElementById('tabSearch');
  const tl = document.getElementById('tabLibrary');

  if (tab === 'search') {
    if (sv) sv.style.display = 'flex'; if (lv) lv.style.display = 'none';
    ts?.classList.add('active'); tl?.classList.remove('active');
  } else {
    if (sv) sv.style.display = 'none'; if (lv) lv.style.display = 'flex';
    ts?.classList.remove('active'); tl?.classList.add('active');
    renderMobileLibrary();
  }
}


function removeFromPlaylist(videoId) {
  playlist = playlist.filter(t => t.videoId !== videoId);
  if (currentTrack?.videoId === videoId) {
    currentIndex = -1; setHeartState(false);
  } else {
    currentIndex = playlist.findIndex(t => currentTrack && t.videoId === currentTrack.videoId);
  }
  savePlaylist();
}

function savePlaylist() {
  try { localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlist)); } catch(e) {}
  renderSidebar();
  renderMobileLibrary();
  renderPlaylistPanel();
  renderPlaylistPanelMobile();
  updateGridSavePills();
  updateSidebarCount();
  if (currentTrack) setHeartState(playlist.some(t => t.videoId === currentTrack.videoId));
}

function updateSidebarCount() {
  const cnt = document.getElementById('sidebarCount');
  if (cnt) cnt.textContent = playlist.length;
}

function renderSidebar()       { renderPlaylistInto('playlistList',       false); }
function renderMobileLibrary() { renderPlaylistInto('playlistListMobile', true);  }

function renderPlaylistInto(containerId, isMobile) {
  const list = document.getElementById(containerId);
  if (!list) return;

  if (!playlist.length) {
    if (isMobile) {
      list.innerHTML = `<div class="library-empty-state">
        <div class="library-empty-icon">🎵</div>
        <div class="library-empty-title">Your library is empty</div>
        <div class="library-empty-desc">Search and save songs to build your personal collection</div>
      </div>`;
    } else {
      list.innerHTML = '<div class="sidebar-empty">Your saved tracks will appear here.</div>';
    }
    return;
  }

  const countHeader = isMobile ? `<div class="library-count-header">${playlist.length} track${playlist.length !== 1 ? 's' : ''} saved</div>` : '';

  list.innerHTML = countHeader + playlist.map(t => {
    const active    = currentTrack?.videoId === t.videoId;
    const thumbHTML = t.thumbUrl ? `<img src="${escHtml(t.thumbUrl)}" alt="">` : '🎵';
    const eqHTML    = active && isPlaying
      ? `<div class="equalizer"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
      : '';
    return `
      <div class="playlist-track${active ? ' active' : ''}" data-videoid="${t.videoId}">
        <div class="pt-thumb">${thumbHTML}</div>
        <div class="pt-info">
          <div class="pt-title">${escHtml(t.title)}</div>
          <div class="pt-channel">${escHtml(t.channel)}</div>
        </div>
        ${eqHTML}
        <button class="pt-delete" data-videoid="${t.videoId}" aria-label="Remove">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.playlist-track').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('pt-delete')) return;
      const t = playlist.find(x => x.videoId === el.dataset.videoid);
      if (t) {
        playTrack(t.videoId, t.title, t.channel, t.thumbUrl);
        if (isMobile) switchTab('search');
      }
    });
  });
  list.querySelectorAll('.pt-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeFromPlaylist(btn.dataset.videoid);
    });
  });
}

function updateGridSavePills() {
  document.querySelectorAll('.save-pill[data-videoid]').forEach(pill => {
    const saved = playlist.some(t => t.videoId === pill.dataset.videoid);
    pill.textContent = saved ? '✓ Saved' : '+ Save';
    pill.classList.toggle('saved', saved);
  });
}


function setupMediaSession(track) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:   track.title,
    artist:  track.channel,
    album:   'Sakura',
    artwork: track.thumbUrl
      ? [{ src: track.thumbUrl, sizes: '320x180', type: 'image/jpeg' }]
      : [],
  });

  navigator.mediaSession.setActionHandler('play',          () => { if (playerReady) ytPlayer.playVideo(); });
  navigator.mediaSession.setActionHandler('pause',         () => { if (playerReady) ytPlayer.pauseVideo(); });
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack',     playNext);
  navigator.mediaSession.setActionHandler('seekto', d => {
    if (playerReady && d.seekTime != null) ytPlayer.seekTo(d.seekTime);
  });
  navigator.mediaSession.setActionHandler('seekbackward', d => {
    if (playerReady) ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() - (d.seekOffset || 10)));
  });
  navigator.mediaSession.setActionHandler('seekforward', d => {
    if (playerReady) ytPlayer.seekTo(ytPlayer.getCurrentTime() + (d.seekOffset || 10));
  });
}

function updateMediaSession(playing) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (!playerReady || !ytPlayer) return;
  try {
    if (typeof ytPlayer.getDuration !== 'function' || typeof ytPlayer.getCurrentTime !== 'function') return;
    const dur = ytPlayer.getDuration()    || 0;
    const cur = ytPlayer.getCurrentTime() || 0;
    if (dur > 0) {
      navigator.mediaSession.setPositionState({
        duration:     dur,
        playbackRate: 1,
        position:     Math.min(cur, dur),
      });
    }
  } catch(e) {}
}


async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (!wakeLock || wakeLock.released) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        if (isPlaying) requestWakeLock();
      });
    }
  } catch(e) { /* WakeLock not supported or denied */ }
}

async function releaseWakeLock() {
  if (wakeLock && !wakeLock.released) {
    try { await wakeLock.release(); } catch(e) {}
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (isPlaying) await requestWakeLock();

    setTimeout(() => {
      if (!playerReady || !ytPlayer || typeof ytPlayer.getPlayerState !== 'function' || typeof ytPlayer.playVideo !== 'function') return;
      try {
        const state = ytPlayer.getPlayerState();
        if (isPlaying && state !== 1 && state !== 3) {
          ytPlayer.playVideo();
        }
      } catch(e) {}
    }, 500);
  } else {
    releaseWakeLock();
  }
});

window.addEventListener('focus', () => {
  if (isPlaying) requestWakeLock();
});

window.addEventListener('resume', () => {
  if (isPlaying && playerReady && ytPlayer && typeof ytPlayer.getPlayerState === 'function' && typeof ytPlayer.playVideo === 'function') {
    try {
      const state = ytPlayer.getPlayerState();
      if (state !== 1 && state !== 3) ytPlayer.playVideo();
    } catch(e) {}
  }
});


function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


injectSidebarUserSection();
injectMobileLibraryUserSection();
renderSidebar();
updateSidebarCount();
syncVolumeBars();
renderBrowse();
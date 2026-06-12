// fetch-setlists.js
// Pulls The Cure's recent setlists from setlist.fm and merges them into
// shows.json. Run on a schedule by .github/workflows/setlists.yml.
// Node 20+ (uses built-in fetch). The API key comes from the SETLISTFM_KEY env var.

const fs = require("fs");

const MBID = "69ee3720-a7cb-4402-b48d-a02c366f2bcf"; // The Cure (Crawley, UK)
const API_KEY = process.env.SETLISTFM_KEY;
const SHOWS_FILE = "shows.json";
const PAGES = 2;            // most recent ~40 setlists — plenty for a tour
const UA = "InBetweenDays/1.0 (unofficial Cure fan app)";

// A show counts as "live" from a short lead before stage time until +3.5h.
// The lead lets the watcher catch the first songs the moment they're logged.
const LEAD_MS   = 20 * 60 * 1000;
const WINDOW_MS = 3.5 * 3600 * 1000;
function isShowLive(showsArr, now) {
  return showsArr.some(s => {
    const t = Date.parse(s.date);
    return Number.isFinite(t) && now >= t - LEAD_MS && now < t + WINDOW_MS;
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const arr = x => (Array.isArray(x) ? x : x ? [x] : []);

// setlist.fm eventDate is "dd-MM-yyyy"; our shows use ISO "yyyy-MM-dd..."
function toIso(eventDate) {
  const [d, m, y] = eventDate.split("-");
  return `${y}-${m}-${d}`;
}

// turn a setlist.fm setlist into our { setlistUrl, main, encore } shape
function toSetlist(sl) {
  const sets = arr(sl.sets && sl.sets.set);
  const main = [], encore = [];
  for (const s of sets) {
    const bucket = s.encore ? encore : main;
    for (const song of arr(s.song)) {
      if (!song || !song.name) continue;        // skip unnamed segues/tape markers
      const entry = { name: song.name };
      if (song.info) entry.info = song.info;     // crowdsourced "(first time since…)" notes
      bucket.push(entry);
    }
  }
  return { setlistUrl: sl.url, main, encore };
}

async function fetchPage(page) {
  const url = `https://api.setlist.fm/rest/1.0/artist/${MBID}/setlists?p=${page}`;
  const res = await fetch(url, {
    headers: { "x-api-key": API_KEY, "Accept": "application/json", "User-Agent": UA }
  });
  if (res.status === 404) return [];             // no more pages
  if (!res.ok) throw new Error(`setlist.fm returned ${res.status} on page ${page}`);
  const data = await res.json();
  return arr(data.setlist);
}

async function runOnce() {
  if (!API_KEY) {
    console.error("Missing SETLISTFM_KEY environment variable.");
    process.exit(1);
  }
  const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, "utf8"));

  // collect recent setlists keyed by ISO date
  const byDate = {};
  for (let p = 1; p <= PAGES; p++) {
    const list = await fetchPage(p);
    if (!list.length) break;
    for (const sl of list) {
      if (sl.eventDate) byDate[toIso(sl.eventDate)] = sl;
    }
    await sleep(1100);                            // stay under ~2 requests/second
  }

  // attach a setlist to any show whose date matches one we fetched
  let changed = 0;
  for (const show of arr(shows.shows)) {
    const iso = (show.date || "").slice(0, 10);
    const sl = byDate[iso];
    if (!sl) continue;
    const built = toSetlist(sl);
    if (!built.main.length && !built.encore.length) continue;   // nothing usable yet
    if (JSON.stringify(show.setlist) !== JSON.stringify(built)) {
      show.setlist = built;
      changed++;
    }
  }

  if (changed === 0) {
    console.log("No setlist changes.");
    return;
  }
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(shows, null, 2) + "\n");
  console.log(`Updated ${changed} show(s) with setlists.`);
}

// `--check-live` exits 0 when a show is currently live, non-zero otherwise.
// The workflow uses it to decide whether to keep watching. No API key needed.
if (process.argv.includes("--check-live")) {
  const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, "utf8"));
  const live = isShowLive(arr(shows.shows), Date.now());
  console.log(live ? "A show is live." : "No show live.");
  process.exit(live ? 0 : 3);
} else {
  runOnce().catch(err => { console.error(err); process.exit(1); });
}

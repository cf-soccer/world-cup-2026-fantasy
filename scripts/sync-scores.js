// ─────────────────────────────────────────────────────────────
// WC2026 Fantasy — Automated Score Sync
// Runs via GitHub Actions every 2 hours during the tournament.
// Fetches match results from football-data.org and writes
// updated scores for every player entry to Firestore.
// ─────────────────────────────────────────────────────────────

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

// ── Firebase Admin init (uses service account secrets) ────────
const app = initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // GitHub stores the private key with literal \n — replace them
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore(app);

// ── Team name aliases (API names → our app names) ─────────────
const NAME_ALIASES = {
  'Czech Republic':         'Czechia',
  "Côte d'Ivoire":          'C. Ivoire',
  "Cote d'Ivoire":          'C. Ivoire',
  'Ivory Coast':            'C. Ivoire',
  'South Korea':            'S. Korea',
  'Korea Republic':         'S. Korea',
  'Turkey':                 'Türkiye',
  'Bosnia and Herzegovina': 'Bosnia',
  'Bosnia Herzegovina':     'Bosnia',
  'Bosnia-Herzegovina':     'Bosnia',
  'Congo DR':               'DR Congo',
  'United States':          'USA',
};
const norm = n => NAME_ALIASES[n] || n;

// ── Stage mapping ─────────────────────────────────────────────
const STAGE_MAP = {
  'GROUP_STAGE':    'group',
  'ROUND_OF_32':    'r32',
  'LAST_32':        'r32',
  'ROUND_OF_16':    'r16',
  'LAST_16':        'r16',
  'QUARTER_FINALS': 'qf',
  'SEMI_FINALS':    'sf',
  'THIRD_PLACE':    'third',
  'FINAL':          'final',
};

// ── Score calculator ──────────────────────────────────────────
function calcScore(picks, matches) {
  let score = 0, group = 0, knockout = 0, bonus = 0;
  const normPicks = picks.map(norm);
  let winner = null, third = null;

  matches.forEach(m => {
    const stage = STAGE_MAP[m.stage] || m.stage;
    const t1 = norm(m.homeTeam?.name || '');
    const t2 = norm(m.awayTeam?.name || '');
    const g1 = m.score?.fullTime?.home ?? null;
    const g2 = m.score?.fullTime?.away ?? null;
    if (g1 === null || g2 === null) return; // not finished

    normPicks.forEach(pick => {
      const isT1 = t1 === pick, isT2 = t2 === pick;
      if (!isT1 && !isT2) return;

      // Group stage: 3pts win, 1pt draw
      if (stage === 'group') {
        if (isT1) { if (g1 > g2) { score += 3; group += 3; } else if (g1 === g2) { score += 1; group += 1; } }
        if (isT2) { if (g2 > g1) { score += 3; group += 3; } else if (g1 === g2) { score += 1; group += 1; } }
      }

      // Knockout: 5pts for winning the round
      if (['r32', 'r16', 'qf', 'sf'].includes(stage)) {
        let won = false;
        if (isT1 && g1 > g2) won = true;
        if (isT2 && g2 > g1) won = true;
        // Check penalties if draw after 90/120 mins
        if (g1 === g2) {
          const p1 = m.score?.penalties?.home ?? null;
          const p2 = m.score?.penalties?.away ?? null;
          if (p1 !== null && p2 !== null) {
            if (isT1 && p1 > p2) won = true;
            if (isT2 && p2 > p1) won = true;
          }
        }
        if (won) { score += 5; knockout += 5; }
      }

      // Final: determine World Cup winner
      if (stage === 'final') {
        let w = null;
        if (g1 > g2) w = t1;
        else if (g2 > g1) w = t2;
        else {
          const p1 = m.score?.penalties?.home ?? null;
          const p2 = m.score?.penalties?.away ?? null;
          if (p1 !== null && p2 !== null) w = p1 > p2 ? t1 : t2;
        }
        if (w) winner = w;
      }

      // 3rd place match
      if (stage === 'third') {
        if (g1 > g2) third = t1;
        else if (g2 > g1) third = t2;
      }
    });
  });

  // Bonuses
  if (winner && normPicks.includes(winner)) { score += 20; bonus += 20; }
  if (third  && normPicks.includes(third))  { score += 3;  bonus += 3;  }

  return { score, breakdown: { group, knockout, bonus } };
}

// ── ESPN fetcher (primary) ────────────────────────────────────
async function fetchESPN() {
  // Fetch all dates since tournament start
  const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=100&dates=20260611-20260719';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ESPN API error ${resp.status}`);
  const data = await resp.json();
  const matches = [];
  for (const event of (data.events || [])) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const state = comp.status?.type?.state;
    if (state !== 'post') continue; // only finished matches
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const g1 = parseInt(home.score);
    const g2 = parseInt(away.score);
    if (isNaN(g1) || isNaN(g2)) continue;
    // Determine stage from notes or season slug
    const notes = comp.notes?.[0]?.headline || '';
    const slug = event.season?.slug || 'group-stage';
    let stage = 'group';
    if (slug.includes('round-of-32') || notes.includes('Round of 32')) stage = 'r32';
    else if (slug.includes('round-of-16') || notes.includes('Round of 16')) stage = 'r16';
    else if (slug.includes('quarter') || notes.includes('Quarterfinal')) stage = 'qf';
    else if (slug.includes('semi') || notes.includes('Semifinal')) stage = 'sf';
    else if (slug.includes('third') || notes.includes('Third Place')) stage = 'third';
    else if (slug.includes('final') || notes.includes('Final')) stage = 'final';
    matches.push({
      stage,
      homeTeam: { name: home.team.displayName },
      awayTeam: { name: away.team.displayName },
      score: { fullTime: { home: g1, away: g2 }, penalties: { home: null, away: null } },
    });
  }
  return matches;
}

// ── football-data.org fetcher (fallback) ──────────────────────
async function fetchFootballData(apiKey) {
  const resp = await fetch(
    'https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED&season=2026',
    { headers: { 'X-Auth-Token': apiKey } }
  );
  if (!resp.ok) throw new Error(`football-data.org error ${resp.status}`);
  const data = await resp.json();
  return (data.matches || [])
    .filter(m => m.score?.fullTime?.home !== null)
    .map(m => ({
      stage: STAGE_MAP[m.stage] || 'group',
      homeTeam: { name: m.homeTeam?.name },
      awayTeam: { name: m.awayTeam?.name },
      score: {
        fullTime: { home: m.score.fullTime.home, away: m.score.fullTime.away },
        penalties: { home: m.score.penalties?.home ?? null, away: m.score.penalties?.away ?? null },
      },
    }));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('🌍 WC2026 Score Sync — starting...');
  console.log(`⏰ ${new Date().toISOString()}`);

  // 1. Fetch finished matches — ESPN primary, football-data.org fallback
  let matches = [];
  let source = '';
  try {
    console.log('\n📡 Trying ESPN API (primary)...');
    matches = await fetchESPN();
    source = 'ESPN';
    console.log(`✅ ESPN: Got ${matches.length} finished matches`);
  } catch (e) {
    console.warn(`⚠️  ESPN failed: ${e.message} — falling back to football-data.org`);
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) throw new Error('Missing FOOTBALL_DATA_API_KEY secret');
    matches = await fetchFootballData(apiKey);
    source = 'football-data.org';
    console.log(`✅ football-data.org: Got ${matches.length} finished matches`);
  }

  matches.forEach(m => console.log(`  [${source}] Match: "${m.homeTeam?.name}" vs "${m.awayTeam?.name}" [${m.stage}] ${m.score?.fullTime?.home}-${m.score?.fullTime?.away}`));

  if (matches.length === 0) {
    console.log('ℹ️  No finished matches yet — nothing to update');
    return;
  }

  // Log match summary
  const byStage = {};
  matches.forEach(m => { byStage[m.stage] = (byStage[m.stage] || 0) + 1; });
  console.log('📊 Matches by stage:', JSON.stringify(byStage));

  // 2. Load all player entries from Firestore
  console.log('\n📂 Loading player entries...');
  const entriesSnap = await db.collection('entries').get();
  console.log(`✅ Found ${entriesSnap.docs.length} entries`);

  if (entriesSnap.docs.length === 0) {
    console.log('ℹ️  No entries yet — nothing to update');
    return;
  }

  // 3. Recalculate scores and batch write to Firestore
  console.log('\n⚡ Recalculating scores...');
  const batch = db.batch();
  let updated = 0;

  entriesSnap.docs.forEach(docSnap => {
    const entry = docSnap.data();
    const { score, breakdown } = calcScore(entry.picks || [], matches);
    const prevScore = entry.score || 0;

    batch.update(docSnap.ref, {
      score,
      breakdown,
      lastSynced: new Date(),
    });

    const changed = score !== prevScore ? ` (was ${prevScore})` : '';
    console.log(`  ✓ ${entry.name}: ${score}pts${changed} — grp:${breakdown.group} ko:${breakdown.knockout} bonus:${breakdown.bonus}`);
    updated++;
  });

  await batch.commit();
  console.log(`\n✅ Updated ${updated} entries`);
  console.log('🏁 Sync complete!');
}

main().catch(err => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1); // Non-zero exit so GitHub Actions marks it as failed
});

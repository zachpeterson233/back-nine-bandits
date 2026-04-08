import { useState, useEffect, useMemo } from "react";
import { db } from "./firebase";
import { doc, setDoc, onSnapshot } from "firebase/firestore";

const ADMIN_PIN = "1234";

const DEFAULT_TOURNAMENTS = [
  { id: 1, name: "Tournament 1", isMajor: false },
  { id: 2, name: "Tournament 2", isMajor: false },
  { id: 3, name: "The Masters Cup", isMajor: true },
  { id: 4, name: "Tournament 4", isMajor: false },
  { id: 5, name: "Tournament 5", isMajor: false },
  { id: 6, name: "The Open", isMajor: true },
  { id: 7, name: "Tournament 7", isMajor: false },
  { id: 8, name: "Championship", isMajor: true },
];

const DEFAULT_PLAYERS = ["Tiger", "Phil", "Rory", "Dustin", "Jordan", "Brooks", "Jon", "Xander"];

// ── SCORING LOGIC ─────────────────────────────────────────────────────────────
function calcWeekPoints(entries) {
  const played = entries.filter(e => e.score != null && e.score !== "");
  if (!played.length) return entries.map(e => ({ ...e, rank: null, basePts: null, lowerBonus: 0, totalPts: null, isLowerWinner: false }));
  const sorted = [...played].sort((a, b) => a.score - b.score);
  const rankMap = {};
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].score === sorted[i - 1].score) rankMap[sorted[i].player] = rankMap[sorted[i - 1].player];
    else rankMap[sorted[i].player] = rank;
    rank++;
  }
  const PTS = { 1: 6, 2: 4, 3: 2 };
  const basePtsMap = {};
  played.forEach(e => { basePtsMap[e.player] = PTS[rankMap[e.player]] ?? 1; });
  const lowerPlayers = played.filter(e => e.inLowerGroup);
  let autoLowerWinner = null;
  if (lowerPlayers.length) {
    const best = Math.min(...lowerPlayers.map(e => e.score));
    autoLowerWinner = lowerPlayers.filter(e => e.score === best).map(e => e.player);
  }
  return entries.map(e => {
    if (e.score == null || e.score === "") return { ...e, rank: null, basePts: null, lowerBonus: 0, totalPts: null, isLowerWinner: false };
    const r = rankMap[e.player];
    const bp = basePtsMap[e.player];
    let isLowerWinner = false;
    if (e.inLowerGroup) {
      if (e.lowerGroupWinOverride === true) isLowerWinner = true;
      else if (e.lowerGroupWinOverride === false) isLowerWinner = false;
      else isLowerWinner = autoLowerWinner?.includes(e.player) ?? false;
    }
    const lb = isLowerWinner ? 2 : 0;
    return { ...e, rank: r, basePts: bp, lowerBonus: lb, totalPts: bp + lb, isLowerWinner };
  });
}

function calcTournamentScore(weekPts, isMajor) {
  const played = weekPts.filter(w => w != null);
  if (!played.length) return null;
  let counted, dropped = null, bonus = played.length === 3 ? 3 : 0;
  if (played.length === 3) {
    const minIdx = played.indexOf(Math.min(...played));
    counted = played.filter((_, i) => i !== minIdx);
    dropped = weekPts.indexOf(Math.min(...played));
  } else counted = played;
  const base = counted.reduce((a, b) => a + b, 0) + bonus;
  return { base, total: isMajor ? base * 2 : base, bonus, dropped };
}

function getLastWeekBottom4(data, currentTId, currentWeek) {
  const tIdx = data.tournaments.findIndex(t => t.id === currentTId);
  let prevScores = null;
  if (currentWeek > 0) {
    const wd = data.scores[currentTId]?.weeks?.[currentWeek - 1];
    if (wd) prevScores = wd;
  } else if (tIdx > 0) {
    const prevT = data.tournaments[tIdx - 1];
    const weeks = data.scores[prevT.id]?.weeks || {};
    const keys = Object.keys(weeks).map(Number).sort((a, b) => b - a);
    if (keys.length) prevScores = weeks[keys[0]];
  }
  if (!prevScores) return [];
  const entries = data.players.map(p => ({ player: p, score: prevScores[p]?.score ?? null, inLowerGroup: prevScores[p]?.inLowerGroup ?? false, lowerGroupWinOverride: prevScores[p]?.lowerGroupWinOverride ?? null }));
  const results = calcWeekPoints(entries);
  const played = results.filter(r => r.totalPts != null).sort((a, b) => b.totalPts - a.totalPts);
  return played.slice(-4).map(r => r.player);
}

// Collect ALL raw scores for a player across the season
function getAllScores(data, player) {
  const all = [];
  data.tournaments.forEach((t, tIdx) => {
    const weeks = data.scores[t.id]?.weeks || {};
    [0, 1, 2].forEach(wi => {
      const wd = weeks[wi];
      if (wd?.[player]?.score != null) all.push({ score: wd[player].score, tIdx, wi });
    });
  });
  return all;
}

function stdDev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function makeDefaultData() {
  return {
    season: { name: "2025 Season", startDate: "2025-04-01", endDate: "2025-09-30" },
    players: DEFAULT_PLAYERS,
    scores: {},
    tournaments: DEFAULT_TOURNAMENTS,
  };
}

const DOC_REF = doc(db, "league", "data");

function useData() {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(DOC_REF, (snap) => {
      if (snap.exists()) {
        setData(snap.data());
      } else {
        const def = makeDefaultData();
        setDoc(DOC_REF, def);
        setData(def);
      }
      setLoaded(true);
    });
    return () => unsub();
  }, []);

  const updateData = (updater) => {
    setData(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      setDoc(DOC_REF, next);
      return next;
    });
  };

  return [data, updateData, loaded];
}
// ── STYLES ────────────────────────────────────────────────────────────────────
const S = {
  app: { fontFamily: "system-ui,sans-serif", maxWidth: 520, margin: "0 auto", minHeight: "100vh", background: "var(--color-background-tertiary)" },
  hdr: { background: "#1a3d2b", color: "#fff", padding: "14px 18px 10px" },
  nav: { display: "flex", background: "#14301f", borderBottom: "1px solid #0a1f14" },
  navBtn: (a) => ({ flex: 1, padding: "10px 4px", border: "none", background: a ? "#2d6a44" : "transparent", color: a ? "#fff" : "#7aab8a", fontSize: 12, fontWeight: a ? 600 : 400, cursor: "pointer", borderBottom: a ? "2px solid #5adf8a" : "2px solid transparent" }),
  page: { padding: 14 },
  card: { background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", marginBottom: 10, overflow: "hidden" },
  row: { display: "flex", alignItems: "center", padding: "11px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)" },
  rank: (i) => ({ width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, flexShrink: 0, background: i === 0 ? "#f0c030" : i === 1 ? "#b0b8c0" : i === 2 ? "#c07840" : "var(--color-background-secondary)", color: i < 3 ? "#1a1a1a" : "var(--color-text-secondary)" }),
  label: { fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", letterSpacing: 1, textTransform: "uppercase", padding: "14px 0 6px" },
  btn: (v) => ({ padding: v === "sm" ? "6px 12px" : "10px 18px", borderRadius: 8, border: v === "danger" ? "0.5px solid #fcc" : "0.5px solid var(--color-border-secondary)", background: v === "primary" ? "#2d6a44" : v === "danger" ? "transparent" : "var(--color-background-primary)", color: v === "primary" ? "#fff" : v === "danger" ? "#d03030" : "var(--color-text-primary)", fontSize: v === "sm" ? 13 : 14, fontWeight: 500, cursor: "pointer" }),
  input: { width: "100%", padding: "9px 11px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", fontSize: 14, boxSizing: "border-box" },
  badge: (t) => { const m = { major: ["#1a3d2b","#e8f5ee"], hot: ["#7a2020","#fff0e8"], bonus: ["#1a3575","#e8eeff"], lower: ["#5a3000","#fff3e0"] }; const [bg,c] = m[t]||["#ccc","#333"]; return { background: bg, color: c, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, display: "inline-block" }; },
  toast: { background: "#e8f5ee", color: "#1a3d2b", padding: "10px 14px", borderRadius: 8, marginBottom: 12, fontWeight: 500, fontSize: 14 },
  statCard: (accent) => ({ background: "var(--color-background-primary)", borderRadius: 12, border: `0.5px solid var(--color-border-tertiary)`, borderLeft: `3px solid ${accent}`, padding: "12px 16px", marginBottom: 10 }),
};

function Toast({ msg }) { if (!msg) return null; return <div style={S.toast}>{msg}</div>; }

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
function LeaderboardPage({ data }) {
  const { lb, bestRound, worstRound, mostImproved, mostConsistent } = useMemo(() => {
    const allRounds = []; // { player, score }

    const lb = data.players.map(player => {
      let totalPts = 0, tournsPlayed = 0;
      const scores = getAllScores(data, player);
      scores.forEach(s => allRounds.push({ player, score: s.score }));
      data.tournaments.forEach(t => {
        const weeks = data.scores[t.id]?.weeks || {};
        const weekPts = [0, 1, 2].map(wi => {
          const wd = weeks[wi];
          if (!wd) return null;
          const entries = data.players.map(p => ({ player: p, score: wd[p]?.score ?? null, inLowerGroup: wd[p]?.inLowerGroup ?? false, lowerGroupWinOverride: wd[p]?.lowerGroupWinOverride ?? null }));
          const res = calcWeekPoints(entries);
          return res.find(r => r.player === player)?.totalPts ?? null;
        });
        const res = calcTournamentScore(weekPts, t.isMajor);
        if (res) { totalPts += res.total; tournsPlayed++; }
      });
      return { player, totalPts, tournsPlayed, avg: tournsPlayed > 0 ? (totalPts / tournsPlayed).toFixed(1) : "–" };
    }).sort((a, b) => b.totalPts - a.totalPts);

    // Best & worst round season-wide
    let bestRound = null, worstRound = null;
    if (allRounds.length) {
      const best = allRounds.reduce((a, b) => b.score < a.score ? b : a);
      const worst = allRounds.reduce((a, b) => b.score > a.score ? b : a);
      bestRound = best;
      worstRound = worst;
    }

    // Most improved: first 4 tournaments avg vs last 4 avg (need scores in both halves)
    let mostImproved = null;
    const firstHalfIds = data.tournaments.slice(0, 4).map(t => t.id);
    const secondHalfIds = data.tournaments.slice(4).map(t => t.id);
    const improvements = data.players.map(player => {
      const firstScores = [], secondScores = [];
      firstHalfIds.forEach(tid => {
        const weeks = data.scores[tid]?.weeks || {};
        [0,1,2].forEach(wi => { const s = weeks[wi]?.[player]?.score; if (s != null) firstScores.push(s); });
      });
      secondHalfIds.forEach(tid => {
        const weeks = data.scores[tid]?.weeks || {};
        [0,1,2].forEach(wi => { const s = weeks[wi]?.[player]?.score; if (s != null) secondScores.push(s); });
      });
      if (!firstScores.length || !secondScores.length) return null;
      const firstAvg = firstScores.reduce((a,b)=>a+b,0)/firstScores.length;
      const secondAvg = secondScores.reduce((a,b)=>a+b,0)/secondScores.length;
      const improvement = firstAvg - secondAvg; // positive = got better (lower score)
      return { player, firstAvg: firstAvg.toFixed(1), secondAvg: secondAvg.toFixed(1), improvement };
    }).filter(Boolean);
    if (improvements.length) {
      const best = improvements.reduce((a, b) => b.improvement > a.improvement ? b : a);
      if (best.improvement > 0) mostImproved = best;
    }

    // Most consistent: lowest std dev, min 3 rounds
    let mostConsistent = null;
    const consistency = data.players.map(player => {
      const scores = getAllScores(data, player).map(s => s.score);
      if (scores.length < 3) return null;
      const sd = stdDev(scores);
      const avg = scores.reduce((a,b)=>a+b,0)/scores.length;
      return { player, sd, avg: avg.toFixed(1), rounds: scores.length };
    }).filter(Boolean);
    if (consistency.length) {
      mostConsistent = consistency.reduce((a, b) => b.sd < a.sd ? b : a);
    }

    return { lb, bestRound, worstRound, mostImproved, mostConsistent };
  }, [data]);

  const leader = lb[0];
  const hasSeasonStats = bestRound || mostImproved || mostConsistent;

  return (
    <div style={S.page}>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, textAlign: "center" }}>
        {data.season.name} · {data.season.startDate} – {data.season.endDate}
      </div>

      {leader?.totalPts > 0 && (
        <div style={{ ...S.card, background: "#1a3d2b", padding: "14px 18px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "#a8c5b0", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Season Leader</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
            <span style={{ fontSize: 22 }}>🏆</span>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#f0c030" }}>{leader.player}</div>
              <div style={{ fontSize: 13, color: "#a8c5b0" }}>{leader.totalPts} pts · {leader.tournsPlayed} events</div>
            </div>
          </div>
        </div>
      )}

      {/* Season highlights */}
      {hasSeasonStats && (
        <>
          <div style={S.label}>Season Highlights</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            {bestRound && (
              <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", borderTop: "3px solid #2d6a44", padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#2d6a44", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Best Round</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)" }}>{bestRound.score}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 2 }}>{bestRound.player}</div>
              </div>
            )}
            {worstRound && (
              <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", borderTop: "3px solid #c07040", padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#c07040", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Worst Round</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)" }}>{worstRound.score}</div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 2 }}>{worstRound.player}</div>
              </div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {mostImproved && (
              <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", borderTop: "3px solid #1a3575", padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#1a3575", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Most Improved</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text-primary)" }}>{mostImproved.player}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 3 }}>
                  {mostImproved.firstAvg} → {mostImproved.secondAvg}
                </div>
                <div style={{ fontSize: 11, color: "#2d6a44", marginTop: 2 }}>▼ {(+mostImproved.improvement).toFixed(1)} strokes</div>
              </div>
            )}
            {mostConsistent && (
              <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", borderTop: "3px solid #7a2080", padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#7a2080", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Most Consistent</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text-primary)" }}>{mostConsistent.player}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 3 }}>
                  avg {mostConsistent.avg} · {mostConsistent.rounds} rounds
                </div>
                <div style={{ fontSize: 11, color: "#7a2080", marginTop: 2 }}>σ {mostConsistent.sd.toFixed(2)}</div>
              </div>
            )}
          </div>
        </>
      )}

      <div style={S.label}>Standings</div>
      <div style={S.card}>
        {lb.map((p, i) => (
          <div key={p.player} style={{ ...S.row, background: i === 0 && p.totalPts > 0 ? "rgba(45,106,68,0.06)" : undefined }}>
            <div style={S.rank(i)}>{i + 1}</div>
            <div style={{ flex: 1, marginLeft: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{p.player}</span>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 1 }}>{p.tournsPlayed} events · avg {p.avg} pts</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#2d6a44" }}>{p.totalPts}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>pts</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── TOURNAMENTS ───────────────────────────────────────────────────────────────
function TournamentsPage({ data }) {
  const [sel, setSel] = useState(null);
  if (sel !== null) return <TournamentDetail t={data.tournaments[sel]} data={data} onBack={() => setSel(null)} />;
  return (
    <div style={S.page}>
      {data.tournaments.map((t, i) => {
        const weeks = data.scores[t.id]?.weeks || {};
        const hasScores = Object.keys(weeks).length > 0;
        return (
          <div key={t.id} style={{ ...S.card, cursor: "pointer" }} onClick={() => setSel(i)}>
            <div style={{ ...S.row, borderBottom: "none" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{t.name}</span>
                  {t.isMajor && <span style={S.badge("major")}>MAJOR 2×</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{hasScores ? `${Object.keys(weeks).length} week(s) entered` : "Not started"}</div>
              </div>
              <div style={{ color: "var(--color-text-secondary)", fontSize: 18 }}>›</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TournamentDetail({ t, data, onBack }) {
  const weekResults = useMemo(() => [0,1,2].map(wi => {
    const wd = data.scores[t.id]?.weeks?.[wi];
    if (!wd) return null;
    const entries = data.players.map(p => ({ player: p, score: wd[p]?.score ?? null, inLowerGroup: wd[p]?.inLowerGroup ?? false, lowerGroupWinOverride: wd[p]?.lowerGroupWinOverride ?? null }));
    return calcWeekPoints(entries);
  }), [data, t]);

  const playerResults = useMemo(() => data.players.map(player => {
    const weekPts = weekResults.map(wr => wr?.find(r => r.player === player)?.totalPts ?? null);
    const res = calcTournamentScore(weekPts, t.isMajor);
    return { player, weekPts, weekDetails: weekResults.map(wr => wr?.find(r => r.player === player) ?? null), res };
  }).filter(r => r.res).sort((a, b) => b.res.total - a.res.total), [data, t, weekResults]);

  return (
    <div style={S.page}>
      <button onClick={onBack} style={{ ...S.btn("sm"), marginBottom: 14 }}>← Back</button>
      <div style={{ ...S.card, background: "#1a3d2b", padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: "#a8c5b0", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Tournament</div>
        <div style={{ fontSize: 19, fontWeight: 600, color: "#fff", marginTop: 4 }}>{t.name}</div>
        {t.isMajor && <span style={{ ...S.badge("major"), marginTop: 6, display: "inline-block" }}>MAJOR – Points Doubled</span>}
      </div>
      {!playerResults.length
        ? <div style={{ color: "var(--color-text-secondary)", textAlign: "center", padding: 32 }}>No scores entered yet.</div>
        : playerResults.map((r, i) => (
          <div key={r.player} style={S.card}>
            <div style={{ padding: "11px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={S.rank(i)}>{i+1}</div>
              <span style={{ fontWeight: 500, flex: 1, color: "var(--color-text-primary)" }}>{r.player}</span>
              <span style={{ fontSize: 19, fontWeight: 700, color: "#2d6a44" }}>{r.res.total} pts</span>
              {t.isMajor && <span style={{ fontSize: 11, color: "#7a9", marginLeft: 2 }}>×2</span>}
            </div>
            <div style={{ padding: "10px 14px", display: "flex", gap: 8 }}>
              {[0,1,2].map(wi => {
                const wd = r.weekDetails[wi];
                const dropped = r.res.dropped === wi;
                return (
                  <div key={wi} style={{ textAlign: "center", flex: 1, padding: "8px 4px", borderRadius: 8, border: `1px solid ${dropped?"#ddd":wd?"#2d6a44":"#eee"}`, opacity: dropped?0.45:1, background: dropped?"var(--color-background-secondary)":wd?"rgba(45,106,68,0.07)":"transparent" }}>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>Wk {wi+1}</div>
                    {wd ? <>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>{wd.score}</div>
                      <div style={{ fontSize: 12, color: "#2d6a44" }}>{wd.totalPts} pts</div>
                      {wd.inLowerGroup && <div style={{ fontSize: 10, color: "#a06000", marginTop: 2 }}>lower{wd.isLowerWinner?" +2":""}</div>}
                      {dropped && <div style={{ fontSize: 10, color: "#e05" }}>dropped</div>}
                    </> : <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>–</div>}
                  </div>
                );
              })}
            </div>
            {r.res.bonus > 0 && <div style={{ padding: "2px 14px 10px" }}><span style={S.badge("bonus")}>+3 Attendance Bonus</span></div>}
          </div>
        ))
      }
    </div>
  );
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function StatsPage({ data }) {
  const stats = useMemo(() => data.players.map(player => {
    let totalPts = 0, tournsPlayed = 0, weekWins = 0, top3 = 0, bonuses = 0, lowerWins = 0;
    const allScores = getAllScores(data, player).map(s => s.score);

    data.tournaments.forEach(t => {
      const weeks = data.scores[t.id]?.weeks || {};
      const weekPts = [0,1,2].map(wi => {
        const wd = weeks[wi];
        if (!wd) return null;
        const entries = data.players.map(p => ({ player: p, score: wd[p]?.score ?? null, inLowerGroup: wd[p]?.inLowerGroup ?? false, lowerGroupWinOverride: wd[p]?.lowerGroupWinOverride ?? null }));
        const res = calcWeekPoints(entries);
        const mine = res.find(r => r.player === player);
        if (!mine || mine.totalPts == null) return null;
        if (mine.rank === 1) weekWins++;
        if (mine.rank <= 3) top3++;
        if (mine.isLowerWinner) lowerWins++;
        return mine.totalPts;
      });
      const res = calcTournamentScore(weekPts, t.isMajor);
      if (res) { totalPts += res.total; tournsPlayed++; if (res.bonus) bonuses++; }
    });

    // Score average (not points average)
    const scoreAvg = allScores.length > 0 ? (allScores.reduce((a,b)=>a+b,0) / allScores.length).toFixed(1) : "–";
    const bestScore = allScores.length ? Math.min(...allScores) : null;
    const worstScore = allScores.length ? Math.max(...allScores) : null;
    const sd = allScores.length >= 2 ? stdDev(allScores) : null;

    return { player, totalPts, tournsPlayed, weekWins, top3, bonuses, lowerWins, scoreAvg, bestScore, worstScore, sd, rounds: allScores.length };
  }).sort((a, b) => b.totalPts - a.totalPts), [data]);

  return (
    <div style={S.page}>
      {stats.map((p, i) => (
        <div key={p.player} style={S.card}>
          <div style={{ padding: "11px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={S.rank(i)}>{i+1}</div>
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: 500, fontSize: 15, color: "var(--color-text-primary)" }}>{p.player}</span>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 1 }}>{p.rounds} rounds played</div>
            </div>
            <span style={{ fontSize: 18, fontWeight: 700, color: "#2d6a44" }}>{p.totalPts} pts</span>
          </div>
          {/* Row 1: score stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", padding: "10px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            {[
              ["Avg Score", p.scoreAvg],
              ["Best", p.bestScore ?? "–"],
              ["Worst", p.worstScore ?? "–"],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text-primary)" }}>{val}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{lbl}</div>
              </div>
            ))}
          </div>
          {/* Row 2: points stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", padding: "10px 8px" }}>
            {[
              ["Wk Wins", p.weekWins],
              ["Top 3", p.top3],
              ["Attend", p.bonuses],
              ["Lower W", p.lowerWins],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>{val}</div>
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{lbl}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
function AdminPage({ data, setData, isAdmin, setIsAdmin }) {
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState(false);
  const [tab, setTab] = useState("scores");
  const [msg, setMsg] = useState("");
  const toast = (m) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  if (!isAdmin) return (
    <div style={{ ...S.page, maxWidth: 300, margin: "0 auto", paddingTop: 40 }}>
      <div style={{ textAlign: "center", fontSize: 15, color: "var(--color-text-secondary)", marginBottom: 10 }}>Enter Admin PIN</div>
      <input style={{ ...S.input, marginBottom: 10 }} type="password" placeholder="PIN" value={pin}
        onChange={e => { setPin(e.target.value); setPinErr(false); }}
        onKeyDown={e => e.key === "Enter" && (pin === ADMIN_PIN ? setIsAdmin(true) : setPinErr(true))} />
      {pinErr && <div style={{ color: "#d03030", fontSize: 13, textAlign: "center", marginBottom: 8 }}>Incorrect PIN</div>}
      <button style={{ ...S.btn("primary"), width: "100%" }} onClick={() => pin === ADMIN_PIN ? setIsAdmin(true) : setPinErr(true)}>Unlock Admin</button>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", textAlign: "center", marginTop: 8 }}>Default PIN: 1234</div>
    </div>
  );

  return (
    <div style={S.page}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {["scores","players","events","season"].map(tb => (
          <button key={tb} style={{ ...S.btn(tab===tb?"primary":""), fontSize:13, padding:"7px 14px" }} onClick={() => setTab(tb)}>
            {tb.charAt(0).toUpperCase()+tb.slice(1)}
          </button>
        ))}
        <button style={{ ...S.btn("sm"), marginLeft: "auto", color: "var(--color-text-secondary)" }} onClick={() => setIsAdmin(false)}>Lock</button>
      </div>
      <Toast msg={msg} />
      {tab==="scores"  && <ScoresTab  data={data} setData={setData} toast={toast} />}
      {tab==="players" && <PlayersTab data={data} setData={setData} toast={toast} />}
      {tab==="events"  && <EventsTab  data={data} setData={setData} toast={toast} />}
      {tab==="season"  && <SeasonTab  data={data} setData={setData} toast={toast} />}
    </div>
  );
}

// ── SCORES TAB ────────────────────────────────────────────────────────────────
function ScoresTab({ data, setData, toast }) {
  const [selTIdx, setSelTIdx] = useState(0);
  const [selWeek, setSelWeek] = useState(0);
  const t = data.tournaments[selTIdx];
  const [localScores, setLocalScores] = useState({});
  const [lowerOverrides, setLowerOverrides] = useState({});
  const [lowerWinOverrides, setLowerWinOverrides] = useState({});
  const autoLower = useMemo(() => getLastWeekBottom4(data, t.id, selWeek), [data, t.id, selWeek]);

  useEffect(() => {
    const wd = data.scores[t.id]?.weeks?.[selWeek] || {};
    const scores={}, lower={}, lowerWin={};
    data.players.forEach(p => {
      scores[p] = wd[p]?.score ?? "";
      lower[p] = wd[p]?.inLowerGroup ?? autoLower.includes(p);
      lowerWin[p] = wd[p]?.lowerGroupWinOverride ?? null;
    });
    setLocalScores(scores); setLowerOverrides(lower); setLowerWinOverrides(lowerWin);
  }, [selTIdx, selWeek, data]);

  const preview = useMemo(() => {
    const entries = data.players.map(p => ({ player: p, score: localScores[p]!==""&&localScores[p]!=null?Number(localScores[p]):null, inLowerGroup: lowerOverrides[p]??false, lowerGroupWinOverride: lowerWinOverrides[p]??null }));
    return calcWeekPoints(entries);
  }, [localScores, lowerOverrides, lowerWinOverrides, data.players]);

  const save = () => {
    const wd = {};
    data.players.forEach(p => {
      const score = localScores[p]!==""&&localScores[p]!=null?Number(localScores[p]):null;
      if (score!=null) wd[p]={ score, inLowerGroup:lowerOverrides[p]??false, lowerGroupWinOverride:lowerWinOverrides[p]??null };
    });
    setData(d => ({ ...d, scores:{ ...d.scores, [t.id]:{ ...d.scores[t.id], weeks:{ ...(d.scores[t.id]?.weeks||{}), [selWeek]:wd } } } }));
    toast("Scores saved!");
  };

  return <>
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
      <div>
        <div style={S.label}>Tournament</div>
        <select style={S.input} value={selTIdx} onChange={e => setSelTIdx(+e.target.value)}>
          {data.tournaments.map((t,i) => <option key={t.id} value={i}>{t.name}{t.isMajor?" ★":""}</option>)}
        </select>
      </div>
      <div>
        <div style={S.label}>Week</div>
        <select style={S.input} value={selWeek} onChange={e => setSelWeek(+e.target.value)}>
          <option value={0}>Week 1</option><option value={1}>Week 2</option><option value={2}>Week 3</option>
        </select>
      </div>
    </div>
    <div style={S.card}>
      <div style={{ padding:"10px 14px", borderBottom:"0.5px solid var(--color-border-tertiary)", fontSize:13, color:"var(--color-text-secondary)" }}>
        Enter 9-hole scores. Lower = better. Lower group auto-set from last week.
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 68px 36px 36px 56px", gap:6, padding:"8px 12px 4px", fontSize:11, color:"var(--color-text-secondary)", fontWeight:600, alignItems:"center" }}>
        <div>Player</div><div style={{ textAlign:"center" }}>Score</div><div style={{ textAlign:"center" }}>Low</div><div style={{ textAlign:"center" }}>Win</div><div style={{ textAlign:"center" }}>Pts</div>
      </div>
      {data.players.map(p => {
        const prev = preview.find(r => r.player === p);
        const inLower = lowerOverrides[p]??false;
        const winOverride = lowerWinOverrides[p];
        const autoWin = prev?.isLowerWinner && winOverride==null;
        return (
          <div key={p} style={{ display:"grid", gridTemplateColumns:"1fr 68px 36px 36px 56px", gap:6, padding:"7px 12px", borderTop:"0.5px solid var(--color-border-tertiary)", alignItems:"center" }}>
            <div style={{ fontSize:14, fontWeight:500, color:"var(--color-text-primary)" }}>{p}</div>
            <input type="number" min="18" max="90" style={{ ...S.input, padding:"7px 4px", textAlign:"center", fontSize:14 }}
              placeholder="–" value={localScores[p]??""} onChange={e => setLocalScores(prev=>({...prev,[p]:e.target.value}))} />
            <div style={{ display:"flex", justifyContent:"center" }}>
              <input type="checkbox" checked={inLower} onChange={e=>setLowerOverrides(prev=>({...prev,[p]:e.target.checked}))} style={{ width:16, height:16, cursor:"pointer" }} />
            </div>
            <div style={{ display:"flex", justifyContent:"center" }}>
              {inLower
                ? <input type="checkbox" checked={winOverride===true||(winOverride==null&&autoWin)} onChange={e=>setLowerWinOverrides(prev=>({...prev,[p]:e.target.checked?true:false}))} style={{ width:16, height:16, cursor:"pointer", accentColor:"#c07000" }} />
                : <span style={{ fontSize:11, color:"var(--color-text-secondary)" }}>–</span>}
            </div>
            <div style={{ textAlign:"center" }}>
              {prev?.totalPts!=null?<span style={{ fontSize:15, fontWeight:700, color:"#2d6a44" }}>{prev.totalPts}</span>:<span style={{ fontSize:13, color:"var(--color-text-secondary)" }}>–</span>}
            </div>
          </div>
        );
      })}
      <div style={{ padding:"10px 14px", borderTop:"0.5px solid var(--color-border-tertiary)", background:"var(--color-background-secondary)" }}>
        <div style={{ fontSize:11, fontWeight:600, color:"var(--color-text-secondary)", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Live Preview</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {[...preview].filter(r=>r.totalPts!=null).sort((a,b)=>a.rank-b.rank||a.score-b.score).map(r=>(
            <div key={r.player} style={{ display:"flex", alignItems:"center", gap:5, background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:"5px 10px" }}>
              <span style={{ fontSize:12, color:"var(--color-text-secondary)" }}>#{r.rank}</span>
              <span style={{ fontSize:13, fontWeight:500, color:"var(--color-text-primary)" }}>{r.player}</span>
              <span style={{ fontSize:12, color:"var(--color-text-secondary)" }}>{r.score}</span>
              <span style={{ fontSize:13, fontWeight:700, color:"#2d6a44" }}>{r.totalPts}pts</span>
              {r.isLowerWinner&&<span style={S.badge("lower")}>+2</span>}
            </div>
          ))}
        </div>
      </div>
      <div style={{ padding:"12px 14px" }}>
        <button style={{ ...S.btn("primary"), width:"100%" }} onClick={save}>Save Week {selWeek+1} Scores</button>
      </div>
    </div>
  </>;
}

// ── PLAYERS TAB ───────────────────────────────────────────────────────────────
function PlayersTab({ data, setData, toast }) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState("");
  const add = () => {
    const name = newName.trim();
    if (!name||data.players.includes(name)){ toast("Name empty or already exists."); return; }
    setData(d=>({...d,players:[...d.players,name]})); setNewName(""); toast(`Added ${name}`);
  };
  const startEdit = (i) => { setEditing(i); setEditVal(data.players[i]); };
  const saveEdit = (i) => {
    const name = editVal.trim();
    if (!name){ toast("Name cannot be empty."); return; }
    if (data.players.includes(name)&&data.players[i]!==name){ toast("Name already taken."); return; }
    const old = data.players[i];
    setData(d => {
      const players = d.players.map((p,idx)=>idx===i?name:p);
      const scores={};
      Object.keys(d.scores).forEach(tid=>{ scores[tid]={weeks:{}}; const weeks=d.scores[tid]?.weeks||{}; Object.keys(weeks).forEach(wi=>{ scores[tid].weeks[wi]={}; Object.keys(weeks[wi]).forEach(p=>{ scores[tid].weeks[wi][p===old?name:p]=weeks[wi][p]; }); }); });
      return {...d,players,scores};
    });
    setEditing(null); toast(`Renamed to ${name}`);
  };
  const remove = (i) => {
    const name = data.players[i];
    if (!window.confirm(`Remove ${name}?`)) return;
    setData(d => {
      const scores={};
      Object.keys(d.scores).forEach(tid=>{ scores[tid]={weeks:{}}; const weeks=d.scores[tid]?.weeks||{}; Object.keys(weeks).forEach(wi=>{ scores[tid].weeks[wi]={}; Object.keys(weeks[wi]).forEach(p=>{ if(p!==name) scores[tid].weeks[wi][p]=weeks[wi][p]; }); }); });
      return {...d,players:d.players.filter((_,idx)=>idx!==i),scores};
    });
    toast(`Removed ${name}`);
  };
  return <>
    <div style={S.label}>Add Player</div>
    <div style={{ display:"flex", gap:8, marginBottom:14 }}>
      <input style={{ ...S.input, flex:1 }} placeholder="Player name" value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} />
      <button style={S.btn("primary")} onClick={add}>Add</button>
    </div>
    <div style={S.label}>Roster ({data.players.length} players)</div>
    <div style={S.card}>
      {data.players.map((p,i)=>(
        <div key={p} style={{ ...S.row, gap:8 }}>
          {editing===i?<>
            <input style={{ ...S.input, flex:1 }} value={editVal} autoFocus onChange={e=>setEditVal(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter")saveEdit(i); if(e.key==="Escape")setEditing(null); }} />
            <button style={{ ...S.btn("primary"), padding:"6px 12px", fontSize:13 }} onClick={()=>saveEdit(i)}>Save</button>
            <button style={S.btn("sm")} onClick={()=>setEditing(null)}>✕</button>
          </>:<>
            <span style={{ flex:1, fontSize:15, color:"var(--color-text-primary)" }}>{p}</span>
            <button style={{ ...S.btn("sm"), fontSize:12 }} onClick={()=>startEdit(i)}>Rename</button>
            <button style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }} onClick={()=>remove(i)}>Remove</button>
          </>}
        </div>
      ))}
    </div>
  </>;
}

// ── EVENTS TAB ────────────────────────────────────────────────────────────────
function EventsTab({ data, setData, toast }) {
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState("");
  const [editMajor, setEditMajor] = useState(false);
  const startEdit = (i) => { setEditing(i); setEditName(data.tournaments[i].name); setEditMajor(data.tournaments[i].isMajor); };
  const saveEdit = (i) => {
    if (!editName.trim()){ toast("Name required."); return; }
    setData(d=>({...d,tournaments:d.tournaments.map((t,idx)=>idx===i?{...t,name:editName.trim(),isMajor:editMajor}:t)}));
    setEditing(null); toast("Event updated.");
  };
  return <>
    <div style={S.label}>Edit Events</div>
    <div style={S.card}>
      {data.tournaments.map((t,i)=>(
        <div key={t.id} style={{ ...S.row, flexDirection:"column", alignItems:"stretch", gap:8 }}>
          {editing===i?<>
            <input style={S.input} value={editName} autoFocus onChange={e=>setEditName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter")saveEdit(i); if(e.key==="Escape")setEditing(null); }} />
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:14, color:"var(--color-text-primary)", cursor:"pointer", flex:1 }}>
                <input type="checkbox" checked={editMajor} onChange={e=>setEditMajor(e.target.checked)} />Major (points doubled)
              </label>
              <button style={{ ...S.btn("primary"), padding:"6px 12px", fontSize:13 }} onClick={()=>saveEdit(i)}>Save</button>
              <button style={S.btn("sm")} onClick={()=>setEditing(null)}>✕</button>
            </div>
          </>:(
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:500, color:"var(--color-text-primary)" }}>{t.name}</div>
                {t.isMajor&&<span style={{ ...S.badge("major"), marginTop:3, display:"inline-block" }}>MAJOR</span>}
              </div>
              <button style={{ ...S.btn("sm"), fontSize:12 }} onClick={()=>startEdit(i)}>Edit</button>
            </div>
          )}
        </div>
      ))}
    </div>
  </>;
}

// ── SEASON TAB ────────────────────────────────────────────────────────────────
function SeasonTab({ data, setData, toast }) {
  const [seasonName, setSeasonName] = useState(data.season.name);
  const [startDate, setStartDate] = useState(data.season.startDate);
  const [endDate, setEndDate] = useState(data.season.endDate);
  const [showNew, setShowNew] = useState(false);
  const [nsName, setNsName] = useState("");
  const [nsStart, setNsStart] = useState("");
  const [nsEnd, setNsEnd] = useState("");
  const [keepPlayers, setKeepPlayers] = useState(true);
  const saveSeason = () => {
    if (!seasonName.trim()){ toast("Name required."); return; }
    setData(d=>({...d,season:{name:seasonName.trim(),startDate,endDate}})); toast("Season info saved.");
  };
  const startNew = () => {
    if (!nsName.trim()||!nsStart||!nsEnd){ toast("Fill in all fields."); return; }
    if (!window.confirm(`Start "${nsName}"? All scores will be reset.`)) return;
    setData(d=>({...makeDefaultData(),players:keepPlayers?d.players:DEFAULT_PLAYERS,scores:{},season:{name:nsName.trim(),startDate:nsStart,endDate:nsEnd}}));
    setShowNew(false); toast(`New season "${nsName}" started!`);
  };
  return <>
    <div style={S.label}>Current Season</div>
    <div style={S.card}>
      <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <div style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:4 }}>Season Name</div>
          <input style={S.input} value={seasonName} onChange={e=>setSeasonName(e.target.value)} />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div>
            <div style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:4 }}>Start Date</div>
            <input type="date" style={S.input} value={startDate} onChange={e=>setStartDate(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:4 }}>End Date</div>
            <input type="date" style={S.input} value={endDate} onChange={e=>setEndDate(e.target.value)} />
          </div>
        </div>
        <button style={{ ...S.btn("primary"), width:"100%" }} onClick={saveSeason}>Save Season Info</button>
      </div>
    </div>
    <div style={S.label}>New Season</div>
    <div style={S.card}>
      {!showNew?(
        <div style={{ padding:14 }}>
          <div style={{ fontSize:14, color:"var(--color-text-secondary)", marginBottom:12 }}>Reset all scores and start fresh for a new season.</div>
          <button style={{ ...S.btn(""), borderColor:"#c09030", color:"#a07020", width:"100%" }} onClick={()=>setShowNew(true)}>Start New Season →</button>
        </div>
      ):(
        <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:10 }}>
          <div>
            <div style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:4 }}>New Season Name</div>
            <input style={S.input} placeholder="e.g. 2026 Season" value={nsName} onChange={e=>setNsName(e.target.value)} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:4 }}>Start Date</div>
              <input type="date" style={S.input} value={nsStart} onChange={e=>setNsStart(e.target.value)} />
            </div>
            <div>
              <div style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:4 }}>End Date</div>
              <input type="date" style={S.input} value={nsEnd} onChange={e=>setNsEnd(e.target.value)} />
            </div>
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:14, color:"var(--color-text-primary)", cursor:"pointer" }}>
            <input type="checkbox" checked={keepPlayers} onChange={e=>setKeepPlayers(e.target.checked)} />Keep current player roster
          </label>
          <div style={{ display:"flex", gap:8 }}>
            <button style={{ ...S.btn("danger"), flex:1 }} onClick={startNew}>Confirm New Season</button>
            <button style={{ ...S.btn(""), flex:1 }} onClick={()=>setShowNew(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  </>;
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData, loaded] = useData();
  const [tab, setTab] = useState("leaderboard");
  const [isAdmin, setIsAdmin] = useState(false);

  if (!loaded) return (
    <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Loading...</div>
  );

  const tabs = [{ id:"leaderboard",label:"Board" },{ id:"tournaments",label:"Events" },{ id:"stats",label:"Stats" },{ id:"admin",label:isAdmin?"Admin ✓":"Admin" }];
  return (
    <div style={S.app}>
      <div style={S.hdr}>
        <div style={{ fontSize:19, fontWeight:600, letterSpacing:0.5 }}>⛳ Back Nine Bandits</div>
        <div style={{ fontSize:12, color:"#a8c5b0", marginTop:2 }}>{data.season.name}</div>
      </div>
      <div style={S.nav}>
        {tabs.map(t=><button key={t.id} style={S.navBtn(tab===t.id)} onClick={()=>setTab(t.id)}>{t.label}</button>)}
      </div>
      {tab==="leaderboard" && <LeaderboardPage data={data} />}
      {tab==="tournaments" && <TournamentsPage data={data} />}
      {tab==="stats"       && <StatsPage data={data} />}
      {tab==="admin"       && <AdminPage data={data} setData={setData} isAdmin={isAdmin} setIsAdmin={setIsAdmin} />}
    </div>
  );
}
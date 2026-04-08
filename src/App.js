import { useState, useEffect, useMemo, useRef } from "react";
import { db } from "./firebase";
import { doc, setDoc, onSnapshot } from "firebase/firestore";
const ADMIN_PIN = "1234";
const TEAL = "#338387";
const TEAL_DARK = "#236063";
const TEAL_LIGHT = "#e8f4f5";
const TEAL_MID = "#5aa3a7";

const DEFAULT_TOURNAMENTS = [
  { id: 1, name: "Tournament 1", isMajor: false, format: "stroke" },
  { id: 2, name: "Tournament 2", isMajor: false, format: "stroke" },
  { id: 3, name: "The Masters Cup", isMajor: true, format: "stroke" },
  { id: 4, name: "Tournament 4", isMajor: false, format: "stroke" },
  { id: 5, name: "Tournament 5", isMajor: false, format: "stroke" },
  { id: 6, name: "The Open", isMajor: true, format: "stroke" },
  { id: 7, name: "Tournament 7", isMajor: false, format: "stroke" },
  { id: 8, name: "Championship", isMajor: true, format: "stroke" },
];

const DEFAULT_PLAYERS = ["Tiger", "Phil", "Rory", "Dustin", "Jordan", "Brooks", "Jon", "Xander"];

const PTS_MAP = { 1: 6, 2: 4, 3: 2 };
const getPlacementPts = (p) => PTS_MAP[p] || 1;

// ── SCORING ───────────────────────────────────────────────────────────────────
function calcWeekPoints(entries) {
  const played = entries.filter(e => e.score != null && e.score !== "");
  if (!played.length) return entries.map(e => ({ ...e, rank: null, basePts: null, lowerBonus: 0, totalPts: null, isLowerWinner: false }));
  const sorted = [...played].sort((a, b) => a.score - b.score);
  const rankMap = {};
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    rankMap[sorted[i].player] = i > 0 && sorted[i].score === sorted[i-1].score ? rankMap[sorted[i-1].player] : rank;
    rank++;
  }
  const basePtsMap = {};
  played.forEach(e => { basePtsMap[e.player] = PTS_MAP[rankMap[e.player]] ?? 1; });
  const lowerPlayers = played.filter(e => e.inLowerGroup);
  let autoLowerWinner = null;
  if (lowerPlayers.length) {
    const best = Math.min(...lowerPlayers.map(e => e.score));
    autoLowerWinner = lowerPlayers.filter(e => e.score === best).map(e => e.player);
  }
  return entries.map(e => {
    if (e.score == null || e.score === "") return { ...e, rank: null, basePts: null, lowerBonus: 0, totalPts: null, isLowerWinner: false };
    const r = rankMap[e.player], bp = basePtsMap[e.player];
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
  return results.filter(r => r.totalPts != null).sort((a, b) => b.totalPts - a.totalPts).slice(-4).map(r => r.player);
}

function getAllScores(data, player) {
  const all = [];
  (data.tournaments || []).forEach((t, tIdx) => {
    const weeks = data.scores[t.id]?.weeks || {};
    [0, 1, 2].forEach(wi => { const wd = weeks[wi]; if (wd?.[player]?.score != null) all.push({ score: wd[player].score, tIdx, wi }); });
  });
  return all;
}

function stdDev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length);
}

function makeDefaultData() {
  return {
    season: { name: "2025 Season", startDate: "2025-04-01", endDate: "2025-09-30" },
    players: [...DEFAULT_PLAYERS],
    scores: {},
    tournaments: DEFAULT_TOURNAMENTS.map(t => ({ ...t })),
    logo: null,
    archivedSeasons: [],
  };
}

function initData() {
  try { const s = localStorage.getItem("bnn_v5"); if (s) return JSON.parse(s); } catch (e) {}
  return makeDefaultData();
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
  app: { fontFamily: "system-ui,sans-serif", maxWidth: 520, margin: "0 auto", minHeight: "100vh", background: "#f5f5f5" },
  hdr: { background: TEAL_DARK, color: "#fff", padding: "14px 18px 10px", display: "flex", alignItems: "center", gap: 12 },
  nav: { display: "flex", background: TEAL_DARK, borderBottom: `2px solid ${TEAL}` },
  navBtn: (a) => ({ flex: 1, padding: "10px 4px", border: "none", background: a ? TEAL : "transparent", color: a ? "#fff" : "rgba(255,255,255,0.6)", fontSize: 12, fontWeight: a ? 700 : 400, cursor: "pointer", borderBottom: a ? "2px solid #fff" : "2px solid transparent" }),
  page: { padding: 14 },
  card: { background: "#fff", borderRadius: 12, border: "1px solid #e0e0e0", marginBottom: 10, overflow: "hidden" },
  row: { display: "flex", alignItems: "center", padding: "11px 14px", borderBottom: "1px solid #f0f0f0" },
  rank: (i) => ({ width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0, background: i === 0 ? "#f0c030" : i === 1 ? "#b0b8c0" : i === 2 ? "#c07840" : "#f0f0f0", color: i < 3 ? "#1a1a1a" : "#666" }),
  label: { fontSize: 11, fontWeight: 700, color: "#666", letterSpacing: 1, textTransform: "uppercase", padding: "14px 0 6px" },
  btn: (v) => ({ padding: v === "sm" ? "6px 12px" : "10px 18px", borderRadius: 8, border: v === "danger" ? "1px solid #ffcccc" : v === "primary" ? "none" : "1px solid #ddd", background: v === "primary" ? TEAL : v === "danger" ? "#fff5f5" : "#fff", color: v === "primary" ? "#fff" : v === "danger" ? "#d03030" : "#333", fontSize: v === "sm" ? 13 : 14, fontWeight: 600, cursor: "pointer" }),
  input: { width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", color: "#222", fontSize: 14, boxSizing: "border-box", outline: "none" },
  badge: (t) => { const m = { major: [TEAL_DARK, TEAL_LIGHT], bonus: ["#1a3575", "#e8eeff"], lower: ["#5a3000", "#fff3e0"], ryder: ["#222", "#f5f5f5"] }; const [bg, c] = m[t] || ["#ccc", "#333"]; return { background: bg, color: c, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, display: "inline-block" }; },
  toast: { background: TEAL_LIGHT, color: TEAL_DARK, padding: "10px 14px", borderRadius: 8, marginBottom: 12, fontWeight: 600, fontSize: 14, border: `1px solid ${TEAL_MID}` },
  sectionHdr: { background: TEAL, color: "#fff", padding: "8px 14px", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" },
};

function Toast({ msg }) { if (!msg) return null; return <div style={S.toast}>{msg}</div>; }

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
function LeaderboardPage({ data }) {
  const { lb, bestRound, worstRound, mostImproved, mostConsistent } = useMemo(() => {
    const allRounds = [];
    const lb = (data.players || []).map(player => {
      let totalPts = 0, tournsPlayed = 0;
      const scores = getAllScores(data, player);
      scores.forEach(s => allRounds.push({ player, score: s.score }));
      (data.tournaments || []).forEach(t => {
        const weeks = data.scores[t.id]?.weeks || {};
        const weekPts = [0, 1, 2].map(wi => {
          const wd = weeks[wi];
          if (!wd) return null;
          const entries = (data.players || []).map(p => ({ player: p, score: wd[p]?.score ?? null, inLowerGroup: wd[p]?.inLowerGroup ?? false, lowerGroupWinOverride: wd[p]?.lowerGroupWinOverride ?? null }));
          return calcWeekPoints(entries).find(r => r.player === player)?.totalPts ?? null;
        });
        const res = calcTournamentScore(weekPts, t.isMajor);
        if (res) { totalPts += res.total; tournsPlayed++; }
      });
      return { player, totalPts, tournsPlayed, avg: tournsPlayed > 0 ? (totalPts / tournsPlayed).toFixed(1) : "–" };
    }).sort((a, b) => b.totalPts - a.totalPts);

    let bestRound = null, worstRound = null;
    if (allRounds.length) {
      bestRound = allRounds.reduce((a, b) => b.score < a.score ? b : a);
      worstRound = allRounds.reduce((a, b) => b.score > a.score ? b : a);
    }

    const firstHalfIds = (data.tournaments || []).slice(0, 4).map(t => t.id);
    const secondHalfIds = (data.tournaments || []).slice(4).map(t => t.id);
    let mostImproved = null;
    const improvements = (data.players || []).map(player => {
      const fs = [], ss = [];
      firstHalfIds.forEach(tid => { const w = data.scores[tid]?.weeks || {}; [0,1,2].forEach(wi => { const s = w[wi]?.[player]?.score; if (s != null) fs.push(s); }); });
      secondHalfIds.forEach(tid => { const w = data.scores[tid]?.weeks || {}; [0,1,2].forEach(wi => { const s = w[wi]?.[player]?.score; if (s != null) ss.push(s); }); });
      if (!fs.length || !ss.length) return null;
      const fa = fs.reduce((a,b)=>a+b,0)/fs.length, sa = ss.reduce((a,b)=>a+b,0)/ss.length;
      return { player, firstAvg: fa.toFixed(1), secondAvg: sa.toFixed(1), improvement: fa - sa };
    }).filter(Boolean);
    if (improvements.length) { const best = improvements.reduce((a,b)=>b.improvement>a.improvement?b:a); if (best.improvement>0) mostImproved = best; }

    let mostConsistent = null;
    const consistency = (data.players || []).map(player => {
      const scores = getAllScores(data, player).map(s => s.score);
      if (scores.length < 3) return null;
      return { player, sd: stdDev(scores), avg: (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1), rounds: scores.length };
    }).filter(Boolean);
    if (consistency.length) mostConsistent = consistency.reduce((a,b)=>b.sd<a.sd?b:a);

    return { lb, bestRound, worstRound, mostImproved, mostConsistent };
  }, [data]);

  const leader = lb[0];
  const hasStats = bestRound || mostImproved || mostConsistent;

  return (
    <div style={S.page}>
      {/* Season banner */}
      <div style={{ ...S.card, background: TEAL_DARK, padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Current Season</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginTop: 4 }}>{data.season.name}</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>{data.season.startDate} – {data.season.endDate}</div>
      </div>

      {/* Leader card */}
      {leader?.totalPts > 0 && (
        <div style={{ ...S.card, background: "#111", padding: "14px 18px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Season Leader</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
            <span style={{ fontSize: 28 }}>🏆</span>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#f0c030" }}>{leader.player}</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{leader.totalPts} pts · {leader.tournsPlayed} events</div>
            </div>
          </div>
        </div>
      )}

      {/* Season highlights */}
      {hasStats && <>
        <div style={S.label}>Season Highlights</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          {bestRound && (
            <div style={{ ...S.card, borderTop: `3px solid ${TEAL}`, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: TEAL, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Best Round</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#111" }}>{bestRound.score}</div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{bestRound.player}</div>
            </div>
          )}
          {worstRound && (
            <div style={{ ...S.card, borderTop: "3px solid #c07040", padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#c07040", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Worst Round</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#111" }}>{worstRound.score}</div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{worstRound.player}</div>
            </div>
          )}
          {mostImproved && (
            <div style={{ ...S.card, borderTop: "3px solid #1a3575", padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#1a3575", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Most Improved</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111" }}>{mostImproved.player}</div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>{mostImproved.firstAvg} → {mostImproved.secondAvg}</div>
              <div style={{ fontSize: 11, color: TEAL, marginTop: 2 }}>▼ {(+mostImproved.improvement).toFixed(1)} strokes</div>
            </div>
          )}
          {mostConsistent && (
            <div style={{ ...S.card, borderTop: "3px solid #7a2080", padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#7a2080", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Most Consistent</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111" }}>{mostConsistent.player}</div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>avg {mostConsistent.avg} · {mostConsistent.rounds} rounds</div>
              <div style={{ fontSize: 11, color: "#7a2080", marginTop: 2 }}>σ {mostConsistent.sd.toFixed(2)}</div>
            </div>
          )}
        </div>
      </>}

      <div style={S.label}>Standings</div>
      <div style={S.card}>
        {lb.map((p, i) => (
          <div key={p.player} style={{ ...S.row, background: i === 0 && p.totalPts > 0 ? TEAL_LIGHT : undefined }}>
            <div style={S.rank(i)}>{i + 1}</div>
            <div style={{ flex: 1, marginLeft: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#111" }}>{p.player}</span>
              <div style={{ fontSize: 12, color: "#888", marginTop: 1 }}>{p.tournsPlayed} events · avg {p.avg} pts</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: TEAL }}>{p.totalPts}</div>
              <div style={{ fontSize: 11, color: "#888" }}>pts</div>
            </div>
          </div>
        ))}
      </div>

      {/* Archived seasons */}
      {data.archivedSeasons?.length > 0 && <>
        <div style={S.label}>Past Seasons</div>
        {data.archivedSeasons.map((s, i) => (
          <div key={i} style={{ ...S.card, padding: "12px 16px" }}>
            <div style={{ fontWeight: 600, color: "#111" }}>{s.season.name}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{s.season.startDate} – {s.season.endDate} · {s.players?.length || 0} players</div>
          </div>
        ))}
      </>}
    </div>
  );
}

// ── TOURNAMENTS ───────────────────────────────────────────────────────────────
function TournamentsPage({ data }) {
  const [sel, setSel] = useState(null);
  if (sel !== null && data.tournaments[sel]) return <TournamentDetail t={data.tournaments[sel]} data={data} onBack={() => setSel(null)} />;
  return (
    <div style={S.page}>
      {(data.tournaments || []).map((t, i) => {
        const weeks = data.scores[t.id]?.weeks || {};
        const hasScores = Object.keys(weeks).length > 0;
        return (
          <div key={t.id} style={{ ...S.card, cursor: "pointer" }} onClick={() => setSel(i)}>
            <div style={{ ...S.row, borderBottom: "none" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "#111" }}>{t.name}</span>
                  {t.isMajor && <span style={S.badge("major")}>MAJOR 2×</span>}
                  {t.format === "ryder" && <span style={S.badge("ryder")}>RYDER CUP</span>}
                  {t.format === "both" && <span style={S.badge("ryder")}>STROKE + RYDER</span>}
                </div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{hasScores ? `${Object.keys(weeks).length} week(s) entered` : "Not started"}</div>
              </div>
              <div style={{ color: "#aaa", fontSize: 18 }}>›</div>
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
    const entries = (data.players||[]).map(p => ({ player: p, score: wd[p]?.score ?? null, inLowerGroup: wd[p]?.inLowerGroup ?? false, lowerGroupWinOverride: wd[p]?.lowerGroupWinOverride ?? null }));
    return calcWeekPoints(entries);
  }), [data, t]);

  const playerResults = useMemo(() => (data.players||[]).map(player => {
    const weekPts = weekResults.map(wr => wr?.find(r => r.player === player)?.totalPts ?? null);
    const res = calcTournamentScore(weekPts, t.isMajor);
    return { player, weekDetails: weekResults.map(wr => wr?.find(r => r.player === player) ?? null), res };
  }).filter(r => r.res).sort((a, b) => b.res.total - a.res.total), [data, t, weekResults]);

  return (
    <div style={S.page}>
      <button onClick={onBack} style={{ ...S.btn("sm"), marginBottom: 14 }}>← Back</button>
      <div style={{ ...S.card, background: TEAL_DARK, padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Tournament</div>
        <div style={{ fontSize: 19, fontWeight: 700, color: "#fff", marginTop: 4 }}>{t.name}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {t.isMajor && <span style={S.badge("major")}>MAJOR – Points Doubled</span>}
          {t.format === "ryder" && <span style={S.badge("ryder")}>RYDER CUP</span>}
        </div>
      </div>
      {!playerResults.length
        ? <div style={{ color: "#888", textAlign: "center", padding: 32 }}>No scores entered yet.</div>
        : playerResults.map((r, i) => (
          <div key={r.player} style={S.card}>
            <div style={{ padding: "11px 14px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={S.rank(i)}>{i+1}</div>
              <span style={{ fontWeight: 600, flex: 1, color: "#111" }}>{r.player}</span>
              <span style={{ fontSize: 19, fontWeight: 700, color: TEAL }}>{r.res.total} pts</span>
              {t.isMajor && <span style={{ fontSize: 11, color: TEAL_MID, marginLeft: 2 }}>×2</span>}
            </div>
            <div style={{ padding: "10px 14px", display: "flex", gap: 8 }}>
              {[0,1,2].map(wi => {
                const wd = r.weekDetails[wi];
                const dropped = r.res.dropped === wi;
                return (
                  <div key={wi} style={{ textAlign: "center", flex: 1, padding: "8px 4px", borderRadius: 8, border: `1px solid ${dropped?"#eee":wd?TEAL:"#eee"}`, opacity: dropped?0.4:1, background: dropped?"#fafafa":wd?TEAL_LIGHT:"transparent" }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Wk {wi+1}</div>
                    {wd ? <>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111" }}>{wd.score}</div>
                      <div style={{ fontSize: 12, color: TEAL }}>{wd.totalPts} pts</div>
                      {wd.inLowerGroup && <div style={{ fontSize: 10, color: "#a06000", marginTop: 2 }}>lower{wd.isLowerWinner?" +2":""}</div>}
                      {dropped && <div style={{ fontSize: 10, color: "#e05" }}>dropped</div>}
                    </> : <div style={{ fontSize: 13, color: "#ccc" }}>–</div>}
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
  const stats = useMemo(() => (data.players||[]).map(player => {
    let totalPts=0, tournsPlayed=0, weekWins=0, top3=0, bonuses=0, lowerWins=0;
    const allScores = getAllScores(data, player).map(s => s.score);
    (data.tournaments||[]).forEach(t => {
      const weeks = data.scores[t.id]?.weeks || {};
      const weekPts = [0,1,2].map(wi => {
        const wd = weeks[wi];
        if (!wd) return null;
        const entries = (data.players||[]).map(p => ({ player: p, score: wd[p]?.score ?? null, inLowerGroup: wd[p]?.inLowerGroup ?? false, lowerGroupWinOverride: wd[p]?.lowerGroupWinOverride ?? null }));
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
    const scoreAvg = allScores.length > 0 ? (allScores.reduce((a,b)=>a+b,0)/allScores.length).toFixed(1) : "–";
    const bestScore = allScores.length ? Math.min(...allScores) : null;
    const worstScore = allScores.length ? Math.max(...allScores) : null;
    const sd = allScores.length >= 2 ? stdDev(allScores) : null;
    return { player, totalPts, tournsPlayed, weekWins, top3, bonuses, lowerWins, scoreAvg, bestScore, worstScore, sd, rounds: allScores.length };
  }).sort((a, b) => b.totalPts - a.totalPts), [data]);

  return (
    <div style={S.page}>
      {stats.map((p, i) => (
        <div key={p.player} style={{ ...S.card, marginBottom: 14 }}>
          {/* Player header bar */}
          <div style={{ background: TEAL_DARK, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ ...S.rank(i), background: i===0?"#f0c030":i===1?"#b0b8c0":i===2?"#c07840":"rgba(255,255,255,0.2)", color: i<3?"#1a1a1a":"#fff" }}>{i+1}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>{p.player}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: 1 }}>{p.rounds} rounds · {p.tournsPlayed} events</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>{p.totalPts}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>pts</div>
            </div>
          </div>

          {/* Scoring section */}
          <div style={{ padding: "6px 14px 2px", fontSize: 10, fontWeight: 700, color: TEAL, letterSpacing: 1, textTransform: "uppercase", borderBottom: "none" }}>Scoring</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", padding: "4px 8px 12px", borderBottom: "1px solid #f0f0f0" }}>
            {[["Avg Score", p.scoreAvg, TEAL_DARK], ["Best Round", p.bestScore ?? "–", TEAL], ["Worst Round", p.worstScore ?? "–", "#c07040"]].map(([lbl, val, color]) => (
              <div key={lbl} style={{ textAlign: "center", padding: "8px 4px" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
                <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>{lbl}</div>
              </div>
            ))}
          </div>

          {/* Performance section */}
          <div style={{ padding: "6px 14px 2px", fontSize: 10, fontWeight: 700, color: TEAL, letterSpacing: 1, textTransform: "uppercase" }}>Performance</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", padding: "4px 8px 12px" }}>
            {[["Wk Wins", p.weekWins], ["Top 3", p.top3], ["Attendance", p.bonuses], ["Lower Wins", p.lowerWins]].map(([lbl, val]) => (
              <div key={lbl} style={{ textAlign: "center", padding: "8px 2px" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#111" }}>{val}</div>
                <div style={{ fontSize: 10, color: "#888", marginTop: 3, lineHeight: 1.3 }}>{lbl}</div>
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
      <div style={{ textAlign: "center", fontSize: 15, color: "#666", marginBottom: 10 }}>Enter Admin PIN</div>
      <input style={{ ...S.input, marginBottom: 10 }} type="password" placeholder="PIN" value={pin}
        onChange={e => { setPin(e.target.value); setPinErr(false); }}
        onKeyDown={e => e.key === "Enter" && (pin === ADMIN_PIN ? setIsAdmin(true) : setPinErr(true))} />
      {pinErr && <div style={{ color: "#d03030", fontSize: 13, textAlign: "center", marginBottom: 8 }}>Incorrect PIN</div>}
      <button style={{ ...S.btn("primary"), width: "100%" }} onClick={() => pin === ADMIN_PIN ? setIsAdmin(true) : setPinErr(true)}>Unlock Admin</button>
      <div style={{ fontSize: 12, color: "#888", textAlign: "center", marginTop: 8 }}>Default PIN: 1234</div>
    </div>
  );

  return (
    <div style={S.page}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {["scores","players","events","season"].map(tb => (
          <button key={tb} style={{ ...S.btn(tab===tb?"primary":""), fontSize: 13, padding: "7px 14px" }} onClick={() => setTab(tb)}>
            {tb.charAt(0).toUpperCase()+tb.slice(1)}
          </button>
        ))}
        <button style={{ ...S.btn("sm"), marginLeft: "auto", color: "#888" }} onClick={() => setIsAdmin(false)}>Lock</button>
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
  const t = data.tournaments[selTIdx] || data.tournaments[0];
  const [localScores, setLocalScores] = useState({});
  const [lowerOverrides, setLowerOverrides] = useState({});
  const [lowerWinOverrides, setLowerWinOverrides] = useState({});
  const autoLower = useMemo(() => getLastWeekBottom4(data, t.id, selWeek), [data, t.id, selWeek]);

  useEffect(() => {
    const wd = data.scores[t.id]?.weeks?.[selWeek] || {};
    const scores={}, lower={}, lowerWin={};
    (data.players||[]).forEach(p => {
      scores[p] = wd[p]?.score ?? "";
      lower[p] = wd[p]?.inLowerGroup ?? autoLower.includes(p);
      lowerWin[p] = wd[p]?.lowerGroupWinOverride ?? null;
    });
    setLocalScores(scores); setLowerOverrides(lower); setLowerWinOverrides(lowerWin);
  }, [selTIdx, selWeek, data]);

  const preview = useMemo(() => {
    const entries = (data.players||[]).map(p => ({ player: p, score: localScores[p]!==""&&localScores[p]!=null?Number(localScores[p]):null, inLowerGroup: lowerOverrides[p]??false, lowerGroupWinOverride: lowerWinOverrides[p]??null }));
    return calcWeekPoints(entries);
  }, [localScores, lowerOverrides, lowerWinOverrides, data.players]);

  const save = () => {
    const wd = {};
    (data.players||[]).forEach(p => {
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
          {(data.tournaments||[]).map((t,i) => <option key={t.id} value={i}>{t.name}{t.isMajor?" ★":""}</option>)}
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
      <div style={{ padding:"10px 14px", borderBottom:"1px solid #f0f0f0", fontSize:13, color:"#666" }}>
        Enter 9-hole scores. Lower = better. Lower group auto-set from last week.
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 68px 36px 36px 56px", gap:6, padding:"8px 12px 4px", fontSize:11, color:"#888", fontWeight:700, alignItems:"center" }}>
        <div>Player</div><div style={{ textAlign:"center" }}>Score</div><div style={{ textAlign:"center" }}>Low</div><div style={{ textAlign:"center" }}>Win</div><div style={{ textAlign:"center" }}>Pts</div>
      </div>
      {(data.players||[]).map(p => {
        const prev = preview.find(r => r.player === p);
        const inLower = lowerOverrides[p]??false;
        const winOverride = lowerWinOverrides[p];
        const autoWin = prev?.isLowerWinner && winOverride==null;
        return (
          <div key={p} style={{ display:"grid", gridTemplateColumns:"1fr 68px 36px 36px 56px", gap:6, padding:"7px 12px", borderTop:"1px solid #f0f0f0", alignItems:"center" }}>
            <div style={{ fontSize:14, fontWeight:600, color:"#111" }}>{p}</div>
            <input type="number" min="18" max="90" style={{ ...S.input, padding:"7px 4px", textAlign:"center", fontSize:14 }}
              placeholder="–" value={localScores[p]??""} onChange={e => setLocalScores(prev=>({...prev,[p]:e.target.value}))} />
            <div style={{ display:"flex", justifyContent:"center" }}>
              <input type="checkbox" checked={inLower} onChange={e=>setLowerOverrides(prev=>({...prev,[p]:e.target.checked}))} style={{ width:16, height:16, cursor:"pointer", accentColor:TEAL }} />
            </div>
            <div style={{ display:"flex", justifyContent:"center" }}>
              {inLower
                ? <input type="checkbox" checked={winOverride===true||(winOverride==null&&autoWin)} onChange={e=>setLowerWinOverrides(prev=>({...prev,[p]:e.target.checked?true:false}))} style={{ width:16, height:16, cursor:"pointer", accentColor:"#c07000" }} />
                : <span style={{ fontSize:11, color:"#ccc" }}>–</span>}
            </div>
            <div style={{ textAlign:"center" }}>
              {prev?.totalPts!=null?<span style={{ fontSize:15, fontWeight:700, color:TEAL }}>{prev.totalPts}</span>:<span style={{ fontSize:13, color:"#ccc" }}>–</span>}
            </div>
          </div>
        );
      })}
      <div style={{ padding:"10px 14px", borderTop:"1px solid #f0f0f0", background:"#fafafa" }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#888", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Live Preview</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {[...preview].filter(r=>r.totalPts!=null).sort((a,b)=>a.rank-b.rank||a.score-b.score).map(r=>(
            <div key={r.player} style={{ display:"flex", alignItems:"center", gap:5, background:"#fff", border:"1px solid #e0e0e0", borderRadius:8, padding:"5px 10px" }}>
              <span style={{ fontSize:12, color:"#888" }}>#{r.rank}</span>
              <span style={{ fontSize:13, fontWeight:600, color:"#111" }}>{r.player}</span>
              <span style={{ fontSize:12, color:"#888" }}>{r.score}</span>
              <span style={{ fontSize:13, fontWeight:700, color:TEAL }}>{r.totalPts}pts</span>
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
    if (!name) { toast("Name cannot be empty."); return; }
    if ((data.players||[]).includes(name)) { toast("Player already exists."); return; }
    setData(d => ({ ...d, players: [...(d.players||[]), name] }));
    setNewName(""); toast(`Added ${name}`);
  };

  const startEdit = (i) => { setEditing(i); setEditVal(data.players[i]); };

  const saveEdit = (i) => {
    const name = editVal.trim();
    if (!name) { toast("Name cannot be empty."); return; }
    if ((data.players||[]).includes(name) && data.players[i] !== name) { toast("Name already taken."); return; }
    const old = data.players[i];
    setData(d => {
      const players = (d.players||[]).map((p, idx) => idx === i ? name : p);
      const scores = {};
      Object.keys(d.scores||{}).forEach(tid => {
        scores[tid] = { weeks: {} };
        const weeks = d.scores[tid]?.weeks || {};
        Object.keys(weeks).forEach(wi => {
          scores[tid].weeks[wi] = {};
          Object.keys(weeks[wi]).forEach(p => { scores[tid].weeks[wi][p === old ? name : p] = weeks[wi][p]; });
        });
      });
      return { ...d, players, scores };
    });
    setEditing(null); toast(`Renamed to ${name}`);
  };

  const remove = (i) => {
    const name = data.players[i];
    if (!window.confirm(`Remove ${name} and all their scores?`)) return;
    setData(d => {
      const scores = {};
      Object.keys(d.scores||{}).forEach(tid => {
        scores[tid] = { weeks: {} };
        const weeks = d.scores[tid]?.weeks || {};
        Object.keys(weeks).forEach(wi => {
          scores[tid].weeks[wi] = {};
          Object.keys(weeks[wi]).forEach(p => { if (p !== name) scores[tid].weeks[wi][p] = weeks[wi][p]; });
        });
      });
      return { ...d, players: (d.players||[]).filter((_, idx) => idx !== i), scores };
    });
    toast(`Removed ${name}`);
  };

  return <>
    <div style={S.label}>Add Player</div>
    <div style={{ display:"flex", gap:8, marginBottom:14 }}>
      <input style={{ ...S.input, flex:1 }} placeholder="Enter player name" value={newName}
        onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key==="Enter" && add()} />
      <button style={S.btn("primary")} onClick={add}>Add</button>
    </div>
    <div style={S.label}>Roster ({(data.players||[]).length} players)</div>
    <div style={S.card}>
      {(data.players||[]).length === 0 && (
        <div style={{ padding: "20px 16px", textAlign: "center", color: "#888" }}>No players yet. Add one above.</div>
      )}
      {(data.players||[]).map((p, i) => (
        <div key={p+i} style={{ ...S.row, gap: 8 }}>
          {editing === i ? <>
            <input style={{ ...S.input, flex:1 }} value={editVal} autoFocus
              onChange={e => setEditVal(e.target.value)}
              onKeyDown={e => { if(e.key==="Enter") saveEdit(i); if(e.key==="Escape") setEditing(null); }} />
            <button style={{ ...S.btn("primary"), padding:"6px 12px", fontSize:13 }} onClick={() => saveEdit(i)}>Save</button>
            <button style={{ ...S.btn("sm"), fontSize:13 }} onClick={() => setEditing(null)}>✕</button>
          </> : <>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: TEAL_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAL_DARK, flexShrink: 0 }}>
              {p.charAt(0).toUpperCase()}
            </div>
            <span style={{ flex:1, fontSize:15, fontWeight:500, color:"#111" }}>{p}</span>
            <button style={{ ...S.btn("sm"), fontSize:12 }} onClick={() => startEdit(i)}>Rename</button>
            <button style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }} onClick={() => remove(i)}>Remove</button>
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
  const [editFormat, setEditFormat] = useState("stroke");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMajor, setNewMajor] = useState(false);
  const [newFormat, setNewFormat] = useState("stroke");

  const startEdit = (i) => {
    setEditing(i);
    setEditName(data.tournaments[i].name);
    setEditMajor(data.tournaments[i].isMajor);
    setEditFormat(data.tournaments[i].format || "stroke");
  };

  const saveEdit = (i) => {
    if (!editName.trim()) { toast("Name required."); return; }
    setData(d => ({ ...d, tournaments: d.tournaments.map((t, idx) => idx === i ? { ...t, name: editName.trim(), isMajor: editMajor, format: editFormat } : t) }));
    setEditing(null); toast("Tournament updated.");
  };

  const addTournament = () => {
    if (!newName.trim()) { toast("Name required."); return; }
    const newId = Math.max(...(data.tournaments||[]).map(t => t.id), 0) + 1;
    setData(d => ({ ...d, tournaments: [...(d.tournaments||[]), { id: newId, name: newName.trim(), isMajor: newMajor, format: newFormat }] }));
    setNewName(""); setNewMajor(false); setNewFormat("stroke"); setShowAdd(false);
    toast("Tournament added!");
  };

  const removeTournament = (i) => {
    const t = data.tournaments[i];
    if (!window.confirm(`Delete "${t.name}" and all its scores?`)) return;
    setData(d => {
      const scores = { ...d.scores };
      delete scores[t.id];
      return { ...d, tournaments: d.tournaments.filter((_, idx) => idx !== i), scores };
    });
    toast("Tournament deleted.");
  };

  return <>
    <div style={S.label}>Tournaments ({(data.tournaments||[]).length})</div>
    <div style={S.card}>
      {(data.tournaments||[]).map((t, i) => (
        <div key={t.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
          {editing === i ? (
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              <input style={S.input} value={editName} autoFocus onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if(e.key==="Enter") saveEdit(i); if(e.key==="Escape") setEditing(null); }} />
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:14, color:"#333", cursor:"pointer" }}>
                  <input type="checkbox" checked={editMajor} onChange={e => setEditMajor(e.target.checked)} style={{ accentColor: TEAL }} />
                  Major (2×)
                </label>
                <select style={{ ...S.input, width: "auto", padding: "6px 10px" }} value={editFormat} onChange={e => setEditFormat(e.target.value)}>
                  <option value="stroke">Stroke Play</option>
                  <option value="ryder">Ryder Cup</option>
                  <option value="both">Both</option>
                </select>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button style={{ ...S.btn("primary"), flex:1, padding:"8px" }} onClick={() => saveEdit(i)}>Save</button>
                <button style={{ ...S.btn("sm"), flex:1, padding:"8px" }} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:8, padding:"12px 14px" }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:600, color:"#111" }}>{t.name}</div>
                <div style={{ display:"flex", gap:6, marginTop:4, flexWrap:"wrap" }}>
                  {t.isMajor && <span style={S.badge("major")}>MAJOR</span>}
                  {t.format === "ryder" && <span style={S.badge("ryder")}>RYDER CUP</span>}
                  {t.format === "both" && <span style={S.badge("ryder")}>STROKE + RYDER</span>}
                  {(!t.format || t.format === "stroke") && <span style={{ fontSize:11, color:"#888" }}>Stroke Play</span>}
                </div>
              </div>
              <button style={{ ...S.btn("sm"), fontSize:12 }} onClick={() => startEdit(i)}>Edit</button>
              <button style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }} onClick={() => removeTournament(i)}>Delete</button>
            </div>
          )}
        </div>
      ))}
    </div>

    {/* Add tournament */}
    {!showAdd ? (
      <button style={{ ...S.btn("primary"), width:"100%", marginTop:4 }} onClick={() => setShowAdd(true)}>+ Add Tournament</button>
    ) : (
      <div style={{ ...S.card, padding: "14px" }}>
        <div style={{ fontSize:13, fontWeight:700, color:TEAL, marginBottom:10 }}>New Tournament</div>
        <input style={{ ...S.input, marginBottom:10 }} placeholder="Tournament name" value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
        <div style={{ display:"flex", gap:16, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
          <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:14, color:"#333", cursor:"pointer" }}>
            <input type="checkbox" checked={newMajor} onChange={e => setNewMajor(e.target.checked)} style={{ accentColor:TEAL }} />
            Major (2×)
          </label>
          <select style={{ ...S.input, width:"auto", padding:"6px 10px" }} value={newFormat} onChange={e => setNewFormat(e.target.value)}>
            <option value="stroke">Stroke Play</option>
            <option value="ryder">Ryder Cup</option>
            <option value="both">Both</option>
          </select>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button style={{ ...S.btn("primary"), flex:1 }} onClick={addTournament}>Add Tournament</button>
          <button style={{ ...S.btn("sm"), flex:1 }} onClick={() => setShowAdd(false)}>Cancel</button>
        </div>
      </div>
    )}
  </>;
}

// ── SEASON TAB ────────────────────────────────────────────────────────────────
function SeasonTab({ data, setData, toast }) {
  const [seasonName, setSeasonName] = useState(data.season?.name || "");
  const [startDate, setStartDate] = useState(data.season?.startDate || "");
  const [endDate, setEndDate] = useState(data.season?.endDate || "");
  const [showNew, setShowNew] = useState(false);
  const [nsName, setNsName] = useState("");
  const [nsStart, setNsStart] = useState("");
  const [nsEnd, setNsEnd] = useState("");
  const logoRef = useRef();

  // Keep local state in sync if data changes
  useEffect(() => {
    setSeasonName(data.season?.name || "");
    setStartDate(data.season?.startDate || "");
    setEndDate(data.season?.endDate || "");
  }, [data.season]);

  const saveSeason = () => {
    if (!seasonName.trim()) { toast("Season name required."); return; }
    setData(d => ({ ...d, season: { ...d.season, name: seasonName.trim(), startDate, endDate } }));
    toast("Season info saved!");
  };

  const handleLogo = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setData(d => ({ ...d, logo: ev.target.result }));
      toast("Logo uploaded!");
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => { setData(d => ({ ...d, logo: null })); toast("Logo removed."); };

  const startNew = () => {
    if (!nsName.trim() || !nsStart || !nsEnd) { toast("Fill in all fields."); return; }
    if (!window.confirm(`Archive current season and start "${nsName}"?`)) return;
    setData(d => {
      const archive = { season: d.season, players: d.players, tournaments: d.tournaments, scores: d.scores, logo: d.logo };
      return {
        ...makeDefaultData(),
        logo: d.logo,
        players: [...(d.players||[])],
        tournaments: (d.tournaments||[]).map(t => ({ ...t })),
        scores: {},
        season: { name: nsName.trim(), startDate: nsStart, endDate: nsEnd },
        archivedSeasons: [...(d.archivedSeasons||[]), archive],
      };
    });
    setShowNew(false); setNsName(""); setNsStart(""); setNsEnd("");
    toast(`New season "${nsName}" started!`);
  };

  return <>
    {/* Logo */}
    <div style={S.label}>League Logo</div>
    <div style={S.card}>
      <div style={{ padding:"14px", display:"flex", alignItems:"center", gap:14 }}>
        {data.logo ? (
          <>
            <img src={data.logo} alt="logo" style={{ width:64, height:64, borderRadius:8, objectFit:"cover", border:"1px solid #ddd" }} />
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, color:"#333", marginBottom:8 }}>Logo uploaded</div>
              <div style={{ display:"flex", gap:8 }}>
                <button style={{ ...S.btn("sm"), fontSize:12 }} onClick={() => logoRef.current.click()}>Change</button>
                <button style={{ ...S.btn("danger"), padding:"5px 10px", fontSize:12 }} onClick={removeLogo}>Remove</button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, color:"#666", marginBottom:8 }}>No logo uploaded yet</div>
            <button style={S.btn("primary")} onClick={() => logoRef.current.click()}>Upload Logo</button>
          </div>
        )}
        <input ref={logoRef} type="file" accept="image/*" style={{ display:"none" }} onChange={handleLogo} />
      </div>
    </div>

    {/* Season info */}
    <div style={S.label}>Current Season</div>
    <div style={S.card}>
      <div style={{ padding:"14px", display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <div style={{ fontSize:12, color:"#666", marginBottom:4, fontWeight:600 }}>Season Name</div>
          <input style={S.input} value={seasonName} onChange={e => setSeasonName(e.target.value)} placeholder="e.g. 2025 Season" />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div>
            <div style={{ fontSize:12, color:"#666", marginBottom:4, fontWeight:600 }}>Start Date</div>
            <input type="date" style={S.input} value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize:12, color:"#666", marginBottom:4, fontWeight:600 }}>End Date</div>
            <input type="date" style={S.input} value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
        </div>
        <button style={{ ...S.btn("primary"), width:"100%" }} onClick={saveSeason}>Save Season Info</button>
      </div>
    </div>

    {/* New season */}
    <div style={S.label}>Start New Season</div>
    <div style={S.card}>
      {!showNew ? (
        <div style={{ padding:14 }}>
          <div style={{ fontSize:13, color:"#666", marginBottom:6, lineHeight:1.5 }}>
            The current season will be <strong>archived</strong> and viewable on the leaderboard. Your logo, player roster, and tournament names will carry over.
          </div>
          <div style={{ fontSize:12, color:"#888", marginBottom:12, padding:"8px 10px", background:"#fff8e8", borderRadius:8, border:"1px solid #f0d080" }}>
            ⚠️ Only one active season at a time. Scores will reset.
          </div>
          <button style={{ ...S.btn(""), borderColor:"#c09030", color:"#8a6000", width:"100%", fontWeight:700 }} onClick={() => setShowNew(true)}>
            Archive & Start New Season →
          </button>
        </div>
      ) : (
        <div style={{ padding:"14px", display:"flex", flexDirection:"column", gap:10 }}>
          <div>
            <div style={{ fontSize:12, color:"#666", marginBottom:4, fontWeight:600 }}>New Season Name</div>
            <input style={S.input} placeholder="e.g. 2026 Season" value={nsName} onChange={e => setNsName(e.target.value)} autoFocus />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <div style={{ fontSize:12, color:"#666", marginBottom:4, fontWeight:600 }}>Start Date</div>
              <input type="date" style={S.input} value={nsStart} onChange={e => setNsStart(e.target.value)} />
            </div>
            <div>
              <div style={{ fontSize:12, color:"#666", marginBottom:4, fontWeight:600 }}>End Date</div>
              <input type="date" style={S.input} value={nsEnd} onChange={e => setNsEnd(e.target.value)} />
            </div>
          </div>
          <div style={{ fontSize:12, color:"#666", padding:"8px 10px", background:TEAL_LIGHT, borderRadius:8, border:`1px solid ${TEAL_MID}` }}>
            ✓ Logo, player roster, and tournament names will carry over automatically.
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button style={{ ...S.btn("danger"), flex:1 }} onClick={startNew}>Confirm & Archive</button>
            <button style={{ ...S.btn("sm"), flex:1 }} onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>

    {/* Archived seasons */}
    {(data.archivedSeasons||[]).length > 0 && <>
      <div style={S.label}>Archived Seasons ({data.archivedSeasons.length})</div>
      {data.archivedSeasons.map((s, i) => (
        <div key={i} style={{ ...S.card, padding:"12px 16px" }}>
          <div style={{ fontWeight:700, color:"#111" }}>{s.season?.name}</div>
          <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{s.season?.startDate} – {s.season?.endDate} · {s.players?.length || 0} players</div>
        </div>
      ))}
    </>}
  </>;
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData, loaded] = useData();
  const [tab, setTab] = useState("leaderboard");
  const [isAdmin, setIsAdmin] = useState(false);

  if (!loaded) return (
    <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Loading...</div>
  );

  const tabs = [
    { id:"leaderboard", label:"Board" },
    { id:"tournaments", label:"Events" },
    { id:"stats", label:"Stats" },
    { id:"admin", label: isAdmin ? "Admin ✓" : "Admin" },
  ];

  return (
    <div style={S.app}>
      <div style={S.hdr}>
        {data.logo && <img src={data.logo} alt="logo" style={{ width:40, height:40, borderRadius:8, objectFit:"cover", border:"2px solid rgba(255,255,255,0.3)", flexShrink:0 }} />}
        <div>
          <div style={{ fontSize:19, fontWeight:700, letterSpacing:0.5 }}>⛳ Back Nine Bandits</div>
          <div style={{ fontSize:12, color:"rgba(255,255,255,0.7)", marginTop:1 }}>{data.season?.name}</div>
        </div>
      </div>
      <div style={S.nav}>
        {tabs.map(t => <button key={t.id} style={S.navBtn(tab===t.id)} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {tab==="leaderboard" && <LeaderboardPage data={data} />}
      {tab==="tournaments" && <TournamentsPage data={data} />}
      {tab==="stats"       && <StatsPage data={data} />}
      {tab==="admin"       && <AdminPage data={data} setData={setData} isAdmin={isAdmin} setIsAdmin={setIsAdmin} />}
    </div>
  );
}
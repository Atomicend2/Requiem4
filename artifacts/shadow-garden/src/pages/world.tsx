import { useEffect, useMemo, useState } from "react";
import { Crown, MapPin, Loader2 } from "lucide-react";

interface TerritoryOwner {
  id: string;
  name: string;
  level: number;
}

interface Territory {
  id: string;
  name: string;
  region: string;
  resource: string;
  baseIncome: number;
  x: number;
  y: number;
  owner: TerritoryOwner | null;
  claimedAt: number | null;
  taxRate: number | null;
  dangerLevel: number | null;
}

interface RegionInfo {
  id: string;
  name: string;
  continent: string;
}

interface ContinentInfo {
  id: string;
  name: string;
}

async function fetchTerritories(): Promise<{ continents: ContinentInfo[]; regions: RegionInfo[]; territories: Territory[] }> {
  const res = await fetch("/api/v1/territories");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Deterministic color per guild id, so the same guild always shows the same
// marker color everywhere on the map without needing a stored color field.
const GUILD_PALETTE = [
  { dot: "bg-amber-400",  ring: "border-amber-400/30",  text: "text-amber-400",  glow: "rgba(251,191,36,0.8)" },
  { dot: "bg-primary",    ring: "border-primary/30",    text: "text-primary",    glow: "rgba(160,0,26,0.8)" },
  { dot: "bg-teal-400",   ring: "border-teal-400/30",   text: "text-teal-400",   glow: "rgba(45,212,191,0.8)" },
  { dot: "bg-sky-400",    ring: "border-sky-400/30",    text: "text-sky-400",    glow: "rgba(56,189,248,0.8)" },
  { dot: "bg-violet-400", ring: "border-violet-400/30", text: "text-violet-400", glow: "rgba(167,139,250,0.8)" },
  { dot: "bg-emerald-400", ring: "border-emerald-400/30", text: "text-emerald-400", glow: "rgba(52,211,153,0.8)" },
  { dot: "bg-orange-400", ring: "border-orange-400/30", text: "text-orange-400", glow: "rgba(251,146,60,0.8)" },
];
const UNCLAIMED_STYLE = { dot: "bg-white/25", ring: "border-white/15", text: "text-white/50", glow: "rgba(255,255,255,0.25)" };

function colorForGuild(guildId: string) {
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) hash = (hash * 31 + guildId.charCodeAt(i)) >>> 0;
  return GUILD_PALETTE[hash % GUILD_PALETTE.length];
}

export default function World() {
  const [data, setData] = useState<{ continents: ContinentInfo[]; regions: RegionInfo[]; territories: Territory[] } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const result = await fetchTerritories();
        if (mounted) setData(result);
      } catch {
        if (mounted) setError(true);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    // Refresh periodically so a territory claimed in WhatsApp shows up here
    // without needing a manual page reload.
    const interval = setInterval(async () => {
      try {
        const result = await fetchTerritories();
        if (mounted) setData(result);
      } catch { /* keep showing the last good data on a transient failure */ }
    }, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const regionById = useMemo(() => new Map((data?.regions || []).map((r) => [r.id, r])), [data]);
  const continentById = useMemo(() => new Map((data?.continents || []).map((c) => [c.id, c])), [data]);

  // Active guilds present on the map right now, for the legend.
  const activeGuilds = useMemo(() => {
    const seen = new Map<string, TerritoryOwner>();
    for (const t of data?.territories || []) {
      if (t.owner && !seen.has(t.owner.id)) seen.set(t.owner.id, t.owner);
    }
    return [...seen.values()];
  }, [data]);

  return (
    <div className="min-h-screen relative overflow-hidden flex flex-col" style={{ background: "linear-gradient(180deg,#0A0A0F 0%,#111117 35%,#15151D 60%,#0A0A0F 100%)" }}>

      {/* ── Sky background layers ── */}
      <div className="absolute inset-0 pointer-events-none select-none z-0">
        {/* Celestial glow */}
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 90% 55% at 50% 0%, rgba(160,0,26,0.18) 0%, transparent 70%)" }} />
        <div className="absolute" style={{ left:"15%", top:"5%", width:500, height:500, background:"radial-gradient(circle, rgba(160,0,26,0.10) 0%, transparent 70%)", borderRadius:"50%", filter:"blur(40px)" }} />
        <div className="absolute" style={{ right:"8%", top:"8%", width:340, height:340, background:"radial-gradient(circle, rgba(212,175,55,0.10) 0%, transparent 70%)", borderRadius:"50%", filter:"blur(30px)" }} />
        <div className="absolute" style={{ left:"35%", bottom:"15%", width:600, height:200, background:"radial-gradient(ellipse, rgba(160,0,26,0.06) 0%, transparent 70%)", borderRadius:"50%", filter:"blur(20px)" }} />

        {/* Cloud bands */}
        <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="cloud-blur"><feGaussianBlur stdDeviation="8"/></filter>
          </defs>
          <ellipse cx="200"  cy="140" rx="280" ry="45" fill="rgba(212,201,168,0.35)" filter="url(#cloud-blur)" />
          <ellipse cx="900"  cy="80"  rx="200" ry="30" fill="rgba(212,201,168,0.28)" filter="url(#cloud-blur)" />
          <ellipse cx="640"  cy="320" rx="350" ry="38" fill="rgba(212,201,168,0.18)" filter="url(#cloud-blur)" />
          <ellipse cx="1100" cy="460" rx="220" ry="30" fill="rgba(212,201,168,0.14)" filter="url(#cloud-blur)" />
          <ellipse cx="300"  cy="550" rx="260" ry="36" fill="rgba(212,201,168,0.12)" filter="url(#cloud-blur)" />
        </svg>

        {/* Stars */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          {Array.from({ length: 100 }, (_, i) => {
            const x = ((i * 137.508) % 100) * 12.8;
            const y = ((i * 79.3) % 60) * 7.2;
            const r = i % 8 === 0 ? 1.4 : i % 3 === 0 ? 0.9 : 0.5;
            const op = 0.15 + (i % 4) * 0.12;
            return <circle key={i} cx={x} cy={y} r={r} fill="white" opacity={op} />;
          })}
        </svg>

        {/* Atlas grid */}
        <svg className="absolute inset-0 w-full h-full opacity-[0.06]" viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          {Array.from({ length: 9 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={`${(i+1)*10}`} x2="100" y2={`${(i+1)*10}`} stroke="#A0001A" strokeWidth="0.3" />
          ))}
          {Array.from({ length: 11 }, (_, i) => (
            <line key={`v${i}`} x1={`${i*10}`} y1="0" x2={`${i*10}`} y2="100" stroke="#A0001A" strokeWidth="0.3" />
          ))}
          {/* Concentric circles from centre */}
          {[10,20,32,45].map(r => (
            <circle key={r} cx="50" cy="38" r={r} fill="none" stroke="#A0001A" strokeWidth="0.2" strokeDasharray="2 4" />
          ))}
        </svg>

        {/* Compass rose */}
        <svg className="absolute opacity-10" style={{ bottom:80, left:32, width:80, height:80 }} viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
          <circle cx="40" cy="40" r="38" fill="none" stroke="#A0001A" strokeWidth="0.8" />
          <circle cx="40" cy="40" r="30" fill="none" stroke="#A0001A" strokeWidth="0.4" />
          <line x1="40" y1="2"  x2="40" y2="78" stroke="#A0001A" strokeWidth="0.6" />
          <line x1="2"  y1="40" x2="78" y2="40" stroke="#A0001A" strokeWidth="0.6" />
          <polygon points="40,5 43,38 40,33 37,38" fill="#A0001A" opacity="0.7" />
          <text x="40" y="16"  textAnchor="middle" fill="#A0001A" fontSize="7" fontFamily="monospace">N</text>
          <text x="40" y="70"  textAnchor="middle" fill="#A0001A" fontSize="7" fontFamily="monospace">S</text>
          <text x="69" y="43"  textAnchor="middle" fill="#A0001A" fontSize="7" fontFamily="monospace">E</text>
          <text x="12" y="43"  textAnchor="middle" fill="#A0001A" fontSize="7" fontFamily="monospace">W</text>
        </svg>
      </div>

      {/* ── Header ── */}
      <div className="relative z-20 p-6 md:p-8 pointer-events-none" style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.65), transparent)" }}>
        <p className="font-mono tracking-[0.5em] text-xs uppercase mb-1" style={{ color:"rgba(160,0,26,0.4)" }}>反逆</p>
        <h1 className="font-serif text-3xl md:text-5xl font-bold text-white tracking-widest uppercase neon-text-sky">Requiem Order World Atlas</h1>
        <p className="mt-2 max-w-xl text-sm" style={{ color:"rgba(212,201,168,0.35)" }}>
          Live territory control across the known world. Every marker reflects real guild ownership — claim territory in-bot with <span className="font-mono">.territory claim</span> and it appears here.
        </p>
      </div>

      {/* ── Loading / error states ── */}
      {loading && (
        <div className="flex-1 flex items-center justify-center z-10 gap-2 text-white/40 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading world state...
        </div>
      )}
      {!loading && error && (
        <div className="flex-1 flex items-center justify-center z-10 text-rose-400/70 text-sm">
          Failed to load territory data. Please try again shortly.
        </div>
      )}

      {/* ── Territory Markers ── */}
      {!loading && !error && data && (
        <div className="flex-1 relative w-full min-h-[700px] z-10">
          {data.territories.map((territory) => {
            const style = territory.owner ? colorForGuild(territory.owner.id) : UNCLAIMED_STYLE;
            const region = regionById.get(territory.region);
            const continent = region ? continentById.get(region.continent) : undefined;
            return (
              <div
                key={territory.id}
                className="absolute -translate-x-1/2 -translate-y-1/2 group/marker cursor-crosshair"
                style={{ left: `${territory.x}%`, top: `${territory.y}%` }}
              >
                <div className="relative">
                  {/* Outer pulse — only animates for claimed territories, so unclaimed ones read as quieter/neutral */}
                  {territory.owner && (
                    <>
                      <div className={`absolute inset-0 rounded-full animate-ping opacity-25 ${style.dot}`} style={{ animationDuration: "2.6s" }} />
                      <div className={`absolute inset-0 rounded-full animate-ping opacity-10 scale-[2] ${style.dot}`} style={{ animationDuration: "3.8s" }} />
                    </>
                  )}

                  {/* Marker */}
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center relative z-10 border transition-all duration-300 hover:scale-110 glass-card ${style.text} ${style.ring}`}
                    style={{ background:"rgba(0,0,0,0.55)" }}>
                    {territory.owner ? <Crown className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                  </div>

                  {/* Tooltip */}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 p-4 rounded-xl opacity-0 translate-y-2 pointer-events-none group-hover/marker:opacity-100 group-hover/marker:translate-y-0 transition-all duration-300 z-50"
                    style={{ width:260, background:"rgba(17,17,23,0.92)", border:"1px solid rgba(160,0,26,0.18)", boxShadow:"0 0 30px rgba(160,0,26,0.2)" }}>
                    <div className={`text-[10px] font-mono tracking-widest uppercase mb-1 opacity-60 ${style.text}`}>
                      {continent?.name || "?"} · {region?.name || "?"}
                    </div>
                    <h3 className="font-serif text-base font-bold text-white mb-1.5">{territory.name}</h3>
                    <p className="text-xs leading-relaxed" style={{ color:"rgba(212,201,168,0.45)" }}>
                      Produces <span className="text-white/70">{territory.resource}</span> — {territory.baseIncome.toLocaleString()} gold/day base income.
                    </p>
                    <div className="mt-3 pt-2 text-[10px] font-bold tracking-[0.2em] uppercase text-center" style={{ borderTop:"1px solid rgba(255,255,255,0.05)", color: territory.owner ? "rgba(212,201,168,0.7)" : "rgba(160,0,26,0.6)" }}>
                      {territory.owner
                        ? `Controlled by ${territory.owner.name}${territory.taxRate != null ? ` · ${territory.taxRate}% tax` : ""}`
                        : "Unclaimed Territory"}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Legend ── */}
      {!loading && !error && (
        <div className="absolute z-20 p-4 rounded-xl" style={{ bottom:80, right:24, background:"rgba(17,17,23,0.85)", border:"1px solid rgba(160,0,26,0.15)", boxShadow:"0 0 20px rgba(160,0,26,0.08)" }}>
          <h4 className="text-[10px] font-mono font-bold tracking-[0.3em] uppercase pb-2 mb-3" style={{ color:"rgba(160,0,26,0.5)", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
            Guild Control
          </h4>
          <ul className="space-y-2 text-xs text-white/70 max-h-48 overflow-y-auto pr-1">
            {activeGuilds.length === 0 && (
              <li className="text-white/40 italic">No territories claimed yet</li>
            )}
            {activeGuilds.map((g) => {
              const style = colorForGuild(g.id);
              return (
                <li key={g.id} className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${style.dot}`} style={{ boxShadow: `0 0 6px ${style.glow}` }} />
                  {g.name}
                </li>
              );
            })}
            <li className="flex items-center gap-2 pt-1" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${UNCLAIMED_STYLE.dot}`} />
              Unclaimed
            </li>
          </ul>
        </div>
      )}

      {/* ── Coord label (flavour) ── */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 font-mono text-[10px] tracking-widest" style={{ color:"rgba(160,0,26,0.25)" }}>
        REQUIEM ORDER WORLD ATLAS · 反逆 · v1.0
      </div>
    </div>
  );
}

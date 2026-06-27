import { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Crown, MapPin, Loader2, X, Swords, Users, Shield } from "lucide-react";

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

interface TerritoryDetail {
  id: string;
  name: string;
  resource: string;
  baseIncome: number;
  x: number;
  y: number;
  claimedAt: number | null;
  taxRate: number | null;
  dangerLevel: number | null;
  region: { id: string; name: string } | null;
  continent: { id: string; name: string } | null;
  owner: (TerritoryOwner & {
    emblem: string | null;
    description: string;
    leader: { id: string | null; name: string };
    memberCount: number;
  }) | null;
  warHistory: Array<{
    id: string;
    title: string;
    guildName: string | null;
    outcome: string | null;
    actorName: string;
    timestamp: number;
  }>;
}

async function fetchTerritories(): Promise<{ territories: Territory[] }> {
  const res = await fetch("/api/v1/territories");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTerritoryDetail(id: string): Promise<{ territory: TerritoryDetail }> {
  const res = await fetch(`/api/v1/territories/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Deterministic color per guild id, so the same guild always shows the same
// marker color everywhere on the map without needing a stored color field.
const GUILD_COLORS = ["#fbbf24", "#a0001a", "#2dd4bf", "#38bdf8", "#a78bfa", "#34d399", "#fb923c"];
const UNCLAIMED_COLOR = "rgba(255,255,255,0.35)";

function colorForGuild(guildId: string): string {
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) hash = (hash * 31 + guildId.charCodeAt(i)) >>> 0;
  return GUILD_COLORS[hash % GUILD_COLORS.length];
}

// Flat-plane coordinate space for the map image — Leaflet's Simple CRS
// treats this as pixel coordinates rather than real-world lat/lng, which is
// the correct mode for a fictional/game map instead of actual geography.
const MAP_W = 1408;
const MAP_H = 768;

function World() {
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  // territory id -> live Leaflet layer, so ownership-color updates can
  // restyle an existing marker in place instead of tearing down and
  // rebuilding the whole map every time data refreshes.
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const territoriesRef = useRef<Territory[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TerritoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const buildPopupHtml = useCallback((t: Territory) => {
    const ownerLine = t.owner
      ? `<div style="color:#d4c9a8;font-size:11px;margin-top:2px;">Held by <strong style="color:${colorForGuild(t.owner.id)}">${t.owner.name}</strong></div>`
      : `<div style="color:rgba(160,0,26,0.7);font-size:11px;margin-top:2px;">Unclaimed</div>`;
    return `<div style="font-family:inherit;min-width:140px;">
      <div style="font-weight:700;color:#fff;font-size:13px;">${t.name}</div>
      <div style="color:rgba(212,201,168,0.5);font-size:10px;">${t.resource} · ${t.baseIncome.toLocaleString()} gold/day</div>
      ${ownerLine}
    </div>`;
  }, []);

  // ── Apply live ownership colors onto existing markers — never recreate
  // the map or its markers for a data refresh, only restyle in place. ──
  const applyOwnership = useCallback((territories: Territory[]) => {
    territoriesRef.current = territories;
    for (const t of territories) {
      const marker = markersRef.current.get(t.id);
      if (!marker) continue;
      const color = t.owner ? colorForGuild(t.owner.id) : UNCLAIMED_COLOR;
      marker.setStyle({ color, fillColor: color, fillOpacity: t.owner ? 0.85 : 0.3 });
      marker.setPopupContent(buildPopupHtml(t));
    }
  }, [buildPopupHtml]);

  // ── One-time map + marker construction ──────────────────────────────────
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return;

    const map = L.map(mapElRef.current, {
      crs: L.CRS.Simple,
      minZoom: -1,
      maxZoom: 4,
      zoomSnap: 0.25,
      attributionControl: false,
    });
    mapRef.current = map;

    const bounds: L.LatLngBoundsExpression = [[0, 0], [MAP_H, MAP_W]];
    L.imageOverlay("/images/world-map.png", bounds).addTo(map);
    map.fitBounds(bounds);
    map.setMaxBounds(bounds);

    let mounted = true;
    (async () => {
      try {
        const result = await fetchTerritories();
        if (!mounted) return;

        for (const t of result.territories) {
          // x/y are 0–100 percent in the atlas data; convert to this map's
          // pixel plane. Leaflet's y-axis increases upward in Simple CRS,
          // so the percent-from-top y value needs flipping.
          const px = (t.x / 100) * MAP_W;
          const py = MAP_H - (t.y / 100) * MAP_H;
          const color = t.owner ? colorForGuild(t.owner.id) : UNCLAIMED_COLOR;

          const marker = L.circleMarker([py, px], {
            radius: 9,
            color,
            weight: 2,
            fillColor: color,
            fillOpacity: t.owner ? 0.85 : 0.3,
          }).addTo(map);

          marker.bindPopup(buildPopupHtml(t));
          marker.on("click", () => setSelectedId(t.id));

          markersRef.current.set(t.id, marker);
        }
        territoriesRef.current = result.territories;
        setLoading(false);
      } catch {
        if (mounted) { setError(true); setLoading(false); }
      }
    })();

    return () => {
      mounted = false;
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, [buildPopupHtml]);

  // ── Poll for ownership changes — restyles existing markers, never
  // rebuilds the map. This is what makes a .territory claim in WhatsApp
  // show up here automatically without a page reload. ──
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const result = await fetchTerritories();
        applyOwnership(result.territories);
      } catch { /* keep showing last good state on a transient failure */ }
    }, 15000);
    return () => clearInterval(interval);
  }, [applyOwnership]);

  // ── Detail panel data fetch ──────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let mounted = true;
    setDetailLoading(true);
    (async () => {
      try {
        const result = await fetchTerritoryDetail(selectedId);
        if (mounted) setDetail(result.territory);
      } catch {
        if (mounted) setDetail(null);
      } finally {
        if (mounted) setDetailLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [selectedId]);

  return (
    <div className="min-h-screen relative overflow-hidden flex flex-col bg-[#05050a]">

      {/* ── Header ── */}
      <div className="relative z-20 p-6 md:p-8 pointer-events-none" style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.65), transparent)" }}>
        <p className="font-mono tracking-[0.5em] text-xs uppercase mb-1" style={{ color: "rgba(160,0,26,0.4)" }}>反逆</p>
        <h1 className="font-serif text-3xl md:text-5xl font-bold text-white tracking-widest uppercase neon-text-sky">Requiem Order World Atlas</h1>
        <p className="mt-2 max-w-xl text-sm" style={{ color: "rgba(212,201,168,0.45)" }}>
          Live territory control across the known world. Claim territory in-bot with <span className="font-mono">.territory claim</span> and it appears here — no reload needed. Scroll to zoom, drag to pan, click a marker for details.
        </p>
      </div>

      {/* ── Loading / error states ── */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-30 gap-2 text-white/40 text-sm bg-[#05050a]/60">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading world state...
        </div>
      )}
      {!loading && error && (
        <div className="absolute inset-0 flex items-center justify-center z-30 text-rose-400/70 text-sm bg-[#05050a]/60">
          Failed to load territory data. Please try again shortly.
        </div>
      )}

      {/* ── Leaflet map container ── */}
      <div ref={mapElRef} className="flex-1 w-full min-h-[500px] z-10" style={{ background: "#05050a" }} />

      {/* ── Territory detail panel ── */}
      {selectedId && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setSelectedId(null)}>
          <div
            className="w-full max-w-md rounded-2xl overflow-hidden"
            style={{ background: "rgba(17,17,23,0.97)", border: "1px solid rgba(160,0,26,0.25)", boxShadow: "0 0 40px rgba(160,0,26,0.25)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <h2 className="font-serif text-lg font-bold text-white">{detail?.name || "Loading…"}</h2>
              <button onClick={() => setSelectedId(null)} className="text-white/40 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 max-h-[70vh] overflow-y-auto space-y-5">
              {detailLoading && (
                <div className="flex items-center justify-center gap-2 text-white/40 text-sm py-8">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading territory details...
                </div>
              )}

              {!detailLoading && detail && (
                <>
                  <div className="flex items-center gap-2 text-xs" style={{ color: "rgba(212,201,168,0.5)" }}>
                    <span>{detail.continent?.name || "?"}</span>
                    <span>·</span>
                    <span>{detail.region?.name || "?"}</span>
                    <span>·</span>
                    <span className="text-white/60">{detail.resource}</span>
                    <span>·</span>
                    <span className="text-white/60">{detail.baseIncome.toLocaleString()} gold/day</span>
                  </div>

                  {detail.owner ? (
                    <div className="rounded-xl p-4" style={{ background: "rgba(0,0,0,0.3)", border: `1px solid ${colorForGuild(detail.owner.id)}33` }}>
                      <div className="flex items-center gap-3 mb-3">
                        <div
                          className="w-12 h-12 rounded-full flex items-center justify-center font-serif font-bold text-lg shrink-0"
                          style={{
                            background: detail.owner.emblem ? `url(${detail.owner.emblem}) center/cover` : `${colorForGuild(detail.owner.id)}22`,
                            color: colorForGuild(detail.owner.id),
                            border: `2px solid ${colorForGuild(detail.owner.id)}55`,
                          }}
                        >
                          {!detail.owner.emblem && detail.owner.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-white truncate">{detail.owner.name}</p>
                          <p className="text-xs" style={{ color: "rgba(212,201,168,0.5)" }}>Guild Level {detail.owner.level}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="flex items-center gap-1.5" style={{ color: "rgba(212,201,168,0.6)" }}>
                          <Crown className="w-3.5 h-3.5 shrink-0" style={{ color: colorForGuild(detail.owner.id) }} />
                          <span className="truncate">Leader: <span className="text-white/80">{detail.owner.leader.name}</span></span>
                        </div>
                        <div className="flex items-center gap-1.5" style={{ color: "rgba(212,201,168,0.6)" }}>
                          <Users className="w-3.5 h-3.5 shrink-0" style={{ color: colorForGuild(detail.owner.id) }} />
                          <span>{detail.owner.memberCount} member{detail.owner.memberCount !== 1 ? "s" : ""}</span>
                        </div>
                        {detail.taxRate != null && (
                          <div className="flex items-center gap-1.5" style={{ color: "rgba(212,201,168,0.6)" }}>
                            <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: colorForGuild(detail.owner.id) }} />
                            <span>{detail.taxRate}% tax rate</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl p-4 text-center text-sm" style={{ background: "rgba(160,0,26,0.06)", border: "1px solid rgba(160,0,26,0.15)", color: "rgba(160,0,26,0.7)" }}>
                      This territory is unclaimed. Use <span className="font-mono">.territory claim {detail.id}</span> in-bot to take it.
                    </div>
                  )}

                  <div>
                    <h3 className="text-[10px] font-mono font-bold tracking-[0.25em] uppercase mb-2 flex items-center gap-1.5" style={{ color: "rgba(160,0,26,0.6)" }}>
                      <Swords className="w-3 h-3" /> War History
                    </h3>
                    {detail.warHistory.length === 0 ? (
                      <p className="text-xs italic" style={{ color: "rgba(212,201,168,0.35)" }}>No recorded conquests for this territory yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {detail.warHistory.map((h) => (
                          <li key={h.id} className="text-xs rounded-lg p-2.5" style={{ background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.05)" }}>
                            <p className="text-white/75">{h.title}</p>
                            <p className="mt-0.5" style={{ color: "rgba(212,201,168,0.4)" }}>
                              {new Date(h.timestamp * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              {!detailLoading && !detail && (
                <p className="text-sm text-center py-8" style={{ color: "rgba(212,201,168,0.4)" }}>Couldn't load this territory's details.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Coord label (flavour) ── */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 font-mono text-[10px] tracking-widest pointer-events-none" style={{ color: "rgba(160,0,26,0.35)" }}>
        REQUIEM ORDER WORLD ATLAS · 反逆 · v3.0
      </div>
    </div>
  );
}

export default World;

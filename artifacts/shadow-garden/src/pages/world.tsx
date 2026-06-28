import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Crown, MapPin, Loader2, ZoomIn, ZoomOut, Maximize2, X, Swords, Users, Shield } from "lucide-react";

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

async function fetchTerritories(): Promise<{ continents: ContinentInfo[]; regions: RegionInfo[]; territories: Territory[] }> {
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
const GUILD_PALETTE = [
  { dot: "bg-amber-400",  ring: "border-amber-400/30",  text: "text-amber-400",  glow: "rgba(251,191,36,0.8)",  hex: "#fbbf24" },
  { dot: "bg-primary",    ring: "border-primary/30",    text: "text-primary",    glow: "rgba(160,0,26,0.8)",   hex: "#a0001a" },
  { dot: "bg-teal-400",   ring: "border-teal-400/30",   text: "text-teal-400",   glow: "rgba(45,212,191,0.8)", hex: "#2dd4bf" },
  { dot: "bg-sky-400",    ring: "border-sky-400/30",    text: "text-sky-400",    glow: "rgba(56,189,248,0.8)", hex: "#38bdf8" },
  { dot: "bg-violet-400", ring: "border-violet-400/30", text: "text-violet-400", glow: "rgba(167,139,250,0.8)", hex: "#a78bfa" },
  { dot: "bg-emerald-400", ring: "border-emerald-400/30", text: "text-emerald-400", glow: "rgba(52,211,153,0.8)", hex: "#34d399" },
  { dot: "bg-orange-400", ring: "border-orange-400/30", text: "text-orange-400", glow: "rgba(251,146,60,0.8)", hex: "#fb923c" },
];
const UNCLAIMED_STYLE = { dot: "bg-white/25", ring: "border-white/15", text: "text-white/50", glow: "rgba(255,255,255,0.25)", hex: "rgba(255,255,255,0.35)" };

function colorForGuild(guildId: string) {
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) hash = (hash * 31 + guildId.charCodeAt(i)) >>> 0;
  return GUILD_PALETTE[hash % GUILD_PALETTE.length];
}

const MAP_W = 1408;
const MAP_H = 768;
const MAX_ZOOM = 4;
// MIN_ZOOM is no longer a fixed constant — it's computed per-viewport below,
// since a phone screen is much narrower than the 1408px map canvas. With a
// hardcoded floor of 1 (100%), mobile users could never zoom OUT far enough
// to see the whole map at once; "1" only happened to look right on a
// laptop/tablet viewport that's already wider than the map itself.

export default function World() {
  const [data, setData] = useState<{ continents: ContinentInfo[]; regions: RegionInfo[]; territories: Territory[] } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TerritoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [minZoom, setMinZoom] = useState(1);
  const userInteractedRef = useRef(false);
  const dragState = useRef<{ dragging: boolean; startX: number; startY: number; panX: number; panY: number; moved: boolean }>({
    dragging: false, startX: 0, startY: 0, panX: 0, panY: 0, moved: false,
  });
  // Tracks every currently-active pointer (finger) by id, so we can tell a
  // one-finger drag apart from a two-finger pinch. A plain mouse/single
  // touch only ever has one entry here; pinch-to-zoom kicks in the moment a
  // second one shows up.
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchState = useRef<{ startDist: number; startZoom: number; midX: number; midY: number } | null>(null);

  // Compute the zoom level that fits the entire MAP_W x MAP_H canvas inside
  // the current viewport, and use that as the floor for how far out you can
  // zoom (capped at 1 so we never force an upscale on a viewport that's
  // already bigger than the map). Re-run whenever the viewport resizes
  // (rotating a phone, resizing a browser window) so the floor stays correct.
  const computeFitZoom = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return 1;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (!vw || !vh) return 1;
    return Math.min(1, vw / MAP_W, vh / MAP_H);
  }, []);

  const fitToViewport = useCallback(() => {
    const vp = viewportRef.current;
    const fit = computeFitZoom();
    setMinZoom(fit);
    if (!vp) { setZoom(fit); setPan({ x: 0, y: 0 }); return; }
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    // Center the (possibly letterboxed) map in the viewport at the fit zoom.
    const x = Math.min(0, (vw - MAP_W * fit) / 2);
    const y = Math.min(0, (vh - MAP_H * fit) / 2);
    setZoom(fit);
    setPan({ x, y });
  }, [computeFitZoom]);

  useEffect(() => {
    fitToViewport();
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // Don't yank the view out from under someone mid-interaction — only
      // auto-refit while they haven't manually zoomed/panned yet.
      if (!userInteractedRef.current) fitToViewport();
    });
    ro.observe(vp);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clampPan = useCallback((nextZoom: number, nextPan: { x: number; y: number }) => {
    const vp = viewportRef.current;
    if (!vp) return nextPan;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const scaledW = MAP_W * nextZoom;
    const scaledH = MAP_H * nextZoom;
    // If the scaled map is smaller than the viewport on an axis (letterboxed
    // at the fit zoom), center it on that axis instead of pinning to 0 —
    // otherwise it sticks to the top/left with empty space only on one side.
    const minX = Math.min(0, vw - scaledW);
    const minY = Math.min(0, vh - scaledH);
    const x = scaledW <= vw ? (vw - scaledW) / 2 : Math.max(minX, Math.min(0, nextPan.x));
    const y = scaledH <= vh ? (vh - scaledH) / 2 : Math.max(minY, Math.min(0, nextPan.y));
    return { x, y };
  }, []);

  const zoomTo = useCallback((nextZoom: number, focalX?: number, focalY?: number) => {
    const vp = viewportRef.current;
    const clamped = Math.max(minZoom, Math.min(MAX_ZOOM, nextZoom));
    setZoom((prevZoom) => {
      if (!vp) return clamped;
      const fx = focalX ?? vp.clientWidth / 2;
      const fy = focalY ?? vp.clientHeight / 2;
      setPan((prevPan) => {
        const ratio = clamped / prevZoom;
        const newPan = { x: fx - (fx - prevPan.x) * ratio, y: fy - (fy - prevPan.y) * ratio };
        return clampPan(clamped, newPan);
      });
      return clamped;
    });
  }, [clampPan, minZoom]);

  const resetView = useCallback(() => { userInteractedRef.current = false; fitToViewport(); }, [fitToViewport]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    userInteractedRef.current = true;
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const focalX = e.clientX - rect.left;
    const focalY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? -0.18 : 0.18;
    zoomTo(zoom + delta * zoom, focalX, focalY);
  }, [zoom, zoomTo]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    userInteractedRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.current.size === 2) {
      // Second finger just landed — switch from drag to pinch-zoom.
      dragState.current.dragging = false;
      const pts = [...activePointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const vp = viewportRef.current;
      const rect = vp?.getBoundingClientRect();
      pinchState.current = {
        startDist: dist,
        startZoom: zoom,
        midX: (pts[0].x + pts[1].x) / 2 - (rect?.left ?? 0),
        midY: (pts[0].y + pts[1].y) / 2 - (rect?.top ?? 0),
      };
    } else if (activePointers.current.size === 1) {
      dragState.current = { dragging: true, startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y, moved: false };
      setIsDragging(true);
    }
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!activePointers.current.has(e.pointerId)) return;
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.current.size === 2 && pinchState.current) {
      const pts = [...activePointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const scale = dist / Math.max(1, pinchState.current.startDist);
      zoomTo(pinchState.current.startZoom * scale, pinchState.current.midX, pinchState.current.midY);
      return;
    }

    if (!dragState.current.dragging) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.current.moved = true;
    setPan(clampPan(zoom, { x: dragState.current.panX + dx, y: dragState.current.panY + dy }));
  }, [zoom, clampPan]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    pinchState.current = null;
    if (activePointers.current.size === 1) {
      // Dropped from a pinch back down to one finger — resume dragging
      // from here instead of jumping.
      const [[, pt]] = activePointers.current;
      dragState.current = { dragging: true, startX: pt.x, startY: pt.y, panX: pan.x, panY: pan.y, moved: false };
    } else {
      dragState.current.dragging = false;
      setIsDragging(false);
    }
  }, [pan]);

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
    const interval = setInterval(async () => {
      try {
        const result = await fetchTerritories();
        if (mounted) setData(result);
      } catch { /* keep showing the last good data on a transient failure */ }
    }, 15000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

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

  const regionById = useMemo(() => new Map((data?.regions || []).map((r) => [r.id, r])), [data]);
  const continentById = useMemo(() => new Map((data?.continents || []).map((c) => [c.id, c])), [data]);

  const activeGuilds = useMemo(() => {
    const seen = new Map<string, TerritoryOwner>();
    for (const t of data?.territories || []) {
      if (t.owner && !seen.has(t.owner.id)) seen.set(t.owner.id, t.owner);
    }
    return [...seen.values()];
  }, [data]);

  return (
    <div className="min-h-screen relative overflow-hidden flex flex-col bg-[#05050a]">

      <div className="relative z-20 p-4 sm:p-6 md:p-8 pointer-events-none" style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.65), transparent)" }}>
        <p className="font-mono tracking-[0.3em] sm:tracking-[0.5em] text-[10px] sm:text-xs uppercase mb-1" style={{ color:"rgba(160,0,26,0.4)" }}>反逆</p>
        <h1 className="font-serif text-xl sm:text-3xl md:text-5xl font-bold text-white tracking-wide sm:tracking-widest uppercase neon-text-sky">Requiem Order World Atlas</h1>
        <p className="hidden sm:block mt-2 max-w-xl text-sm" style={{ color:"rgba(212,201,168,0.45)" }}>
          Live territory control across the known world. Claim territory in-bot with <span className="font-mono">.territory claim</span> and it appears here. Scroll to zoom, drag to pan, click a marker for details.
        </p>
      </div>

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

      {!loading && !error && data && (
        <div
          ref={viewportRef}
          className="flex-1 relative w-full min-h-[500px] z-10 overflow-hidden touch-none select-none"
          style={{ cursor: isDragging ? "grabbing" : "grab" }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <div
            className="absolute top-0 left-0"
            style={{
              width: MAP_W,
              height: MAP_H,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
              transition: isDragging ? "none" : "transform 0.12s ease-out",
            }}
          >
            <img
              src="/images/world-map.svg"
              alt="World map"
              draggable={false}
              className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
            />

            {data.territories.map((territory) => {
              const style = territory.owner ? colorForGuild(territory.owner.id) : UNCLAIMED_STYLE;
              const region = regionById.get(territory.region);
              const continent = region ? continentById.get(region.continent) : undefined;
              const counterScale = 1 / Math.sqrt(zoom);
              return (
                <div
                  key={territory.id}
                  className="absolute group/marker cursor-pointer"
                  style={{
                    left: `${territory.x}%`,
                    top: `${territory.y}%`,
                    transform: `translate(-50%, -50%) scale(${counterScale})`,
                  }}
                  onClick={() => { if (!dragState.current.moved) setSelectedId(territory.id); }}
                >
                  <div className="relative">
                    {territory.owner && (
                      <>
                        <div className={`absolute inset-0 rounded-full animate-ping opacity-25 ${style.dot}`} style={{ animationDuration: "2.6s" }} />
                        <div className={`absolute inset-0 rounded-full animate-ping opacity-10 scale-[2] ${style.dot}`} style={{ animationDuration: "3.8s" }} />
                      </>
                    )}

                    <div className={`w-10 h-10 rounded-full flex items-center justify-center relative z-10 border transition-all duration-300 hover:scale-110 glass-card ${style.text} ${style.ring}`}
                      style={{ background:"rgba(0,0,0,0.55)" }}>
                      {territory.owner ? <Crown className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                    </div>

                    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 p-4 rounded-xl opacity-0 translate-y-2 pointer-events-none group-hover/marker:opacity-100 group-hover/marker:translate-y-0 transition-all duration-300 z-50"
                      style={{ width:260, background:"rgba(17,17,23,0.92)", border:"1px solid rgba(160,0,26,0.18)", boxShadow:"0 0 30px rgba(160,0,26,0.2)" }}>
                      <div className={`text-[10px] font-mono tracking-widest uppercase mb-1 opacity-60 ${style.text}`}>
                        {continent?.name || "?"} · {region?.name || "?"}
                      </div>
                      <h3 className="font-serif text-base font-bold text-white mb-1.5">{territory.name}</h3>
                      <p className="text-xs leading-relaxed" style={{ color:"rgba(212,201,168,0.55)" }}>
                        Produces <span className="text-white/70">{territory.resource}</span> — {territory.baseIncome.toLocaleString()} gold/day base income.
                      </p>
                      <div className="mt-3 pt-2 text-[10px] font-bold tracking-[0.2em] uppercase text-center" style={{ borderTop:"1px solid rgba(255,255,255,0.05)", color: territory.owner ? "rgba(212,201,168,0.7)" : "rgba(160,0,26,0.6)" }}>
                        {territory.owner
                          ? `Controlled by ${territory.owner.name}${territory.taxRate != null ? ` · ${territory.taxRate}% tax` : ""}`
                          : "Unclaimed — click for details"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="absolute bottom-3 left-3 sm:bottom-6 sm:left-6 z-30 flex flex-col gap-1 sm:gap-1.5 pointer-events-auto">
            <button onClick={() => { userInteractedRef.current = true; zoomTo(zoom + 0.5); }} className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white transition-colors" style={{ background: "rgba(17,17,23,0.85)", border: "1px solid rgba(160,0,26,0.2)" }} title="Zoom in">
              <ZoomIn className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
            <button onClick={() => { userInteractedRef.current = true; zoomTo(zoom - 0.5); }} className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white transition-colors" style={{ background: "rgba(17,17,23,0.85)", border: "1px solid rgba(160,0,26,0.2)" }} title="Zoom out">
              <ZoomOut className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
            <button onClick={resetView} className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center text-white/70 hover:text-white transition-colors" style={{ background: "rgba(17,17,23,0.85)", border: "1px solid rgba(160,0,26,0.2)" }} title="Reset view">
              <Maximize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="absolute z-20 p-2.5 sm:p-4 rounded-lg sm:rounded-xl max-w-[140px] sm:max-w-none bottom-3 right-3 sm:bottom-6 sm:right-6" style={{ background:"rgba(17,17,23,0.85)", border:"1px solid rgba(160,0,26,0.15)", boxShadow:"0 0 20px rgba(160,0,26,0.08)" }}>
          <h4 className="text-[8px] sm:text-[10px] font-mono font-bold tracking-[0.15em] sm:tracking-[0.3em] uppercase pb-1.5 sm:pb-2 mb-2 sm:mb-3" style={{ color:"rgba(160,0,26,0.5)", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
            Guild Control
          </h4>
          <ul className="space-y-1.5 sm:space-y-2 text-[10px] sm:text-xs text-white/70 max-h-32 sm:max-h-48 overflow-y-auto pr-1">
            {activeGuilds.length === 0 && <li className="text-white/40 italic">No territories claimed yet</li>}
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
                  <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: "rgba(212,201,168,0.5)" }}>
                    <span>{detail.continent?.name || "?"}</span>
                    <span>·</span>
                    <span>{detail.region?.name || "?"}</span>
                    <span>·</span>
                    <span className="text-white/60">{detail.resource}</span>
                    <span>·</span>
                    <span className="text-white/60">{detail.baseIncome.toLocaleString()} gold/day</span>
                  </div>

                  {detail.owner ? (
                    <div className="rounded-xl p-4" style={{ background: "rgba(0,0,0,0.3)", border: `1px solid ${colorForGuild(detail.owner.id).hex}33` }}>
                      <div className="flex items-center gap-3 mb-3">
                        <div
                          className="w-12 h-12 rounded-full flex items-center justify-center font-serif font-bold text-lg shrink-0"
                          style={{
                            background: detail.owner.emblem ? `url(${detail.owner.emblem}) center/cover` : `${colorForGuild(detail.owner.id).hex}22`,
                            color: colorForGuild(detail.owner.id).hex,
                            border: `2px solid ${colorForGuild(detail.owner.id).hex}55`,
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
                          <Crown className="w-3.5 h-3.5 shrink-0" style={{ color: colorForGuild(detail.owner.id).hex }} />
                          <span className="truncate">Leader: <span className="text-white/80">{detail.owner.leader.name}</span></span>
                        </div>
                        <div className="flex items-center gap-1.5" style={{ color: "rgba(212,201,168,0.6)" }}>
                          <Users className="w-3.5 h-3.5 shrink-0" style={{ color: colorForGuild(detail.owner.id).hex }} />
                          <span>{detail.owner.memberCount} member{detail.owner.memberCount !== 1 ? "s" : ""}</span>
                        </div>
                        {detail.taxRate != null && (
                          <div className="flex items-center gap-1.5" style={{ color: "rgba(212,201,168,0.6)" }}>
                            <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: colorForGuild(detail.owner.id).hex }} />
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

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 font-mono text-[10px] tracking-widest pointer-events-none" style={{ color:"rgba(160,0,26,0.35)" }}>
        REQUIEM ORDER WORLD ATLAS · 反逆 · v2.1
      </div>
    </div>
  );
}

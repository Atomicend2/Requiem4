import { Wind, Star, Compass, Eye, Zap } from "lucide-react";

export default function World() {
  const REGIONS = [
    { id: 1, name: "Requiem Order Capital",         desc: "The imperial capital. Heart of the Requiem Order, seat of Britannian power.", x: "50%", y: "38%", icon: Star,    colorClass: "text-amber-400",  dotClass: "bg-amber-400",  ringClass: "border-amber-400/30" },
    { id: 2, name: "Skyward Sanctuary",     desc: "Our hidden base of operations. Concealed from the empire — only Requiem Order members may enter.", x: "22%", y: "65%", icon: Wind,    colorClass: "text-primary",    dotClass: "bg-primary",    ringClass: "border-primary/30" },
    { id: 3, name: "The Void Rift",         desc: "A tear in the sky where the enemy gathers. Approach with extreme caution.", x: "78%", y: "22%", icon: Zap,     colorClass: "text-rose-400",   dotClass: "bg-rose-400",   ringClass: "border-rose-400/30" },
    { id: 4, name: "Natsuki's Observatory", desc: "High-altitude watch post of the Founder. The entire world is visible from here.", x: "36%", y: "28%", icon: Eye,     colorClass: "text-rose-300",    dotClass: "bg-rose-300",    ringClass: "border-rose-300/30" },
    { id: 5, name: "Drifting Isles",        desc: "A network of contested territories. Home to rare card spawns and hidden treasures.", x: "68%", y: "75%", icon: Compass, colorClass: "text-teal-400",   dotClass: "bg-teal-400",   ringClass: "border-teal-400/30" },
  ];

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

        {/* Constellation lines connecting regions (decorative) */}
        <svg className="absolute inset-0 w-full h-full opacity-20" viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="50" y1="38" x2="22" y2="65" stroke="#A0001A" strokeWidth="0.15" strokeDasharray="1 2" />
          <line x1="50" y1="38" x2="78" y2="22" stroke="#A0001A" strokeWidth="0.15" strokeDasharray="1 2" />
          <line x1="50" y1="38" x2="36" y2="28" stroke="#A0001A" strokeWidth="0.15" strokeDasharray="1 2" />
          <line x1="50" y1="38" x2="68" y2="75" stroke="#A0001A" strokeWidth="0.15" strokeDasharray="1 2" />
          <line x1="22" y1="65" x2="68" y2="75" stroke="#A0001A" strokeWidth="0.10" strokeDasharray="1 3" />
          <line x1="36" y1="28" x2="78" y2="22" stroke="#A0001A" strokeWidth="0.10" strokeDasharray="1 3" />
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
          Interactive celestial atlas of the known Requiem Order territories. Hover a region to reveal its secrets.
        </p>
      </div>

      {/* ── Region Markers ── */}
      <div className="flex-1 relative w-full min-h-[700px] z-10">
        {REGIONS.map((region) => (
          <div
            key={region.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 group/marker cursor-crosshair"
            style={{ left: region.x, top: region.y }}
          >
            <div className="relative">
              {/* Outer pulse */}
              <div className={`absolute inset-0 rounded-full animate-ping opacity-25 ${region.dotClass}`} style={{ animationDuration:`${2.2 + region.id*0.35}s` }} />
              <div className={`absolute inset-0 rounded-full animate-ping opacity-10 scale-[2] ${region.dotClass}`} style={{ animationDuration:`${3.4 + region.id*0.35}s` }} />

              {/* Marker */}
              <div className={`w-12 h-12 rounded-full flex items-center justify-center relative z-10 border transition-all duration-300 hover:scale-110 glass-card ${region.colorClass} ${region.ringClass}`}
                style={{ background:"rgba(0,0,0,0.55)" }}>
                <region.icon className="w-5 h-5" />
              </div>

              {/* Tooltip */}
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 w-68 p-4 rounded-xl opacity-0 translate-y-2 pointer-events-none group-hover/marker:opacity-100 group-hover/marker:translate-y-0 transition-all duration-300 z-50"
                style={{ width:260, background:"rgba(17,17,23,0.92)", border:"1px solid rgba(160,0,26,0.18)", boxShadow:"0 0 30px rgba(160,0,26,0.2)" }}>
                <div className={`text-[10px] font-mono tracking-widest uppercase mb-1 opacity-60 ${region.colorClass}`}>Region {String(region.id).padStart(2,"0")}</div>
                <h3 className="font-serif text-base font-bold text-white mb-1.5">{region.name}</h3>
                <p className="text-xs leading-relaxed" style={{ color:"rgba(212,201,168,0.45)" }}>{region.desc}</p>
                <div className="mt-3 pt-2 text-[10px] font-bold tracking-[0.2em] uppercase text-center" style={{ borderTop:"1px solid rgba(255,255,255,0.05)", color:"rgba(160,0,26,0.6)" }}>
                  Requiem Order Territory
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Legend ── */}
      <div className="absolute z-20 p-4 rounded-xl" style={{ bottom:80, right:24, background:"rgba(17,17,23,0.85)", border:"1px solid rgba(160,0,26,0.15)", boxShadow:"0 0 20px rgba(160,0,26,0.08)" }}>
        <h4 className="text-[10px] font-mono font-bold tracking-[0.3em] uppercase pb-2 mb-3" style={{ color:"rgba(160,0,26,0.5)", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
          Map Legend
        </h4>
        <ul className="space-y-2 text-xs text-white/70">
          {[
            { dot:"bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]",  label:"Capital" },
            { dot:"bg-primary shadow-[0_0_6px_rgba(160,0,26,0.8)]",   label:"Friendly / HQ" },
            { dot:"bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.8)]", label:"Hostile / Rift" },
            { dot:"bg-rose-300",   label:"Observation Post" },
            { dot:"bg-teal-400",  label:"Neutral / Loot Zone" },
          ].map(l => (
            <li key={l.label} className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${l.dot}`} />
              {l.label}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Coord label (flavour) ── */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 font-mono text-[10px] tracking-widest" style={{ color:"rgba(160,0,26,0.25)" }}>
        REQUIEM ORDER WORLD ATLAS · 反逆 · v1.0
      </div>
    </div>
  );
}

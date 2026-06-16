import { useState, useEffect, useCallback } from "react";
import { useGetMyCards, useAddCardToWishlist } from "@workspace/api-client-react/src/generated/api";
import { useAuth } from "@/lib/auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, Heart, CreditCard, Lock, Flame, Gavel, Sparkles, Star, ImageOff, Users, AlertCircle, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const TIER_CONFIG: Record<string, { label: string; bg: string; text: string; border: string; glow: string; rate: string }> = {
  "T1": { label: "Common",    bg: "bg-slate-500/20",  text: "text-slate-300",  border: "border-slate-500/40",  glow: "shadow-[0_0_12px_rgba(148,163,184,0.4)]",  rate: "45%" },
  "T2": { label: "Uncommon",  bg: "bg-emerald-500/20",text: "text-emerald-400",border: "border-emerald-500/40",glow: "shadow-[0_0_12px_rgba(52,211,153,0.4)]",   rate: "30%" },
  "T3": { label: "Rare",      bg: "bg-rose-500/20",    text: "text-rose-400",    border: "border-rose-500/40",    glow: "shadow-[0_0_12px_rgba(160,0,26,0.5)]",   rate: "15%" },
  "T4": { label: "Epic",      bg: "bg-indigo-500/20", text: "text-indigo-300", border: "border-indigo-500/40", glow: "shadow-[0_0_14px_rgba(129,140,248,0.5)]",  rate: "8%"  },
  "T5": { label: "Legendary", bg: "bg-amber-500/20",  text: "text-amber-400",  border: "border-amber-500/50",  glow: "shadow-[0_0_18px_rgba(212,175,55,0.6)]",   rate: "2%"  },
  "T6": { label: "Animated",  bg: "bg-amber-500/20",   text: "text-amber-200",   border: "border-amber-300/50",   glow: "shadow-[0_0_22px_rgba(212,175,55,0.7)]",   rate: "—"   },
  "TS": { label: "Special",   bg: "bg-rose-500/20",   text: "text-rose-400",   border: "border-rose-500/40",   glow: "shadow-[0_0_14px_rgba(251,113,133,0.5)]",  rate: "—"   },
  "TX": { label: "Exclusive", bg: "bg-yellow-500/20",text: "text-yellow-400",border: "border-yellow-500/40",glow: "shadow-[0_0_18px_rgba(250,204,21,0.6)]",  rate: "—"   },
};

const CARDS_PER_PAGE = 50;

// Fetches from the /from-json route which reads cards.json directly (always populated)
async function fetchCardsFromJson(params: { page: number; tier?: string; search?: string }) {
  const url = new URL("/api/v1/cards/from-json", window.location.origin);
  url.searchParams.set("page", String(params.page));
  url.searchParams.set("limit", String(CARDS_PER_PAGE));
  if (params.tier && params.tier !== "all") url.searchParams.set("tier", params.tier);
  if (params.search) url.searchParams.set("search", params.search);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function Cards() {
  const { isAuthenticated, user } = useAuth();
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const { toast } = useToast();

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [tierFilter]);

  // Fetch from cards.json directly — always available, no DB dependency
  const [allCardsData, setAllCardsData] = useState<{ cards: any[]; total: number; pages: number } | null>(null);
  const [loadingAll, setLoadingAll] = useState(true);
  const [allCardsError, setAllCardsError] = useState<Error | null>(null);

  const loadCards = useCallback(async () => {
    setLoadingAll(true);
    setAllCardsError(null);
    try {
      const data = await fetchCardsFromJson({ page, tier: tierFilter, search: debouncedSearch });
      setAllCardsData(data);
    } catch (err: any) {
      setAllCardsError(err);
    } finally {
      setLoadingAll(false);
    }
  }, [page, tierFilter, debouncedSearch]);

  useEffect(() => { loadCards(); }, [loadCards]);

  const { data: myCards, isLoading: loadingMy } = useGetMyCards({
    query: { enabled: isAuthenticated },
  });

  const isPremium = (user as any)?.premium === 1;

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-10">
        <p className="text-primary/40 font-mono tracking-[0.4em] text-xs uppercase mb-1">反逆</p>
        <h1 className="font-serif text-3xl md:text-4xl font-bold text-white neon-text-sky tracking-widest uppercase">Card Codex</h1>
        <p className="text-muted-foreground mt-2">Collect legendary cards from the Requiem Order universe.</p>
      </div>

      <Tabs defaultValue="all" className="w-full">
        <TabsList className="flex w-full max-w-2xl bg-black/40 border border-primary/10 p-1 gap-1 overflow-x-auto mb-6">
          <TabsTrigger value="all" className="flex-1 data-[state=active]:bg-primary/20 data-[state=active]:text-primary data-[state=active]:neon-border-sky font-bold tracking-wider uppercase text-xs rounded-sm">
            All Cards {allCardsData ? `(${allCardsData.total.toLocaleString()})` : ""}
          </TabsTrigger>
          <TabsTrigger value="my" disabled={!isAuthenticated} className="flex-1 data-[state=active]:bg-primary/20 data-[state=active]:text-primary font-bold tracking-wider uppercase text-xs rounded-sm">
            My Collection {isAuthenticated && myCards ? `(${myCards.total})` : ""}
          </TabsTrigger>
          <TabsTrigger value="gacha" className="flex-1 data-[state=active]:bg-amber-500/20 data-[state=active]:text-amber-400 font-bold tracking-wider uppercase text-xs rounded-sm whitespace-nowrap">
            Gacha {!isPremium && <Lock className="inline w-3 h-3 ml-1 opacity-60" />}
          </TabsTrigger>
          <TabsTrigger value="fusion" className="flex-1 data-[state=active]:bg-rose-500/20 data-[state=active]:text-rose-400 font-bold tracking-wider uppercase text-xs rounded-sm whitespace-nowrap">
            Fusion
          </TabsTrigger>
          <TabsTrigger value="auction" className="flex-1 data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 font-bold tracking-wider uppercase text-xs rounded-sm whitespace-nowrap">
            Auction
          </TabsTrigger>
        </TabsList>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or series..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-black/40 border-primary/20 text-white focus-visible:ring-primary placeholder:text-muted-foreground"
            />
          </div>
          <Select value={tierFilter} onValueChange={setTierFilter}>
            <SelectTrigger className="w-full sm:w-[200px] bg-black/40 border-primary/20 text-white">
              <SelectValue placeholder="Filter by Tier" />
            </SelectTrigger>
            <SelectContent className="bg-[#0A0A0F] border-primary/20 text-white">
              <SelectItem value="all">All Tiers</SelectItem>
              {Object.entries(TIER_CONFIG).map(([key, cfg]) => (
                <SelectItem key={key} value={key}>{key} — {cfg.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* ALL CARDS */}
        <TabsContent value="all" className="mt-0">
          {loadingAll ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {[1,2,3,4,5,6,7,8,9,10].map((i) => <CardSkeleton key={i} />)}
            </div>
          ) : allCardsError ? (
            <ErrorState text="Failed to load cards. Please check your connection and try again." icon={<AlertCircle className="w-8 h-8 text-red-400" />} />
          ) : allCardsData && allCardsData.cards.length > 0 ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {allCardsData.cards.map((card: any) => <CardDisplay key={card.id || card.shoob_id} card={card} />)}
              </div>
              {/* Pagination */}
              {allCardsData.pages > 1 && (
                <div className="flex items-center justify-center gap-3 mt-8">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="bg-black/40 border-primary/20 text-white hover:bg-primary/10"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground font-mono">
                    Page {page} / {allCardsData.pages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(allCardsData.pages, p + 1))}
                    disabled={page >= allCardsData.pages}
                    className="bg-black/40 border-primary/20 text-white hover:bg-primary/10"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </>
          ) : (
            <Empty text="No cards match your filters. Try adjusting your search or tier selection." />
          )}
        </TabsContent>

        {/* MY COLLECTION */}
        <TabsContent value="my" className="mt-0">
          {loadingMy ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {[1,2,3,4].map((i) => <CardSkeleton key={i} />)}
            </div>
          ) : myCards?.cards && myCards.cards.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {myCards.cards.map((uc: any) => <CardDisplay key={uc.userCardId} card={uc.card} showOwned />)}
            </div>
          ) : (
            <Empty icon={<CreditCard className="w-8 h-8 text-muted-foreground" />} text="No cards collected yet. Use bot commands to claim spawned cards." />
          )}
        </TabsContent>

        {/* GACHA */}
        <TabsContent value="gacha" className="mt-0">
          {!isPremium ? (
            <LockedPanel
              color="amber"
              icon={<Lock className="w-10 h-10 text-amber-400" />}
              title="Requiem Order Gacha"
              desc="The premium gacha is restricted to elite members only. Upgrade your status to pull legendary cards from the vault."
              badge="Premium Members Only"
            />
          ) : (
            <div className="space-y-8">
              <div className="text-center py-12 glass-card rounded-xl border border-amber-500/30 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500/8 via-rose-500/5 to-transparent" />
                <div className="relative z-10">
                  <Sparkles className="w-12 h-12 text-amber-400 mx-auto mb-4 animate-pulse" />
                  <h3 className="font-serif text-3xl font-bold text-amber-400 mb-2 neon-text-gold">Requiem Order Gacha</h3>
                  <p className="text-muted-foreground mb-8 max-w-lg mx-auto">Pull from the premium vault and claim legendary cards. Each pull costs <span className="text-amber-400 font-bold">500 Gold</span>.</p>
                  <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <Button className="bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 border border-amber-500/50 font-bold tracking-widest uppercase px-8 h-12 shadow-[0_0_20px_rgba(245,158,11,0.3)]">
                      <Star className="w-4 h-4 mr-2" /> Single Pull — 500 Gold
                    </Button>
                    <Button className="bg-rose-500/20 hover:bg-rose-500/40 text-rose-400 border border-rose-500/50 font-bold tracking-widest uppercase px-8 h-12 shadow-[0_0_20px_rgba(160,0,26,0.3)]">
                      <Sparkles className="w-4 h-4 mr-2" /> 10x Pull — 4,500 Gold
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-6">Use <span className="text-primary font-mono">.draw</span> in the WhatsApp group to pull via the bot.</p>
                </div>
              </div>
              <div className="grid grid-cols-3 md:grid-cols-7 gap-3">
                {Object.entries(TIER_CONFIG).map(([tier, cfg]) => (
                  <div key={tier} className={cn("glass-card rounded-lg p-3 border text-center", cfg.border)}>
                    <div className={cn("text-sm font-serif font-bold mb-0.5", cfg.text)}>{tier}</div>
                    <div className="text-[10px] text-muted-foreground mb-1">{cfg.label}</div>
                    <div className={cn("text-xs font-bold font-mono", cfg.text)}>{cfg.rate}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        {/* FUSION */}
        <TabsContent value="fusion" className="mt-0">
          <LockedPanel
            color="sky"
            icon={<Flame className="w-10 h-10 text-rose-400 animate-pulse" />}
            title="Card Fusion"
            desc="Sacrifice lower-tier cards and Gold to forge a card of higher power. The empire demands sacrifice to birth something greater."
            badge="Coming Soon — In Development"
          />
        </TabsContent>

        {/* AUCTION */}
        <TabsContent value="auction" className="mt-0">
          <LockedPanel
            color="emerald"
            icon={<Gavel className="w-10 h-10 text-emerald-400" />}
            title="Requiem Order Auction House"
            desc="List your cards for auction and let the highest bidder claim them. Trade rare cards with members across the rebellion."
            badge="Coming Soon — In Development"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CardDisplay({ card, showOwned }: { card: any; showOwned?: boolean }) {
  const { toast } = useToast();
  const { isAuthenticated } = useAuth();
  const cfg = TIER_CONFIG[card.tier] || TIER_CONFIG["T1"];

  const wishlistMutation = useAddCardToWishlist({
    mutation: {
      onSuccess: () => toast({ title: "Added to Wishlist", description: `${card.name} — the owner will be notified.` }),
      onError: () => toast({ title: "Wishlist Failed", description: "Could not add. Please try again.", variant: "destructive" }),
    },
  });

  const handleWishlist = () => {
    if (!isAuthenticated) {
      toast({ title: "Login Required", description: "You must be logged in.", variant: "destructive" });
      return;
    }
    wishlistMutation.mutate({ data: { cardId: card.id } });
  };

  const hasImage = !!card.imageUrl;

  return (
    <div className="relative group">
      <div className={cn(
        "glass-card rounded-xl overflow-hidden border transition-all duration-300 group-hover:-translate-y-2 flex flex-col",
        cfg.border,
        "group-hover:" + cfg.glow
      )}>
        {/* Card Image */}
        <div className={cn("relative w-full aspect-[3/4] overflow-hidden", cfg.bg)}>
          {hasImage ? (
            card.isVideo ? (
              // Webm animated card — URL is proxied through our API to satisfy CORS
              <video
                key={card.imageUrl}
                src={card.imageUrl}
                autoPlay
                loop
                muted
                playsInline
                crossOrigin="anonymous"
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
            ) : (
              // Static image OR GIF animated card (is_animated=true but no webm).
              // GIFs autoplay in <img> tags natively — no extra handling needed.
              <img
                src={card.imageUrl}
                alt={card.name}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
            )
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 opacity-40">
              <ImageOff className="w-8 h-8" />
              <span className="text-xs font-mono">No Image</span>
            </div>
          )}

          {/* Tier badge */}
          <div className={cn(
            "absolute top-2 left-2 px-2 py-0.5 rounded font-bold text-xs border font-mono",
            cfg.bg, cfg.text, cfg.border
          )}>
            {card.tier}
          </div>

          {/* Series badge */}
          <div className="absolute top-2 right-2 px-2 py-0.5 bg-black/70 rounded border border-white/10 text-[10px] text-white/70 max-w-[60%] truncate">
            {card.series}
          </div>

          {/* Owned badge */}
          {showOwned && (
            <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-primary/80 rounded text-[10px] text-white font-bold uppercase tracking-wider">
              Owned
            </div>
          )}

          {/* Gradient overlay at bottom */}
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/90 to-transparent" />
        </div>

        {/* Card Footer */}
        <div className="p-3 bg-black/50">
          <h3 className={cn("font-serif font-bold text-white truncate text-sm mb-0.5")}>{card.name}</h3>

          {/* Owners */}
          {card.owners && card.owners.length > 0 && (
            <div className="flex items-center gap-1 mb-2">
              <Users className="w-3 h-3 text-muted-foreground shrink-0" />
              <p className="text-[10px] text-muted-foreground truncate">
                {card.owners.slice(0, 2).map((o: any) => typeof o === "string" ? o : (o.name || o.id)).join(", ")}
                {card.owners.length > 2 ? ` +${card.owners.length - 2}` : ""}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-white/5">
            <span className="text-[10px] text-muted-foreground">{card.totalCopies ?? 0} in existence</span>
            <button
              onClick={handleWishlist}
              disabled={wishlistMutation.isPending}
              className={cn(
                "transition-colors",
                wishlistMutation.isPending ? "opacity-50" : "hover:text-rose-400"
              )}
              title="Add to Wishlist"
            >
              <Heart className={cn("w-4 h-4", wishlistMutation.isSuccess && "text-rose-400 fill-rose-400")} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="glass-card rounded-xl overflow-hidden border border-white/5 animate-pulse">
      <div className="w-full aspect-[3/4] bg-white/5" />
      <div className="p-3 bg-black/40 space-y-2">
        <div className="h-4 bg-white/5 rounded w-3/4" />
        <div className="h-3 bg-white/5 rounded w-1/2" />
      </div>
    </div>
  );
}

function Empty({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="py-20 text-center glass-card rounded-xl border border-white/5 flex flex-col items-center gap-4">
      {icon && <div className="w-16 h-16 rounded-full bg-black/50 border border-white/10 flex items-center justify-center">{icon}</div>}
      <p className="text-muted-foreground max-w-md">{text}</p>
    </div>
  );
}

function ErrorState({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="py-20 text-center glass-card rounded-xl border border-red-500/20 bg-red-500/5 flex flex-col items-center gap-4">
      {icon && <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">{icon}</div>}
      <p className="text-red-400/80 max-w-md">{text}</p>
    </div>
  );
}

function EmptyStateWithAction({ icon, title, text, action }: { icon?: React.ReactNode; title: string; text: string; action: string }) {
  return (
    <div className="py-20 text-center glass-card rounded-xl border border-amber-500/20 bg-amber-500/5 flex flex-col items-center gap-4">
      {icon && <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">{icon}</div>}
      <div>
        <h3 className="text-amber-400 font-bold text-lg mb-1">{title}</h3>
        <p className="text-muted-foreground max-w-md">{text}</p>
        <p className="text-amber-400/70 text-sm mt-3">{action}</p>
      </div>
    </div>
  );
}

function LockedPanel({ color, icon, title, desc, badge }: { color: string; icon: React.ReactNode; title: string; desc: string; badge: string }) {
  const colors: Record<string, string> = {
    amber: "border-amber-500/20 bg-amber-500/5",
    sky:   "border-rose-500/20 bg-rose-500/5",
    emerald: "border-emerald-500/20 bg-emerald-500/5",
  };
  const iconBg: Record<string, string> = {
    amber: "bg-amber-500/10 border-amber-500/30 shadow-[0_0_30px_rgba(245,158,11,0.25)]",
    sky:   "bg-rose-500/10 border-rose-500/30 shadow-[0_0_30px_rgba(160,0,26,0.25)]",
    emerald: "bg-emerald-500/10 border-emerald-500/30 shadow-[0_0_30px_rgba(52,211,153,0.25)]",
  };
  const badgeColors: Record<string, string> = {
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    sky:   "border-rose-500/30 bg-rose-500/10 text-rose-400",
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  };

  return (
    <div className={cn("py-24 text-center glass-card rounded-xl border flex flex-col items-center relative overflow-hidden", colors[color])}>
      <div className="absolute inset-0 bg-gradient-to-b from-current/5 to-transparent opacity-10" />
      <div className="relative z-10">
        <div className={cn("w-20 h-20 rounded-full border flex items-center justify-center mb-6 mx-auto", iconBg[color])}>
          {icon}
        </div>
        <h3 className="font-serif text-2xl font-bold text-white mb-3">{title}</h3>
        <p className="text-muted-foreground max-w-md mx-auto mb-6">{desc}</p>
        <div className={cn("px-6 py-2 rounded-full border text-sm font-bold tracking-widest uppercase inline-block", badgeColors[color])}>
          {badge}
        </div>
      </div>
    </div>
  );
}

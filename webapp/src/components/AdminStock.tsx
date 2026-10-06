import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Minus, Plus, RefreshCw, ShieldAlert, Package, Loader2 } from 'lucide-react';
import TopoBackground from './TopoBackground';
import { buildIdentityParams, identityBody, triggerHaptic } from '../tg';
import { PICKUP_POINTS, type PickupPointId } from '../shop';

interface StockProduct {
  id: number;
  name: string;
  type: string;
  variant: string | null;
  count: number;
  price: number;
  url: string | null;
  location?: string | null;
}

/**
 * Отдельная админ-вьюшка: то же наличие, что видят покупатели, но вместо
 * «в корзину» — +1/-1, меняющие shop.count напрямую. Открывается из /admin
 * (?admin=1), реальная проверка прав — на бэке (_require_admin в server_api.py),
 * этот экран сам по себе ничего не защищает.
 */
export default function AdminStock() {
  const [location, setLocation] = useState<PickupPointId>(PICKUP_POINTS[0].id);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [search, setSearch] = useState('');
  const [pendingIds, setPendingIds] = useState<number[]>([]);

  const fetchProducts = async (loc: PickupPointId) => {
    setLoading(true);
    setError(null);
    try {
      const params = buildIdentityParams();
      const res = await fetch(`/api/admin/products/${loc}?${params.toString()}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error('Не удалось загрузить наличие');
      setProducts(await res.json());
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Не удалось загрузить наличие');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts(location);
    if (window.Telegram?.WebApp) {
      try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
      } catch {
        /* SDK уже инициализирован — не критично */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const handleAdjust = async (product: StockProduct, delta: number) => {
    if (pendingIds.includes(product.id)) return;
    if (delta < 0 && product.count <= 0) return;

    triggerHaptic('light');
    const prevCount = product.count;

    // Оптимистично меняем локально, откатываем при ошибке.
    setProducts(prev => prev.map(p => p.id === product.id ? { ...p, count: p.count + delta } : p));
    setPendingIds(prev => [...prev, product.id]);

    try {
      const res = await fetch(`/api/admin/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: product.id,
          delta,
          ...identityBody(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail || 'Не удалось изменить наличие');

      // Подтверждаем реальным числом с сервера (на случай гонки между вкладками).
      const confirmedCount = data.count;
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, count: confirmedCount } : p));
    } catch (err: any) {
      console.error(err);
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, count: prevCount } : p));
      triggerHaptic('heavy');
    } finally {
      setPendingIds(prev => prev.filter(id => id !== product.id));
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.variant ?? '').toLowerCase().includes(q)
    );
  }, [products, search]);

  if (forbidden) {
    return (
      <div className="relative w-full min-h-screen text-white flex items-center justify-center px-4">
        <TopoBackground />
        <div className="relative z-10 w-full max-w-sm p-7 rounded-2xl border border-red-500/20 bg-red-950/40 backdrop-blur-lg text-center">
          <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-4" />
          <p className="font-display font-semibold text-sm uppercase tracking-widest text-red-200">Доступ запрещён</p>
          <p className="mt-2 text-xs font-sans text-red-300/80 leading-relaxed">
            Этот экран доступен только администраторам.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full min-h-screen text-white select-none overflow-x-hidden font-sans pb-16">
      <TopoBackground />
      <div className="relative z-10 w-full max-w-lg mx-auto px-4 pt-8 space-y-4">
        <header className="flex items-center space-x-2.5">
          <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/15 flex items-center justify-center shrink-0">
            <Package className="w-5 h-5 text-white/80" />
          </div>
          <div>
            <h1 className="font-display font-semibold text-base uppercase tracking-wide text-white">Наличие</h1>
            <p className="text-[10px] font-mono uppercase tracking-widest text-white/40">Только для админов</p>
          </div>
        </header>

        {/* Точка */}
        <div className="grid grid-cols-2 gap-2.5">
          {PICKUP_POINTS.map(loc => {
            const isActive = location === loc.id;
            return (
              <button
                key={loc.id}
                onClick={() => { if (!isActive) { triggerHaptic('medium'); setLocation(loc.id); } }}
                className={`py-3 rounded-xl border text-xs font-display font-medium uppercase tracking-wide transition-all cursor-pointer ${
                  isActive
                    ? 'bg-white text-black border-white shadow-[0_4px_15px_rgba(255,255,255,0.15)]'
                    : 'bg-white/[0.02] text-white/70 border-white/15 hover:border-white/30 hover:bg-white/[0.06]'
                }`}
              >
                {loc.shortName}
              </button>
            );
          })}
        </div>

        {/* Поиск */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-white/40 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по меню..."
            className="w-full bg-white/[0.02] border border-white/15 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/40 transition-colors"
          />
        </div>

        {error && (
          <div className="p-4 rounded-xl border border-red-500/20 bg-red-950/40 flex items-center justify-between gap-2">
            <span className="text-xs text-red-300/90">{error}</span>
            <button
              onClick={() => fetchProducts(location)}
              className="shrink-0 flex items-center space-x-1 text-[10px] font-mono uppercase text-white bg-red-500/10 px-2.5 py-1.5 rounded-lg border border-red-500/20 hover:bg-red-500/20 transition-all cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Обновить</span>
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 text-white/40 animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {filtered.map((p) => {
                const isPending = pendingIds.includes(p.id);
                return (
                  <motion.div
                    key={p.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-white/15 bg-white/[0.02]"
                  >
                    <div className="min-w-0 flex-1">
                      <h4 className="font-display font-semibold text-sm text-white uppercase leading-tight break-words">
                        {p.name}
                        {p.variant && (
                          <span className="text-xs text-white/50 lowercase font-sans font-normal ml-1.5">
                            ({p.variant})
                          </span>
                        )}
                      </h4>
                      <span className="text-xs font-mono text-white/50 mt-0.5 block">{p.price} ₽</span>
                    </div>

                    <div className="flex items-center space-x-2 shrink-0">
                      <button
                        onClick={() => handleAdjust(p, -1)}
                        disabled={isPending || p.count <= 0}
                        className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 transition-all flex items-center justify-center text-white active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className={`w-10 text-center font-mono font-bold text-base ${p.count > 0 ? 'text-white' : 'text-white/30'}`}>
                        {p.count}
                      </span>
                      <button
                        onClick={() => handleAdjust(p, 1)}
                        disabled={isPending}
                        className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 transition-all flex items-center justify-center text-white active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {filtered.length === 0 && (
              <p className="text-center text-xs text-white/40 py-8">Ничего не найдено</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

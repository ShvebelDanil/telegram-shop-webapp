import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, X, Loader2, Plus, Check } from 'lucide-react';
import { buildIdentityParams, triggerHaptic } from '../tg';



interface RecommendedProduct {
  id: number;
  name: string;
  type: string;
  variant: string | null;
  count: number;
  price: number;
  original_price?: number;
  url: string | null;
  location?: string | null;
}

// Цифры ответов складываются в tag товара (см. DEMO_MENU в handlers/shop_dp.py).
const TASTE_OPTIONS = [
  { digit: '1', label: '☕ Классика' },
  { digit: '2', label: '🥛 Молочный' },
  { digit: '3', label: '🍯 Сладкий' },
];
const STRENGTH_OPTIONS = [
  { digit: '1', label: 'Мягкий' },
  { digit: '2', label: 'Средний' },
  { digit: '3', label: 'Бодрящий' },
];
const PRICE_OPTIONS = [
  { digit: '1', label: 'До 250 ₽' },
  { digit: '2', label: 'Не важно' },
];

interface RecommendModalProps {
  location: string;
  onAdd: (product: RecommendedProduct) => void;
  onClose: () => void;
}

/** Квиз «Подобрать напиток»: три вопроса → до трёх позиций из наличия точки,
 * которые можно сразу добавить в корзину. */
export default function RecommendModal({ location, onAdd, onClose }: RecommendModalProps) {
  const [taste, setTaste] = useState<string | null>(null);
  const [strength, setStrength] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RecommendedProduct[] | null>(null);
  const [addedIds, setAddedIds] = useState<number[]>([]);

  const pickPrice = async (priceDigit: string) => {
    if (!taste || !strength) return;
    triggerHaptic('medium');
    setLoading(true);
    const tag = `${taste}${strength}${priceDigit}`;
    try {
      const params = buildIdentityParams();
      params.set('tag', tag);
      params.set('location', location);
      const res = await fetch(`/api/recommend?${params.toString()}`);
      const data = await res.json();
      setResults(res.ok ? data : []);
    } catch (err) {
      console.error(err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = (p: RecommendedProduct) => {
    triggerHaptic('light');
    onAdd(p);
    setAddedIds(prev => [...prev, p.id]);
  };

  const step = results !== null ? 4 : strength ? 3 : taste ? 2 : 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.85 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-[#060606]/95 backdrop-blur-xl cursor-pointer"
      />
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative w-full max-w-sm p-6 rounded-2xl border border-white/15 bg-[#0d0d0d] space-y-5 shadow-[0_0_50px_rgba(255,255,255,0.05)]"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 text-white">
            <Sparkles className="w-4 h-4" />
            <h3 className="text-sm font-display font-medium uppercase tracking-widest">Подобрать напиток</h3>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div key="taste" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2">
              <p className="text-xs font-sans text-white/60">Какой кофе вы любите?</p>
              {TASTE_OPTIONS.map(opt => (
                <button
                  key={opt.digit}
                  onClick={() => { triggerHaptic('light'); setTaste(opt.digit); }}
                  className="w-full py-3 rounded-xl bg-white/[0.04] text-white border border-white/15 text-xs font-display uppercase tracking-wide hover:bg-white/[0.08] transition-all cursor-pointer"
                >
                  {opt.label}
                </button>
              ))}
            </motion.div>
          )}

          {step === 2 && (
            <motion.div key="strength" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2">
              <p className="text-xs font-sans text-white/60">Отлично! Насколько крепкий?</p>
              {STRENGTH_OPTIONS.map(opt => (
                <button
                  key={opt.digit}
                  onClick={() => { triggerHaptic('light'); setStrength(opt.digit); }}
                  className="w-full py-3 rounded-xl bg-white/[0.04] text-white border border-white/15 text-xs font-display uppercase tracking-wide hover:bg-white/[0.08] transition-all cursor-pointer"
                >
                  {opt.label}
                </button>
              ))}
            </motion.div>
          )}

          {step === 3 && (
            <motion.div key="price" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2">
              <p className="text-xs font-sans text-white/60">И последнее — бюджет</p>
              {loading ? (
                <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 text-white/50 animate-spin" /></div>
              ) : (
                PRICE_OPTIONS.map(opt => (
                  <button
                    key={opt.digit}
                    onClick={() => pickPrice(opt.digit)}
                    className="w-full py-3 rounded-xl bg-white/[0.04] text-white border border-white/15 text-xs font-display uppercase tracking-wide hover:bg-white/[0.08] transition-all cursor-pointer"
                  >
                    {opt.label}
                  </button>
                ))
              )}
            </motion.div>
          )}

          {step === 4 && (
            <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2">
              {results && results.length > 0 ? (
                <>
                  <p className="text-xs font-sans text-white/60">✨ Вот что подобрали по вашему запросу:</p>
                  {results.map((p) => {
                    const isAdded = addedIds.includes(p.id);
                    return (
                      <div key={p.id} className="p-3 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-xs text-white block truncate">
                            {p.name}{p.variant ? ` · ${p.variant}` : ''}
                          </span>
                          <span className="text-xs font-mono text-white/70">{p.price} ₽</span>
                        </div>
                        <button
                          onClick={() => handleAdd(p)}
                          disabled={isAdded}
                          className={`shrink-0 flex items-center space-x-1 px-3 py-2 rounded-lg text-[10px] font-mono uppercase tracking-wide transition-all cursor-pointer ${
                            isAdded
                              ? 'bg-emerald-500/20 text-emerald-300 cursor-default'
                              : 'bg-white text-black hover:bg-gray-100 active:scale-95'
                          }`}
                        >
                          {isAdded ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                          <span>{isAdded ? 'В корзине' : 'В корзину'}</span>
                        </button>
                      </div>
                    );
                  })}
                </>
              ) : (
                <p className="text-xs font-sans text-white/60 text-center py-4">
                  Эх, прямо сейчас такой комбинации нет в наличии. 😔<br />Попробуйте выбрать другие критерии.
                </p>
              )}
              <button
                onClick={() => { setTaste(null); setStrength(null); setResults(null); setAddedIds([]); }}
                className="w-full py-3 rounded-xl bg-white text-black font-display font-medium text-xs tracking-wide uppercase hover:bg-gray-100 transition-all cursor-pointer"
              >
                Начать заново
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

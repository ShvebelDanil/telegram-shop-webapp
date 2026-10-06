import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CreditCard,
  RefreshCw,
  AlertCircle,
  ShoppingBag,
  Truck,
  Wrench,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  X,
  ChevronLeft
} from 'lucide-react';
import { buildIdentityParams, getPluralRussian, getUserId, identityBody, triggerHaptic } from '../tg';

interface PendingOrderItem {
  name: string;
  variant: string | null;
  quantity: number;
  price: number;
  sum: number;
}

interface PendingOrder {
  items: PendingOrderItem[];
  total_price: number;
  delivery_cost: number;
  service_fee: number;
  full_price: number;
  pay_url: string;
}

/**
 * Экран оплаты картой: состав заказа + сумма к переводу и статичная ссылка СБП
 * (PAY_LINK в .env) — сумму в неё не подставить, клиент переводит сам ровно
 * столько, сколько указано на экране. После перехода по ссылке разблокируется
 * «Я оплатил» — одноразовая кнопка, которая шлёт заказ в группу менеджеров.
 */
export default function PaymentGate({ onBack }: { onBack?: () => void } = {}) {
  const [order, setOrder] = useState<PendingOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasOpenedPayLink, setHasOpenedPayLink] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const fetchOrder = async () => {
    setLoading(true);
    try {
      const userId = getUserId();
      if (!userId) {
        throw new Error('Не удалось определить пользователя — откройте приложение из бота');
      }

      const params = buildIdentityParams();
      const res = await fetch(`/api/pending-order/${userId}?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'Заказ не найден или уже обработан');
      }
      setOrder(await res.json());
      setError(null);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Не удалось загрузить заказ');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrder();
    if (window.Telegram?.WebApp) {
      try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
      } catch {
        /* SDK уже инициализирован — не критично */
      }
    }
  }, []);

  const handleOpenPayLink = () => {
    if (!order?.pay_url) return;
    triggerHaptic('medium');
    // openLink открывает страницу оплаты во внешнем браузере — так требует Telegram
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(order.pay_url);
    } else {
      window.open(order.pay_url, '_blank');
    }
    setHasOpenedPayLink(true);
  };

  const handleConfirmPaid = async () => {
    if (!hasOpenedPayLink || confirming || done) return;
    const userId = getUserId();
    if (!userId) return;

    setConfirming(true);
    setConfirmError(null);
    triggerHaptic('heavy');

    try {
      const res = await fetch(`/api/confirm-card-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          ...identityBody(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'Не получилось отправить подтверждение, попробуйте ещё раз');
      }
      setDone(true);
    } catch (err: any) {
      console.error(err);
      setConfirmError(err.message || 'Не получилось отправить подтверждение');
      setConfirming(false);
    }
  };

  const handleClose = () => {
    triggerHaptic('light');
    if (window.Telegram?.WebApp?.close) {
      window.Telegram.WebApp.close();
    }
  };

  if (loading) {
    return (
      <motion.div
        key="payment-loading"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[60vh] text-center px-2"
      >
        <Loader2 className="w-6 h-6 text-white/40 animate-spin" />
        <span className="mt-3 text-xs font-mono text-white/50 uppercase tracking-widest">Загружаем ваш заказ...</span>
      </motion.div>
    );
  }

  if (error || !order) {
    return (
      <motion.div
        key="payment-error"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[60vh] px-2"
      >
        <div className="w-full max-w-sm p-7 rounded-2xl border border-red-500/20 bg-red-950/40 backdrop-blur-lg text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-4" />
          <p className="font-display font-semibold text-sm uppercase tracking-widest text-red-200">Заказ не найден</p>
          <p className="mt-2 text-xs font-sans text-red-300/80 leading-relaxed">{error}</p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              onClick={() => {
                triggerHaptic('light');
                fetchOrder();
              }}
              className="inline-flex items-center space-x-1.5 text-xs bg-red-500/10 text-white font-mono px-4 py-2 rounded-lg border border-red-500/20 hover:bg-red-500/20 transition-all cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Обновить</span>
            </button>
            {onBack && (
              <button
                onClick={() => { triggerHaptic('light'); onBack(); }}
                className="inline-flex items-center space-x-1.5 text-xs bg-white/10 text-white font-mono px-4 py-2 rounded-lg border border-white/20 hover:bg-white/20 transition-all cursor-pointer"
              >
                <ChevronLeft className="w-3 h-3" />
                <span>В каталог</span>
              </button>
            )}
          </div>
        </div>
      </motion.div>
    );
  }

  if (done) {
    return (
      <motion.div
        key="payment-done"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[60vh] px-2"
      >
        <div className="w-full max-w-sm p-7 rounded-2xl border border-emerald-500/20 bg-emerald-950/30 backdrop-blur-lg text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-4" />
          <p className="font-display font-semibold text-sm uppercase tracking-widest text-emerald-200">Спасибо за заказ!</p>
          <p className="mt-2 text-xs font-sans text-emerald-100/80 leading-relaxed">
            Вскоре с вами свяжется менеджер для уточнения деталей.
          </p>
          <button
            onClick={handleClose}
            className="mt-5 inline-flex items-center space-x-1.5 text-xs bg-white/10 text-white font-mono px-4 py-2 rounded-lg border border-white/20 hover:bg-white/20 transition-all cursor-pointer"
          >
            <X className="w-3 h-3" />
            <span>Закрыть</span>
          </button>
        </div>
      </motion.div>
    );
  }

  const isDelivery = order.delivery_cost > 0;
  const itemsCount = order.items.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <motion.div
      key="payment-gate"
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center px-2 pb-10"
    >
      <div className="w-full max-w-sm space-y-4">
        {onBack && (
          <button
            onClick={() => { triggerHaptic('light'); onBack(); }}
            className="flex items-center space-x-1 text-[11px] font-mono uppercase tracking-widest text-white/50 hover:text-white/80 transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>В каталог</span>
          </button>
        )}

        {/* Header */}
        <div className="p-5 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg">
          <div className="flex items-center space-x-3">
            <div className="w-11 h-11 rounded-lg bg-black/50 border border-white/15 flex items-center justify-center shrink-0 text-white/80">
              <CreditCard className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-semibold text-base tracking-wide uppercase text-white">
                Оплата заказа
              </h2>
              <p className="mt-0.5 flex items-center space-x-1.5 text-[10px] font-mono uppercase tracking-widest text-white/50">
                {isDelivery ? <Truck className="w-3 h-3" /> : <ShoppingBag className="w-3 h-3" />}
                <span>{isDelivery ? 'Доставка' : 'Самовывоз'} · {itemsCount} {getPluralRussian(itemsCount, 'товар', 'товара', 'товаров')}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Items list */}
        <div className="space-y-2.5">
          {order.items.map((item, idx) => (
            <motion.div
              key={`${item.name}-${idx}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.04, duration: 0.2 }}
              className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-white/15 bg-white/[0.02]"
            >
              <div className="flex-1 min-w-0">
                <h4 className="font-display font-semibold text-sm text-white uppercase leading-tight break-words whitespace-normal">
                  {item.name}
                  {item.variant && (
                    <span className="text-xs text-white/50 lowercase font-sans font-normal ml-1.5">
                      ({item.variant})
                    </span>
                  )}
                </h4>
                <span className="text-xs font-mono text-white/60 mt-1 block">
                  {item.price} ₽ × {item.quantity} шт
                </span>
              </div>
              <span className="font-display font-medium text-sm text-white shrink-0">{item.sum} ₽</span>
            </motion.div>
          ))}
        </div>

        {/* Price breakdown */}
        <div className="p-5 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono uppercase tracking-widest text-white/60">Товары</span>
            <span className="font-display font-medium text-white">{order.total_price} ₽</span>
          </div>

          {isDelivery && (
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center space-x-1.5 font-mono uppercase tracking-widest text-white/60">
                <Truck className="w-3 h-3" />
                <span>Доставка</span>
              </span>
              <span className="font-display font-medium text-white">{order.delivery_cost} ₽</span>
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center space-x-1.5 font-mono uppercase tracking-widest text-white/60">
              <Wrench className="w-3 h-3" />
              <span>Работа сервиса</span>
            </span>
            <span className="font-display font-medium text-white">{order.service_fee} ₽</span>
          </div>

          <div className="border-t border-white/10 pt-3 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-white/60">Сумма к переводу</span>
            <span className="text-2xl font-light font-display text-white">{order.full_price} ₽</span>
          </div>
        </div>

        {/* Предупреждение — ссылка не привязана к сумме, юзер переводит сам */}
        <div className="p-4 rounded-2xl border border-amber-500/25 bg-amber-950/20 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[11px] font-sans text-amber-100/90 leading-relaxed">
            При переходе по ссылке переведите <b>ровно {order.full_price} ₽</b>. Кнопку «Я оплатил»
            можно нажать только один раз — нажимайте её только после того, как перевод
            действительно отправлен. При выдаче заказа менеджер попросит показать перевод.
          </p>
        </div>

        {/* Pay link button */}
        <button
          onClick={handleOpenPayLink}
          className="w-full py-4 rounded-xl bg-white text-black font-display font-medium text-xs tracking-[0.2em] uppercase shadow-[0_6px_25px_rgba(255,255,255,0.15)] hover:bg-gray-100 transition-all text-center flex items-center justify-center space-x-2 active:scale-[0.98] cursor-pointer"
        >
          <CreditCard className="w-4 h-4" />
          <span>Перейти к переводу {order.full_price} ₽</span>
        </button>

        {/* «Я оплатил» — заблокирована, пока не открыта ссылка перевода */}
        <button
          onClick={handleConfirmPaid}
          disabled={!hasOpenedPayLink || confirming}
          className={`w-full py-4 rounded-xl font-display font-medium text-xs tracking-[0.2em] uppercase transition-all text-center flex items-center justify-center space-x-2 ${
            hasOpenedPayLink && !confirming
              ? 'bg-emerald-500 text-black hover:bg-emerald-400 active:scale-[0.98] cursor-pointer'
              : 'bg-white/10 text-white/40 cursor-not-allowed'
          }`}
        >
          {confirming ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4" />
          )}
          <span>Я оплатил</span>
        </button>

        <AnimatePresence>
          {confirmError && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center text-[11px] font-sans text-red-300/90"
            >
              {confirmError}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

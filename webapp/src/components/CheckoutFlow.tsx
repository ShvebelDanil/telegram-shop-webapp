import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Wallet,
  CreditCard,
  Truck,
  ShoppingBag,
  Wrench,
  Loader2,
  MapPin,
  Phone,
  CheckCircle2,
  AlertCircle,
  X,
  RefreshCw
} from 'lucide-react';
import { buildIdentityParams, getPluralRussian, getUserId, identityBody, triggerHaptic, triggerHapticNotification } from '../tg';

// Показывается только для оценки до отправки — реальная сумма всегда считается
// на сервере (SERVICE_FEE в handlers/routes.py).
const SERVICE_FEE_DISPLAY = 20;

interface CheckoutCartItem {
  product: {
    id: number;
    name: string;
    variant: string | null;
    price: number;
  };
  quantity: number;
}

interface CheckoutFlowProps {
  cart: CheckoutCartItem[];
  receiving: 'delivery' | 'pickup';
  pickupPoint: string;
  totalPrice: number;
  bonusToUse: number;
  onCardPending: () => void;
  onDone: () => void;
  onClose: () => void;
}

/**
 * Весь checkout одним экраном в вебаппе: телефон (подставляется из прошлого заказа),
 * адрес с предварительным расчётом доставки и выбор оплаты. Итоговые суммы всё равно
 * пересчитывает сервер (/api/order).
 */
export default function CheckoutFlow({
  cart, receiving, pickupPoint, totalPrice, bonusToUse, onCardPending, onDone, onClose,
}: CheckoutFlowProps) {
  const [phone, setPhone] = useState('');
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  const [address, setAddress] = useState('');
  const [deliveryPreview, setDeliveryPreview] = useState<{ distance_km: number; delivery_cost: number } | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);

  const isDelivery = receiving === 'delivery';
  const itemsCount = cart.reduce((acc, item) => acc + item.quantity, 0);

  useEffect(() => {
    const userId = getUserId();
    if (!userId) {
      setPhoneLoaded(true);
      return;
    }
    (async () => {
      try {
        const params = buildIdentityParams();
        const res = await fetch(`/api/phone/${userId}?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          if (data.phone) setPhone(data.phone);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setPhoneLoaded(true);
      }
    })();
  }, []);

  const handleCalculateDelivery = async () => {
    if (!address.trim()) return;
    triggerHaptic('light');
    setDeliveryLoading(true);
    setDeliveryError(null);
    try {
      const res = await fetch(`/api/delivery-cost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, ...identityBody() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'Не удалось рассчитать доставку');
      setDeliveryPreview(data);
    } catch (err: any) {
      console.error(err);
      setDeliveryError(err.message || 'Не удалось рассчитать доставку');
      setDeliveryPreview(null);
    } finally {
      setDeliveryLoading(false);
    }
  };

  const canSubmit = !submitting && phone.trim().length > 0 && (!isDelivery || address.trim().length > 0);

  const handleSubmit = async (paymentMethod: 'cash' | 'card') => {
    if (!canSubmit) return;
    const userId = getUserId();
    if (!userId) return;

    setSubmitting(true);
    setSubmitError(null);
    triggerHaptic('heavy');

    try {
      const res = await fetch(`/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Цена/название считаются на сервере из БД — шлём только id и количество.
          items: cart.map(item => ({ id: item.product.id, quantity: item.quantity })),
          ...identityBody(),
          order_type: receiving,
          location: receiving === 'pickup' ? pickupPoint : null,
          bonus_to_use: bonusToUse,
          phone,
          address: isDelivery ? address : undefined,
          payment_method: paymentMethod,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'Не удалось оформить заказ');

      if (data.status === 'card_pending') {
        triggerHapticNotification('success');
        onCardPending();
        return;
      }

      triggerHapticNotification('success');
      setOrderNumber(data.order_number ?? null);
    } catch (err: any) {
      console.error(err);
      triggerHapticNotification('error');
      setSubmitError(err.message || 'Не удалось оформить заказ');
      setSubmitting(false);
    }
  };

  if (orderNumber !== null) {
    return (
      <motion.div
        key="checkout-done"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[60vh] px-2"
      >
        <div className="w-full max-w-sm p-7 rounded-2xl border border-emerald-500/20 bg-emerald-950/30 backdrop-blur-lg text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-4" />
          <p className="font-display font-semibold text-sm uppercase tracking-widest text-emerald-200">Заказ принят!</p>
          <p className="mt-2 text-xs font-sans text-emerald-100/80 leading-relaxed">
            Номер заказа: <span className="font-mono font-bold text-emerald-100">{orderNumber}</span><br />
            Менеджер скоро свяжется с вами.
          </p>
          <button
            onClick={() => { triggerHaptic('light'); onDone(); }}
            className="mt-5 inline-flex items-center space-x-1.5 text-xs bg-white/10 text-white font-mono px-4 py-2 rounded-lg border border-white/20 hover:bg-white/20 transition-all cursor-pointer"
          >
            <X className="w-3 h-3" />
            <span>Закрыть</span>
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      key="checkout-flow"
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center px-2 pb-10"
    >
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-1.5 text-[10px] font-mono uppercase tracking-widest text-white/50">
            {isDelivery ? <Truck className="w-3 h-3" /> : <ShoppingBag className="w-3 h-3" />}
            <span>{isDelivery ? 'Доставка' : 'Самовывоз'} · {itemsCount} {getPluralRussian(itemsCount, 'товар', 'товара', 'товаров')}</span>
          </div>
          <button
            onClick={() => { triggerHaptic('light'); onClose(); }}
            className="text-white/40 hover:text-white/70 transition-colors p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Телефон */}
        <div className="p-4 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg space-y-2">
          <label className="flex items-center space-x-1.5 text-[10px] font-mono uppercase tracking-widest text-white/60">
            <Phone className="w-3 h-3" />
            <span>Телефон</span>
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 999 111 22 33"
            disabled={!phoneLoaded}
            className="w-full bg-white/[0.02] border border-white/15 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/40 transition-colors"
          />
        </div>

        {/* Адрес (только доставка) */}
        {isDelivery && (
          <div className="p-4 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg space-y-2">
            <label className="flex items-center space-x-1.5 text-[10px] font-mono uppercase tracking-widest text-white/60">
              <MapPin className="w-3 h-3" />
              <span>Адрес доставки</span>
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => { setAddress(e.target.value); setDeliveryPreview(null); }}
              placeholder="ул. Пушкина, дом 10"
              className="w-full bg-white/[0.02] border border-white/15 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/40 transition-colors"
            />
            <button
              onClick={handleCalculateDelivery}
              disabled={!address.trim() || deliveryLoading}
              className="w-full py-2.5 rounded-lg bg-white/10 text-white text-xs font-mono uppercase tracking-wide hover:bg-white/20 transition-all disabled:opacity-40 cursor-pointer flex items-center justify-center space-x-1.5"
            >
              {deliveryLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>Рассчитать доставку</span>
            </button>
            {deliveryError && (
              <p className="text-[11px] text-red-300/90 font-sans">{deliveryError}</p>
            )}
            {deliveryPreview && (
              <p className="text-[11px] text-white/60 font-sans">
                {deliveryPreview.distance_km} км · примерно {deliveryPreview.delivery_cost} ₽
              </p>
            )}
          </div>
        )}

        {/* Сводка */}
        <div className="p-5 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono uppercase tracking-widest text-white/60">Товары</span>
            <span className="font-display font-medium text-white">{totalPrice} ₽</span>
          </div>
          {isDelivery && (
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center space-x-1.5 font-mono uppercase tracking-widest text-white/60">
                <Truck className="w-3 h-3" />
                <span>Доставка</span>
              </span>
              <span className="font-display font-medium text-white">
                {deliveryPreview ? `${deliveryPreview.delivery_cost} ₽` : 'рассчитается при оформлении'}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center space-x-1.5 font-mono uppercase tracking-widest text-white/60">
              <Wrench className="w-3 h-3" />
              <span>Работа сервиса</span>
            </span>
            <span className="font-display font-medium text-white">{SERVICE_FEE_DISPLAY} ₽</span>
          </div>
          <div className="border-t border-white/10 pt-3 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-white/60">Примерно к оплате</span>
            <span className="text-2xl font-light font-display text-white">
              {totalPrice + (deliveryPreview?.delivery_cost ?? 0) + SERVICE_FEE_DISPLAY} ₽
            </span>
          </div>
        </div>

        {/* Способ оплаты */}
        <div className="grid grid-cols-2 gap-2.5">
          <button
            onClick={() => handleSubmit('cash')}
            disabled={!canSubmit}
            className="py-4 rounded-xl bg-white text-black font-display font-medium text-xs tracking-[0.15em] uppercase hover:bg-gray-100 transition-all flex items-center justify-center space-x-2 active:scale-[0.98] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
            <span>Наличными</span>
          </button>
          <button
            onClick={() => handleSubmit('card')}
            disabled={!canSubmit}
            className="py-4 rounded-xl bg-white/10 text-white border border-white/20 font-display font-medium text-xs tracking-[0.15em] uppercase hover:bg-white/20 transition-all flex items-center justify-center space-x-2 active:scale-[0.98] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
            <span>Картой</span>
          </button>
        </div>

        {submitError && (
          <p className="flex items-center justify-center space-x-1.5 text-center text-[11px] font-sans text-red-300/90">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{submitError}</span>
          </p>
        )}
      </div>
    </motion.div>
  );
}

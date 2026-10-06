import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ShoppingCart,
  ChevronLeft,
  Plus,
  Minus,
  Trash2,
  Search,
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  X,
  Package,
  ChevronDown,
  ChevronUp,
  MapPin,
  Truck,
  ShoppingBag,
  Gift,
  Clock,
  Sparkles
} from 'lucide-react';
import TopoBackground from './components/TopoBackground';
import PaymentGate from './components/PaymentGate';
import CheckoutFlow from './components/CheckoutFlow';
import RecommendModal from './components/RecommendModal';
import AdminStock from './components/AdminStock';
import { buildIdentityParams, getPluralRussian, getUserId, triggerHaptic, triggerHapticNotification } from './tg';
import {
  CATEGORIES, DELIVERY_NOTE, DELIVERY_POINT, LOGO_URL, PICKUP_POINTS, SHOP_NAME, WORKING_HOURS,
  type Category, type PickupPointId,
} from './shop';

type ReceivingType = 'delivery' | 'pickup';

interface Product {
  id: number;
  name: string;
  type: string;
  variant: string | null;
  count: number;
  price: number;
  originalPrice?: number;
  url: string | null;
  location?: string | null;
}

interface GroupedProduct {
  name: string;
  type: string;
  url: string;
  minPrice: number;
  maxPrice: number;
  variants: Product[];
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface BonusInfo {
  bonus_balance: number;
}

// Отдельный режим для админов (кнопка «Управление наличием» в /admin,
// ?admin=1 в ссылке) — своя мини-вьюшка, минуя выбор доставки.
// Реальная защита — на бэке (_require_admin), это просто вход.
const ADMIN_MODE = new URLSearchParams(window.location.search).get('admin') === '1';

// Бонусная программа: бэкенд и база готовы (users.bonus_balance, /api/bonus),
// UI спрятан за флагом — включается одной строкой.
const BONUS_FEATURE_ENABLED = false;

// --- ORDER TYPE GATE (delivery / pickup) -------------------------------
// Пользователь сначала выбирает способ получения заказа, и только потом
// ему открывается меню (у точек разное наличие).
function ReceivingGate({ onSelect }: { onSelect: (type: ReceivingType) => void }) {
  const options: Array<{
    type: ReceivingType;
    title: string;
    icon: React.ReactNode;
  }> = [
    { type: 'delivery', title: 'Доставка', icon: <Truck className="w-6 h-6" /> },
    { type: 'pickup', title: 'Самовывоз', icon: <ShoppingBag className="w-6 h-6" /> }
  ];

  return (
    <motion.div
      key="receiving-gate"
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col items-center justify-center min-h-[80vh] text-center px-2"
    >
      <motion.div
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.35 }}
        className="relative w-full max-w-sm p-7 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg shadow-[0_0_50px_rgba(255,255,255,0.05)]"
      >
        <div className="w-16 h-16 rounded-full bg-white/5 border border-white/15 text-white flex items-center justify-center mx-auto mb-6">
          <MapPin className="w-8 h-8" />
        </div>

        <h2 className="font-display font-semibold text-lg tracking-[0.15em] uppercase text-white">
          Как получите заказ?
        </h2>

        <p className="mt-4 text-xs font-sans text-white/60 leading-relaxed">
          Выберите способ получения: от этого зависит каталог
          и наличие товаров в магазине.
        </p>

        <div className="mt-7 space-y-2.5">
          {options.map((opt) => (
            <button
              key={opt.type}
              onClick={() => {
                triggerHaptic('medium');
                onSelect(opt.type);
              }}
              className="w-full p-4 rounded-xl bg-white/[0.02] border border-white/10 hover:border-white/30 hover:bg-white/[0.06] transition-all text-center active:scale-[0.98] cursor-pointer group"
            >
              <div className="flex items-center space-x-3.5">
                <div className="w-11 h-11 rounded-lg bg-black/50 border border-white/15 flex items-center justify-center shrink-0 text-white/80 group-hover:text-white transition-colors">
                  {opt.icon}
                </div>
                <div className="text-left">
                  <p className="font-display font-medium text-sm tracking-[0.12em] uppercase text-white">
                    {opt.title}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function App() {
  // --- Receiving method state (delivery / pickup) ---
  // null = тип заказа ещё не выбран: показываем гейт выбора перед входом в магазин.
  // Выбор сохраняется в sessionStorage (в рамках сессии).
  const [receiving, setReceiving] = useState<ReceivingType | null>(() => {
    try {
      const saved = sessionStorage.getItem('shop_receiving');
      return saved === 'delivery' || saved === 'pickup' ? saved : null;
    } catch {
      return null;
    }
  });
  const [pickupPoint, setPickupPoint] = useState<PickupPointId>(() => {
    try {
      const saved = sessionStorage.getItem('shop_pickup_point');
      return PICKUP_POINTS.find(p => p.id === saved)?.id ?? PICKUP_POINTS[0].id;
    } catch {
      return PICKUP_POINTS[0].id;
    }
  });

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoursOpen, setHoursOpen] = useState(false);

  // Navigation & Filtering
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Variant Selection State (key is product name, value is selected product variant ID)
  const [selectedVariants, setSelectedVariants] = useState<Record<string, number>>({});

  // Track expanded products for variant selection shutter
  const [expandedProducts, setExpandedProducts] = useState<Record<string, boolean>>({});

  const toggleProductExpansion = (name: string) => {
    triggerHaptic('light');
    setExpandedProducts(prev => ({
      ...prev,
      [name]: !prev[name]
    }));
  };

  // Cart State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  // Checkout: весь флоу (телефон/адрес/способ оплаты) — отдельный экран в вебаппе,
  // cardPending переключает на уже готовый PaymentGate после выбора оплаты картой.
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cardPending, setCardPending] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  // Бонусная система: баланс юзера (1 бонус = 1 ₽) и сколько он решил списать сейчас.
  const [bonusBalance, setBonusBalance] = useState(0);
  const [bonusToUse, setBonusToUse] = useState(0);

  // Telegram User info
  const [tgUser, setTgUser] = useState<{ first_name?: string } | null>(null);

  // Products belong to a specific point (unique DB rows per location),
  // so when the point or receiving method changes we drop foreign items from the cart.
  const switchReceiving = (nextType: ReceivingType, nextPoint: PickupPointId = pickupPoint) => {
    const nextLocation = nextType === 'pickup' ? nextPoint : DELIVERY_POINT;
    try {
      sessionStorage.setItem('shop_receiving', nextType);
      sessionStorage.setItem('shop_pickup_point', nextPoint);
    } catch {
      /* private mode — выбор просто не сохранится между сессиями */
    }
    setReceiving(nextType);
    setPickupPoint(nextPoint);
    setCart(prevCart => prevCart.filter(item => item.product.location === nextLocation));
  };

  // Активная точка, наличие которой показываем (объявлена ДО fetchProducts и эффектов):
  // доставка — всегда DELIVERY_POINT (выбора точек нет), самовывоз — выбранная вкладка.
  const activeLocation: PickupPointId | null =
    receiving === null
      ? null
      : receiving === 'delivery' ? DELIVERY_POINT : pickupPoint;

  // Каталог тянем строго с эндпоинта активной точки (/api/products/<точка>) —
  // товары приходят уже отфильтрованными по точке на сервере.
  const fetchProducts = async () => {
    if (!activeLocation) return; // тип заказа ещё не выбран — каталог скрыт гейтом
    try {
      setLoading(true);
      const params = buildIdentityParams();
      const res = await fetch(`/api/products/${activeLocation}?${params.toString()}`);
      if (res.status === 403) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'Ошибка при загрузке каталога');
      }
      if (!res.ok) throw new Error('Ошибка при загрузке каталога');
      // Бэкенд уже отдаёт уценённую price + original_price (если акция активна, см.
      // DISCOUNT_PERCENT в .env) —
      // фронт ничего не досчитывает, только маппит snake_case в camelCase.
      const raw: (Product & { original_price?: number })[] = await res.json();
      const data: Product[] = raw.map(({ original_price, ...p }) => ({
        ...p,
        originalPrice: original_price,
      }));
      setProducts(data);

      // Auto-select first variant for each product name group
      const initialVariants: Record<string, number> = {};
      // Ключ группы — «локация:название»: один и тот же товар лежит
      // в БД отдельными строками под каждую точку, ключи не должны пересекаться
      const groupedByName: Record<string, Product[]> = {};

      data.forEach(p => {
        const key = `${p.location ?? 'unknown'}:${p.name}`;
        if (!groupedByName[key]) {
          groupedByName[key] = [];
        }
        groupedByName[key].push(p);
      });

      Object.entries(groupedByName).forEach(([key, list]) => {
        // Prefer in-stock variant if possible
        const inStock = list.find(v => v.count > 0);
        initialVariants[key] = inStock ? inStock.id : list[0].id;
      });
      setSelectedVariants(initialVariants);
      setError(null);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Не удалось подключиться к серверу базы данных');
    } finally {
      setLoading(false);
    }
  };

  const fetchBonusBalance = async () => {
    const bonusUserId = getUserId();
    if (!BONUS_FEATURE_ENABLED || !bonusUserId) {
      setBonusBalance(0);
      setBonusToUse(0);
      return;
    }
    try {
      const initData = window.Telegram?.WebApp?.initData ?? '';
      const res = await fetch(`/api/bonus/${bonusUserId}?init_data=${encodeURIComponent(initData)}`);
      if (!res.ok) return;
      const data: BonusInfo = await res.json();
      const nextBalance = data.bonus_balance ?? 0;
      setBonusBalance(nextBalance);
      setBonusToUse(prev => Math.min(prev, nextBalance));
    } catch {
      /* ignore network errors for bonus widget */
    }
  };

  useEffect(() => {
    fetchProducts();
    fetchBonusBalance();

    // Initialize Telegram WebApp
    if (window.Telegram?.WebApp) {
      try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();

        // Retrieve real TG user info
        const user = window.Telegram.WebApp.initDataUnsafe?.user;
        if (user) {
          setTgUser(user);
        }
      } catch (err) {
        console.error('Telegram WebApp SDK Error:', err);
      }
    }
  }, [activeLocation]);

  // Sync cart quantities with current database stock
  const getVariantStock = (variantId: number): number => {
    const found = products.find(p => p.id === variantId);
    return found ? found.count : 0;
  };

  // Cart operations
  const addToCart = (product: Product) => {
    triggerHaptic('light');

    // Check if item is already in cart
    const existing = cart.find(item => item.product.id === product.id);
    const currentQty = existing ? existing.quantity : 0;

    if (currentQty >= product.count) {
      alert(`Невозможно добавить больше! Доступно в наличии всего: ${product.count} шт.`);
      triggerHapticNotification('warning');
      return;
    }

    if (existing) {
      setCart(cart.map(item =>
        item.product.id === product.id
          ? { ...item, quantity: item.quantity + 1 }
          : item
      ));
    } else {
      setCart([...cart, { product, quantity: 1 }]);
    }
  };

  const updateCartQuantity = (variantId: number, delta: number) => {
    triggerHaptic('light');
    const existing = cart.find(item => item.product.id === variantId);
    if (!existing) return;

    const newQty = existing.quantity + delta;
    const maxStock = getVariantStock(variantId);

    if (newQty > maxStock) {
      alert(`Недостаточно товара на складе! Доступно: ${maxStock} шт.`);
      triggerHapticNotification('warning');
      return;
    }

    if (newQty <= 0) {
      // Remove item
      setCart(cart.filter(item => item.product.id !== variantId));
    } else {
      setCart(cart.map(item =>
        item.product.id === variantId
          ? { ...item, quantity: newQty }
          : item
      ));
    }
  };

  const removeFromCart = (variantId: number) => {
    triggerHaptic('medium');
    setCart(cart.filter(item => item.product.id !== variantId));
  };

  // Товары приходят с сервера уже отфильтрованными по точке
  // (/api/products/{location}) — клиентская фильтрация по location не нужна.
  const activeProducts = products;

  // Grouped and filtered products calculation
  const getFilteredGroupedProducts = (): GroupedProduct[] => {
    // 1. Filter raw products by active category, location and search queries
    let filtered = activeProducts;
    if (selectedCategory) {
      filtered = filtered.filter(p => p.type === selectedCategory.id);
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.variant && p.variant.toLowerCase().includes(q))
      );
    }

    // 2. Group by Name
    const groups: Record<string, Product[]> = {};
    filtered.forEach(p => {
      if (!groups[p.name]) {
        groups[p.name] = [];
      }
      groups[p.name].push(p);
    });

    // 3. Convert to list of GroupedProduct
    return Object.entries(groups).map(([name, list]) => {
      const prices = list.map(item => item.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);

      // Use variant URL or category fallback
      const validUrl = list.find(v => v.url)?.url || selectedCategory?.imgUrl || LOGO_URL;

      return {
        name,
        type: list[0].type,
        url: validUrl,
        minPrice,
        maxPrice,
        variants: list
      };
    });
  };

  const groupedProductsList = getFilteredGroupedProducts();

  // Cart helper calculations
  const cartItemCount = cart.reduce((acc, item) => acc + item.quantity, 0);
  const cartTotal = cart.reduce((acc, item) => acc + (item.product.price * item.quantity), 0);

  // Бонусы (1 бонус = 1 ₽) покрывают только стоимость товаров в корзине —
  // доставку и сервисный сбор юзер платит отдельно в боте.
  const maxBonusApplicable = Math.min(bonusBalance, cartTotal);
  const totalToPay = Math.max(cartTotal - bonusToUse, 0);

  // Акцию целиком считает бэкенд: если цены пришли с original_price — показываем баннер.
  const discountSample = products.find(p => p.originalPrice);
  const discountPercent = discountSample?.originalPrice
    ? Math.round((1 - discountSample.price / discountSample.originalPrice) * 100)
    : 0;


  // Бонусы не могут списать больше, чем стоит корзина: при любом изменении
  // состава корзины/баланса обрезаем лишнее (корзина подорожала — ничего не трогаем).
  useEffect(() => {
    setBonusToUse(prev => Math.min(prev, maxBonusApplicable));
  }, [cartTotal, bonusBalance]);

  // Админ-режим — отдельный самостоятельный экран, без выбора
  // доставки/каталога покупателя. Хуки выше уже отработали (ADMIN_MODE не меняется
  // в рамках жизни компонента), просто дальше не рендерим обычный магазин.
  if (ADMIN_MODE) {
    return <AdminStock />;
  }

  return (
    <div className="relative w-full min-h-screen text-white select-none overflow-x-hidden font-sans pb-24">
      {/* 1. Animated Topographic Canvas Background */}
      <TopoBackground />

      {/* Main Container */}
      <div className="relative z-10 w-full max-w-lg mx-auto px-4 pt-8">

        {/* Header Branding */}
        <header className="flex flex-col items-center mb-10">
          <div className="flex items-center space-x-2 mt-4 cursor-pointer" onClick={() => { setSelectedCategory(null); triggerHaptic('light'); }}>
            <img
              src={LOGO_URL}
              alt={SHOP_NAME}
              className="w-32 h-32 object-contain filter drop-shadow-[0_0_15px_rgba(255,255,255,0.15)] hover:scale-105 transition-transform duration-300"
            />
          </div>

          {/* Скидочный баннер: только после выбора получения — до этого товаров ещё не видно */}
          {!cardPending && !checkoutOpen && receiving && discountPercent > 0 && (
            <div className="text-center mt-3">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.15em] uppercase text-white bg-white/10 border border-white/30 px-3.5 py-1.5 rounded-full shadow-[0_0_14px_rgba(255,255,255,0.12)]">
                Скидка −{discountPercent}% на всё меню
              </span>
            </div>
          )}
        </header>

        {/* 0. MODE SWITCH: card-payment / checkout screens replace the whole shop flow */}
        <AnimatePresence mode="wait">
          {cardPending ? (
            <React.Fragment key="payment">
              <PaymentGate onBack={() => setCardPending(false)} />
            </React.Fragment>
          ) : checkoutOpen ? (
            <React.Fragment key="checkout">
              <CheckoutFlow
                cart={cart}
                receiving={receiving ?? 'delivery'}
                pickupPoint={pickupPoint}
                totalPrice={cartTotal}
                bonusToUse={bonusToUse}
                onCardPending={() => { setCardPending(true); setCheckoutOpen(false); }}
                onDone={() => {
                  setCheckoutOpen(false);
                  setCart([]);
                  setBonusToUse(0);
                  fetchBonusBalance();
                }}
                onClose={() => setCheckoutOpen(false)}
              />
            </React.Fragment>
          ) : !receiving ? (
            <React.Fragment key="receiving-gate">
              <ReceivingGate onSelect={(type) => switchReceiving(type)} />
            </React.Fragment>
          ) : (
          <React.Fragment key="shop">
        {/* Database Error Warning */}
        {error && (
          <div className="mb-6 bg-red-950/40 border border-red-500/20 rounded-xl p-4 flex items-start space-x-3 backdrop-blur-lg">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-red-200">Ошибка подключения</p>
              <p className="text-red-300/80 text-xs mt-1">{error}</p>
              <button
                onClick={fetchProducts}
                className="mt-2 text-xs bg-red-500/10 text-white font-mono px-3 py-1 rounded border border-red-500/20 hover:bg-red-500/20 transition-all flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Попробовать снова</span>
              </button>
            </div>
          </div>
        )}

        {/* Catalog Content Switcher */}
        <main className="w-full">
          <AnimatePresence mode="wait">
            {!selectedCategory ? (
              // --- SCREEN 1: CATEGORY DIRECTORY GRID ---
              <motion.div
                key="categories-grid"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.25 }}
                className="space-y-5"
              >
                <div className="flex justify-between items-end border-b border-white/15 pb-2.5 px-1">
                  <h2 className="text-xs font-mono text-white/60 tracking-[0.15em] uppercase">
                    Меню
                  </h2>
                  {BONUS_FEATURE_ENABLED && bonusBalance > 0 && (
                    <div className="flex items-center space-x-1.5 text-emerald-400">
                      <Gift className="w-3 h-3" />
                      <span className="text-[10px] font-mono uppercase tracking-widest">
                        {bonusBalance} {getPluralRussian(bonusBalance, 'бонус', 'бонуса', 'бонусов')}
                      </span>
                    </div>
                  )}
                </div>

                {/* Переключатель способа получения: доставка / самовывоз */}
                <div className="grid grid-cols-2 gap-2.5">
                  {(['delivery', 'pickup'] as ReceivingType[]).map((type) => {
                    const isActive = receiving === type;

                    return (
                      <button
                        key={type}
                        onClick={() => {
                          if (isActive) return;
                          triggerHaptic('medium');
                          switchReceiving(type);
                        }}
                        className={`flex items-center justify-center space-x-2 p-3.5 rounded-xl border transition-all cursor-pointer active:scale-[0.98] ${
                          isActive
                            ? 'bg-white text-black border-white shadow-[0_4px_15px_rgba(255,255,255,0.15)]'
                            : 'bg-white/[0.02] text-white/70 border-white/15 hover:border-white/30 hover:bg-white/[0.06]'
                        }`}
                      >
                        {type === 'delivery'
                          ? <Truck className="w-4 h-4 shrink-0" />
                          : <ShoppingBag className="w-4 h-4 shrink-0" />}
                        <span className="text-xs font-display font-medium uppercase tracking-wide text-center leading-tight">
                          {type === 'delivery' ? 'Доставка' : 'Самовывоз'}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {receiving === 'delivery' && (
                  <p className="text-[10px] text-white/45 font-sans -mt-1.5 px-1">
                    {DELIVERY_NOTE}
                  </p>
                )}

                {/* Самовывоз: выбор точки выдачи */}
                {receiving === 'pickup' && (
                  <div className="grid grid-cols-2 gap-2.5">
                    {PICKUP_POINTS.map((point) => {
                      const isActive = pickupPoint === point.id;

                      return (
                        <button
                          key={point.id}
                          onClick={() => {
                            if (pickupPoint === point.id) return;
                            triggerHaptic('medium');
                            switchReceiving('pickup', point.id);
                          }}
                          className={`flex items-center justify-center space-x-2 p-3.5 rounded-xl border transition-all cursor-pointer active:scale-[0.98] ${
                            isActive
                              ? 'bg-white text-black border-white shadow-[0_4px_15px_rgba(255,255,255,0.15)]'
                              : 'bg-white/[0.02] text-white/70 border-white/15 hover:border-white/30 hover:bg-white/[0.06]'
                          }`}
                        >
                          <MapPin className="w-4 h-4 shrink-0" />
                          <span className="text-xs font-display font-medium uppercase tracking-wide text-center leading-tight">
                            {point.shortName}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Часы работы — раскрывающийся график для активной точки */}
                <div className="rounded-xl border border-white/15 bg-white/[0.02] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { triggerHaptic('light'); setHoursOpen(v => !v); }}
                    className="w-full flex items-center justify-between gap-2 px-3.5 py-3 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2 text-white/80">
                      <Clock className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-[11px] font-display font-medium uppercase tracking-wide">Часы работы</span>
                    </span>
                    {hoursOpen ? <ChevronUp className="w-3.5 h-3.5 text-white/50" /> : <ChevronDown className="w-3.5 h-3.5 text-white/50" />}
                  </button>
                  <AnimatePresence initial={false}>
                    {hoursOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-3.5 pb-3.5 space-y-1.5 border-t border-white/10 pt-3">
                          {activeLocation && WORKING_HOURS[activeLocation] ? (
                            WORKING_HOURS[activeLocation]!.map(({ day, hours }) => (
                              <div key={day} className="flex items-center justify-between text-[11px] font-mono">
                                <span className="text-white/50 uppercase">{day}</span>
                                <span className="text-white/80">{hours}</span>
                              </div>
                            ))
                          ) : (
                            <p className="text-[11px] font-sans text-white/60">Уточняйте у менеджера</p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Квиз «Подобрать напиток» */}
                <button
                  type="button"
                  onClick={() => { triggerHaptic('light'); setRecommendOpen(true); }}
                  className="w-full flex items-center justify-center space-x-2 px-3.5 py-3 rounded-xl border border-white/15 bg-white/[0.02] text-white/80 hover:bg-white/[0.06] transition-all cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[11px] font-display font-medium uppercase tracking-wide">Подобрать напиток</span>
                </button>

                <div className="grid grid-cols-1 gap-4">
                  {CATEGORIES.map((cat, idx) => {
                    // Позиции категории в активной точке — варианты одного товара считаем один раз
                    const catCount = new Set(activeProducts.filter(p => p.type === cat.id).map(p => p.name)).size;

                    return (
                      <motion.button
                        key={cat.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.05, duration: 0.25 }}
                        onClick={() => {
                          triggerHaptic('medium');
                          setSelectedCategory(cat);
                          setSearchQuery('');
                        }}
                        className="group relative flex items-center justify-between p-4.5 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-md hover:border-white/30 hover:bg-white/[0.06] transition-all text-left overflow-hidden cursor-pointer"
                      >
                        {/* Soft Hover Glow */}
                        <div className="absolute inset-0 bg-white/[0.01] group-hover:bg-white/[0.03] transition-all duration-300" />

                        <div className="flex items-center space-x-4 relative z-10 pointer-events-none">
                          {/* Image container with gloss */}
                          <div className="relative w-20 h-20 rounded-lg bg-black/50 border border-white/15 overflow-hidden shrink-0 flex items-center justify-center p-1">
                            <img
                              src={cat.imgUrl}
                              alt={cat.russianName}
                              className="w-full h-full object-contain filter group-hover:scale-110 transition-transform duration-500"
                              referrerPolicy="no-referrer"
                            />
                          </div>

                          <div>
                            <h3 className="font-display font-medium text-base tracking-wide text-white group-hover:text-shadow-editorial transition-all uppercase">
                              {cat.russianName}
                            </h3>
                          </div>
                        </div>

                        {/* Badge with variant count */}
                        <div className="relative z-10 shrink-0 font-mono text-[9px] bg-white/5 border border-white/15 rounded-full px-2.5 py-1 text-white/60 uppercase tracking-widest group-hover:text-white group-hover:border-white/30 transition-all pointer-events-none">
                          {loading ? '...' : `${catCount} ${getPluralRussian(catCount, 'позиция', 'позиции', 'позиций')}`}
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            ) : (
              // --- SCREEN 2: PRODUCT LIST VIEW ---
              <motion.div
                key="products-view"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.25 }}
                className="space-y-5"
              >
                {/* Sticky Back Navigation Bar */}
                <div className="sticky top-0 z-30 flex items-center justify-between bg-[#0c0c0c]/95 backdrop-blur-md py-3.5 -mx-4 px-4 border-b border-white/10 shadow-lg mb-2">
                  <button
                    onClick={() => {
                      triggerHaptic('medium');
                      setSelectedCategory(null);
                    }}
                    className="flex items-center space-x-1.5 font-mono text-[10px] text-white/80 hover:text-white hover:bg-white/10 transition-colors cursor-pointer bg-white/[0.08] border border-white/15 rounded-md px-3.5 py-2 uppercase tracking-wider"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Назад в каталог</span>
                  </button>

                  <div className="text-right">
                    <span className="text-sm font-display font-semibold text-white tracking-wide uppercase">{selectedCategory.russianName}</span>
                  </div>
                </div>

                {/* Banner Header inside Category */}
                <div className="relative rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-lg overflow-hidden p-5 flex items-center space-x-5">
                  <div className="w-24 h-24 rounded-xl bg-black/60 border border-white/15 p-1.5 flex items-center justify-center shrink-0">
                    <img
                      src={selectedCategory.imgUrl}
                      alt={selectedCategory.russianName}
                      className="w-full h-full object-contain filter drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)]"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-xl font-display font-semibold tracking-wide text-white uppercase">{selectedCategory.russianName}</h2>
                    {/* Point context inside category */}
                    <p className="mt-1.5 flex items-center space-x-1.5 text-[10px] font-mono uppercase tracking-widest text-white/50">
                      {receiving === 'pickup' ? <ShoppingBag className="w-3 h-3" /> : <Truck className="w-3 h-3" />}
                      <span>
                        {receiving === 'pickup'
                          ? `Самовывоз · ${PICKUP_POINTS.find(p => p.id === pickupPoint)?.name}`
                          : `Доставка · ${PICKUP_POINTS.find(p => p.id === DELIVERY_POINT)?.name}`}
                      </span>
                    </p>
                  </div>
                </div>


                {/* Live Search Input */}
                <div className="relative">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Поиск по меню..."
                    className="w-full pl-10 pr-10 py-3 bg-black/60 border border-white/15 rounded-xl text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/30 transition-colors backdrop-blur-md font-sans"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full bg-white/10 text-white/60 hover:text-white transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Product Cards Container */}
                {loading ? (
                  <div className="flex flex-col items-center justify-center py-16 space-y-3">
                    <RefreshCw className="w-6 h-6 text-white/40 animate-spin" />
                    <span className="text-xs font-mono text-white/50 uppercase tracking-widest">Загрузка меню...</span>
                  </div>
                ) : groupedProductsList.length === 0 ? (
                  <div className="text-center py-16 bg-white/[0.02] border border-white/15 rounded-2xl backdrop-blur-md">
                    <Package className="w-8 h-8 text-white/30 mx-auto mb-3" />
                    <p className="text-sm font-display uppercase tracking-wider text-white/60">Ничего не найдено</p>
                    <p className="text-xs text-white/40 mt-1 font-sans">Попробуйте изменить поисковый запрос</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {groupedProductsList.map((grouped, groupIdx) => {
                      // Ключ вариантного состояния — с учётом активной точки,
                      // чтобы выбранный вариант не «перетекал» между точками
                      const variantKey = `${activeLocation}:${grouped.name}`;
                      const activeVariantId = selectedVariants[variantKey];
                      const activeVariant = grouped.variants.find(v => v.id === activeVariantId)
                        ?? grouped.variants.find(v => v.count > 0)
                        ?? grouped.variants[0];
                      const totalLinesStock = (grouped.variants || []).reduce((sum, v) => sum + (v.count || 0), 0);
                      const cartEntry = cart.find(item => item.product.id === activeVariant.id);
                      const cartQuantity = cartEntry ? cartEntry.quantity : 0;
                      const isExpanded = !!expandedProducts[variantKey];

                      return (
                        <motion.div
                          key={`${receiving}-${pickupPoint}-${grouped.name}`}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: Math.min(groupIdx * 0.04, 0.3), duration: 0.2 }}
                          className="relative p-5 rounded-2xl border border-white/15 bg-white/[0.03] backdrop-blur-md flex flex-col space-y-3 overflow-hidden"
                        >
                          {/* Clickable Header for "Shutter" (Collapsible accordion) */}
                          <div
                            onClick={() => toggleProductExpansion(variantKey)}
                            className="flex items-start justify-between cursor-pointer group/header select-none"
                          >
                            <div className="flex items-start space-x-4 flex-1 min-w-0">
                              {/* Product Image */}
                              <div className="w-24 h-24 rounded-lg bg-black/50 border border-white/15 p-1.5 shrink-0 flex items-center justify-center">
                                <img
                                  src={grouped.url}
                                  alt={grouped.name}
                                  className="w-full h-full object-contain filter drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)] group-hover/header:scale-105 transition-transform duration-300"
                                  referrerPolicy="no-referrer"
                                />
                              </div>

                              {/* Product Info */}
                              <div className="flex-1 min-w-0">
                                <h3 className="font-display font-semibold text-sm xs:text-base text-white tracking-wide leading-tight break-words whitespace-normal uppercase group-hover/header:text-white/90 transition-colors">
                                  {grouped.name}
                                </h3>

                                {/* Price Tag */}
                                <div className="mt-1.5 flex items-baseline space-x-2">
                                  {activeVariant.originalPrice && (
                                    <span className="text-xs font-mono text-white/40 line-through">
                                      {activeVariant.originalPrice} ₽
                                    </span>
                                  )}
                                  <span className="text-xl font-display font-light text-white">
                                    {activeVariant.price} ₽
                                  </span>
                                  {grouped.variants.length > 1 && (
                                    <span className="text-[9px] font-mono text-white/60 bg-white/5 px-2.5 py-0.5 rounded-full border border-white/15 uppercase tracking-widest">
                                      {grouped.variants.length} {getPluralRussian(grouped.variants.length, 'вариант', 'варианта', 'вариантов')}
                                    </span>
                                  )}
                                </div>

                                {/* Availability Badge */}
                                <div className="mt-1.5 flex items-center">
                                  {totalLinesStock > 0 ? (
                                    <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded-md border border-emerald-500/15">
                                      В наличии: {totalLinesStock} шт
                                    </span>
                                  ) : (
                                    <span className="text-[9px] font-mono uppercase tracking-wider text-white/45 bg-white/5 px-2.5 py-0.5 rounded-md border border-white/10 line-through">
                                      Нет в наличии
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Chevron Toggle Button */}
                            <div className="self-center pl-2 shrink-0">
                              <div className={`w-8 h-8 rounded-full border border-white/10 flex items-center justify-center transition-all ${
                                isExpanded
                                  ? 'bg-white text-black border-white shadow-[0_0_12px_rgba(255,255,255,0.2)]'
                                  : 'bg-white/5 text-white/50 group-hover/header:text-white group-hover/header:bg-white/10'
                              }`}>
                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              </div>
                            </div>
                          </div>

                          {/* Shutter (Collapsible Body) */}
                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0, marginTop: 0 }}
                                animate={{ height: 'auto', opacity: 1, marginTop: 12 }}
                                exit={{ height: 0, opacity: 0, marginTop: 0 }}
                                transition={{ duration: 0.2, ease: 'easeInOut' }}
                                className="overflow-hidden"
                              >
                                <div className="space-y-4 pt-3 border-t border-white/10">
                                  {/* Variant Options Selection (Pills) */}
                                  {(grouped.variants.length > 1 || (grouped.variants[0] && grouped.variants[0].variant)) && (
                                    <div className="flex flex-wrap gap-2">
                                      {grouped.variants.map((v) => {
                                        const isSelected = v.id === activeVariantId;
                                        const isOutOfStock = v.count === 0;

                                        return (
                                          <button
                                            key={v.id}
                                            onClick={() => {
                                              triggerHaptic('light');
                                              setSelectedVariants({
                                                ...selectedVariants,
                                                [variantKey]: v.id
                                              });
                                            }}
                                            className={`relative px-3 py-1.5 rounded-lg text-xs transition-all flex items-center space-x-1.5 border cursor-pointer font-sans ${
                                              isSelected
                                                ? 'bg-white text-black border-white font-medium shadow-[0_4px_12px_rgba(255,255,255,0.15)]'
                                                : isOutOfStock
                                                ? 'bg-white/[0.01] text-white/30 border-white/5 line-through opacity-45'
                                                : 'bg-white/[0.04] text-white/80 border-white/15 hover:border-white/30 hover:bg-white/[0.08]'
                                            }`}
                                          >
                                            <span>{v.variant}</span>
                                            <span className={`text-[9px] font-mono rounded-md px-1.5 py-0.5 ${
                                              isSelected
                                                ? 'bg-black/10 text-black font-bold'
                                                : isOutOfStock
                                                ? 'bg-white/5 text-white/20'
                                                : 'bg-white/10 text-white/50'
                                            }`}>
                                              {isOutOfStock ? 'нет' : `${v.count}`}
                                            </span>
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}

                                  {/* Purchase Controls / Add to Cart */}
                                  <div className="flex items-center justify-between">
                                    {activeVariant.count > 0 ? (
                                      cartQuantity > 0 ? (
                                        // Quantity selector if in cart
                                        <div className="flex items-center space-x-1.5 w-full justify-between bg-white/[0.02] border border-white/15 rounded-xl p-1.5">
                                          <span className="text-[10px] text-white/50 font-mono ml-2 uppercase tracking-wider">В корзине: {cartQuantity} шт</span>
                                          <div className="flex items-center space-x-1">
                                            <button
                                              onClick={() => updateCartQuantity(activeVariant.id, -1)}
                                              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 transition-all flex items-center justify-center text-white active:scale-90"
                                            >
                                              <Minus className="w-3.5 h-3.5" />
                                            </button>
                                            <span className="w-8 text-center font-mono font-bold text-sm text-white">{cartQuantity}</span>
                                            <button
                                              onClick={() => updateCartQuantity(activeVariant.id, 1)}
                                              disabled={cartQuantity >= activeVariant.count}
                                              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 transition-all flex items-center justify-center text-white active:scale-90 disabled:opacity-30"
                                            >
                                              <Plus className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        // Direct Buy Button
                                        <button
                                          onClick={() => addToCart(activeVariant)}
                                          className="w-full py-3.5 px-4 rounded-xl bg-white text-black font-display font-medium text-xs tracking-[0.15em] uppercase hover:bg-gray-100 transition-all text-center flex items-center justify-center space-x-2 active:scale-[0.99] cursor-pointer"
                                        >
                                          <span>Добавить в корзину</span>
                                          <span className="text-xs font-mono font-bold border-l border-black/15 pl-2 ml-1">{activeVariant.price} ₽</span>
                                        </button>
                                      )
                                    ) : (
                                      // Disabled Out Of Stock
                                      <button
                                        disabled
                                        className="w-full py-3.5 px-4 rounded-xl bg-white/[0.02] text-white/30 border border-white/10 font-display font-medium text-xs tracking-[0.15em] uppercase text-center"
                                      >
                                        Нет в наличии
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
          </React.Fragment>
          )}
        </AnimatePresence>
      </div>

      {/* 2. PERSISTENT FIXED FOOTER CART TRIGGER BAR — скрыт во время checkout/оплаты,
          юзер и так уже внутри корзины/checkout-флоу, повторная кнопка не нужна */}
      <AnimatePresence>
        {cartItemCount > 0 && !isCartOpen && !checkoutOpen && !cardPending && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-6 inset-x-4 z-40 max-w-lg mx-auto"
          >
            <button
              onClick={() => {
                triggerHaptic('medium');
                setIsCartOpen(true);
              }}
              className="w-full p-4.5 rounded-2xl bg-white text-black font-display font-medium flex items-center justify-between shadow-[0_15px_35px_rgba(0,0,0,0.6),0_0_30px_rgba(255,255,255,0.15)] hover:bg-gray-100 transition-all cursor-pointer transform hover:-translate-y-0.5 active:scale-98"
            >
              <div className="flex items-center space-x-3.5">
                <div className="relative bg-black text-white p-2.5 rounded-xl shrink-0 border border-white/10">
                  <ShoppingCart className="w-4 h-4" />
                  <span className="absolute -top-1.5 -right-1.5 bg-black text-white border border-white/30 font-mono text-[9px] font-bold w-4.5 h-4.5 rounded-full flex items-center justify-center">
                    {cartItemCount}
                  </span>
                </div>
                <div className="text-left leading-tight">
                  <span className="text-[9px] font-mono text-black/50 block uppercase tracking-[0.15em]">Открыть корзину</span>
                  <span className="text-sm font-semibold uppercase tracking-wide text-black">
                    {cartItemCount} {getPluralRussian(cartItemCount, 'товар', 'товара', 'товаров')} в заказе
                  </span>
                </div>
              </div>

              <div className="text-right flex items-center space-x-4">
                <div className="leading-tight">
                  <span className="text-[9px] font-mono text-black/50 block uppercase tracking-[0.15em]">Сумма заказа</span>
                  <span className="text-base font-black font-display">{cartTotal} ₽</span>
                </div>
              </div>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3. CART SYSTEM SLIDING OVERLAY PANEL */}
      <AnimatePresence>
        {isCartOpen && (
          <div className="fixed inset-0 z-50 overflow-hidden">
            {/* Dark glass backdrop backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.7 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsCartOpen(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md cursor-pointer"
            />

            {/* Sliding Container */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: '0%' }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 220 }}
              className="absolute bottom-0 inset-x-0 bg-[#0c0c0c] border-t border-white/15 rounded-t-[2rem] max-h-[85vh] flex flex-col max-w-lg mx-auto"
            >
              {/* Header drag indicator and title */}
              <div className="p-6 pb-4 border-b border-white/15 flex items-center justify-between shrink-0">
                <div className="flex items-center space-x-2.5">
                  <ShoppingCart className="w-4 h-4 text-white/60" />
                  <h3 className="text-base font-display font-medium uppercase tracking-wider text-white">Корзина</h3>
                  <span className="font-mono text-[9px] bg-white/5 px-2.5 py-0.5 rounded-md border border-white/15 text-white/50 uppercase tracking-wider">
                    {cartItemCount} {getPluralRussian(cartItemCount, 'позиция', 'позиции', 'позиций')}
                  </span>
                </div>
                <button
                  onClick={() => setIsCartOpen(false)}
                  className="w-8 h-8 rounded-full bg-white/5 text-white/60 hover:text-white flex items-center justify-center border border-white/15 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Items List (Scrollable) */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {cart.length === 0 ? (
                  <div className="text-center py-16">
                    <ShoppingCart className="w-12 h-12 text-white/20 mx-auto mb-3" />
                    <p className="text-sm font-display uppercase tracking-wider text-white/60">Ваша корзина пуста</p>
                    <p className="text-xs text-white/40 mt-1 font-sans">Добавьте товары из категорий выше</p>
                  </div>
                ) : (
                  cart.map((item, idx) => {
                    const maxStock = getVariantStock(item.product.id);

                    return (
                      <div
                        key={item.product.id}
                        className="flex items-center justify-between p-3.5 rounded-xl border border-white/15 bg-white/[0.02]"
                      >
                        {/* Image of Category */}
                        <div className="w-12 h-12 rounded-lg bg-black/40 border border-white/15 p-0.5 shrink-0 flex items-center justify-center mr-3">
                          <img
                            src={item.product.url || LOGO_URL}
                            alt={item.product.name}
                            className="w-full h-full object-contain filter drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
                            referrerPolicy="no-referrer"
                          />
                        </div>

                        {/* Text detail */}
                        <div className="flex-1 min-w-0 mr-2">
                          <h4 className="font-display font-semibold text-sm text-white break-words whitespace-normal uppercase">
                            {item.product.name}
                            {item.product.variant && (
                              <span className="text-xs text-white/50 lowercase font-sans font-normal ml-1.5 block xs:inline">
                                ({item.product.variant})
                              </span>
                            )}
                          </h4>
                          <span className="text-xs font-mono font-bold text-white/80 mt-1 block">
                            {item.product.originalPrice && (
                              <span className="text-white/40 line-through font-normal mr-1">
                                {item.product.originalPrice} ₽
                              </span>
                            )}
                            {item.product.price} ₽ / шт
                          </span>
                        </div>

                        {/* Controls */}
                        <div className="flex flex-col items-end shrink-0 space-y-2">
                          {/* Delete Bin Icon */}
                          <button
                            onClick={() => removeFromCart(item.product.id)}
                            className="text-white/40 hover:text-red-400 transition-colors p-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>

                          {/* Minus/Plus counter */}
                          <div className="flex items-center space-x-1 border border-white/15 bg-white/[0.01] p-1 rounded-lg">
                            <button
                              onClick={() => updateCartQuantity(item.product.id, -1)}
                              className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
                            >
                              <Minus className="w-2.5 h-2.5" />
                            </button>
                            <span className="w-6 text-center font-mono font-bold text-xs text-white">{item.quantity}</span>
                            <button
                              onClick={() => updateCartQuantity(item.product.id, 1)}
                              disabled={item.quantity >= maxStock}
                              className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center text-white disabled:opacity-30"
                            >
                              <Plus className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Order total & CTA Checkout Button */}
              <div className="p-6 border-t border-white/15 bg-[#0a0a0a] shrink-0 space-y-4">
                {/* Списание бонусов: одна строка с кнопками ±50/max, 1 бонус = 1 ₽.
                    Показываем всегда — при нулевом балансе юзер хотя бы знает, что бонусы существуют. */}
                {BONUS_FEATURE_ENABLED && cart.length > 0 && (
                  <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition-all ${
                    bonusToUse > 0
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : 'border-white/15 bg-white/[0.02]'
                  }`}>
                    <div className="flex items-center space-x-1.5 min-w-0">
                      <Gift className={`w-3.5 h-3.5 shrink-0 ${bonusToUse > 0 ? 'text-emerald-400' : 'text-white/70'}`} />
                      <span className="text-[10px] font-display font-medium uppercase tracking-wider text-white whitespace-nowrap">
                        Бонусы: <span className="text-emerald-400">{bonusBalance}</span>
                      </span>
                    </div>

                    <div className="flex items-center space-x-1 shrink-0">
                      {bonusToUse > 0 && (
                        <>
                          <span className="text-xs font-display font-semibold text-emerald-400 mr-0.5">
                            −{bonusToUse} ₽
                          </span>
                          <button
                            type="button"
                            onClick={() => { triggerHaptic('light'); setBonusToUse(0); }}
                            className="w-5 h-6 flex items-center justify-center rounded-md text-[10px] font-mono text-white/40 hover:text-white transition-colors"
                          >
                            ✕
                          </button>
                        </>
                      )}
                      {bonusBalance > 0 ? (
                        <>
                          <button
                            type="button"
                            onClick={() => { triggerHaptic('light'); setBonusToUse(v => Math.max(v - 50, 0)); }}
                            className="h-6 px-1.5 rounded-md bg-white/5 border border-white/15 text-[10px] font-mono text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            −50
                          </button>
                          <button
                            type="button"
                            onClick={() => { triggerHaptic('light'); setBonusToUse(v => Math.min(v + 50, maxBonusApplicable)); }}
                            className="h-6 px-1.5 rounded-md bg-white/5 border border-white/15 text-[10px] font-mono text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            +50
                          </button>
                          <button
                            type="button"
                            onClick={() => { triggerHaptic('light'); setBonusToUse(maxBonusApplicable); }}
                            className="h-6 px-1.5 rounded-md bg-white/5 border border-white/15 text-[10px] font-mono text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            max
                          </button>
                        </>
                      ) : (
                        <span className="text-[9px] font-mono text-white/35 whitespace-nowrap">
                          появятся после заказов
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex justify-between items-center px-1">
                  <div>
                    <span className="text-[10px] font-mono text-white/50 block uppercase tracking-widest">ИТОГ К ОПЛАТЕ:</span>
                    <span className="text-[10px] text-white/40 font-mono mt-0.5 block">Доставка и сервис рассчитываются в боте</span>
                  </div>
                  <div className="text-right">
                    {bonusToUse > 0 && (
                      <span className="text-xs font-mono text-white/40 line-through block">{cartTotal} ₽</span>
                    )}
                    <span className="text-2xl font-light font-display text-white">{totalToPay} ₽</span>
                  </div>
                </div>

                {cart.length > 0 ? (
                  <button
                    onClick={() => { triggerHaptic('heavy'); setIsCartOpen(false); setCheckoutOpen(true); }}
                    className="w-full py-4 rounded-xl bg-white text-black font-display font-medium text-xs tracking-[0.2em] uppercase shadow-[0_6px_25px_rgba(255,255,255,0.15)] hover:bg-gray-100 transition-all text-center flex items-center justify-center space-x-2 active:scale-98 cursor-pointer"
                  >
                    <span>Оформить {receiving === 'pickup' ? 'самовывоз' : 'доставку'}</span>
                  </button>
                ) : (
                  <button
                    disabled
                    className="w-full py-4 rounded-xl bg-white/[0.02] text-white/30 border border-white/10 font-display font-medium text-xs tracking-[0.2em] uppercase text-center"
                  >
                    Добавьте товары
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Квиз «Подобрать напиток» — модал поверх всего, независимо от экрана каталога/корзины */}
      <AnimatePresence>
        {recommendOpen && activeLocation && (
          <RecommendModal
            location={activeLocation}
            onAdd={(product) => addToCart(product)}
            onClose={() => setRecommendOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

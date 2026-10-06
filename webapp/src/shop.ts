// Настройки конкретного магазина: название, точки, часы работы, категории меню.
// Ключи точек и категорий должны совпадать с бэкендом: LOCATION_NAMES, DELIVERY_LOCATION
// и shop.type в handlers/shop_dp.py.

export const SHOP_NAME = 'Зерно';

export type PickupPointId = 'park' | 'center';

export interface PickupPoint {
  id: PickupPointId;
  name: string;
  shortName: string;
}

export const PICKUP_POINTS: PickupPoint[] = [
  { id: 'park', name: 'Кофейня в парке', shortName: 'В парке' },
  { id: 'center', name: 'Кофейня в центре', shortName: 'В центре' },
];

// Доставка всегда едет с этой точки — её меню и показываем при выборе доставки.
export const DELIVERY_POINT: PickupPointId = 'center';
export const DELIVERY_NOTE = 'Доставка от 150 ₽';

// null — точных часов нет, показываем «уточняйте у менеджера».
export const WORKING_HOURS: Record<PickupPointId, { day: string; hours: string }[] | null> = {
  park: [
    { day: 'Пн–Пт', hours: '08:00–21:00' },
    { day: 'Сб–Вс', hours: '09:00–22:00' },
  ],
  center: [
    { day: 'Пн–Пт', hours: '07:30–22:00' },
    { day: 'Сб–Вс', hours: '09:00–23:00' },
  ],
};

export interface Category {
  id: string;
  russianName: string;
  imgUrl: string;
}

export const CATEGORIES: Category[] = [
  { id: 'coffee', russianName: 'Кофе', imgUrl: '/img/coffee.svg' },
  { id: 'tea', russianName: 'Чай и не кофе', imgUrl: '/img/tea.svg' },
  { id: 'dessert', russianName: 'Десерты', imgUrl: '/img/dessert.svg' },
  { id: 'beans', russianName: 'Зерно домой', imgUrl: '/img/beans.svg' },
];

export const LOGO_URL = '/img/logo.svg';

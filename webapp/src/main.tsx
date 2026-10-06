import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Вне Telegram (обычный браузер) initData пустой — магазин не показываем вовсе,
// даже если в URL есть подписанный ?uid=&sig= (пересланная ссылка).
const insideTelegram = Boolean(window.Telegram?.WebApp?.initData);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {insideTelegram ? (
      <App />
    ) : (
      <div className="min-h-screen flex items-center justify-center px-4 text-center text-red-300 font-sans">
        Не удалось загрузить данные
      </div>
    )}
  </StrictMode>,
);

import type { Metadata } from "next";
import "./globals.css";
import "./tropnik-system.css";
import "./gotham.css";
import "./terrain.css";
import "./map-design.css";
import "./place-stories.css";
import "./event-categories.css";
import "./map-polish.css";
import "./interface-refresh.css";
import "./map-ui-release.css";
import "./final-polish.css";
import "./map-sheet.css";
import "./map-detail.css";
import '@fontsource/manrope/cyrillic-400.css';
import '@fontsource/manrope/cyrillic-500.css';
import '@fontsource/manrope/cyrillic-600.css';
import '@fontsource/manrope/cyrillic-700.css';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import {ServiceWorker} from '@/components/ServiceWorker';
import {getOrigin,isPublicIndexingEnabled} from '@/lib/content';

export const metadata: Metadata = {
  title: {default:'Тропник — маршруты и походы с гидом по России',template:'%s · Тропник'},
  description: 'Изучайте тропы России, проверяйте условия маршрута и готовьтесь к походу с гидом. Карта, справочные маршруты и сохранение данных офлайн.',
  metadataBase: new URL(getOrigin()),
  robots: {index:isPublicIndexingEnabled(),follow:true},
  manifest:'/manifest.webmanifest',
  openGraph:{type:'website',locale:'ru_RU',siteName:'Тропник',title:'Тропник — найдите свой следующий маршрут',description:'Маршруты по России. Походы с гидом. Люди, которым по пути.',images:[{url:'/og-cover.png',width:1200,height:630}]},
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body><a className="skip-link" href="#main">Перейти к содержимому</a>{children}<ServiceWorker/></body>
    </html>
  );
}

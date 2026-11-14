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
import "./seo-content.css";
import "./final-polish.css";
import "./map-sheet.css";
import "./map-detail.css";
import "./map-direction-marker.css";
import "./custom-map.css";
import '@fontsource/manrope/cyrillic-400.css';
import '@fontsource/manrope/cyrillic-500.css';
import '@fontsource/manrope/cyrillic-600.css';
import '@fontsource/manrope/cyrillic-700.css';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import {ServiceWorker} from '@/components/ServiceWorker';
import {getOrigin} from '@/lib/content';
import {BRAND} from '@/lib/brand';
import {homeSeo} from '@/lib/seo';
import {getSeoContext} from '@/lib/seo-metadata';

const home = homeSeo(getSeoContext());

export const metadata: Metadata = {
  title: {default: home.title, template: `%s · ${BRAND.name}`},
  description: home.description,
  metadataBase: new URL(getOrigin()),
  // Public catalogue pages opt in through their shared SEO model.
  robots: {index:false,follow:true},
  manifest:'/manifest.webmanifest',
  openGraph:{type:'website',locale:'ru_RU',siteName:BRAND.name,title:home.title,description:home.description,images:[{url:home.image,width:1200,height:630,alt:BRAND.name}]},
  twitter:{card:'summary_large_image',title:home.title,description:home.description,images:[home.image]},
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/icon-192.png",
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

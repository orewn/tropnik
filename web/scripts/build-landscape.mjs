import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {Script} from 'node:vm';
const root=path.resolve(import.meta.dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const grid=JSON.parse(read('public/terrain/terrain-grid.json'));
const route=JSON.parse(read('public/data/routes/11566519.geojson'));
const renderer=ts.transpileModule(read('public/terrain/terrain-renderer.js').replace(/^export (?=(?:async function|function|class|const|let)\b)/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.None}}).outputText;
const bootstrap=ts.transpileModule(read('scripts/landscape-bootstrap.js'),{compilerOptions:{target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.None}}).outputText;
new Script(renderer+'\n'+bootstrap, {filename:'terrain-standalone.js'});
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const css=read('scripts/landscape-shell.css');
const spacing=grid.sampleSpacingApproxM;
const gridDescription=`Сетка ${grid.width}×${grid.height} точек, шаг около ${Math.round(spacing.eastWest)}×${Math.round(spacing.northSouth)} м. Номинальный шаг источника 30 м; это не заявленная точность измерений.`;
const fonts=[400,600].flatMap(weight=>['latin','cyrillic'].map(subset=>{
 const data=fs.readFileSync(path.join(root,`node_modules/@fontsource/manrope/files/manrope-${subset}-${weight}-normal.woff2`)).toString('base64');
 return `@font-face{font-family:Manrope;font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${subset==='cyrillic'?'U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116':'U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2191,U+2193'}}`;
})).join('');
const svg=p=>`<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${p}"/></svg>`;
const html=`<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>Тропник · Бзерпинский ландшафт</title><style>${fonts}
${css}
</style></head><body><canvas id="terrain" tabindex="0" aria-label="Трёхмерный рельеф. Перетаскивание меняет ракурс, стрелки поворачивают, плюс и минус меняют масштаб."></canvas><div class="heading"><span class="eyebrow">Западный Кавказ · Тропник</span><h1>Бзерпинский<br>ландшафт</h1><p>Высоты без преувеличения</p></div><div class="tools" aria-label="Управление ландшафтом"><button id="zoom-in" aria-label="Приблизить">${svg('M14 5v18M5 14h18')}</button><button id="zoom-out" aria-label="Отдалить">${svg('M5 14h18')}</button><hr><button id="rotate" aria-label="Повернуть">${svg('M7 8a9 9 0 1 1-2 10M3 4v7h7')}</button><button id="reset" aria-label="Исходный ракурс">${svg('M10 4H4v6m14-6h6v6M4 18v6h6m14-6v6h-6m-8-7 4-7 4 7h-8Z')}</button><hr><button id="about" aria-label="О данных" aria-expanded="false">${svg('M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0ZM13 12h2v8m-2 0h4M14 8v.01')}</button></div><div class="notice"><strong>Поворачивайте сцену. Свет следует ракурсу.</strong><p>Показана справочная геометрия источника. В сообщении от 26.10.2026 указан доступ только до карниза и закрытие лагеря Холодный. Проверяйте условия перед выходом.</p><div class="source">Геометрия маршрута <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> · Данные и лицензии — в сведениях о сцене</div></div><div id="feedback" class="scene-feedback"><div id="status" class="status" role="status">Строим рельеф…</div><button id="retry" class="scene-retry" hidden>Подготовить заново</button></div><section id="info" class="info" role="dialog" aria-modal="true" aria-label="О данных ландшафта" hidden><button class="close" id="close" aria-label="Закрыть сведения">${svg('M7 7 21 21M21 7 7 21')}</button><h2>География сцены</h2><p>Высоты взяты из цифровой модели поверхности Copernicus GLO-30 через Mapterhorn. Цвета и фактура помогают читать форму рельефа. Это условные материалы, не фотосъёмка и не сведения о текущем растительном покрове. Срез по краю обозначает границу модели, а не геологические слои.</p><ul><li>${escapeHTML(gridDescription)}</li><li>Основная съёмка 2011–2015 годов. Поверхность может включать лес и строения.</li><li>Масштаб высоты 1:1. Освещение следует камере автоматически и не показывает фактическую погоду или положение солнца.</li><li>Область 40.29–40.49° в. д., 43.64–43.82° с. ш. Сцена не предназначена для оценки лавин, препятствий и допустимости выхода.</li></ul><p>Полная нитка маршрута на карте не означает, что все её участки открыты. Официальное сообщение Кавказского заповедника от 26.10.2026:</p><small>https://www.kavkazzapoved.ru/news/s-27-oktyabrya-zakryvaetsya-chast-letnikh-turisticheskikh-marshrutov</small><small>${escapeHTML(grid.attribution)}</small><small>${escapeHTML(grid.liabilityNotice)}</small><small>Mapterhorn: https://mapterhorn.com/attribution/<br>Геометрия маршрута © OpenStreetMap contributors, ODbL 1.0. Лицензия Copernicus и сведения об источниках включены в пакет приложения.</small></section><script>
${renderer}
${bootstrap}
mountLandscape(${json(grid)},${json(route)});
</script></body></html>`;
const out=path.join(root,'public/terrain/landscape.html');fs.writeFileSync(out,html);
console.log(JSON.stringify({out,bytes:Buffer.byteLength(html),externalRequests:0,target:'ES2017',gridPoints:grid.elevations.length}));

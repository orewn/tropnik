export type PlaceFact = {
 id:string;
 regionId:string;
 place:string;
 title:string;
 body:string;
 source:string;
 sourceUrl:string;
 checkedAt:string;
 imageUrl:string;
 imageAlt:string;
 imageCredit:string;
 imageLicense:string;
 imagePosition?:string;
 routeIds?:string[];
};

// Editorially selected facts. The public card keeps the source name in Russian,
// while the URL remains internal metadata for editorial verification.
const checkedAt='2026-11-07';
const commons=(name:string)=>`https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(name)}?width=1280`;

const photos={
 altai:{imageUrl:commons('Altai Mountains, Russia - 29180202402.jpg'),imageAlt:'Горные хребты и долины Алтая',imageCredit:'Фото: Mike Norton / Wikimedia Commons',imageLicense:'CC BY 2.0',imagePosition:'50% 52%'},
 caucasus:{imageUrl:commons('Western Caucasus-118318.jpg'),imageAlt:'Горный ландшафт Западного Кавказа',imageCredit:'Фото: Guy Debonnet / Wikimedia Commons',imageLicense:'CC BY-SA 3.0 IGO',imagePosition:'50% 56%'},
 yew:{imageUrl:commons('Тисо-самшитовая роща.JPG'),imageAlt:'Зелёная тропа в Тисо-самшитовой роще',imageCredit:'Фото: JuliaBesedina / Wikimedia Commons',imageLicense:'CC BY-SA 4.0',imagePosition:'50% 58%'},
 kizhi:{imageUrl:commons('Kizhi Pogost P7110210 2200.jpg'),imageAlt:'Деревянный ансамбль Кижского погоста на острове Кижи',imageCredit:'Фото: Alexxx1979 / Wikimedia Commons',imageLicense:'CC BY-SA 4.0',imagePosition:'50% 46%'},
 karadag:{imageUrl:commons('Karadag, Crimea.jpg'),imageAlt:'Скальные хребты Карадага у Чёрного моря',imageCredit:'Фото: Вячеслав Аргенберг / Wikimedia Commons',imageLicense:'CC BY 4.0',imagePosition:'50% 52%'},
 baikal:{imageUrl:commons('Lake Baikal, Russia.jpg'),imageAlt:'Берег и прозрачная вода озера Байкал',imageCredit:'Фото: Вячеслав Аргенберг / Wikimedia Commons',imageLicense:'CC BY 4.0',imagePosition:'50% 55%'},
 kamchatka:{imageUrl:commons('Kamchatka Volcanoes (18170609638).jpg'),imageAlt:'Заснеженные вулканы Камчатки',imageCredit:'Фото: kuhnmi / Wikimedia Commons',imageLicense:'CC BY 2.0',imagePosition:'50% 48%'},
} as const;

export const placeFacts:PlaceFact[]=[
 {...photos.altai,id:'altai-zones',regionId:'altai',place:'Алтай',title:'Несколько миров на одной горе',body:'Высота меняет Алтай ступенями: тайга уступает место субальпийским и альпийским лугам, затем горной степи и высокогорной тундре.',source:'Алтайский биосферный заповедник',sourceUrl:'https://www.altzapovednik.ru/info/obshee.aspx',checkedAt},
 {...photos.altai,id:'altai-leopard',regionId:'altai',place:'Хребет Чихачёва · Алтай',title:'Снежного барса ищут фотоловушки',body:'Ирбис почти не показывается человеку. На хребте Чихачёва его изучают по автоматическим камерам, следам и повторным появлениям отдельных животных.',source:'Алтайский биосферный заповедник',sourceUrl:'https://www.altzapovednik.ru/news/2023/10/den-snejnogo-barsa.aspx',checkedAt},
 {...photos.altai,id:'altai-height',regionId:'altai',place:'Алтайский заповедник',title:'Перепад высот — больше трёх километров',body:'Территория поднимается примерно от 400 до 3500 метров. Поэтому за одну большую экспедицию здесь можно пройти через почти все природные пояса Горного Алтая.',source:'Алтайский биосферный заповедник',sourceUrl:'https://altzapovednik.ru/ekoprosveschenie/smi/prezentatsii/32.aspx',checkedAt},
 {...photos.altai,id:'altai-long-country',regionId:'altai',place:'Телецкое озеро · Алтай',title:'Заповедник длиной в целое путешествие',body:'Горы, хвойные леса, альпийские луга, тундры, реки и озёра тянутся примерно на 230 километров — ландшафт меняется задолго до конца пути.',source:'Алтайский биосферный заповедник',sourceUrl:'https://www.altzapovednik.ru/info/obshee.aspx',checkedAt},
 {...photos.yew,id:'kavkaz-yew',regionId:'krasnodar',place:'Тисо-самшитовая роща',title:'Деревья длиннее истории',body:'Отдельные тисы здесь живут многие столетия. Их медленный рост легко не заметить: молодой зелёный побег может быть частью очень старого дерева.',source:'Кавказский государственный заповедник',sourceUrl:'https://www.kavkazzapoved.ru/news/unikalnyy-i-prekrasnyy-les-kavkazskogo-zapovednika',routeIds:['kavkaz-16a','kavkaz-16b'],checkedAt},
 {...photos.caucasus,id:'kavkaz-forest',regionId:'krasnodar',place:'Западный Кавказ',title:'Лес меняется с высотой',body:'У подножий растут широколиственные леса, выше появляются бук и пихта, а у верхней границы леса деревья переходят в криволесье.',source:'Кавказский государственный заповедник',sourceUrl:'https://www.kavkazzapoved.ru/news/unikalnyy-i-prekrasnyy-les-kavkazskogo-zapovednika',checkedAt},
 {...photos.yew,id:'kavkaz-near-city',regionId:'krasnodar',place:'Хоста · Сочи',title:'Заповедный лес начинается рядом с городом',body:'До рощи легко добраться из Хосты, но внутри это уже не городской парк: грунтовые тропы, перепады высоты, влажный лес и горная река.',source:'Кавказский государственный заповедник',sourceUrl:'https://www.kavkazzapoved.ru/news/tiso-samshitovaya-roscha-kak-podgotovitsya-k-progulke-chto-vzyat-s-soboy-i-o-chyom-nuzhno-znat',routeIds:['kavkaz-16a','kavkaz-16b'],checkedAt},
 {...photos.yew,id:'kavkaz-fault',regionId:'krasnodar',place:'Каньон реки Хоста',title:'Река проходит по древнему разлому',body:'Маршрут «В глубь веков» выводит к каньону Хосты: вода прорезала известняк по линии древнего тектонического разлома.',source:'Кавказский государственный заповедник',sourceUrl:'https://www.kavkazzapoved.ru/routes/no16v-tiso-samshitovaya-roscha-v-glub-vekov',routeIds:['kavkaz-16a','kavkaz-16b'],checkedAt},
 {...photos.kizhi,id:'karelia-kizhi',regionId:'karelia',place:'Кижи · Онежское озеро',title:'Двадцать две главы',body:'Преображенскую церковь венчают 22 главы. Их размеры меняются от яруса к ярусу, поэтому деревянный объём будто движется вверх.',source:'Музей-заповедник «Кижи»',sourceUrl:'https://site.kizhi.karelia.ru/architecture/russkie-zaonezhya/tserkov-preobrazheniya-gospodnya',checkedAt},
 {...photos.kizhi,id:'karelia-island',regionId:'karelia',place:'Остров Кижи · Карелия',title:'Архитектура среди воды',body:'Кижский погост стоит на острове Онежского озера. Две деревянные церкви, колокольня и ограда складываются в единый силуэт.',source:'Музей-заповедник «Кижи»',sourceUrl:'https://site.kizhi.karelia.ru/',checkedAt},
 {...photos.kizhi,id:'karelia-1714',regionId:'karelia',place:'Кижский погост',title:'Дата сохранилась на самом храме',body:'Преображенская церковь была освящена в 1714 году. Запись об этом сохранилась на престольном кресте в алтаре.',source:'Музей-заповедник «Кижи»',sourceUrl:'https://site.kizhi.karelia.ru/info/about/newspaper/61/1122.html',checkedAt},
 {...photos.kizhi,id:'karelia-rhythm',regionId:'karelia',place:'Кижи · Заонежье',title:'Сложность, собранная из простых форм',body:'Кажущийся очень сложным храм построен из последовательно поставленных восьмериков и прирубов. Ритм глав делает конструкцию визуально лёгкой.',source:'Музей-заповедник «Кижи»',sourceUrl:'https://site.kizhi.karelia.ru/library/traditsionnaya-kultura-russkih-zaonezhya-spravochno-metodicheskoe-posobie-dlya-eksku/763.html',checkedAt},
 {...photos.karadag,id:'krym-volcano',regionId:'krym',place:'Карадаг',title:'Юрский вулкан у моря',body:'Карадаг — остатки древнего вулканического массива. Скалы сохранили следы процессов, начавшихся ещё в юрском периоде.',source:'Российская академия наук',sourceUrl:'https://www.ras.ru/news/shownews.aspx?id=332ae20f-f12a-4238-955c-b98b03ff422b',checkedAt},
 {...photos.karadag,id:'krym-reserve',regionId:'krym',place:'Карадаг',title:'Сначала лаборатория, потом заповедник',body:'Научная станция появилась здесь раньше заповедника. Её основал Терентий Вяземский, а заповедный статус территория получила в 1979 году.',source:'Российская академия наук',sourceUrl:'https://www.ras.ru/news/shownews.aspx?id=332ae20f-f12a-4238-955c-b98b03ff422b',checkedAt},
 {...photos.karadag,id:'krym-sculpture',regionId:'krym',place:'Карадаг · Чёрное море',title:'Камень выглядит как архитектура',body:'Лава, туфы, ветер и море превратили массив в гребни, башни и арки. Здесь геология читается прямо по силуэту берега.',source:'Российская академия наук',sourceUrl:'https://www.ras.ru/news/shownews.aspx?id=332ae20f-f12a-4238-955c-b98b03ff422b',checkedAt},
 {...photos.karadag,id:'krym-living-lab',regionId:'krym',place:'Карадагский заповедник',title:'Ландшафт остаётся научной площадкой',body:'Карадаг изучают не только как красивое место: вулканические породы, морская акватория и живые сообщества образуют единый природный комплекс.',source:'Российская академия наук',sourceUrl:'https://www.ras.ru/news/shownews.aspx?id=332ae20f-f12a-4238-955c-b98b03ff422b',checkedAt},
 {...photos.baikal,id:'baikal-age',regionId:'baikal',place:'Байкал',title:'Озеру около 25 миллионов лет',body:'Байкал считают самым древним озером планеты. Долгая изоляция помогла сформироваться необычному миру пресноводных организмов.',source:'Байкальский государственный заповедник',sourceUrl:'https://baikalzapovednik.ru/landscapes',checkedAt},
 {...photos.baikal,id:'baikal-water',regionId:'baikal',place:'Байкал',title:'Около пятой части озёрной пресной воды',body:'В Байкале сосредоточено около 19–20% мировых запасов озёрной пресной воды. Этот масштаб трудно почувствовать, пока не увидишь горизонт с берега.',source:'Росприроднадзор',sourceUrl:'https://rpn.gov.ru/activity/baikal/',checkedAt},
 {...photos.baikal,id:'baikal-depth',regionId:'baikal',place:'Байкал',title:'Глубина — 1642 метра',body:'Максимальная глубина Байкала достигает 1642 метров. Дно озёрной впадины лежит значительно ниже уровня Мирового океана.',source:'Байкальский государственный заповедник',sourceUrl:'https://baikalzapovednik.ru/landscapes',checkedAt},
 {...photos.baikal,id:'baikal-islands',regionId:'baikal',place:'Ольхон · Байкал',title:'Двадцать семь островов',body:'На Байкале насчитывают 27 островов. Самый крупный — Ольхон: вытянутый участок суши с собственными степями, лесами и скалистыми берегами.',source:'Росприроднадзор',sourceUrl:'https://rpn.gov.ru/activity/baikal/',checkedAt},
 {...photos.kamchatka,id:'kamchatka-worlds',regionId:'kamchatka',place:'Кроноцкий заповедник · Камчатка',title:'Почти вся Камчатка в одной территории',body:'В границах Кроноцкого заповедника встречаются почти все характерные для полуострова экосистемы — от побережья и болот до горной тундры и вулканов.',source:'Кроноцкий государственный заповедник',sourceUrl:'https://kronoki.ru/ru/kamchatka/kronotskiy-zapovednik/161.html',checkedAt},
 {...photos.kamchatka,id:'kamchatka-ice',regionId:'kamchatka',place:'Кроноцкий полуостров',title:'Сорок шесть ледников',body:'Из 414 ледников Камчатки 46 находятся в Кроноцком заповеднике. Они лежат на вулканах и образуют крупную ледниковую систему полуострова.',source:'Кроноцкий государственный заповедник',sourceUrl:'https://kronoki.ru/ru/kamchatka/kamchatka-objects/375.html',checkedAt},
 {...photos.kamchatka,id:'kamchatka-snow',regionId:'kamchatka',place:'Восточная Камчатка',title:'Снег держится до двухсот двадцати дней',body:'На юго-восточном побережье снежный покров сохраняется примерно 180–220 дней. Ветер, мокрый снег и метели здесь формируют сам характер пути.',source:'Кроноцкий государственный заповедник',sourceUrl:'https://kronoki.ru/ru/kamchatka/kronotskiy-zapovednik/161.html',checkedAt},
 {...photos.kamchatka,id:'kamchatka-low-ice',regionId:'kamchatka',place:'Кроноцкий полуостров',title:'Ледники спускаются почти к лесу',body:'Из-за обильных осадков и прохладного климата отдельные ледники опускаются до высот 300–400 метров и питают главные водоёмы заповедника.',source:'Кроноцкий государственный заповедник',sourceUrl:'https://kronoki.ru/ru/kamchatka/kronotskiy-zapovednik/161.html',checkedAt},
];

export function factsForPlace(regionId?:string,routeId?:string){
 const local=regionId?placeFacts.filter(f=>f.regionId===regionId):placeFacts;
 const specific=routeId?local.filter(f=>f.routeIds?.includes(routeId)):[];
 return specific.length>1?specific:local;
}

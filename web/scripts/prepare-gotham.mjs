import {readdir,writeFile} from 'node:fs/promises';
// Copy only web/app-licensed font files supplied by the project owner here.
const root=new URL('../public/fonts/',import.meta.url),files=await readdir(root);
const variants=[['Thin',100],['Light',300],['Regular',400],['Medium',500],['Bold',700],['Black',900]];
let css='/* Gotham Pro: licensed files when supplied; local installed faces otherwise. No synthetic bold or italic. */\n';let embedded=0;
for(const [name,weight]of variants)for(const italic of [false,true]){const basename=`GothamPro-${name}${italic?'Italic':''}`;const file=files.find(f=>f.toLowerCase()===`${basename}.woff2`.toLowerCase()||f.toLowerCase()===`${basename}.ttf`.toLowerCase());if(file)embedded++;const local=[basename,`Gotham Pro ${name}${italic?' Italic':''}`].map(n=>`local('${n}')`).join(',');css+=`@font-face{font-family:'Gotham Pro';font-style:${italic?'italic':'normal'};font-weight:${weight};font-display:swap;src:${file?`url('/fonts/${file}') format('${file.endsWith('.woff2')?'woff2':'truetype'}'),`:''}${local};}\n`;}
css+="html,body{font-family:'Gotham Pro',Manrope,system-ui,sans-serif;font-synthesis:none}\n";
await writeFile(new URL('../app/gotham.css',import.meta.url),css);
console.log(JSON.stringify({fontFamily:'Gotham Pro',embeddedVariants:embedded,localFaces:12,fallback:'Manrope',requiresSuppliedLicensedFonts:embedded===0}));

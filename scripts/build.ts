import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { portableDocument } from '../src/domain/share-format.ts';
const output = 'dist/web';
const read = (file: string) => readFile(file, 'utf8');
await mkdir(output, {
  recursive: true
});
await cp('public', output, {
  recursive: true
});
await cp('node_modules/leaflet/dist/leaflet.css', output + '/vendor/leaflet.css');
await cp('node_modules/leaflet/dist/leaflet.js', output + '/vendor/leaflet.js');
await cp('node_modules/leaflet/dist/images', output + '/vendor/images', {
  recursive: true
});
await build({
  entryPoints: ['src/web/journal-app.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outdir: output,
  legalComments: 'inline'
});
await build({
  entryPoints: ['src/server/app.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'dist/server/app.mjs'
});
const template = await read('public/journal.html');
const script = (code: string) => '<script>' + code.replace(/<\/script/gi, '<\\/script') + '</script>';
const leaflet = await read(output + '/vendor/leaflet.js'),
  journal = await read(output + '/journal-app.js');
let standalone = template.replace('<html ', '<html data-portable ').replace('<!-- map library -->', () => script(leaflet)).replace('<!-- journal entry -->', () => script(journal)).replace(/href="(support|privacy|terms)\.html"/g, 'href="https://hayiti-beta.cocoacoati256.chatgpt.site/$1.html"');
function embedStyles(html: string, name: string, css: string): string {
  const link = '<link rel="stylesheet" href="' + name + '">';
  if (!html.includes(link)) throw Error('Missing stylesheet ' + name);
  return html.replace(link, () => '<style>' + css + '</style>');
}
const dataURL = async (file: string, mime: string) => 'data:' + mime + ';base64,' + (await readFile(file)).toString('base64');
standalone = embedStyles(standalone, 'journal.css', await read('public/journal.css'));
let mapCSS = await read(output + '/vendor/leaflet.css');
for (const name of new Set(Array.from(mapCSS.matchAll(/url\(images\/([\w.-]+)\)/g), m => m[1]))) {
  mapCSS = mapCSS.replaceAll('url(images/' + name + ')', 'url(' + (await dataURL(output + '/vendor/images/' + name, 'image/png')) + ')');
}
standalone = embedStyles(standalone, 'vendor/leaflet.css', mapCSS);
for (const name of ['hayiti-icon.png', 'hayiti-signature.png']) {
  const image = await dataURL('public/' + name, 'image/png');
  standalone = standalone.replaceAll(new RegExp('"' + name.replace('.', '\\.') + '(?:\\?[^"]*)?"', 'g'), '"' + image + '"');
}
const blank = portableDocument(standalone);
await writeFile(output + '/Hayiti.html', blank);
await writeFile(output + '/Hayiti.zip', zipSync({
  'Hayiti.html': strToU8(blank)
}));
await writeFile(output + '/journal.html', template.replace('<!-- map library -->', '<script src="vendor/leaflet.js"></script>').replace('<!-- journal entry -->', '<script defer src="journal-app.js"></script>'));

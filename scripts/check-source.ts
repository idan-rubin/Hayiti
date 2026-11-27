import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const assetExtensions = new Set([
  '.css', '.html', '.ico', '.jpeg', '.jpg', '.json', '.md', '.png', '.svg',
  '.toml', '.ttf', '.txt', '.webp', '.woff', '.woff2', '.yaml', '.yml'
]);
const metadata = new Set(['.gitignore', '.gitattributes', '.editorconfig', 'LICENSE', 'leaflet-LICENSE']);
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'utf8'
}).split('\0').filter(Boolean);

for (const path of files) {
  if (/\.(?:[cm]?ts|tsx)$/i.test(path)) {
    if (/@ts-(?:ignore|nocheck)/.test(readFileSync(path, 'utf8'))) {
      throw Error('Type checking suppressed in ' + path);
    }
    continue;
  }
  const extension = extname(path).toLowerCase();
  if (!assetExtensions.has(extension) && !metadata.has(basename(path))) {
    throw Error('Only TypeScript source or a recognized project asset may be committed: ' + path);
  }
  if (extension === '.html' && /<script\b(?![^>]*type=["']application\/json["'])[^>]*>|\son[a-z]+\s*=/i.test(readFileSync(path, 'utf8'))) {
    throw Error('Keep executable code in TypeScript entry points: ' + path);
  }
}

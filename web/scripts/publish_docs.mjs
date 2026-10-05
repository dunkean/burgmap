import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [source, destination, revision] = process.argv.slice(2);
if (!source || !destination || !/^[a-f0-9]{40}$/.test(revision ?? '')) {
  throw new Error('Usage: node publish_docs.mjs <source checkout> <site directory> <commit>');
}
const document = await readFile(path.join(source, 'web/docs/generation.html'), 'utf8');
const published = document.replace(/href="(\.\.\/[^"#]+)"/g, (_match, href) => {
  const repositoryPath = path.posix.normalize('web/docs/' + href);
  return `href="https://github.com/dunkean/burgmap/blob/${revision}/${repositoryPath}"`;
});
await mkdir(path.join(destination, 'docs'), { recursive: true });
await writeFile(path.join(destination, 'docs/generation.html'), published);
await writeFile(path.join(destination, 'version.json'), JSON.stringify({ revision }) + '\n');

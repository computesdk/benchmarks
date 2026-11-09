import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [modulePath, exportName, ...candidates] = process.argv.slice(2);
if (!modulePath || !exportName) throw new Error('Provider module and export are required');
const module = await import(pathToFileURL(path.resolve(modulePath)).href);
const providers = module[exportName] as { name: string; dailyOnly?: boolean }[];
if (!Array.isArray(providers)) throw new Error('Expected a provider array');
const dailyOnly = new Set(providers.filter(provider => provider.dailyOnly).map(provider => provider.name));
console.log(JSON.stringify(candidates.filter(name => !dailyOnly.has(name))));

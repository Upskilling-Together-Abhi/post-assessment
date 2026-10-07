import { mkdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Scenario } from './types';

const root = () => path.resolve(process.env.SIMULATION_DATA_DIR ?? '.data');
function recordPath(collection: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid record ID');
  return path.join(root(), collection, `${id}.json`);
}
export async function readRecord<T>(collection: string, id: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(recordPath(collection, id), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
// Publish a complete record atomically. A retry sees the existing result, even
// after a worker crash between this write and reporting Activity completion.
export async function createOnce<T>(collection: string, id: string, value: T): Promise<T> {
  const target = recordPath(collection, id);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  try {
    try { await link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return (await readRecord<T>(collection, id))!;
  } finally { await unlink(temporary); }
}
export async function setCurrent(id: string): Promise<void> {
  await mkdir(root(), { recursive: true });
  const temporary = path.join(root(), `current-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ id }));
  await rename(temporary, path.join(root(), 'current.json'));
}
export async function readCurrent(): Promise<Scenario | undefined> {
  try {
    const { id } = JSON.parse(await readFile(path.join(root(), 'current.json'), 'utf8'));
    return readRecord<Scenario>('scenarios', id);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

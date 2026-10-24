// Preparador para Bolt: descarga y valida el paquete en una carpeta temporal.
// No modifica el proyecto abierto, no instala paquetes y no ejecuta SQL.
import { createDecipheriv, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';

const config = __BOLT_IMPORT_CONFIG__;
const MAX_PACKED = 16 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const decoder = new TextDecoder('utf-8', { fatal: true });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unpack(zip) {
  ensure(zip.length >= 22, 'El ZIP está incompleto.');
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  }
  ensure(end >= 0, 'No se encuentra el índice del ZIP.');
  const entries = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  ensure(zip.readUInt16LE(end + 4) === 0 && zip.readUInt16LE(end + 6) === 0 && zip.readUInt16LE(end + 8) === entries, 'No se admiten ZIP de varios volúmenes.');
  ensure(entries > 0 && entries < 1000 && entries !== 0xffff && offset !== 0xffffffff && size !== 0xffffffff && offset + size === end, 'Índice ZIP no admitido.');
  const files = [];
  const names = new Set();
  let cursor = offset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    ensure(cursor + 46 <= end && zip.readUInt32LE(cursor) === 0x02014b50, 'Entrada ZIP inválida.');
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const expanded = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const disk = zip.readUInt16LE(cursor + 34);
    const mode = (zip.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    const local = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    ensure(next <= end && disk === 0 && (flags & ~0x0808) === 0 && [0, 8].includes(method), 'Formato de entrada ZIP no admitido.');
    ensure([0, 0x8000].includes(mode), 'No se admiten enlaces simbólicos ni archivos especiales.');
    ensure(compressed !== 0xffffffff && expanded <= MAX_FILE && local !== 0xffffffff, 'Archivo demasiado grande o ZIP64 no admitido.');
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    ensure(name.startsWith('project/') && name.length <= 260 && !/[\\\0:]/.test(name), 'Ruta ZIP no admitida.');
    const relative = name.slice(8);
    const parts = relative.split('/');
    ensure(parts.every(part => part && part !== '.' && part !== '..'), 'Ruta ZIP insegura.');
    ensure(!parts.some(part => ['.git', 'node_modules', 'dist', '.prerender'].includes(part)), 'El paquete incluye archivos ajenos al código fuente.');
    ensure(!parts.some(part => part.startsWith('.env')) || relative === '.env.example', 'El paquete no debe contener configuración privada.');
    const normalized = relative.normalize('NFC').toLowerCase();
    ensure(!names.has(normalized), 'El ZIP contiene rutas duplicadas.');
    names.add(normalized);
    ensure(local + 30 <= offset && zip.readUInt32LE(local) === 0x04034b50, 'Cabecera local ZIP inválida.');
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    ensure(zip.readUInt16LE(local + 6) === flags && zip.readUInt16LE(local + 8) === method && start <= offset && start + compressed <= offset, 'Datos ZIP fuera de sus límites.');
    ensure(zip.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes), 'Las rutas del ZIP no coinciden.');
    total += expanded;
    ensure(total <= MAX_TOTAL, 'El paquete expandido supera el límite permitido.');
    const input = zip.subarray(start, start + compressed);
    const bytes = method === 0 ? Buffer.from(input) : inflateRawSync(input, { maxOutputLength: MAX_FILE });
    ensure(bytes.length === expanded && crc32(bytes) === crc, 'Un archivo no supera la comprobación de integridad.');
    files.push({ relative, bytes });
    cursor = next;
  }
  ensure(cursor === end && files.some(file => file.relative === 'INSTRUCCIONES_PARA_BOLT.md') && files.some(file => file.relative === 'src/App.tsx') && files.some(file => file.relative === 'package.json'), 'El paquete fuente está incompleto.');
  return files;
}

async function download(url) {
  let response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) }); }
  catch { throw new Error('No se ha podido descargar el paquete. Comprueba que la terminal de Bolt puede acceder a GitHub Pages y vuelve a intentarlo.'); }
  ensure(response.ok && response.body, 'El servidor no entrega el paquete fuente.');
  const announced = Number(response.headers.get('content-length') || 0);
  ensure(Number.isFinite(announced) && announced <= MAX_PACKED, 'La descarga supera el tamaño permitido.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_PACKED) { await reader.cancel(); throw new Error('La descarga supera el tamaño permitido.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

async function main() {
  ensure(process.argv.slice(2).every(value => value === '--check'), 'Este preparador solo admite --check; nunca aplica cambios al proyecto.');
  ensure(typeof config?.url === 'string' && typeof config?.key === 'string' && /^[a-f0-9]{64}$/.test(config?.sha256 || ''), 'La configuración de entrega no es válida.');
  const url = new URL(config.url);
  ensure(url.protocol === 'https:' && url.hostname === 'rubenpazos11-droid.github.io' && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/blank-app/entrega/codigo-${config.sha256.slice(0, 12)}.lcpack`, 'La dirección del paquete no es la esperada.');
  ensure(/^[A-Za-z0-9_-]{43}$/.test(config.key), 'La clave del enlace de entrega no es válida.');
  const key = Buffer.from(config.key, 'base64url');
  ensure(key.length === 32, 'La clave de entrega no tiene el formato esperado.');
  let current;
  try { current = JSON.parse(await readFile(resolve('package.json'), 'utf8')); }
  catch { throw new Error('Ejecuta este archivo desde la raíz del proyecto actual de Bolt, donde está package.json.'); }
  const deps = { ...current.dependencies, ...current.devDependencies };
  ensure(deps.react && deps.vite, 'La carpeta actual no parece el proyecto React/Vite de Limpiezas Coslada. No se ha cambiado ningún archivo.');
  const packed = await download(url.href);
  ensure(packed.length >= 34 && packed.subarray(0, 5).toString() === 'LCPK1', 'El paquete descargado no tiene el formato esperado.');
  let zip;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(5, 17));
    decipher.setAuthTag(packed.subarray(-16));
    zip = Buffer.concat([decipher.update(packed.subarray(17, -16)), decipher.final()]);
  } catch { throw new Error('No se ha podido autenticar el paquete. Descarga de nuevo el archivo de instrucciones desde el enlace protegido.'); }
  ensure(createHash('sha256').update(zip).digest('hex') === config.sha256, 'La integridad del paquete no coincide con la entrega.');
  const files = unpack(zip);
  if (process.argv.includes('--check')) {
    console.log(`Paquete autenticado y validado: ${files.length} archivos. No se ha escrito ningún archivo.`);
    return;
  }
  let folder;
  try {
    folder = await mkdtemp(join(tmpdir(), 'limpiezas-coslada-'));
    const root = join(folder, 'project');
    await mkdir(root, { mode: 0o700 });
    for (const file of files) {
      const target = resolve(root, file.relative);
      ensure(target.startsWith(root + sep) && basename(target) !== '.env', 'Ruta de salida insegura.');
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    console.log(`Código fuente preparado en: ${root}`);
    console.log(`Lee primero: ${join(root, 'INSTRUCCIONES_PARA_BOLT.md')}`);
    console.log('El proyecto abierto, su .env, Supabase y sus datos permanecen sin cambios.');
    console.log('Integra los archivos desde esa carpeta siguiendo las instrucciones: conserva conexiones e historial, revisa las diferencias y ejecuta las pruebas antes de publicar.');
  } catch (error) {
    if (folder) await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => { console.error(`Preparación detenida: ${error.message}`); process.exitCode = 1; });

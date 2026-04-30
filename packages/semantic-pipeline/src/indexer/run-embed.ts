import { readSemanticLayer } from '../storage.js';
import { embedSemanticLayer } from './embed-semantic-layer.js';
import { VectorStore, Embedder } from '@qwery/vector-store';

const id = process.argv[2] ?? '7952f0a6-52a1-47bb-b34a-af4fe1686927';

const sl = await readSemanticLayer(id);
if (!sl) { console.error('No semantic layer found for', id); process.exit(1); }

const dbUrl = process.env['QWERY_INTERNAL_DATABASE_URL']!;
const vs = new VectorStore(dbUrl);
const em = new Embedder();

const total =
  Object.keys(sl.measures ?? {}).length +
  Object.keys(sl.dimensions ?? {}).length +
  Object.keys(sl.business_rules ?? {}).length;

console.log(`Embedding ${total} fields for datasource ${id}...`);
await embedSemanticLayer(id, sl, vs, em);
await vs.end();
console.log('Done.');

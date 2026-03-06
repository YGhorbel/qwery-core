// Lazy load Node.js modules to avoid bundling in browser
let __dirname: string | undefined;
let readFileSync: typeof import('node:fs')['readFileSync'] | undefined;
let join: typeof import('node:path')['join'] | undefined;

async function getNodeModules() {
  if (!__dirname || !readFileSync || !join) {
    const { fileURLToPath } = await import('node:url');
    const fs = await import('node:fs');
    const path = await import('node:path');
    
    __dirname = fileURLToPath(new URL('.', import.meta.url));
    readFileSync = fs.readFileSync;
    join = path.join;
  }
  return { __dirname: __dirname!, readFileSync: readFileSync!, join: join! };
}

export async function getMigrationSQL(filename: string): Promise<string> {
  const { __dirname: dir, readFileSync: read, join: pathJoin } = await getNodeModules();
  const migrationPath = pathJoin(dir, filename);
  return read(migrationPath, 'utf-8');
}

export async function getMigrations() {
  return [
    {
      version: '001',
      filename: '001_initial.sql',
      getSQL: async () => await getMigrationSQL('001_initial.sql'),
    },
  ] as const;
}

// Synchronous version for CLI usage (only used server-side)
// Using a lazy getter pattern to prevent Vite from analyzing require() calls
let _migrations: Array<{
  version: string;
  filename: string;
  getSQL: () => string;
}> | undefined;

function getMigrationsSync() {
  if (!_migrations) {
    // This is only called server-side in the CLI
    // Using require() inside a function so it's not analyzed by Vite
    const fs = require('node:fs');
    const path = require('node:path');
    const url = require('node:url');
    const dir = url.fileURLToPath(new URL('.', import.meta.url));
    
    _migrations = [
      {
        version: '001',
        filename: '001_initial.sql',
        getSQL: () => {
          const migrationPath = path.join(dir, '001_initial.sql');
          return fs.readFileSync(migrationPath, 'utf-8');
        },
      },
    ] as const;
  }
  return _migrations;
}

// Export as a getter property to delay evaluation
// Using Proxy to make MIGRATIONS lazy - require() is only called when accessed
export const MIGRATIONS = new Proxy([] as NonNullable<typeof _migrations>, {
  get(_target, prop) {
    const migrations = getMigrationsSync()!;
    if (prop === 'length') return migrations.length;
    if (prop === Symbol.iterator) return migrations[Symbol.iterator].bind(migrations);
    if (typeof prop === 'string' && !isNaN(Number(prop))) {
      return migrations[Number(prop)];
    }
    return (migrations as any)[prop];
  },
  ownKeys() {
    return Object.keys(getMigrationsSync()!);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const migrations = getMigrationsSync()!;
    return Object.getOwnPropertyDescriptor(migrations, prop);
  },
});

import neo4j, { Driver } from 'neo4j-driver';

let _driver: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!_driver) {
    const host = process.env['NEO4J_HOST'] ?? 'localhost';
    const port = process.env['NEO4J_PORT'] ?? '7687';
    const user = process.env['NEO4J_USER'] ?? 'neo4j';
    const password = process.env['NEO4J_PASSWORD'] ?? 'neo4j';

    _driver = neo4j.driver(
      `bolt://${host}:${port}`,
      neo4j.auth.basic(user, password),
    );
  }
  return _driver;
}

export async function closeNeo4jDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

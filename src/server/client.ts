export async function callDaemon(path: '/command' | '/snapshot', command?: unknown): Promise<unknown> {
  const url = process.env.HIVE_URL ?? 'http://127.0.0.1:4317';
  const response = await fetch(`${url}${path}`, {
    method: command === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${process.env.HIVE_TOKEN ?? ''}`, 'Content-Type': 'application/json' },
    ...(command === undefined ? {} : { body: JSON.stringify(command) }),
    signal: AbortSignal.timeout(path === '/command' && typeof command === 'object' && command !== null && (command as { action?: string }).action === 'analyze' ? 120_000 : 15_000),
  });
  if (!response.ok) throw new Error(`Hive daemon returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function lazy(): Promise<number> {
  const mod = await import('demo-lib');
  return mod.stable(1);
}

export async function lazyNamed(): Promise<string> {
  const { greet } = await import('demo-lib');
  return greet('a', 'b');
}

export function chained(): Promise<string> {
  return import('demo-lib').then((m) => m.VERSION);
}

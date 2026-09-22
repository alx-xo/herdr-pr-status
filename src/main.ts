import { sanitize } from './feedback';
import { control, loadConfig, manualRefresh, previewRefresh, session, start, status, worker } from './polling';

export async function run(args: string[]): Promise<number> {
  const command = args[0] ?? 'info';
  if (!['info', 'preview', 'refresh', 'start', 'stop', 'status', '_worker'].includes(command) || args.length > 1) {
    console.error(`Unknown command or arguments: ${args.join(' ')}. Available commands: info, preview, refresh, start, stop, status`);
    return 1;
  }
  if (command === 'info') {
    console.log('alx-xo.pr-status: Bun/TypeScript polling POC.');
    console.log('start/stop/status: session poller; preview: read-only lookup; refresh: serialized manual refresh. No GitHub writes.');
    return 0;
  }
  try {
    if (process.env.HERDR_ENV !== '1') throw new Error('Run preview/refresh inside Herdr (HERDR_ENV=1); lifecycle actions also require Herdr supplied state/config/socket directories');
    if (command === 'preview' || command === 'refresh') {
      const config = await loadConfig();
      const results = command === 'preview' ? await previewRefresh(config) : await manualRefresh(await session(), config);
      console.log(JSON.stringify(results, null, 2));
      return results.some(result => result.status === 'error') ? 1 : 0;
    }
    const context = await session();
    if (command === '_worker') { await worker(context); return 0; }
    if (command === 'start') {
      await loadConfig(); // Useful startup diagnostics; worker reloads each cycle.
      console.log(JSON.stringify(await start(context), null, 2));
    } else if (command === 'status') console.log(JSON.stringify(await status(context), null, 2));
    else {
      const current = await status(context);
      console.log(JSON.stringify(current.running ? await control(context, 'stop') : current, null, 2));
    }
    return 0;
  } catch (error) {
    console.error(sanitize(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));

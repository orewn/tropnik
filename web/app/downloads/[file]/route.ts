import manifest from '@/public/downloads/android-manifest.json';
import {androidDownloadTarget} from '@/lib/android-download';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: {params: Promise<{file: string}>}) {
  const {file} = await context.params;
  const target = androidDownloadTarget(manifest, file);
  if (!target) return new Response('Файл не найден.', {status: 404, headers: {'Cache-Control': 'no-store'}});
  return new Response(null, {status: 307, headers: {Location: target, 'Cache-Control': 'no-store'}});
}

export const HEAD = GET;

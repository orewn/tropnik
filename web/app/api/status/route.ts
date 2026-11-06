import {probeServiceReadiness} from '@/lib/service-readiness';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await probeServiceReadiness(process.env.TROPA_API_URL);
  return Response.json(status.body, {status: status.status, headers: {'Cache-Control': 'no-store'}});
}

import {probeWebServiceReadiness} from '@/lib/service-readiness';
import {publicOriginPolicy} from '@/lib/backend-origin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await probeWebServiceReadiness(process.env.TROPA_API_URL, publicOriginPolicy(process.env.PUBLIC_ORIGIN, process.env.NODE_ENV) !== null);
  return Response.json(status.body, {status: status.status, headers: {'Cache-Control': 'no-store'}});
}

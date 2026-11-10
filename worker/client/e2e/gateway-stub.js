// A stand-in for the Gateway (cail-model-api) on the GATEWAY service binding
// under `wrangler dev`. Canned catalog, quota and chat replies; it records
// nothing and calls nothing. It is the only substituted component in the
// end-to-end journey.
import { quotaSnapshotBody } from '@cuny-ai-lab/cail-client/testing';

const row = (id, order, capabilities) => ({ id, object: 'model', recommended: true, tier: 'recommended', order, status: 'active', modality: 'text', provider: 'workers-ai', upstream_model: id, pricing_known: 'catalog', streaming: true, sunset: null, capabilities, context_length: 128000, registry_url: null, name: id, task: 'Text Generation' });
const CATALOG = { object: 'list', data: [row('stub-vision', 1, ['text-generation', 'vision']), row('stub-vision-reasoning', 2, ['text-generation', 'vision', 'reasoning']), row('stub-text', 3, ['text-generation'])] };

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    // Discovery is caller-independent; everything else needs the Gateway leg.
    if (pathname === '/v1/catalog') return Response.json(CATALOG);
    if (!request.headers.get('x-cail-identity-jwt')) return Response.json({ error: { message: 'no credential', type: 'auth', param: null, code: 'authentication_required' } }, { status: 401 });
    if (pathname === '/v1/quota') {
      return Response.json(quotaSnapshotBody());
    }
    if (pathname === '/v1/chat/completions') {
      const body = await request.json();
      const hasImage = JSON.stringify(body.messages).includes('image_url');
      const content = hasImage ? 'Transcribed by the stub model.\n\nSecond paragraph of the page.' : 'A stub summary.';
      return Response.json({ id: 'stub', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    return new Response('not found', { status: 404 });
  },
};

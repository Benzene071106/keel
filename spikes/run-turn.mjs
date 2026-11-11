import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 120 });
const spec = {
  model: { name: process.argv[2] ?? 'mock/mock-1' },
  instructions: 'Use the hello tool.',
  mcp_servers: [{ name: 'keel-spike', preload: true, require_approval_for_tools: process.argv[3] === 'gate' ? ['hello'] : [] }],
  config: { iteration_limit: 5 },
};
const { data: session } = await client.sessions.create({ agent: { spec } });
console.log('session', session.id);
const events = new Map();
async function run(input) {
  const stream = await client.sessions.createTurnStream(session.id, { input });
  const pending = [];
  for await (const { data: ev } of stream.withMetadata()) {
    if (isEventDelta(ev)) { const b = events.get(ev.id); if (b) mergeEventDelta(b, ev); process.stdout.write('·'); continue; }
    events.set(ev.id, ev);
    if (ev.type === 'tool.approval_required') pending.push(ev);
    console.log('\n<', ev.type, ev.type === 'turn.done' ? JSON.stringify(ev.state).slice(0, 300) : ev.type === 'tool.response' ? ev.content : '');
  }
  return pending;
}
let pending = await run([{ type: 'user.message', content: 'say hello' }]);
if (pending.length) {
  const approvals = [];
  for (const p of pending) for (const ref of p.toolCalls) {
    const msg = events.get(ref.sourceEventId);
    const call = msg?.toolCalls?.find(tc => tc.id === ref.id);
    console.log('APPROVAL for', call?.toolInfo?.name, call?.function?.arguments);
    approvals.push({ type: 'user.tool_approval', threadId: p.threadId, toolCallId: ref.id, approval: { status: 'allow' } });
  }
  await run(approvals);
}

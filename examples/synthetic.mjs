import { MODEL, Router, pack } from '../dist/index.js';
const snapshot = {
  incoming: { id: '3', channel: '#demo', speaker: 'synthetic-user', text: 'Please include a synthetic example.' },
  busy: true,
  channelHistory: [{ id: '1', speaker: 'synthetic-user', text: 'We are discussing the README.' }],
  piContext: [{ id: '2', speaker: 'assistant', text: 'I am drafting the README.' }],
};
const router = new Router({ adapter: { mode: 'mock', classify: async () => ({ model: MODEL, answers: { route: { type: 'choice', choice: 'queue', confidence: 1, probabilities: { ignore: 0, queue: 1, interrupt: 0 } } } }) } });
const packed = pack(snapshot);
console.log({ decision: await router.decide(snapshot), units: packed.units, assurance: packed.assurance });

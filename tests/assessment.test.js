import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { stages, validateQuestion, formattedCopy } from '../shared/assessment.js';
import { createCandidates } from '../server/question-service.js';
import { createProviderClient } from '../server/providers.js';
import { createCredentialStore } from '../server/secure-store.js';
import { createApp } from '../server/app.js';

const source = 'A constant cannot be reassigned. Functions return values.';
const common = { difficulty: 'Easy', topics: ['Constants'], evidence: 'A constant cannot be reassigned.', explanation: 'The source states this.' };
const mcq = { ...common, stem: 'Which binding cannot be reassigned?', options: ['const', 'let', 'var', 'parameter'], correctAnswer: 'a' };
const tf = { ...common, statement: 'A constant can be reassigned.', correctAnswer: false };
const coding = { ...common, codeSnippet: 'const x = 1; x = 2;', task: 'Explain the error.', expectedAnswer: 'Reassignment is forbidden.' };

test('question validation preserves false answers and normalizes MCQ letters', () => {
  assert.equal(validateQuestion(tf, 'truefalse', source).correctAnswer, false);
  assert.equal(validateQuestion(mcq, 'mcq', source).correctAnswer, 'A');
  assert.equal(validateQuestion(coding, 'coding', source).title, 'Code analysis');
});

test('reviewer edits cannot approve blank fields, duplicate options, or invented evidence', () => {
  for (const patch of [{ stem: '' }, { options: ['const', 'const', 'let', 'var'] }, { options: [{}, 'b', 'c', 'd'] }, { correctAnswer: 'E' }, { topics: [] }, { topics: [42] }, { explanation: ' ' }, { evidence: 'a constant cannot be reassigned.' }, { evidence: '   ' }]) {
    assert.throws(() => validateQuestion({ ...mcq, ...patch }, 'mcq', source));
  }
  assert.throws(() => validateQuestion({ ...tf, correctAnswer: 'false' }, 'truefalse', source));
});

test('student exports exclude answer, explanation, and evidence fields', () => {
  const approved = { mcq: [{ ...mcq, explanation: 'PRIVATE EXPLANATION', evidence: 'PRIVATE QUOTE' }], truefalse: [tf], coding: [coding] };
  const student = formattedCopy(approved, false);
  assert.doesNotMatch(student, /Answer:|Explanation:|Source link:|PRIVATE/);
  const trainer = formattedCopy(approved, true);
  assert.match(trainer, /Answer: False/);
  assert.match(trainer, /PRIVATE EXPLANATION/);
  assert.match(student, /const x = 1/);
});

test('generation validates all categories and ignores model-supplied approval/IDs', async () => {
  for (const [i, stage] of stages.entries()) {
    const result = await createCandidates({ type: stage.id, sourceText: source }, async () => JSON.stringify({ status: 'ok', items: Array.from({ length: stage.total }, () => ({ ...[mcq, tf, coding][i], approved: true, id: 'forged' })) }));
    assert.equal(result.items.length, stage.total);
    assert.equal(new Set(result.items.map(item => item.id)).size, stage.total);
    assert.ok(result.items.every(item => !item.approved && item.id !== 'forged'));
  }
});

test('generation rejects malformed output, bad counts, unknown status, and invalid coverage reports', async () => {
  for (const output of ['not json', '{bad}', '{"status":"wat"}', '{"status":"ok","items":[]}', '{"status":"gap","missingTopics":[{}]}']) {
    await assert.rejects(createCandidates({ type: 'mcq', sourceText: source }, async () => output));
  }
  const gap = { status: 'gap', missingTopics: ['Functions'], reason: 'More detail required.' };
  assert.deepEqual(await createCandidates({ type: 'mcq', sourceText: source }, async () => JSON.stringify(gap)), gap);
  const single = await createCandidates({ type: 'mcq', sourceText: source, single: true }, async () => '```json\n' + JSON.stringify({ status: 'ok', items: [mcq] }) + '\n```');
  assert.equal(single.items.length, 1);
});

test('a topic title returns a local coverage gap without calling a provider', async () => {
  const result = await createCandidates({ type: 'mcq', sourceText: 'HTML Basics to Advance' }, async () => assert.fail('A title should not spend a generation request.'));
  assert.equal(result.status, 'gap');
  assert.match(result.reason, /topic title/);
});

test('the generation prompt includes an explicit category-specific JSON example', async () => {
  await createCandidates({ type: 'mcq', sourceText: source, single: true }, async (_provider, _key, _model, prompt) => {
    assert.match(prompt, /"stem":"Question text"/);
    assert.match(prompt, /"options":\["First option"/);
    assert.match(prompt, /exactly 1 items/);
    return JSON.stringify({ status: 'ok', items: [mcq] });
  });
});

test('model choices prioritize assessment models and exclude incompatible output tasks', async () => {
  const client = createProviderClient({ fetchImpl: async url => Response.json(url.includes('googleapis')
    ? { models: ['gemini-2.5-pro', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-image', 'gemini-3.5-flash-lite'].map(id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] })) }
    : { data: ['nvidia/nemotron-3.5-embed-1b', 'nvidia/llama-guard-4-12b', 'deepseek-ai/deepseek-v4.1-flash', 'bigcode/starcoder2-15b', 'nvidia/nemotron-3.5-lightning-30b-a3b'].map(id => ({ id })) }) });
  const gemini = await client.listModels('gemini', 'secret');
  assert.equal(gemini[0].id, 'gemini-3.5-flash-lite');
  assert.deepEqual(gemini.map(model => model.id), ['gemini-3.5-flash-lite']);
  const nvidia = await client.listModels('nvidia', 'secret');
  assert.equal(nvidia[0].id, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.deepEqual(nvidia.map(model => model.id), ['nvidia/nemotron-3.5-lightning-30b-a3b', 'bigcode/starcoder2-15b']);
  assert.match(nvidia[0].label, /recommended/);
});

test('Lightning requests disable thinking without sending unsupported controls to other models', async () => {
  const bodies = [];
  const client = createProviderClient({ fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: '{"status":"ok"}' } }] });
  } });
  await client.generate('nvidia', 'secret', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'prompt');
  await client.generate('nvidia', 'secret', 'deepseek-ai/deepseek-v4.1-flash', 'prompt');
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(bodies[1].chat_template_kwargs, undefined);
});

test('schema constraints reach supported providers and preserve typed question fields', async () => {
  let schema;
  await createCandidates({ type: 'truefalse', sourceText: source, single: true }, async (_provider, _key, _model, _prompt, options) => {
    schema = options.responseSchema;
    assert.equal(schema.properties.items.items.properties.correctAnswer.type, 'boolean');
    assert.ok(schema.properties.items.items.required.includes('evidence'));
    return JSON.stringify({ status: 'ok', items: [tf] });
  });
  const bodies = [];
  const client = createProviderClient({ fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: '{}' }] } }], choices: [{ message: { content: '{}' } }] });
  } });
  await client.generate('gemini', 'secret', 'gemini-3.5-flash-lite', 'prompt', { responseSchema: schema });
  await client.generate('nvidia', 'secret', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'prompt', { responseSchema: schema });
  await client.generate('nvidia', 'secret', 'other-model', 'prompt', { responseSchema: schema });
  assert.deepEqual(bodies[0].generationConfig.responseJsonSchema, schema);
  assert.deepEqual(bodies[1].response_format.json_schema.schema, schema);
  assert.equal(bodies[2].response_format, undefined);
});

test('provider adapter handles both providers and Gemini model pagination', async () => {
  const calls = [];
  const client = createProviderClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('generateContent')) return Response.json({ candidates: [{ content: { parts: [{ text: 'private thought', thought: true }, { text: 'result' }] } }] });
    if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: 'result' } }] });
    if (url.includes('nvidia')) return Response.json({ data: [{ id: 'model-1' }] });
    return Response.json({ models: [{ name: 'models/model-1', supportedGenerationMethods: ['generateContent'] }], ...(url.includes('pageToken') ? {} : { nextPageToken: 'next' }) });
  } });
  assert.equal((await client.listModels('gemini', 'secret')).length, 1);
  assert.equal((await client.listModels('nvidia', 'secret'))[0].id, 'model-1');
  for (const provider of ['gemini', 'nvidia']) assert.equal(await client.generate(provider, 'secret', 'model-1', 'prompt'), 'result');
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'secret');
  assert.ok(calls.every(call => call.options.signal));
});

test('provider adapter translates rate limits, invalid JSON, empty completions, and transport errors', async () => {
  const cases = [
    [async () => new Response('sensitive provider body', { status: 429 }), 429],
    [async () => new Response('bad json'), 502],
    [async () => Response.json({}), 502],
    [async () => { throw new TypeError('secret transport details'); }, 502],
  ];
  for (const [fetchImpl, status] of cases) {
    await assert.rejects(createProviderClient({ fetchImpl }).generate('gemini', 'secret', 'model', 'prompt'), error => error.status === status && !error.message.includes('secret') && !error.message.includes('sensitive'));
  }
  await assert.rejects(createProviderClient({ fetchImpl: () => assert.fail('must not fetch') }).listModels('unknown', 'key'), /Choose Gemini/);
});

test('provider timeout aborts a stalled upstream operation', async () => {
  const client = createProviderClient({ timeoutMs: 20, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('timeout did not abort')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  }) });
  await assert.rejects(client.generate('gemini', 'key', 'model', 'prompt'), error => error.status === 504);
});

test('credential writes are serialized, encrypted, and recover after encryption failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'question-studio-test-'));
  try {
    const store = createCredentialStore({ directory, protect: async value => {
      if (value === 'fail') throw new Error('encryption failed');
      await new Promise(resolve => setTimeout(resolve, 5));
      return 'encrypted:' + value;
    }, reveal: value => value?.replace('encrypted:', '') || '' });
    await Promise.all([
      store.saveCredentials({ provider: 'gemini', model: 'g', geminiKey: 'g-key' }),
      store.saveCredentials({ provider: 'nvidia', model: 'n', nvidiaKey: 'n-key' }),
    ]);
    const stored = await store.getCredentials();
    assert.equal(stored.geminiKey, 'encrypted:g-key');
    assert.equal(stored.nvidiaKey, 'encrypted:n-key');
    assert.equal(await store.getApiKey(stored, 'gemini'), 'g-key');
    assert.equal(store.safeSettings(stored).geminiKey, undefined);
    const before = await readFile(path.join(directory, 'credentials.json'), 'utf8');
    await assert.rejects(store.saveCredentials({ geminiKey: 'fail' }));
    assert.equal(await readFile(path.join(directory, 'credentials.json'), 'utf8'), before);
    await store.saveCredentials({ provider: 'gemini', model: 'recovered', geminiKey: '' });
    assert.equal(store.safeSettings(await store.getCredentials()).hasGeminiKey, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP interface validates requests, protects local credentials, and returns JSON errors', async () => {
  const generated = [];
  let storeFailure = false;
  const app = createApp({
    store: { getCredentials: async () => { if (storeFailure) throw new Error('secret/path'); return {}; }, getApiKey: () => 'stored-key', safeSettings: () => ({ provider: 'gemini', model: 'test', hasGeminiKey: true }), saveCredentials: async value => ({ provider: value.provider, model: value.model }) },
    listModels: async () => [{ id: 'test', label: 'Test' }],
    createCandidates: async input => { generated.push(input); return { status: 'ok', items: [] }; },
    logger: { error() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body, route = '/api/generate') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const valid = { provider: 'gemini', model: 'test', type: 'mcq', sourceText: source };
    for (const patch of [{ provider: 'fake' }, { model: {} }, { sourceText: 42 }, { sourceText: ' ' }, { type: 'fake' }, { single: 'false' }, { feedback: [] }, { sourceText: 'x'.repeat(100001) }]) assert.equal((await post({ ...valid, ...patch })).status, 400);
    assert.equal(generated.length, 0);
    assert.equal((await post(valid)).status, 200);
    assert.equal(generated[0].key, 'stored-key');
    assert.equal((await fetch(base + '/api/settings', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(base + '/api/settings', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(base + '/api/missing')).status, 404);
    assert.equal((await fetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad}' })).status, 400);
    assert.equal((await fetch(base + '/api/generate', { method: 'POST', body: 'text' })).status, 415);
    storeFailure = true;
    const failure = await fetch(base + '/api/settings');
    assert.equal(failure.status, 500);
    assert.doesNotMatch(await failure.text(), /secret/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// Uses disposable synthetic values; never opens the application's real data directory.
test('Windows DPAPI adapter round-trips a disposable key without storing plaintext', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'question-studio-dpapi-'));
  try {
    const store = createCredentialStore({ directory });
    const key = 'synthetic-test-key-' + Date.now();
    const settings = await store.saveCredentials({ provider: 'gemini', model: 'test', geminiKey: key });
    assert.equal(settings.hasGeminiKey, true);
    assert.doesNotMatch(await readFile(path.join(directory, 'credentials.json'), 'utf8'), new RegExp(key));
    assert.equal(await store.getApiKey(await store.getCredentials(), 'gemini'), key);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

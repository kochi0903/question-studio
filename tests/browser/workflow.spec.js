import { test, expect } from '@playwright/test';

const source = 'A constant cannot be reassigned. Functions return values.';
const common = { difficulty: 'Easy', topics: ['Constants'], evidence: 'A constant cannot be reassigned.', explanation: 'PRIVATE TRAINER EXPLANATION' };
function candidate(type, index) {
  const shape = type === 'mcq' ? { stem: `Which binding ${index} cannot be reassigned?`, options: ['const', 'let', 'var', 'parameter'], correctAnswer: 'A' }
    : type === 'truefalse' ? { statement: `A constant can be reassigned (${index}).`, correctAnswer: false }
      : { title: `Code analysis ${index}`, codeSnippet: 'const x = 1; x = 2;', task: 'Explain the error.', expectedAnswer: 'PRIVATE EXPECTED ANSWER' };
  return { ...common, ...shape, id: `${type}-${index}`, approved: false };
}
async function setup(page, options = {}) {
  const calls = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/settings') return route.fulfill({ json: { provider: 'gemini', model: 'saved-model', hasGeminiKey: true, hasNvidiaKey: false } });
    if (url.pathname === '/api/models') return route.fulfill({ json: { models: [{ id: 'saved-model', label: 'Saved model' }, { id: 'other-model', label: 'Other model' }] } });
    if (url.pathname === '/api/generate') {
      const request = route.request().postDataJSON(); calls.push(request);
      if (options.gap && calls.length === 1) return route.fulfill({ json: { status: 'gap', missingTopics: ['Functions'], reason: 'Add a function example.' } });
      return route.fulfill({ json: { status: 'ok', items: Array.from({ length: request.single ? 1 : request.type === 'coding' ? 3 : 5 }, (_, i) => candidate(request.type, i)) } });
    }
    return route.abort();
  });
  await page.goto('/');
  await expect(page.getByText('saved-model', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Reading material' }).fill(source);
  return calls;
}
async function select(page, count) {
  for (let i = 0; i < count; i++) await page.getByRole('button', { name: 'Select candidate', exact: true }).first().click();
}

async function startAssessment(page) {
  await page.getByRole('button', { name: 'Choose topics first' }).click();
  await expect(page.getByRole('dialog', { name: 'What should this assessment cover?' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate 5 MCQs' }).click();
}

test('discarded settings and locked controls preserve the assessment configuration', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = await setup(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /NVIDIA NIM/ }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await startAssessment(page);
  await expect(page.locator('.candidate-card')).toHaveCount(5);
  expect(calls[0].provider).toBe('gemini'); expect(calls[0].model).toBe('saved-model');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: /Google Gemini/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Load available models' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await select(page, 2);
  await page.getByRole('button', { name: 'Approve & continue' }).click();
  await expect(page.locator('.candidate-card')).toHaveCount(5);
  expect(calls[1].model).toBe('saved-model');
  expect(errors).toEqual([]);
});

test('edited candidates must remain valid before approval', async ({ page }) => {
  await setup(page);
  await startAssessment(page);
  await select(page, 2);
  const card = page.locator('.candidate-card').first();
  await card.getByTitle('Edit question').click();
  await card.locator('textarea').first().fill('');
  await page.getByRole('button', { name: 'Approve & continue' }).click();
  await expect(page.getByText(/Review the selected questions:/)).toBeVisible();
  await expect(page.locator('.review-heading h1')).toContainText('Multiple choice');
  await card.locator('textarea').first().fill('Which declaration cannot be reassigned?');
  await page.getByRole('button', { name: 'Approve & continue' }).click();
  await expect(page.locator('.review-heading h1')).toContainText('True or false');
});

test('full assessment exports five questions with trainer-only answers and a downloadable PDF', async ({ page }) => {
  await setup(page);
  await startAssessment(page);
  for (let stage = 0; stage < 3; stage++) {
    await expect(page.locator('.candidate-card')).toHaveCount(stage === 2 ? 3 : 5);
    await select(page, stage === 2 ? 1 : 2);
    await page.getByRole('button', { name: stage === 2 ? 'Build both copies' : 'Approve & continue' }).click();
  }
  await expect(page.getByText('Ready for the')).toBeVisible();
  await page.locator('.student-card').getByRole('button', { name: 'Copy text' }).click();
  const student = await page.evaluate(() => navigator.clipboard.readText());
  expect(student).not.toMatch(/PRIVATE|Answer:|Explanation:|Source link:/);
  expect(student).toContain('const x = 1');
  await page.locator('.trainer-card').getByRole('button', { name: 'Copy text' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Answer: False');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.student-card').getByRole('button', { name: 'Download PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('assessment-student-copy.pdf');
  expect(await download.failure()).toBeNull();
});

test('coverage gaps accept additional source and single regeneration clears approval', async ({ page }) => {
  const calls = await setup(page, { gap: true });
  await startAssessment(page);
  await expect(page.getByText('Add a function example.')).toBeVisible();
  await page.getByPlaceholder('Paste additional lesson notes or explanations…').fill('A function returns its result to the caller.');
  await page.getByRole('button', { name: 'Add to source' }).click();
  await page.getByRole('button', { name: 'Generate 5 candidates' }).click();
  await expect(page.locator('.candidate-card')).toHaveCount(5);
  expect(calls[1].sourceText).toContain('A function returns');
  await select(page, 1);
  const card = page.locator('.candidate-card').first();
  await card.getByPlaceholder('Tell the model how to improve this…').fill('Make the wording clearer.');
  await card.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('button', { name: 'Unselect candidate', exact: true })).toHaveCount(0);
  expect(calls[2].single).toBe(true);
});

test('a delayed model response cannot overwrite another provider draft', async ({ page }) => {
  await setup(page);
  const pending = [];
  await page.route('**/api/models', route => { pending.push(route); });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Load available models' }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: /NVIDIA NIM/ }).click();
  await pending[0].fulfill({ json: { models: [{ id: 'stale-gemini', label: 'Stale Gemini' }] } });
  await expect(page.getByRole('combobox')).toHaveValue('');
  await expect(page.getByRole('combobox')).toBeDisabled();
  await page.locator('input[type="password"]').fill('synthetic-nvidia-key');
  await page.getByRole('button', { name: 'Load available models' }).click();
  await expect.poll(() => pending.length).toBe(2);
  await pending[1].fulfill({ json: { models: [{ id: 'nvidia-model', label: 'NVIDIA model' }] } });
  await expect(page.getByRole('combobox')).toHaveValue('nvidia-model');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await startAssessment(page);
  await expect(page.locator('.candidate-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Discard assessment' }).click();
  await expect(page.getByRole('textbox', { name: 'Reading material' })).toHaveValue(source);
});

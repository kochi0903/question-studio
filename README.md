# Question Studio

A local assessment builder that turns source material into five reviewer-approved questions: two multiple choice, two true/false, and one code analysis.

## How the app works

Think of Question Studio as a **workbench**: the browser is where you provide material and review the work; the backend is the workshop that sends a carefully shaped request to an AI provider and checks what comes back.

```mermaid
flowchart LR
    A[You add lesson text or rough topics] --> B[Browser app helps you choose topics]
    B --> C[You confirm the topics]
    C --> D[Browser sends text, choices, model, and API key over HTTPS]
    D --> E{Where is the app running?}
    E -->|On your computer| F[Local Express backend]
    E -->|Production| G[Vercel Function at /api/*]
    F --> H[Backend checks the request and prepares the prompt]
    G --> H
    H --> I[Gemini or NVIDIA model]
    I --> J[Backend checks the JSON, question count, and source evidence]
    J -->|Valid| K[You review and select candidates]
    J -->|Evidence mismatch| L[One corrective generation attempt]
    L --> I
    K --> M[Approve 2 MCQs, 2 true/false, and 1 code analysis question]
    M --> N[Copy or download trainer and student versions]
```

In everyday terms:

1. **You choose what to teach.** Paste lesson material or start from rough topics. The browser helps you select the topics before question generation.
2. **The backend sends the request.** It adds instructions for the chosen question type and asks the selected provider for a fixed number of candidates in a structured format.
3. **The backend checks the result.** It checks that the response has the right fields and number of questions, and that evidence uses words found together in your source. If evidence does not match, it asks the provider once to correct it. Unsupported results are rejected.
4. **You make the final choices.** Review the candidates, edit or regenerate where needed, and approve the required number. The app then prepares separate trainer and student exports.

The browser keeps the lesson and assessment in memory. In the local app, saved provider keys are encrypted on the Windows account. In production, a key you enter stays in browser memory and is sent over HTTPS with requests; it is not saved by the hosted app. The selected provider receives the key and the source text needed to complete each request.

The local and production backends serve the same purpose through different paths:

| Mode | Browser connects to | Key handling |
| --- | --- | --- |
| Local development | Vite frontend → local Express server | Saved keys are encrypted with Windows DPAPI |
| Vercel production | Vite build → Vercel Function at `/api/*` | Key stays in browser memory and is sent with each provider request |

## Requirements and setup

- Node.js 20.19 or newer, matching the package engine requirement.
- Windows for locally remembered provider keys, using the current account's DPAPI encryption.
- Microsoft Edge for the browser regression suite. To use another Playwright browser, adjust `channel` in `playwright.config.js`.

```powershell
npm ci
npm run dev
```

Open the local Vite address printed in the terminal. In **Settings**, choose Gemini or NVIDIA, enter a provider key, load models, select one, and save. Closing Settings discards unsaved edits.

For a production build:

```powershell
npm run build
npm start
```

Open http://127.0.0.1:4174. Set `PORT` to change the backend port; also update the development proxy in `vite.config.js` if using a different backend port during development. Stop the server with Ctrl+C. Run only one backend process against a given credential directory.

## Vercel production

The deployment uses `vercel.json` to build the Vite app into `dist` and `api/[...path].js` to expose the Express API as a Vercel Function. `.env.production` points the browser app at `https://question-studio-lime.vercel.app`; update `VITE_API_BASE_URL` there if the production domain changes. Deploy the project root in Vercel so it includes both `api/` and `server/`.

Provider keys entered in the hosted app stay in browser memory and are sent over HTTPS with model and generation requests. They are not saved to Vercel's filesystem or browser storage; refreshing the page requires entering the key again. In Settings, load models with the key, choose a model, and save preferences for that browser.

`POST /api/models` is the model-discovery endpoint and requires a JSON body containing `provider` and `apiKey`. Opening `/api/models` directly in a browser sends `GET`, so the API responds with `405 Method Not Allowed` and guidance instead of a not-found page.

## Assessment workflow

1. Paste up to 100,000 characters of source material, or start with rough topics and use guided material development.
2. Generate five MCQs and approve two; generate five true/false questions and approve two; generate three code-analysis questions and approve one.
3. Edit candidates or regenerate an individual question with reviewer direction. Edited questions are validated again on approval.
4. When coverage is insufficient, add source text or develop the missing topics with the selected provider. Review the suggested topics, select what to cover, then edit and accept the draft lesson material before it is added. The app rechecks the same category and keeps already-approved stages. Provider and model are fixed throughout the assessment. **Discard assessment** returns to source entry and keeps the source text.
5. Copy or download separate trainer and student editions. Student exports exclude answer, explanation, and evidence fields. Long PDF text flows across pages.

Source text and rough topics are sent to the selected provider. AI-drafted lesson material is clearly labeled and must be reviewed and accepted before it becomes source for questions. Presence of a verbatim evidence quote is checked; this does not establish that a generated answer follows logically from the quote. Review every question and answer. Questions and pasted material live in browser memory and are lost on refresh.

## Verification

```powershell
npm test
npm run build
npm run test:e2e
# Or run all three:
npm run check
npm audit
```

The Node tests cover question contracts, generation, provider transport failures, deadlines, HTTP validation, local access protection, serialized storage, and a Windows DPAPI round trip. Tests use temporary storage and synthetic keys. Browser tests exercise settings cancellation, assessment configuration, edited-question approval, all three stages, coverage gaps, regeneration, clipboard exports, and PDF download. Provider responses are simulated, so these checks incur no provider charges and do not verify live account/model availability.

## Structure

- `shared/assessment.js`: the assessment contract, stage requirements, question validation, and edition formatting shared by server and browser.
- `server/app.js`: injectable Express application, HTTP input checks, local access protections, JSON errors, and health endpoint (`GET /api/health`). Importing it does not open a port.
- `server/index.js`: process startup, port validation, and shutdown.
- `server/question-service.js`: prompts, coverage-report validation, candidate counts, and model-output validation.
- `server/material-service.js`: topic suggestions and draft lesson material, with bounded validated output before it reaches the browser.
- `server/providers.js`: Gemini and NVIDIA adapters behind one transport interface, 90-second upstream deadlines, Gemini pagination, and safe error translation.
- `server/secure-store.js`: asynchronous Windows encryption, serialized saves, and same-directory temporary-file replacement. Encryption and storage location can be replaced in tests.
- `src/lib/`: browser HTTP behavior and PDF export implementation.
- `tests/`: Node regression tests and Playwright browser scenarios.

The local server is intended for one user on the same computer and rejects non-loopback access. The hosted Vercel app has no user accounts or shared database; each visitor supplies their own provider key in the browser session. Keep `data/` private and do not commit it. Both modes reject cross-site browser requests. Internal failures return generic errors; provider response bodies are not exposed. Network and provider errors are not automatically retried or routed to another provider. Only a response with invalid source evidence gets one corrective generation attempt.

Original source files were copied to `work/production-backup/` before this refactor; credentials were not copied. `package-lock.json` pins dependency resolution. The jsPDF upgrade to 4.2.1 resolves the advisories reported by the dependency audit during this work.

## Live-tested assessment models

Live generation was verified with both saved provider keys on 30 October 2026 using the same HTML lesson:

- **Preferred: Gemini `gemini-3.5-flash-lite`**. It returned valid MCQs, true/false questions, and coding questions. This is now the saved selection.
- **NVIDIA alternative: `nvidia/nemotron-3.5-lightning-30b-a3b`**. It also returned valid sets for all three categories. The adapter explicitly disables thinking for this model and requests schema-constrained output.

The model picker is restricted to the assessment choices: Gemini `gemini-3.5-flash-lite`, and NVIDIA `nvidia/nemotron-3.5-lightning-30b-a3b` plus `bigcode/starcoder2-15b`. Nemotron Lightning appears first and is labeled as recommended for assessments. StarCoder2 7B was not returned by the saved NVIDIA account's live model catalog, so it is omitted rather than shown as a model that may fail. The NVIDIA catalog currently marks the StarCoder2 15B free endpoint as deprecated; availability can change independently of this picker.

A topic title such as `HTML Basics to Advance` is not source material. Obvious short titles now return a local coverage gap before a generation call. Paste the actual lesson explanations and examples. For generated output, the app sends a category-specific JSON example and a JSON Schema to Gemini and the recommended NVIDIA model. Source evidence, fields, and candidate counts are still validated after generation.

`npm run dev` watches backend files as well as reloading frontend changes. `npm start` remains the local production startup command. Timeouts stay bounded, and requests are not silently routed to a different provider.

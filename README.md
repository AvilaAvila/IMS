# IMS Ideas

A simple website to capture user ideas with attachments, votes, comments, and idea status tracking.

## Features

- Home page shows all posted ideas
  - Shows attached image, otherwise a default image
  - Vote + comment actions
- Submit idea: Title + Description + optional image attachment
- My Ideas: shows all ideas submitted by the logged-in user + status (Approved / In progress / Closed)
- Side navigation: Home, About, Help & FAQ, Achievers
- Top bar: Profile, Inbox (notifications)
- Admin (first account created): can update idea status

## Run locally (Windows)

1. Install Node.js (LTS).
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm run dev
```

Then open `http://localhost:3000`.

## AI “Enhance” option (no OpenAI required)

The Description “Enhance” button supports multiple providers:

- **Ollama (default)**: runs locally on your PC
  - Install Ollama, run it, then pull a model:

```bash
ollama pull llama3.1
```

  - Start the app (optional env vars):
    - `AI_PROVIDER=ollama`
    - `OLLAMA_URL=http://localhost:11434`
    - `OLLAMA_MODEL=llama3.1`

- **OpenAI (optional)**:
  - `AI_PROVIDER=openai`
  - `OPENAI_API_KEY=...`

- **Fallback (no AI)**:
  - Any other `AI_PROVIDER` value will use a simple cleanup/structure template.


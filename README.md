# Phantom-Thieves

LINAW, a personal document journal with Lumen OCR and Lumen AI Chat.

## Run

Requires Node.js 20.12 or newer. No packages to install.

1. Copy `.env.example` to `.env` and fill in your Lumen credentials and the two base URLs
   (from the `servers` section of the competition's OCR and AI Chat OpenAPI specs).
2. Start the server:

   ```
   npm start
   ```

3. Open http://localhost:3000. This opens My Room (`Main/MyRoom.html`), the main page.
   Click the book in the room to open the LINAW journal (`Main/Phantom.html`).

## How the Lumen integration works

- The browser only calls this app's own server: `POST /api/ocr`, `POST /api/chat` and `POST /api/analyze`.
- `server.js` reads the credentials from `.env` and sends them to Lumen as the
  `lumen-api-key` and `lumen-api-secret` headers. They never reach the browser.
- OCR: upload the file (`POST /documents`), poll `GET /documents/{id}` until `READY` or
  `PARTIAL`, then read the text from `GET /documents/{id}/pages`.
- Chat: the first `ACTIVE` instance from `GET /instances` (or `LUMEN_CHAT_INSTANCE_ID`),
  one session per browser tab, `POST .../sessions/{id}/messages` per question.

Never commit `.env`. It is listed in `.gitignore`.

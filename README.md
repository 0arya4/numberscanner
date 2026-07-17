# Iraqi Scanner AI

Camera scanner for Iraqi phone numbers and short ID barcodes, with a manual ID lookup panel.

## Safe local setup

1. Copy `.env.example` to `.env`.
2. Ask the API provider to **rotate the key that was pasted in chat**, then put only the new key in `RPIRAQ_API_ACCESS_KEY`.
3. Start the local server:

```powershell
node --env-file=.env server.mjs
```

4. Open `http://127.0.0.1:8787/`.

The browser sends IDs only to the same-origin `/api/lookup` endpoint. The server forwards the request to the company API and returns only the phone number and location (not city or the full upstream record).

## Security

- Never commit `.env` or paste API keys into the page, repository, or chat.
- GitHub Pages hosts only static files, so it cannot run `server.mjs` or safely store the secret. For production, deploy the server on a private Node-compatible backend, configure its environment variables there, and point the app to that backend.
- Add real user authentication and stronger rate limits before exposing ID lookups to the public internet.

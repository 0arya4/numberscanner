# Just a small scanner for my work

Camera scanner for Iraqi phone numbers and short ID barcodes, with a manual ID lookup panel.

## Digit AI scanner

The live scanner now requests the highest camera resolution available, crops the number zone, and uses a lightweight PaddleOCR digit model in the browser. It confirms the same value in two frames before an ID lookup. The model downloads and caches on the first use; Tesseract remains only as a fallback if the digit model cannot load.

For the highest accuracy on tiny Red Pack numbers, supply a future training set of real sticker photos so the recognition model can be fine-tuned to the exact digits, print, blur, and lighting used in the field.

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

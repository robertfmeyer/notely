# Notely

Notely is a mobile-first music composition app for writing compact text shorthand,
turning it into engraved sheet music, and playing it back immediately.

## Features

- Notes, rests, dotted durations, chords, ties, accidentals, and key signatures
- Standard and odd time signatures with automatic bar validation
- Reusable named chord definitions such as `AM = [A3,E4,A4,C#5,E5]`
- Multiple device-local song tabs
- `.txt` composition import and export
- Print-friendly sheet music and PDF output
- Responsive smartphone-focused interface

## Prerequisites

- Node.js `>=22.13.0`

## Local development

```bash
npm install
npm run dev
npm run build
```

## Cloudflare deployment

The repository includes a production `wrangler.jsonc`. After authenticating
Wrangler with your Cloudflare account, deploy with:

```bash
npm run deploy
```

Use `npm run deploy:dry-run` to validate the Cloudflare bundle without publishing.

## Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run deploy`: build and publish to Cloudflare Workers
- `npm run deploy:dry-run`: validate the deployment bundle

## Learn More

- [vinext](https://github.com/cloudflare/vinext)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)

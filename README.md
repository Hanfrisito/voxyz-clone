# Voxyz Clone - Backend API

This repository contains the backend services for the Voxyz Clone project.

## Project Structure

- `api/`: Serverless functions (Vercel).
  - `ops/heartbeat.ts`: Main monitor and automation trigger.
- `public/`: Static assets and landing page.
- `vercel.json`: Vercel configuration for deployment.
- `tsconfig.json`: TypeScript configuration.

## Deployment

The project is configured for deployment on **Vercel**.

### Configuration

- **Build Command:** `npm run build` (runs `tsc`)
- **Output Directory:** `dist` for the API, `public` for the landing page.

## Tech Stack

- **Runtime:** Node.js 18+
- **Language:** TypeScript
- **Database:** Supabase
- **Deployment:** Vercel

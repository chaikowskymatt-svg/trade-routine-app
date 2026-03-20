# Trade Routine AI - fastest deploy

## Fastest working route
Use **GitHub for code** and **Vercel for hosting**.

Why: GitHub Pages cannot run server-side API code, but this app needs API routes for live market data.

## Files
- `index.html` - frontend
- `api/dashboard.js` - dashboard data endpoint
- `api/scanner.js` - scanner endpoint
- `vercel.json` - Vercel config

## Deploy steps
1. In your GitHub repo, delete the old `index.html`.
2. Upload every file and folder from this package.
3. Go to Vercel.
4. Click **Add New Project**.
5. Import your GitHub repo.
6. Deploy.

## Important
- Holdings still save in localStorage on the same device/browser.
- The economic calendar area is a placeholder in this fast version.
- Live market data and scanner should work through the Vercel API routes.

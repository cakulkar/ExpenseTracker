# Deploying free on GitHub Pages

The app is static files. GitHub Pages serves them over HTTPS for free, which PWAs require. A workflow in
`.github/workflows/deploy.yml` tests, builds and publishes on every push to `main`.

## One-time setup
1. Push this project to `https://github.com/cakulkar/ExpenseTracker` on the `main` branch.
2. In the repo, open **Settings → Pages**, and under **Build and deployment → Source** choose **GitHub Actions**.
3. On a free GitHub plan, Pages requires the repository to be **public**. The code holds no secrets and no personal
   data. Your expenses live on your devices and, encrypted, in your Google Drive.
4. **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   `GOOGLE_CLIENT_ID` = your OAuth Client ID. This is a public identifier, not a secret, so a *variable* is correct.

## Each deploy
```bash
git add -A
git commit -m "Describe the change"
git push origin main
```
Watch **Actions** in the repo. The workflow runs typecheck, unit and integration tests, the license audit and the Playwright end-to-end tests, and only then builds and deploys. When the run is green, the site is live at `https://cakulkar.github.io/ExpenseTracker/`.
Installed apps pick up the new version and offer **Update now**.

## Building locally exactly like CI
```bash
VITE_BASE_PATH=/ExpenseTracker/ npm run build
VITE_BASE_PATH=/ExpenseTracker/ npm run preview   # http://localhost:4173/ExpenseTracker/
```

## Notes
- `VITE_BASE_PATH` must match the repository name (with slashes). The workflow sets it automatically.
- The app uses hash URLs (`#/expenses`), so no server rewrite rules are needed.
- A custom domain works too (Settings → Pages → Custom domain). In that case set `VITE_BASE_PATH=/`, and add the new origin
  to the OAuth client's authorized JavaScript origins.

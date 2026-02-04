# Commit and Push Workflow

This project uses **HTTPS** with a GitHub Personal Access Token (PAT) for push authentication. The PAT is stored in `.env.local` as `GITHUB_PAT` and is also configured in the Git remote URL so normal `git push` works.

## One-time setup (already done)

1. **Create a PAT** in GitHub: Settings → Developer settings → Personal access tokens. Give it `repo` scope.
2. **Add to `.env.local`**:
   ```bash
   GITHUB_PAT=github_pat_xxxx...
   ```
3. **Point origin at GitHub over HTTPS** (with PAT in URL so push works without prompts):
   ```bash
   git remote set-url origin "https://YOUR_GITHUB_USERNAME:YOUR_GITHUB_PAT@github.com/YOUR_GITHUB_USERNAME/YOUR_REPO.git"
   ```
   Example:
   ```bash
   git remote set-url origin "https://ukinoo-rgb:$(grep GITHUB_PAT .env.local | cut -d= -f2)@github.com/ukinoo-rgb/proxy.git"
   ```
   Or set the URL manually with the PAT (stored in `.git/config`, not committed).

## Regular workflow: commit and push

From the project root:

```bash
# 1. See what changed
git status

# 2. Stage changes (all or specific files)
git add -A
# or: git add path/to/file.ts

# 3. Commit with a clear message
git commit -m "Brief description of the change"

# 4. Push to origin (uses PAT from remote URL; no password prompt)
git push origin main
```

If push ever asks for a password or fails with auth errors:

- Confirm `GITHUB_PAT` in `.env.local` is correct and not expired.
- Re-run the one-time setup step 3 to refresh the remote URL with the current PAT.
- Rotate the PAT in GitHub if it may have been exposed.

## Branch name

Default branch is `main`. Use `git push origin main` (or your current branch: `git push origin $(git branch --show-current)`).

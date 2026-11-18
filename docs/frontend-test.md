# Frontend & Nginx – Implementation Notes and Test Record (Member 2)

> Branch: `feat/docker-frontend` · Owner: Member 2
> **Status of every test below is `NOT RUN` until the team executes it on Ubuntu and attaches evidence.**
> Do not change a status to PASS without a log/screenshot in `docs/evidence/`.

## 1. What was implemented

| File | Purpose |
|---|---|
| `client/Dockerfile` | Multi-stage build: `node:22-alpine` builds Vite → `nginx:stable-alpine` serves `dist` |
| `client/nginx.conf` | Static hosting, SPA fallback, `/api/` reverse proxy, caching, gzip, security headers, `/healthz` |
| `client/.dockerignore` | Keeps `node_modules`, `dist`, `.env*` out of the build context |
| `scripts/test-frontend.sh` | Automated smoke test (SPA routes, assets, headers, proxy) |
| `scripts/check-bundle-secrets.sh` | Proves no secret / stale API URL is baked into the bundle |

## 2. Design decisions (use these in the report, Chapter 4)

1. **Same-origin API via `VITE_BASE_URL=/`.** `AppContext.jsx` sets `axios.defaults.baseURL = import.meta.env.VITE_BASE_URL` and calls paths like `/api/show/all`. With `/`, the browser calls `http://<host>:8080/api/...`; Nginx forwards to `api:3000`. A browser cannot resolve the Docker service name `api`, so it must never be put in a `VITE_*` value.
2. **Build-time variables.** Vite inlines `VITE_*` at build time, so changing one requires `docker compose up -d --build`. Four values are exposed as build args: `VITE_CLERK_PUBLISHABLE_KEY` (required, build fails if empty), `VITE_BASE_URL` (`/`), `VITE_CURRENCY` (`$`) and `VITE_TMDB_IMAGE_BASE_URL`. The last two are used by the UI (prices, posters); because `.env` is excluded from the image, they need defaults or posters/prices would be `undefined`.
3. **SPA fallback.** `try_files $uri $uri/ /index.html` lets React Router handle `/movies`, `/my-bookings`, `/admin` after a browser refresh.
4. **Docker DNS re-resolution.** `resolver 127.0.0.11` + `set $api_upstream` makes Nginx re-resolve `api` per request, so recreating the API container (new IP) does not leave Nginx pointing to a dead address.
5. **`Host $http_host`** (not `$host`) keeps the port (`localhost:8080`) visible to Express/Clerk.
6. **Caching.** `/assets/*` (content-hashed) cached 1 year; `index.html` is `no-cache` so users always get the latest hashed bundle names.
7. **No `add_header` inside locations** – Nginx drops inherited headers when a location defines its own.
8. **Not included on purpose:** a Content-Security-Policy. Clerk, Stripe and YouTube embeds need a carefully tested allow-list; a wrong CSP would break login/payment. Listed as future work.

## 3. Commands

```bash
# From the repo root, after Member 1's compose.yaml exists and root .env has VITE_CLERK_PUBLISHABLE_KEY
sudo docker compose build web
sudo ./scripts/check-bundle-secrets.sh            # image name defaults to quickshow-docker-web
sudo docker compose up -d --build
./scripts/test-frontend.sh http://localhost:8080 | tee docs/evidence/frontend-smoke-output.txt
```

Image-only check (before Compose exists):

```bash
cd client
sudo docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx -t qs-web-test .
sudo docker run --rm -p 8080:80 qs-web-test        # /api/* will 502 here: no api container yet (expected)
```

## 4. Test record

Fill **Result / Date / Branch / Evidence** from real runs.

| ID | Test | Expected | Result | Date | Evidence |
|---|---|---|---|---|---|
| T03 | Open `http://localhost:8080`, refresh `/movies`, `/my-bookings`, `/admin` | App renders, no Nginx 404 | NOT RUN | | `06-spa-route-refresh.png` |
| T04 | `curl -i http://localhost:8080/api/show/all` | HTTP 200 JSON `{"success":...}` | NOT RUN | | `05-quickshow-api-response.png` |
| FE-01 | `docker build` of `client/` | Build finishes, image created | NOT RUN | | terminal |
| FE-02 | Build with empty `VITE_CLERK_PUBLISHABLE_KEY` | Build fails with clear error | NOT RUN | | terminal |
| FE-03 | DevTools → Network on home page | `/api/show/all` goes to `localhost:8080`, not `localhost:3000`/Vercel | NOT RUN | | screenshot |
| FE-04 | `check-bundle-secrets.sh` | No `sk_`, `whsec_`, `localhost:3000`, `vercel.app` | NOT RUN | | terminal |
| FE-05 | Movie posters & prices on UI | Posters load; currency symbol shown (not `undefined`) | NOT RUN | | `04-quickshow-home.png` |
| FE-06 | `test-frontend.sh` | FAIL=0 | NOT RUN | | `frontend-smoke-output.txt` |
| FE-07 | `docker compose stop api` → open site → `start api` | Site stays up, API calls fail then recover **without restarting `web`** | NOT RUN | | terminal + screenshot |
| T11 (shared) | Clerk sign-in at `:8080`, open `/admin` | Auth works; admin only for admin role | NOT RUN / BLOCKED if no keys | | `13-clerk-login.png` |

## 5. Known constraints to remember

- **Open the site with the same hostname everywhere.** Stripe Checkout uses the request `Origin` header and the backend only accepts origins listed in `FRONTEND_URL`. `http://localhost:8080` and `http://127.0.0.1:8080` are different origins. Put the one you demo with into `FRONTEND_URL` (comma-separated list is supported) and into Clerk's allowed origins.
- Clerk must allow `http://localhost:8080` (it was `5173` before).
- On `127.0.0.1` alone from Windows you need the VirtualBox NAT rule Host `127.0.0.1:8080` → Guest `8080` (Member 1).
- Before Member 3 finishes the API image, `/api/*` returning 502 is expected, not a frontend bug.

## 6. Requests for Member 1 (compose.yaml)

- Pass `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_BASE_URL: /` as build args (already in the plan). `VITE_CURRENCY` and `VITE_TMDB_IMAGE_BASE_URL` have Dockerfile defaults; add them as args only if you want to override.
- Optional: use the `/healthz` endpoint for the `web` healthcheck: `wget -q -O /dev/null http://127.0.0.1/healthz`.

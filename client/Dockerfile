# syntax=docker/dockerfile:1

# ---------- Stage 1: build React/Vite ----------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifest first so the `npm ci` layer is cached until dependencies change
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

# Vite inlines VITE_* values at BUILD time. Changing any of them => rebuild the image.
# Only PUBLIC values belong here (never Clerk secret / Stripe secret).
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_BASE_URL=/
ARG VITE_CURRENCY="$"
ARG VITE_TMDB_IMAGE_BASE_URL=https://image.tmdb.org/t/p/original

ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY} \
    VITE_BASE_URL=${VITE_BASE_URL} \
    VITE_CURRENCY=${VITE_CURRENCY} \
    VITE_TMDB_IMAGE_BASE_URL=${VITE_TMDB_IMAGE_BASE_URL}

# Fail the build early instead of shipping a blank page ("Missing Publishable Key")
RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" \
    || (echo "ERROR: VITE_CLERK_PUBLISHABLE_KEY is empty. Set it in the root .env" >&2 && exit 1)

RUN npm run build

# ---------- Stage 2: serve static files with Nginx ----------
FROM nginx:stable-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

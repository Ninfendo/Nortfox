# 6. One web app that is also the PWA

Status: accepted, 2026-11-01

## Context

People use NortFox at a desk and on a phone. Two apps would double the work. A company wants the app to look like its own.

## Decision

- One React 19 single-page app in `apps/web`, built with Vite and Tailwind v4. It is also the PWA. There is no separate mobile app.
- Components are shadcn/ui on Base UI, in `packages/ui`.
- Icons come from Lucide, and only from Lucide.
- Theming happens at runtime. A theme is a set of values: style, base colour, theme colour, chart colours, light or dark, radius, menu colour, menu accent and font. The app turns the values into CSS variables while it runs, without a rebuild.
- Company admins get a style builder. It stores values only, never raw CSS. Each value must come from an allowed list or range, and the server checks the colour contrast.
- Fonts are self-hosted. The app makes no request to another site.

## Consequences

- One code base serves desk and phone, so every layout must work at phone width.
- A theme is data, so it can be set through the API and MCP like everything else.
- No field takes CSS, so a theme cannot inject CSS.
- Booking needs the server, also in the PWA, because the database gives the numbers.

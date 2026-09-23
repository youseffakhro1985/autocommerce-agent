# AutoCommerce Agent

Ett persistent, policyföljande system för dropshipping på Amazon EU och eBay EU. Det letar produkter, hittar grossister, räknar verklig nettomarginal, blockerar reglerade och IP-riskabla produkter, listar, bevakar lager och priser, lägger leverantörsordrar, laddar upp tracking, övervakar kontohälsan och rapporterar varje dag. Du behöver bara agera där lag, avtal eller plattformarnas regler kräver en människa.

- **Status för externa beroenden:** [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) (VERIFIED / UNVERIFIED / BLOCKED / NEEDS OWNER ACTION)
- **Arkitektur, agenter, loopar och säkerhetsregler:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Tillväxtmotorer:** vinstmål 25k–1M SEK/mån med krav och väg till målet, kill/winner-regler, 80/20, vinnarmotor (15 frågor + förhandlingsunderlag), kassaflöde 7/30/60/90, annonsmotor (vinst efter annons), veckovis CEO review, fasstatus 0–12 i dashboarden.
- **Det du behöver göra, steg för steg:** [`docs/OWNER_ACTIONS.md`](docs/OWNER_ACTIONS.md)

## Köra lokalt (simulering, inga riktiga pengar)
```bash
npm ci
export DATABASE_URL=postgres://postgres@localhost:5432/autocommerce_sim
npm run simulate                  # hela loopen mot mockar + daglig rapport (databasen RENSAS)
APP_MODE=simulation npm run dev:web     # dashboard på http://localhost:3000
APP_MODE=simulation npm run dev:worker  # 24/7-loopen
npm test                          # enhetstester + end-to-end-simulering (kräver Postgres)
```

## Driftsättning
**Primärt: Vercel** (eget projekt `autocommerce-agent`, region fra1) + Neon Postgres. `api/index.js` kör hela appen serverless; `/api/cron` (Vercel Cron, CRON_SECRET) och `/api/tick` (GitHub Actions var 30:e min, strypt, idempotent) driver alla jobb.

Alternativt: Docker-image med `PROCESS=web` eller `PROCESS=worker`. Filerna `railway.json` och `render.yaml` finns med. Använd EU-region (Frankfurt). Hemligheter läggs bara i värdens variabler (se `.env.example`).

## Lägen
| `APP_MODE` | Marknadsplatser/leverantörer | Pengar |
|---|---|---|
| `simulation` | Mockar | Inga |
| `sandbox` | Officiella sandlådor | Inga |
| `live` | Produktion, spärrat med `GO_LIVE_STAGE` 0–4 | Ja, inom utgiftsgränser |

## Kända begränsningar (ärligt)
- Adaptrarna för Amazon, eBay, BigBuy och Keepa följer den officiella dokumentationen men har **inte** körts mot riktiga konton. Validera dem i sandbox (fas C) innan du går live.
- Orders API v0 tas bort 2027-03-27. Migreringen till v2026-01-01 är markerad `TODO(ORDERS_V2026)`.
- Retur- och refund-API:er (Amazon MFN-returer, eBays Post-Order-ersättare) är inte automatiserade. Returer eskaleras till dig.
- Kundmeddelanden (Amazon Buyer-Seller Messaging, eBay-meddelanden) läses inte ännu. Klassificerare och mallar finns och kan kopplas in i fas 2.
- Trend från Google Trends är BLOCKED tills du fått alpha-åtkomst. Scoring använder då ett neutralt värde.
- Moms, OSS och GPSR-ansvar måste bekräftas med din redovisningskonsult. Systemets siffror är uppskattningar, inte bokföring.

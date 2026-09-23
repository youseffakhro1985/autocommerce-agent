# Det du behöver göra – i ordning

Varje steg är en enda sak. Allt annat gör systemet. Gör dem när du vill; systemet väntar och påminner i dashboarden.

## Fas A – Infrastruktur (ingen marknadsplats, inga pengar)
1. **Skapa ett Railway-konto** (railway.com) och ett nytt projekt från den här koden (GitHub-repo eller `railway up`). Lägg till en **PostgreSQL** i projektet.
2. **Skapa två tjänster** från samma kod: `web` med variabeln `PROCESS=web` och `worker` med `PROCESS=worker`. Båda: `APP_MODE=simulation`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `DASHBOARD_PASSWORD=<långt slumpat lösenord>`.
3. **Öppna dashboarden** (web-tjänstens URL) och se att simuleringen kör: produkter bedöms, listningar och ordrar skapas mot mockar.
4. (Valfritt) **Lägg in `NOTIFY_WEBHOOK_URL`** (t.ex. Slack/Discord incoming webhook) eller `RESEND_API_KEY` + `OWNER_EMAIL` för notiser.

## Fas B – Konton och nycklar (du måste göra dessa själv – identitet/avtal)
5. **Amazon:** skapa/verifiera ett *Professional*-konto på Seller Central Europe (identitets- och bankverifiering sker hos Amazon).
6. **Amazon SP-API:** i Seller Central → *Develop Apps* → registrera dig som privat utvecklare, skapa en app, klicka *Authorize* (självauktorisering) och kopiera **LWA client id, client secret, refresh token** och ditt **Seller ID** till Railway-variablerna.
7. **eBay:** skapa företagskonto på ebay.de (säljare), skapa en keyset på developer.ebay.com, generera en **user refresh token** via OAuth-medgivandet och lägg in `EBAY_CLIENT_ID/SECRET/REFRESH_TOKEN`. Skapa business policies (frakt, betalning, retur) och en lagerplats i Seller Hub; lägg in deras ID:n. Sätt `EBAY_VERIFICATION_TOKEN` + `PUBLIC_BASE_URL` och registrera `https://<din-url>/webhooks/ebay/account-deletion` i eBay-portalen.
8. **Keepa:** köp en API-plan på keepa.com och lägg in `KEEPA_API_KEY`.
9. **Leverantör:** skapa konto hos BigBuy (plan med API), läs och signera deras dropshippingvillkor, aktivera neutral (blind) leverans, lägg in `BIGBUY_API_KEY` (sandbox först).
10. **Moms/redovisning:** bekräfta med din redovisningskonsult: momsregistrering, OSS för distansförsäljning inom EU, och att leverantörsköp från Spanien sker med ditt VAT-nummer (omvänd skattskyldighet). Systemets momssiffror är uppskattningar.
11. **GPSR:** eftersom du säljer i EU är du ansvarig ekonomisk aktör för kunden – spara leverantörens produktsäkerhetsdokument; systemet blockerar produkter utan tillverkaruppgifter.

## Fas C – Sandbox (riktiga API:er, inga riktiga pengar)
12. Sätt `APP_MODE=sandbox`. Systemet anropar SP-API sandbox, eBay sandbox och BigBuy sandbox. Kontrollera i dashboarden att *Jobs* är gröna och att inga `NEEDS OWNER ACTION` återstår. (Här valideras alla punkter märkta UNVERIFIED i `INTEGRATIONS.md`.)

## Fas D – Live stegvis
13. Sätt `APP_MODE=live`, `GO_LIVE_STAGE=0`: bara research och bedömning mot riktig data. Granska *Opportunities* och beslutsloggen i några dagar.
14. **Verifiera leverantören** i dashboarden (knappen *Verify* = du intygar avtal, blind dropship, företagsuppgifter).
15. Sätt `CURRENT_CASH_SEK` och justera spend limits.
16. `GO_LIVE_STAGE=1`: systemet publicerar upp till `MAX_ACTIVE_LISTINGS` (börja med 3–5). Ordrar kräver ditt godkännande i dashboarden.
17. `GO_LIVE_STAGE=2`: automatiska leverantörsordrar inom gränserna.
18. `GO_LIVE_STAGE=3`: automatisk prissättning. `GO_LIVE_STAGE=4`: full autonomi (automatiska refunds endast om `AUTO_REFUNDS=true`).

## Det systemet alltid lämnar till dig
Identitet/KYC/BankID/2FA/CAPTCHA, nya avtal, chargebacks, A-to-z/eBay-ärenden, juridiska hot, kontovarningar, refunds över gränsen, order över gränserna, förlustordrar, misstänkt bedrägeri, ordrar som annullerats efter leverantörsköp.
